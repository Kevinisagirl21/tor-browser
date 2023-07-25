// Copyright (c) 2021, The Tor Project, Inc.

import { setTimeout } from "resource://gre/modules/Timer.sys.mjs";
import { ConsoleAPI } from "resource://gre/modules/Console.sys.mjs";

import { TorParsers } from "resource://gre/modules/TorParsers.sys.mjs";
import { TorLauncherUtil } from "resource://gre/modules/TorLauncherUtil.sys.mjs";

const lazy = {};

ChromeUtils.defineModuleGetter(
  lazy,
  "FileUtils",
  "resource://gre/modules/FileUtils.jsm"
);

ChromeUtils.defineModuleGetter(
  lazy,
  "TorMonitorService",
  "resource://gre/modules/TorMonitorService.jsm"
);
ChromeUtils.defineModuleGetter(
  lazy,
  "configureControlPortModule",
  "resource://torbutton/modules/tor-control-port.js"
);
ChromeUtils.defineModuleGetter(
  lazy,
  "controller",
  "resource://torbutton/modules/tor-control-port.js"
);

const TorTopics = Object.freeze({
  ProcessExited: "TorProcessExited",
  ProcessRestarted: "TorProcessRestarted",
});

const logger = new ConsoleAPI({
  maxLogLevel: "warn",
  prefix: "TorProtocolService",
});

/**
 * Stores the data associated with a circuit node.
 *
 * @typedef NodeData
 * @property {string} fingerprint The node fingerprint.
 * @property {string[]} ipAddrs - The ip addresses associated with this node.
 * @property {string?} bridgeType - The bridge type for this node, or "" if the
 *   node is a bridge but the type is unknown, or null if this is not a bridge
 *   node.
 * @property {string?} regionCode - An upper case 2-letter ISO3166-1 code for
 *   the first ip address, or null if there is no region. This should also be a
 *   valid BCP47 Region subtag.
 */

