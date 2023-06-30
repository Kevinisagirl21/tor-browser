import { setTimeout } from "resource://gre/modules/Timer.sys.mjs";
import { ConsoleAPI } from "resource://gre/modules/Console.sys.mjs";
import { Subprocess } from "resource://gre/modules/Subprocess.sys.mjs";

const lazy = {};

ChromeUtils.defineModuleGetter(
  lazy,
  "TorProtocolService",
  "resource://gre/modules/TorProtocolService.jsm"
);
const { TorLauncherUtil } = ChromeUtils.import(
  "resource://gre/modules/TorLauncherUtil.jsm"
);

const { TorParsers } = ChromeUtils.import(
  "resource://gre/modules/TorParsers.jsm"
);

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
  _exeFile = null;
  _dataDir = null;
  _args = [];
  _subprocess = null;
  _status = TorProcessStatus.Unknown;
  _torProcessStartTime = null; // JS Date.now()
  _didConnectToTorControlPort = false; // Have we ever made a connection?

  onExit = null;
  onRestart = null;

  get status() {
    return this._status;
  }

  get isRunning() {
    return (
      this._status === TorProcessStatus.Starting ||
      this._status === TorProcessStatus.Running
    );
  }

  async start() {
    if (this._subprocess) {
      return;
    }

    this._status = TorProcessStatus.Unknown;

    try {
      this._makeArgs();
      this._addControlPortArg();
      this._addSocksPortArg();

      const pid = Services.appinfo.processID;
      if (pid !== 0) {
        this._args.push("__OwningControllerProcess");
        this._args.push("" + pid);
      }

      if (TorLauncherUtil.shouldShowNetworkSettings) {
        this._args.push("DisableNetwork");
        this._args.push("1");
      }

      this._status = TorProcessStatus.Starting;
      this._didConnectToTorControlPort = false;

      // useful for simulating slow tor daemon launch
      const kPrefTorDaemonLaunchDelay = "extensions.torlauncher.launch_delay";
      const launchDelay = Services.prefs.getIntPref(
        kPrefTorDaemonLaunchDelay,
        0
      );
      if (launchDelay > 0) {
        await new Promise(resolve => setTimeout(() => resolve(), launchDelay));
      }

      logger.debug(`Starting ${this._exeFile.path}`, this._args);
      const options = {
        command: this._exeFile.path,
        arguments: this._args,
        stderr: "stdout",
        workdir: TorLauncherUtil.getTorFile("pt-startup-dir", false).path,
      };
      this._subprocess = await Subprocess.call(options);
      this._dumpStdout();
      this._watchProcess();
      this._status = TorProcessStatus.Running;
      this._torProcessStartTime = Date.now();
    } catch (e) {
      this._status = TorProcessStatus.Exited;
      this._subprocess = null;
      logger.error("startTor error:", e);
      throw e;
    }
  }

  // Forget about a process.
  //
  // Instead of killing the tor process, we  rely on the TAKEOWNERSHIP feature
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
    this._subprocess = null;
    this._status = TorProcessStatus.Exited;
  }

  // The owner of the process can use this function to tell us that they
  // successfully connected to the control port. This information will be used
  // only to decide which text to show in the confirmation dialog if tor exits.
  connectionWorked() {
    this._didConnectToTorControlPort = true;
  }

  async _dumpStdout() {
    let string;
    while (
      this._subprocess &&
      (string = await this._subprocess.stdout.readString())
    ) {
      dump(string);
    }
  }

  async _watchProcess() {
    const watched = this._subprocess;
    if (!watched) {
      return;
    }
    try {
      const { exitCode } = await watched.wait();

      if (watched !== this._subprocess) {
        logger.debug(`A Tor process exited with code ${exitCode}.`);
      } else if (exitCode) {
        logger.warn(`The watched Tor process exited with code ${exitCode}.`);
      } else {
        logger.info("The Tor process exited.");
      }
    } catch (e) {
      logger.error("Failed to watch the tor process", e);
    }

    if (watched === this._subprocess) {
      this._processExitedUnexpectedly();
    }
  }

  _processExitedUnexpectedly() {
    this._subprocess = null;
    this._status = TorProcessStatus.Exited;

    // TODO: Move this logic somewhere else?
    let s;
    if (!this._didConnectToTorControlPort) {
      // tor might be misconfigured, becauser we could never connect to it
      const key = "tor_exited_during_startup";
      s = TorLauncherUtil.getLocalizedString(key);
    } else {
      // tor exited suddenly, so configuration should be okay
      s =
        TorLauncherUtil.getLocalizedString("tor_exited") +
        "\n\n" +
        TorLauncherUtil.getLocalizedString("tor_exited2");
    }
    logger.info(s);
    const defaultBtnLabel = TorLauncherUtil.getLocalizedString("restart_tor");
    let cancelBtnLabel = "OK";
    try {
      const kSysBundleURI = "chrome://global/locale/commonDialogs.properties";
      const sysBundle = Services.strings.createBundle(kSysBundleURI);
      cancelBtnLabel = sysBundle.GetStringFromName(cancelBtnLabel);
    } catch (e) {
      logger.warn("Could not localize the cancel button", e);
    }

    const restart = TorLauncherUtil.showConfirm(
      null,
      s,
      defaultBtnLabel,
      cancelBtnLabel
    );
    if (restart) {
      this.start().then(() => {
        if (this.onRestart) {
          this.onRestart();
        }
      });
    } else if (this.onExit) {
      this.onExit();
    }
  }

  _makeArgs() {
    // Ideally, we would cd to the Firefox application directory before
    // starting tor (but we don't know how to do that). Instead, we
    // rely on the TBB launcher to start Firefox from the right place.

    // Get the Tor data directory first so it is created before we try to
    // construct paths to files that will be inside it.
    this._exeFile = TorLauncherUtil.getTorFile("tor", false);
    const torrcFile = TorLauncherUtil.getTorFile("torrc", true);
    this._dataDir = TorLauncherUtil.getTorFile("tordatadir", true);
    const onionAuthDir = TorLauncherUtil.getTorFile("toronionauthdir", true);
    const hashedPassword = lazy.TorProtocolService.torGetPassword(true);
    let detailsKey;
    if (!this._exeFile) {
      detailsKey = "tor_missing";
    } else if (!torrcFile) {
      detailsKey = "torrc_missing";
    } else if (!this._dataDir) {
      detailsKey = "datadir_missing";
    } else if (!onionAuthDir) {
      detailsKey = "onionauthdir_missing";
    } else if (!hashedPassword) {
      detailsKey = "password_hash_missing";
    }
    if (detailsKey) {
      const details = TorLauncherUtil.getLocalizedString(detailsKey);
      const key = "unable_to_start_tor";
      const err = TorLauncherUtil.getFormattedLocalizedString(
        key,
        [details],
        1
      );
      throw new Error(err);
    }

    const torrcDefaultsFile = TorLauncherUtil.getTorFile(
      "torrc-defaults",
      false
    );
    // The geoip and geoip6 files are in the same directory as torrc-defaults.
    const geoipFile = torrcDefaultsFile.clone();
    geoipFile.leafName = "geoip";
    const geoip6File = torrcDefaultsFile.clone();
    geoip6File.leafName = "geoip6";

    this._args = [];
    if (torrcDefaultsFile) {
      this._args.push("--defaults-torrc");
      this._args.push(torrcDefaultsFile.path);
    }
    this._args.push("-f");
    this._args.push(torrcFile.path);
    this._args.push("DataDirectory");
    this._args.push(this._dataDir.path);
    this._args.push("ClientOnionAuthDir");
    this._args.push(onionAuthDir.path);
    this._args.push("GeoIPFile");
    this._args.push(geoipFile.path);
    this._args.push("GeoIPv6File");
    this._args.push(geoip6File.path);
    this._args.push("HashedControlPassword");
    this._args.push(hashedPassword);
  }

  _addControlPortArg() {
    // Include a ControlPort argument to support switching between
    // a TCP port and an IPC port (e.g., a Unix domain socket). We
    // include a "+__" prefix so that (1) this control port is added
    // to any control ports that the user has defined in their torrc
    // file and (2) it is never written to torrc.
    let controlPortArg;
    const controlIPCFile = lazy.TorProtocolService.torGetControlIPCFile();
    const controlPort = lazy.TorProtocolService.torGetControlPort();
    if (controlIPCFile) {
      controlPortArg = this._ipcPortArg(controlIPCFile);
    } else if (controlPort) {
      controlPortArg = "" + controlPort;
    }
    if (controlPortArg) {
      this._args.push("+__ControlPort");
      this._args.push(controlPortArg);
    }
  }

  _addSocksPortArg() {
    // Include a SocksPort argument to support switching between
    // a TCP port and an IPC port (e.g., a Unix domain socket). We
    // include a "+__" prefix so that (1) this SOCKS port is added
    // to any SOCKS ports that the user has defined in their torrc
    // file and (2) it is never written to torrc.
    const socksPortInfo = lazy.TorProtocolService.torGetSOCKSPortInfo();
    if (socksPortInfo) {
      let socksPortArg;
      if (socksPortInfo.ipcFile) {
        socksPortArg = this._ipcPortArg(socksPortInfo.ipcFile);
      } else if (socksPortInfo.host && socksPortInfo.port != 0) {
        socksPortArg = socksPortInfo.host + ":" + socksPortInfo.port;
      }
      if (socksPortArg) {
        let socksPortFlags = Services.prefs.getCharPref(
          "extensions.torlauncher.socks_port_flags",
          "IPv6Traffic PreferIPv6 KeepAliveIsolateSOCKSAuth"
        );
        if (socksPortFlags) {
          socksPortArg += " " + socksPortFlags;
        }
        this._args.push("+__SocksPort");
        this._args.push(socksPortArg);
      }
    }
  }

  // Return a ControlPort or SocksPort argument for aIPCFile (an nsIFile).
  // The result is unix:/path or unix:"/path with spaces" with appropriate
  // C-style escaping within the path portion.
  _ipcPortArg(aIPCFile) {
    return "unix:" + TorParsers.escapeString(aIPCFile.path);
  }
}
