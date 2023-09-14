/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { setTimeout } from "resource://gre/modules/Timer.sys.mjs";
import { ConsoleAPI } from "resource://gre/modules/Console.sys.mjs";
import { Subprocess } from "resource://gre/modules/Subprocess.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  TorLauncherUtil: "resource://gre/modules/TorLauncherUtil.sys.mjs",
  TorParsers: "resource://gre/modules/TorParsers.sys.mjs",
});

const TorProcessStatus = Object.freeze({
  Unknown: 0,
  Starting: 1,
  Running: 2,
  Exited: 3,
});

const logger = new ConsoleAPI({
  maxLogLevel: "info",
  prefix: "TorProcess",
});

export class TorProcess {
  #controlSettings;
  #socksSettings;
  #exeFile = null;
  #dataDir = null;
  #args = [];
  #subprocess = null;
  #status = TorProcessStatus.Unknown;
  // Have we ever made a connection on the control port?
  #didConnectToTorControlPort = false;

  onExit = exitCode => {};
  onRestart = () => {};

  constructor(controlSettings, socksSettings) {
    if (
      controlSettings &&
      !controlSettings.password?.length &&
      !controlSettings.cookieFilePath
    ) {
      throw new Error("Unauthenticated control port is not supported");
    }

    const checkPort = port =>
      port === undefined ||
      (Number.isInteger(controlSettings.port) &&
        controlSettings.port > 0 &&
        controlSettings.port < 65535);
    if (!checkPort(controlSettings?.port)) {
      throw new Error("Invalid control port");
    }
    if (!checkPort(socksSettings.port)) {
      throw new Error("Invalid port specified for the SOCKS port");
    }

    this.#controlSettings = { ...controlSettings };
    const ipcFileToString = file =>
      "unix:" + lazy.TorParsers.escapeString(file.path);
    if (controlSettings.ipcFile) {
      this.#controlSettings.ipcFile = ipcFileToString(controlSettings.ipcFile);
    }
    this.#socksSettings = { ...socksSettings };
    if (socksSettings.ipcFile) {
      this.#socksSettings.ipcFile = ipcFileToString(socksSettings.ipcFile);
    }
  }

  get status() {
    return this.#status;
  }

  get isRunning() {
    return (
      this.#status === TorProcessStatus.Starting ||
      this.#status === TorProcessStatus.Running
    );
  }

  async start() {
    if (this.#subprocess) {
      return;
    }

    this.#status = TorProcessStatus.Unknown;

    try {
      this.#makeArgs();
      this.#addControlPortArgs();
      this.#addSocksPortArg();

      const pid = Services.appinfo.processID;
      if (pid !== 0) {
        this.#args.push("__OwningControllerProcess", pid.toString());
      }

      if (lazy.TorLauncherUtil.shouldShowNetworkSettings) {
        this.#args.push("DisableNetwork", "1");
      }

      this.#status = TorProcessStatus.Starting;
      this.#didConnectToTorControlPort = false;

      // useful for simulating slow tor daemon launch
      const kPrefTorDaemonLaunchDelay = "extensions.torlauncher.launch_delay";
      const launchDelay = Services.prefs.getIntPref(
        kPrefTorDaemonLaunchDelay,
        0
      );
      if (launchDelay > 0) {
        await new Promise(resolve => setTimeout(() => resolve(), launchDelay));
      }

      logger.debug(`Starting ${this.#exeFile.path}`, this.#args);
      const options = {
        command: this.#exeFile.path,
        arguments: this.#args,
        stderr: "stdout",
        workdir: lazy.TorLauncherUtil.getTorFile("pt-startup-dir", false).path,
      };
      this.#subprocess = await Subprocess.call(options);
      this.#status = TorProcessStatus.Running;
    } catch (e) {
      this.#status = TorProcessStatus.Exited;
      this.#subprocess = null;
      logger.error("startTor error:", e);
      throw e;
    }

    // Do not await the following functions, as they will return only when the
    // process exits.
    this.#dumpStdout();
    this.#watchProcess();
  }

  // Forget about a process.
  //
  // Instead of killing the tor process, we rely on the TAKEOWNERSHIP feature
  // to shut down tor when we close the control port connection.
  //
  // Previously, we sent a SIGNAL HALT command to the tor control port,
  // but that caused hangs upon exit in the Firefox 24.x based browser.
  // Apparently, Firefox does not like to process socket I/O while
  // quitting if the browser did not finish starting up (e.g., when
  // someone presses the Quit button on our Network Settings window
  // during startup).
  //
  // Still, before closing the owning connection, this class should forget about
  // the process, so that future notifications will be ignored.
  forget() {
    this.#subprocess = null;
    this.#status = TorProcessStatus.Exited;
  }

  // The owner of the process can use this function to tell us that they
  // successfully connected to the control port. This information will be used
  // only to decide which text to show in the confirmation dialog if tor exits.
  connectionWorked() {
    this.#didConnectToTorControlPort = true;
  }

  async #dumpStdout() {
    let string;
    while (
      this.#subprocess &&
      (string = await this.#subprocess.stdout.readString())
    ) {
      dump(string);
    }
  }

  async #watchProcess() {
    const watched = this.#subprocess;
    if (!watched) {
      return;
    }
    let processExitCode;
    try {
      const { exitCode } = await watched.wait();
      processExitCode = exitCode;

      if (watched !== this.#subprocess) {
        logger.debug(`A Tor process exited with code ${exitCode}.`);
      } else if (exitCode) {
        logger.warn(`The watched Tor process exited with code ${exitCode}.`);
      } else {
        logger.info("The Tor process exited.");
      }
    } catch (e) {
      logger.error("Failed to watch the tor process", e);
    }

    if (watched === this.#subprocess) {
      this.#processExitedUnexpectedly(processExitCode);
    }
  }

