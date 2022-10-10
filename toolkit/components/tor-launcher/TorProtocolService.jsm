// Copyright (c) 2021, The Tor Project, Inc.

"use strict";

var EXPORTED_SYMBOLS = ["TorProtocolService"];

const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");
const { setTimeout } = ChromeUtils.import("resource://gre/modules/Timer.jsm");
ChromeUtils.defineModuleGetter(
  this,
  "FileUtils",
  "resource://gre/modules/FileUtils.jsm"
);
const { XPCOMUtils } = ChromeUtils.import(
  "resource://gre/modules/XPCOMUtils.jsm"
);

Cu.importGlobalProperties(["crypto"]);

const { TorParsers } = ChromeUtils.import(
  "resource://gre/modules/TorParsers.jsm"
);
const { TorLauncherUtil } = ChromeUtils.import(
  "resource://gre/modules/TorLauncherUtil.jsm"
);

ChromeUtils.defineModuleGetter(
  this,
  "TorMonitorService",
  "resource://gre/modules/TorMonitorService.jsm"
);
ChromeUtils.defineModuleGetter(
  this,
  "configureControlPortModule",
  "resource://torbutton/modules/tor-control-port.js"
);
ChromeUtils.defineModuleGetter(
  this,
  "controller",
  "resource://torbutton/modules/tor-control-port.js"
);

const TorTopics = Object.freeze({
  ProcessExited: "TorProcessExited",
  ProcessRestarted: "TorProcessRestarted",
});

// Logger adapted from CustomizableUI.jsm
XPCOMUtils.defineLazyGetter(this, "logger", () => {
  const { ConsoleAPI } = ChromeUtils.import(
    "resource://gre/modules/Console.jsm"
  );
  // TODO: Use a preference to set the log level.
  const consoleOptions = {
    // maxLogLevel: "warn",
    maxLogLevel: "all",
    prefix: "TorProtocolService",
  };
  return new ConsoleAPI(consoleOptions);
});