// Manage the connection to tor's control port, to update its settings and query
// other useful information.
//
// NOTE: Many Tor protocol functions return a reply object, which is a
// a JavaScript object that has the following fields:
//   reply.statusCode  -- integer, e.g., 250
//   reply.lineArray   -- an array of strings returned by tor
// For GetConf calls, the aKey prefix is removed from the lineArray strings.
export const TorProtocolService = {
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
    lazy.TorMonitorService.clearBootstrapError();
    lazy.TorMonitorService.retrieveBootstrapStatus();
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
    lazy.TorMonitorService.retrieveBootstrapStatus();
  },

  async newnym() {
    return this.sendCommand("SIGNAL NEWNYM");
  },

  // Ask tor which ports it is listening to for SOCKS connections.
  // At the moment this is used only in TorCheckService.
  async getSocksListeners() {
    const cmd = "GETINFO";
    const keyword = "net/listeners/socks";
    const response = await this.sendCommand(cmd, keyword);
    return TorParsers.parseReply(cmd, keyword, response);
  },

  async getBridges() {
    // Ideally, we would not need this function, because we should be the one
    // setting them with TorSettings. However, TorSettings is not notified of
    // change of settings. So, asking tor directly with the control connection
    // is the most reliable way of getting the configured bridges, at the
    // moment. Also, we are using this for the circuit display, which should
    // work also when we are not configuring the tor daemon, but just using it.
    return this._withConnection(conn => {
      return conn.getConf("bridge");
    });
  },

  /**
   * Returns tha data about a relay or a bridge.
   *
   * @param {string} id The fingerprint of the node to get data about
   * @returns {NodeData}
   */
  async getNodeInfo(id) {
    return this._withConnection(async conn => {
      const node = {
        fingerprint: id,
        ipAddrs: [],
        bridgeType: null,
        regionCode: null,
      };
      const bridge = (await conn.getConf("bridge"))?.find(
        foundBridge => foundBridge.ID?.toUpperCase() === id.toUpperCase()
      );
      const addrRe = /^\[?([^\]]+)\]?:\d+$/;
      if (bridge) {
        node.bridgeType = bridge.type ?? "";
        // Attempt to get an IP address from bridge address string.
        const ip = bridge.address.match(addrRe)?.[1];
        if (ip && !ip.startsWith("0.")) {
          node.ipAddrs.push(ip);
        }
      } else {
        // Either dealing with a relay, or a bridge whose fingerprint is not
        // saved in torrc.
        const info = await conn.getInfo(`ns/id/${id}`);
        if (info.IP && !info.IP.startsWith("0.")) {
          node.ipAddrs.push(info.IP);
        }
        const ip6 = info.IPv6?.match(addrRe)?.[1];
        if (ip6) {
          node.ipAddrs.push(ip6);
        }
      }
      if (node.ipAddrs.length) {
        // Get the country code for the node's IP address.
        let regionCode;
        try {
          // Expect a 2-letter ISO3166-1 code, which should also be a valid
          // BCP47 Region subtag.
          regionCode = await conn.getInfo("ip-to-country/" + node.ipAddrs[0]);
        } catch {}
        if (regionCode && regionCode !== "??") {
          node.regionCode = regionCode.toUpperCase();
        }
      }
      return node;
    });
  },

  async onionAuthAdd(hsAddress, b64PrivateKey, isPermanent) {
    return this._withConnection(conn => {
      return conn.onionAuthAdd(hsAddress, b64PrivateKey, isPermanent);
    });
  },

  async onionAuthRemove(hsAddress) {
    return this._withConnection(conn => {
      return conn.onionAuthRemove(hsAddress);
    });
  },

  async onionAuthViewKeys() {
    return this._withConnection(conn => {
      return conn.onionAuthViewKeys();
    });
  },

  // TODO: transform the following 4 functions in getters. At the moment they
  // are also used in torbutton.

  // Returns Tor password string or null if an error occurs.
  torGetPassword() {
    return this._controlPassword;
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

  get torControlPortInfo() {
    const info = {
      password: this._controlPassword,
    };
    if (this._controlIPCFile) {
      info.ipcFile = this._controlIPCFile?.clone();
    }
    if (this._controlPort) {
      info.host = this._controlHost;
      info.port = this._controlPort;
    }
    return info;
  },

  get torSOCKSPortInfo() {
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
      // Determine how Tor Launcher will connect to the Tor control port.
      // Environment variables get top priority followed by preferences.
      if (!isWindows && Services.env.exists("TOR_CONTROL_IPC_PATH")) {
        const ipcPath = Services.env.get("TOR_CONTROL_IPC_PATH");
        this._controlIPCFile = new lazy.FileUtils.File(ipcPath);
      } else {
        // Check for TCP host and port environment variables.
        if (Services.env.exists("TOR_CONTROL_HOST")) {
          this._controlHost = Services.env.get("TOR_CONTROL_HOST");
        }
        if (Services.env.exists("TOR_CONTROL_PORT")) {
          this._controlPort = parseInt(
            Services.env.get("TOR_CONTROL_PORT"),
            10
          );
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
      if (Services.env.exists("TOR_CONTROL_PASSWD")) {
        this._controlPassword = Services.env.get("TOR_CONTROL_PASSWD");
      } else if (Services.env.exists("TOR_CONTROL_COOKIE_AUTH_FILE")) {
        // TODO: test this code path (TOR_CONTROL_COOKIE_AUTH_FILE).
        const cookiePath = Services.env.get("TOR_CONTROL_COOKIE_AUTH_FILE");
        if (cookiePath) {
          this._controlPassword = await this._readAuthenticationCookie(
            cookiePath
          );
        }
      }
      if (!this._controlPassword) {
        this._controlPassword = this._generateRandomPassword();
      }

      this._SOCKSPortInfo = TorLauncherUtil.getPreferredSocksConfiguration();
      TorLauncherUtil.setProxyConfiguration(this._SOCKSPortInfo);

      // Set the global control port info parameters.
      // These values may be overwritten by torbutton when it initializes, but
      // torbutton's values *should* be identical.
      lazy.configureControlPortModule(
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
    return TorParsers.parseReply(cmd, aSetting, reply);
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
      this._controlConnection = await lazy.controller(avoidCache);
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

  async _withConnection(func) {
    // TODO: Make more robust?
    const conn = await this._getConnection();
    try {
      return await func(conn);
    } finally {
      this._returnConnection();
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

  _toHex(aValue, aMinLen) {
    return aValue.toString(16).padStart(aMinLen, "0");
  },
};