  #processExitedUnexpectedly(exitCode) {
    this.#subprocess = null;
    this.#status = TorProcessStatus.Exited;
    // FIXME: We can probably drop #didConnectToTorControlPort and use only one
    // callback. Then we can let the provider actually distinguish between the
    // cases.
    if (!this.#didConnectToTorControlPort) {
      logger.warn("Tor exited before we could connect to its control port.");
      // tor might be misconfigured, because we could never connect to it.
      // Two instances of Tor Browser trying to use the same port numbers is
      // also a typical scenario for this.
      // This might happen very early, before the browser UI is actually
      // available. So, we will tell the process owner that the process exited,
      // without trying to restart it.
      this.onExit(exitCode);
      return;
    }
    logger.warn("Tor exited suddenly.");
    if (lazy.TorLauncherUtil.showRestartPrompt(false)) {
      this.start().then(this.onRestart);
    } else {
      this.onExit(exitCode);
    }
  }

  #makeArgs() {
    this.#exeFile = lazy.TorLauncherUtil.getTorFile("tor", false);
    const torrcFile = lazy.TorLauncherUtil.getTorFile("torrc", true);
    // Get the Tor data directory first so it is created before we try to
    // construct paths to files that will be inside it.
    this.#dataDir = lazy.TorLauncherUtil.getTorFile("tordatadir", true);
    const onionAuthDir = lazy.TorLauncherUtil.getTorFile(
      "toronionauthdir",
      true
    );
    let detailsKey;
    if (!this.#exeFile) {
      detailsKey = "tor_missing";
    } else if (!torrcFile) {
      detailsKey = "torrc_missing";
    } else if (!this.#dataDir) {
      detailsKey = "datadir_missing";
    } else if (!onionAuthDir) {
      detailsKey = "onionauthdir_missing";
    }
    if (detailsKey) {
      const details = lazy.TorLauncherUtil.getLocalizedString(detailsKey);
      const key = "unable_to_start_tor";
      const err = lazy.TorLauncherUtil.getFormattedLocalizedString(
        key,
        [details],
        1
      );
      throw new Error(err);
    }

    const torrcDefaultsFile = lazy.TorLauncherUtil.getTorFile(
      "torrc-defaults",
      false
    );
    // The geoip and geoip6 files are in the same directory as torrc-defaults.
    const geoipFile = torrcDefaultsFile.clone();
    geoipFile.leafName = "geoip";
    const geoip6File = torrcDefaultsFile.clone();
    geoip6File.leafName = "geoip6";

    this.#args = [];
    if (torrcDefaultsFile) {
      this.#args.push("--defaults-torrc", torrcDefaultsFile.path);
    }
    this.#args.push("-f", torrcFile.path);
    this.#args.push("DataDirectory", this.#dataDir.path);
    this.#args.push("ClientOnionAuthDir", onionAuthDir.path);
    this.#args.push("GeoIPFile", geoipFile.path);
    this.#args.push("GeoIPv6File", geoip6File.path);
  }

  /**
   * Add all the arguments related to the control port.
   * We use the + prefix so that the the port is added to any other port already
   * defined in the torrc, and the __ prefix so that it is never written to
   * torrc.
   */
  #addControlPortArgs() {
    if (!this.#controlSettings) {
      return;
    }

    let controlPortArg;
    if (this.#controlSettings.ipcFile) {
      controlPortArg = this.#controlSettings.ipcFile;
    } else if (this.#controlSettings.port) {
      controlPortArg = this.#controlSettings.host
        ? `${this.#controlSettings.host}:${this.#controlSettings.port}`
        : this.#controlSettings.port.toString();
    }
    if (controlPortArg) {
      this.#args.push("+__ControlPort", controlPortArg);
    }

    if (this.#controlSettings.password?.length) {
      this.#args.push(
        "HashedControlPassword",
        this.#hashPassword(this.#controlSettings.password)
      );
    }
    if (this.#controlSettings.cookieFilePath) {
      this.#args.push("CookieAuthentication", "1");
      this.#args.push("CookieAuthFile", this.#controlSettings.cookieFilePath);
    }
  }

  /**
   * Add the argument related to the control port.
   * We use the + prefix so that the the port is added to any other port already
   * defined in the torrc, and the __ prefix so that it is never written to
   * torrc.
   */
  #addSocksPortArg() {
    let socksPortArg;
    if (this.#socksSettings.ipcFile) {
      socksPortArg = this.#socksSettings.ipcFile;
    } else if (this.#socksSettings.port != 0) {
      socksPortArg = this.#socksSettings.host
        ? `${this.#socksSettings.host}:${this.#socksSettings.port}`
        : this.#socksSettings.port.toString();
    }
    if (socksPortArg) {
      const socksPortFlags = Services.prefs.getCharPref(
        "extensions.torlauncher.socks_port_flags",
        "IPv6Traffic PreferIPv6 KeepAliveIsolateSOCKSAuth"
      );
      if (socksPortFlags) {
        socksPortArg += " " + socksPortFlags;
      }
      this.#args.push("+__SocksPort", socksPortArg);
    }
  }

  /**
   * Hash a password to then pass it to Tor as a command line argument.
   * Based on Vidalia's TorSettings::hashPassword().
   *
   * @param {Uint8Array} password The password, as an array of bytes
   */
  #hashPassword(password) {
    // The password has already been checked by the caller.

    // Generate a random, 8 byte salt value.
    const salt = Array.from(crypto.getRandomValues(new Uint8Array(8)));

    // Run through the S2K algorithm and convert to a string.
    const toHex = v => v.toString(16).padStart(2, "0");
    const arrayToHex = aArray => aArray.map(toHex).join("");
    const kCodedCount = 96;
    const hashVal = this.#cryptoSecretToKey(
      Array.from(password),
      salt,
      kCodedCount
    );
    return "16:" + arrayToHex(salt) + toHex(kCodedCount) + arrayToHex(hashVal);
  }

  /**
   * Generates and return a hash of a password by following the iterated and
   * salted S2K algorithm (see RFC 2440 section 3.6.1.3).
   * See also https://gitlab.torproject.org/tpo/core/torspec/-/blob/main/control-spec.txt#L3824.
   * #cryptoSecretToKey() is similar to Vidalia's crypto_secret_to_key().
   *
   * @param {Array} password The password to hash, as an array of bytes
   * @param {Array} salt The salt to use for the hash, as an array of bytes
   * @param {number} codedCount The counter, coded as specified in RFC 2440
   * @returns {Array} The hash of the password, as an array of bytes
   */
  #cryptoSecretToKey(password, salt, codedCount) {
    const inputArray = salt.concat(password);

    // Subtle crypto only has the final digest, and does not allow incremental
    // updates.
    const hasher = Cc["@mozilla.org/security/hash;1"].createInstance(
      Ci.nsICryptoHash
    );
    hasher.init(hasher.SHA1);
    const kEXPBIAS = 6;
    let count = (16 + (codedCount & 15)) << ((codedCount >> 4) + kEXPBIAS);
    while (count > 0) {
      if (count > inputArray.length) {
        hasher.update(inputArray, inputArray.length);
        count -= inputArray.length;
      } else {
        const finalArray = inputArray.slice(0, count);
        hasher.update(finalArray, finalArray.length);
        count = 0;
      }
    }
    return hasher
      .finish(false)
      .split("")
      .map(b => b.charCodeAt(0));
  }
}