// Manage the connection to tor's control port, to update its settings and query
// other useful information.
//
// NOTE: Many Tor protocol functions return a reply object, which is a
// a JavaScript object that has the following fields:
//   reply.statusCode  -- integer, e.g., 250
//   reply.lineArray   -- an array of strings returned by tor
// For GetConf calls, the aKey prefix is removed from the lineArray strings.
const TorProtocolService = {
  _inited: false,

  // Maintain a map of tor settings set by Tor Browser so that we don't
  // repeatedly set the same key/values over and over.
  // This map contains string keys to primitives or array values.
  _settingsCache: new Map(),

  _controlPort: null,
  _controlHost: null,
  _controlIPCFile: null, // An nsIFile if using IPC for control port.
  _controlPassword: null, // JS string that contains hex-encoded password.
  _SOCKSPortInfo: null, // An object that contains ipcFile, host, port.

  _controlConnection: null, // This is cached and reused.
  _connectionQueue: [],

  // Public methods

  async init() {
    if (this._inited) {
      return;
    }
    this._inited = true;

    Services.obs.addObserver(this, TorTopics.ProcessExited);
    Services.obs.addObserver(this, TorTopics.ProcessRestarted);

    await this._setSockets();

    logger.debug("TorProtocolService initialized");
  },

  uninit() {
    Services.obs.removeObserver(this, TorTopics.ProcessExited);
    Services.obs.removeObserver(this, TorTopics.ProcessRestarted);
    this._closeConnection();
  },

  observe(subject, topic, data) {
    if (topic === TorTopics.ProcessExited) {
      this._closeConnection();
    } else if (topic === TorTopics.ProcessRestarted) {
      this._reconnect();
    }
  },

  // takes a Map containing tor settings
  // throws on error
  async writeSettings(aSettingsObj) {
    // only write settings that have changed
    const newSettings = Array.from(aSettingsObj).filter(([setting, value]) => {
      // make sure we have valid data here
      this._assertValidSetting(setting, value);

      if (!this._settingsCache.has(setting)) {
        // no cached setting, so write
        return true;
      }

      const cachedValue = this._settingsCache.get(setting);
      if (value === cachedValue) {
        return false;
      } else if (Array.isArray(value) && Array.isArray(cachedValue)) {
        // compare arrays member-wise
        if (value.length !== cachedValue.length) {
          return true;
        }
        for (let i = 0; i < value.length; i++) {
          if (value[i] !== cachedValue[i]) {
            return true;
          }
        }
        return false;
      }
      // some other different values
      return true;
    });

    // only write if new setting to save
    if (newSettings.length) {
      const settingsObject = Object.fromEntries(newSettings);
      await this.setConfWithReply(settingsObject);

      // save settings to cache after successfully writing to Tor
      for (const [setting, value] of newSettings) {
        this._settingsCache.set(setting, value);
      }
    }
  },

  async readStringArraySetting(aSetting) {
    const value = await this._readSetting(aSetting);
    this._settingsCache.set(aSetting, value);
    return value;
  },

  // writes current tor settings to disk
  async flushSettings() {
    await this.sendCommand("SAVECONF");
  },

  async connect() {
    const kTorConfKeyDisableNetwork = "DisableNetwork";
    const settings = {};
    settings[kTorConfKeyDisableNetwork] = false;
    await this.setConfWithReply(settings);
    await this.sendCommand("SAVECONF");
    TorMonitorService.clearBootstrapError();
    TorMonitorService.retrieveBootstrapStatus();
  },

  async stopBootstrap() {
    // Tell tor to disable use of the network; this should stop the bootstrap
    // process.
    try {
      const settings = { DisableNetwork: true };
      await this.setConfWithReply(settings);
    } catch (e) {
      logger.error("Error stopping bootstrap", e);
    }
    // We are not interested in waiting for this, nor in **catching its error**,
    // so we do not await this. We just want to be notified when the bootstrap
    // status is actually updated through observers.
    TorMonitorService.retrieveBootstrapStatus();
  },

  // TODO: transform the following 4 functions in getters. At the moment they
  // are also used in torbutton.

  // Returns Tor password string or null if an error occurs.
  torGetPassword(aPleaseHash) {
    const pw = this._controlPassword;
    return aPleaseHash ? this._hashPassword(pw) : pw;
  },

  torGetControlIPCFile() {
    return this._controlIPCFile?.clone();
  },

  torGetControlPort() {
    return this._controlPort;
  },

  torGetSOCKSPortInfo() {
    return this._SOCKSPortInfo;
  },

  // Public, but called only internally

  // Executes a command on the control port.
  // Return a reply object or null if a fatal error occurs.
  async sendCommand(cmd, args) {
    const maxTimeout = 1000;
    let leftConnAttempts = 5;
    let timeout = 250;
    let reply;
    while (leftConnAttempts-- > 0) {
      const response = await this._trySend(cmd, args, leftConnAttempts == 0);
      if (response.connected) {
        reply = response.reply;
        break;
      }
      // We failed to acquire the controller after multiple attempts.
      // Try again after some time.
      logger.warn(
        "sendCommand: Acquiring control connection failed, trying again later.",
        cmd,
        args
      );
      await new Promise(resolve => setTimeout(() => resolve(), timeout));
      timeout = Math.min(2 * timeout, maxTimeout);
    }

    // We sent the command, but we still got an empty response.
    // Something must be busted elsewhere.
    if (!reply) {
      throw new Error(`${cmd} sent an empty response`);
    }

    // TODO: Move the parsing of the reply to the controller, because anyone
    // calling sendCommand on it actually wants a parsed reply.

    reply = TorParsers.parseCommandResponse(reply);
    if (!TorParsers.commandSucceeded(reply)) {
      if (reply?.lineArray) {
        throw new Error(reply.lineArray.join("\n"));
      }
      throw new Error(`${cmd} failed with code ${reply.statusCode}`);
    }

    return reply;
  },

  // Perform a SETCONF command.
  // aSettingsObj should be a JavaScript object with keys (property values)
  // that correspond to tor config. keys. The value associated with each
  // key should be a simple string, a string array, or a Boolean value.
  // If an associated value is undefined or null, a key with no value is
  // passed in the SETCONF command.
  // Throws in case of error, or returns a reply object.
  async setConfWithReply(settings) {
    if (!settings) {
      throw new Error("Empty settings object");
    }
    const args = Object.entries(settings)
      .map(([key, val]) => {
        if (val === undefined || val === null) {
          return key;
        }
        const valType = typeof val;
        let rv = `${key}=`;
        if (valType === "boolean") {
          rv += val ? "1" : "0";
        } else if (Array.isArray(val)) {
          rv += val.map(TorParsers.escapeString).join(` ${key}=`);
        } else if (valType === "string") {
          rv += TorParsers.escapeString(val);
        } else {
          logger.error(`Got unsupported type for ${key}`, val);
          throw new Error(`Unsupported type ${valType} (key ${key})`);
        }
        return rv;
      })
      .filter(arg => arg);
    if (!args.length) {
      throw new Error("No settings to set");
    }

    await this.sendCommand("SETCONF", args.join(" "));
  },

  // Public, never called?

  async readBoolSetting(aSetting) {
    let value = await this._readBoolSetting(aSetting);
    this._settingsCache.set(aSetting, value);
    return value;
  },

  async readStringSetting(aSetting) {
    let value = await this._readStringSetting(aSetting);
    this._settingsCache.set(aSetting, value);
    return value;
  },

  // Private

  async _setSockets() {
    try {
      const isWindows = TorLauncherUtil.isWindows;
      const env = Cc["@mozilla.org/process/environment;1"].getService(
        Ci.nsIEnvironment
      );
      // Determine how Tor Launcher will connect to the Tor control port.
      // Environment variables get top priority followed by preferences.
      if (!isWindows && env.exists("TOR_CONTROL_IPC_PATH")) {
        const ipcPath = env.get("TOR_CONTROL_IPC_PATH");
        this._controlIPCFile = new FileUtils.File(ipcPath);
      } else {
        // Check for TCP host and port environment variables.
        if (env.exists("TOR_CONTROL_HOST")) {
          this._controlHost = env.get("TOR_CONTROL_HOST");
        }
        if (env.exists("TOR_CONTROL_PORT")) {
          this._controlPort = parseInt(env.get("TOR_CONTROL_PORT"), 10);
        }

        const useIPC =
          !isWindows &&
          Services.prefs.getBoolPref(
            "extensions.torlauncher.control_port_use_ipc",
            false
          );
        if (!this._controlHost && !this._controlPort && useIPC) {
          this._controlIPCFile = TorLauncherUtil.getTorFile(
            "control_ipc",
            false
          );
        } else {
          if (!this._controlHost) {
            this._controlHost = Services.prefs.getCharPref(
              "extensions.torlauncher.control_host",
              "127.0.0.1"
            );
          }
          if (!this._controlPort) {
            this._controlPort = Services.prefs.getIntPref(
              "extensions.torlauncher.control_port",
              9151
            );
          }
        }
      }

      // Populate _controlPassword so it is available when starting tor.
      if (env.exists("TOR_CONTROL_PASSWD")) {
        this._controlPassword = env.get("TOR_CONTROL_PASSWD");
      } else if (env.exists("TOR_CONTROL_COOKIE_AUTH_FILE")) {
        // TODO: test this code path (TOR_CONTROL_COOKIE_AUTH_FILE).
        const cookiePath = env.get("TOR_CONTROL_COOKIE_AUTH_FILE");
        if (cookiePath) {
          this._controlPassword = await this._readAuthenticationCookie(
            cookiePath
          );
        }
      }
      if (!this._controlPassword) {
        this._controlPassword = this._generateRandomPassword();
      }

      // Determine what kind of SOCKS port Tor and the browser will use.
      // On Windows (where Unix domain sockets are not supported), TCP is
      // always used.
      //
      // The following environment variables are supported and take
      // precedence over preferences:
      //    TOR_SOCKS_IPC_PATH  (file system path; ignored on Windows)
      //    TOR_SOCKS_HOST
      //    TOR_SOCKS_PORT
      //
      // The following preferences are consulted:
      //    network.proxy.socks
      //    network.proxy.socks_port
      //    extensions.torlauncher.socks_port_use_ipc (Boolean)
      //    extensions.torlauncher.socks_ipc_path (file system path)
      // If extensions.torlauncher.socks_ipc_path is empty, a default
      // path is used (<tor-data-directory>/socks.socket).
      //
      // When using TCP, if a value is not defined via an env variable it is
      // taken from the corresponding browser preference if possible. The
      // exceptions are:
      //   If network.proxy.socks contains a file: URL, a default value of
      //     "127.0.0.1" is used instead.
      //   If the network.proxy.socks_port value is 0, a default value of
      //     9150 is used instead.
      //
      // Supported scenarios:
      // 1. By default, an IPC object at a default path is used.
      // 2. If extensions.torlauncher.socks_port_use_ipc is set to false,
      //    a TCP socket at 127.0.0.1:9150 is used, unless different values
      //    are set in network.proxy.socks and network.proxy.socks_port.
      // 3. If the TOR_SOCKS_IPC_PATH env var is set, an IPC object at that
      //    path is used (e.g., a Unix domain socket).
      // 4. If the TOR_SOCKS_HOST and/or TOR_SOCKS_PORT env vars are set, TCP
      //    is used. Values not set via env vars will be taken from the
      //    network.proxy.socks and network.proxy.socks_port prefs as described
      //    above.
      // 5. If extensions.torlauncher.socks_port_use_ipc is true and
      //    extensions.torlauncher.socks_ipc_path is set, an IPC object at
      //    the specified path is used.
      // 6. Tor Launcher is disabled. Torbutton will respect the env vars if
      //    present; if not, the values in network.proxy.socks and
      //    network.proxy.socks_port are used without modification.

      let useIPC;
      this._SOCKSPortInfo = { ipcFile: undefined, host: undefined, port: 0 };
      if (!isWindows && env.exists("TOR_SOCKS_IPC_PATH")) {
        let ipcPath = env.get("TOR_SOCKS_IPC_PATH");
        this._SOCKSPortInfo.ipcFile = new FileUtils.File(ipcPath);
        useIPC = true;
      } else {
        // Check for TCP host and port environment variables.
        if (env.exists("TOR_SOCKS_HOST")) {
          this._SOCKSPortInfo.host = env.get("TOR_SOCKS_HOST");
          useIPC = false;
        }
        if (env.exists("TOR_SOCKS_PORT")) {
          this._SOCKSPortInfo.port = parseInt(env.get("TOR_SOCKS_PORT"), 10);
          useIPC = false;
        }
      }

      if (useIPC === undefined) {
        useIPC =
          !isWindows &&
          Services.prefs.getBoolPref(
            "extensions.torlauncher.socks_port_use_ipc",
            false
          );
      }

      // Fill in missing SOCKS info from prefs.
      if (useIPC) {
        if (!this._SOCKSPortInfo.ipcFile) {
          this._SOCKSPortInfo.ipcFile = TorLauncherUtil.getTorFile(
            "socks_ipc",
            false
          );
        }
      } else {
        if (!this._SOCKSPortInfo.host) {
          let socksAddr = Services.prefs.getCharPref(
            "network.proxy.socks",
            "127.0.0.1"
          );
          let socksAddrHasHost = socksAddr && !socksAddr.startsWith("file:");
          this._SOCKSPortInfo.host = socksAddrHasHost ? socksAddr : "127.0.0.1";
        }

        if (!this._SOCKSPortInfo.port) {
          let socksPort = Services.prefs.getIntPref(
            "network.proxy.socks_port",
            0
          );
          // This pref is set as 0 by default in Firefox, use 9150 if we get 0.
          this._SOCKSPortInfo.port = socksPort != 0 ? socksPort : 9150;
        }
      }

      logger.info("SOCKS port type: " + (useIPC ? "IPC" : "TCP"));
      if (useIPC) {
        logger.info(`ipcFile: ${this._SOCKSPortInfo.ipcFile.path}`);
      } else {
        logger.info(`SOCKS host: ${this._SOCKSPortInfo.host}`);
        logger.info(`SOCKS port: ${this._SOCKSPortInfo.port}`);
      }

      // Set the global control port info parameters.
      // These values may be overwritten by torbutton when it initializes, but
      // torbutton's values *should* be identical.
      configureControlPortModule(
        this._controlIPCFile,
        this._controlHost,
        this._controlPort,
        this._controlPassword
      );
    } catch (e) {
      logger.error("Failed to get environment variables", e);
    }
  },

  _assertValidSettingKey(aSetting) {
    // ensure the 'key' is a string
    if (typeof aSetting !== "string") {
      throw new Error(
        `Expected setting of type string but received ${typeof aSetting}`
      );
    }
  },

  _assertValidSetting(aSetting, aValue) {
    this._assertValidSettingKey(aSetting);
    switch (typeof aValue) {
      case "boolean":
      case "string":
        return;
      case "object":
        if (aValue === null) {
          return;
        } else if (Array.isArray(aValue)) {
          for (const element of aValue) {
            if (typeof element !== "string") {
              throw new Error(
                `Setting '${aSetting}' array contains value of invalid type '${typeof element}'`
              );
            }
          }
          return;
        }
      // fall through
      default:
        throw new Error(
          `Invalid object type received for setting '${aSetting}'`
        );
    }
  },

  // Perform a GETCONF command.
  async _readSetting(aSetting) {
    this._assertValidSettingKey(aSetting);

    const cmd = "GETCONF";
    let reply = await this.sendCommand(cmd, aSetting);
    reply = TorParsers.parseReply(cmd, aSetting, reply);
    if (TorParsers.commandSucceeded(reply)) {
      return reply.lineArray;
    }
    throw new Error(reply.lineArray.join("\n"));
  },

  async _readStringSetting(aSetting) {
    let lineArray = await this._readSetting(aSetting);
    if (lineArray.length !== 1) {
      throw new Error(
        `Expected an array with length 1 but received array of length ${lineArray.length}`
      );
    }
    return lineArray[0];
  },

  async _readBoolSetting(aSetting) {
    const value = this._readStringSetting(aSetting);
    switch (value) {
      case "0":
        return false;
      case "1":
        return true;
      default:
        throw new Error(`Expected boolean (1 or 0) but received '${value}'`);
    }
  },

  async _trySend(cmd, args, rethrow) {
    let connected = false;
    let reply;
    let leftAttempts = 2;
    while (leftAttempts-- > 0) {
      let conn;
      try {
        conn = await this._getConnection();
      } catch (e) {
        logger.error("Cannot get a connection to the control port", e);
        if (leftAttempts == 0 && rethrow) {
          throw e;
        }
      }
      if (!conn) {
        continue;
      }
      // If we _ever_ got a connection, the caller should not try again
      connected = true;
      try {
        reply = await conn.sendCommand(cmd + (args ? " " + args : ""));
        if (reply) {
          // Return for reuse.
          this._returnConnection();
        } else {
          // Connection is bad.
          logger.warn(
            "sendCommand returned an empty response, taking the connection as broken and closing it."
          );
          this._closeConnection();
        }
      } catch (e) {
        logger.error(`Cannot send the command ${cmd}`, e);
        this._closeConnection();
        if (leftAttempts == 0 && rethrow) {
          throw e;
        }
      }
    }
    return { connected, reply };
  },

  // Opens an authenticated connection, sets it to this._controlConnection, and
  // return it.
  async _getConnection() {
    if (!this._controlConnection) {
      const avoidCache = true;
      this._controlConnection = await controller(avoidCache);
    }
    if (this._controlConnection.inUse) {
      await new Promise((resolve, reject) =>
        this._connectionQueue.push({ resolve, reject })
      );
    } else {
      this._controlConnection.inUse = true;
    }
    return this._controlConnection;
  },

  _returnConnection() {
    if (this._connectionQueue.length) {
      this._connectionQueue.shift().resolve();
    } else {
      this._controlConnection.inUse = false;
    }
  },

  // If aConn is omitted, the cached connection is closed.
  _closeConnection() {
    if (this._controlConnection) {
      logger.info("Closing the control connection");
      this._controlConnection.close();
      this._controlConnection = null;
    }
    for (const promise of this._connectionQueue) {
      promise.reject("Connection closed");
    }
    this._connectionQueue = [];
  },

  async _reconnect() {
    this._closeConnection();
    const conn = await this._getConnection();
    logger.debug("Reconnected to the control port.");
    this._returnConnection(conn);
  },

  async _readAuthenticationCookie(aPath) {
    const bytes = await IOUtils.read(aPath);
    return Array.from(bytes, b => this._toHex(b, 2)).join("");
  },

  // Returns a random 16 character password, hex-encoded.
  _generateRandomPassword() {
    // Similar to Vidalia's crypto_rand_string().
    const kPasswordLen = 16;
    const kMinCharCode = "!".charCodeAt(0);
    const kMaxCharCode = "~".charCodeAt(0);
    let pwd = "";
    for (let i = 0; i < kPasswordLen; ++i) {
      const val = this._cryptoRandInt(kMaxCharCode - kMinCharCode + 1);
      if (val < 0) {
        logger.error("_cryptoRandInt() failed");
        return null;
      }
      pwd += this._toHex(kMinCharCode + val, 2);
    }

    return pwd;
  },

  // Based on Vidalia's TorSettings::hashPassword().
  _hashPassword(aHexPassword) {
    if (!aHexPassword) {
      return null;
    }

    // Generate a random, 8 byte salt value.
    const salt = Array.from(crypto.getRandomValues(new Uint8Array(8)));

    // Convert hex-encoded password to an array of bytes.
    const password = [];
    for (let i = 0; i < aHexPassword.length; i += 2) {
      password.push(parseInt(aHexPassword.substring(i, i + 2), 16));
    }

    // Run through the S2K algorithm and convert to a string.
    const kCodedCount = 96;
    const hashVal = this._cryptoSecretToKey(password, salt, kCodedCount);
    if (!hashVal) {
      logger.error("_cryptoSecretToKey() failed");
      return null;
    }

    const arrayToHex = aArray =>
      aArray.map(item => this._toHex(item, 2)).join("");
    let rv = "16:";
    rv += arrayToHex(salt);
    rv += this._toHex(kCodedCount, 2);
    rv += arrayToHex(hashVal);
    return rv;
  },

  // Returns -1 upon failure.
  _cryptoRandInt(aMax) {
    // Based on tor's crypto_rand_int().
    const maxUInt = 0xffffffff;
    if (aMax <= 0 || aMax > maxUInt) {
      return -1;
    }

    const cutoff = maxUInt - (maxUInt % aMax);
    let val = cutoff;
    while (val >= cutoff) {
      const uint32 = new Uint32Array(1);
      crypto.getRandomValues(uint32);
      val = uint32[0];
    }
    return val % aMax;
  },

  // _cryptoSecretToKey() is similar to Vidalia's crypto_secret_to_key().
  // It generates and returns a hash of aPassword by following the iterated
  // and salted S2K algorithm (see RFC 2440 section 3.6.1.3).
  // Returns an array of bytes.
  _cryptoSecretToKey(aPassword, aSalt, aCodedCount) {
    if (!aPassword || !aSalt) {
      return null;
    }

    const inputArray = aSalt.concat(aPassword);

    // Subtle crypto only has the final digest, and does not allow incremental
    // updates. Also, it is async, so we should hash and keep the hash in a
    // variable if we wanted to switch to getters.
    // So, keeping this implementation should be okay for now.
    const hasher = Cc["@mozilla.org/security/hash;1"].createInstance(
      Ci.nsICryptoHash
    );
    hasher.init(hasher.SHA1);
    const kEXPBIAS = 6;
    let count = (16 + (aCodedCount & 15)) << ((aCodedCount >> 4) + kEXPBIAS);
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
  },

  _toHex(aValue, aMinLen) {
    return aValue.toString(16).padStart(aMinLen, "0");
  },
};
