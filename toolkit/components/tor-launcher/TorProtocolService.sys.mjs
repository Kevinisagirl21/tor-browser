// Copyright (c) 2021, The Tor Project, Inc.

import { setTimeout } from "resource://gre/modules/Timer.sys.mjs";
import { ConsoleAPI } from "resource://gre/modules/Console.sys.mjs";

import { TorParsers } from "resource://gre/modules/TorParsers.sys.mjs";
import { TorLauncherUtil } from "resource://gre/modules/TorLauncherUtil.sys.mjs";

const lazy = {};

ChromeUtils.defineModuleGetter(
  lazy,
  "TorMonitorService",
  "resource://gre/modules/TorMonitorService.jsm"
);
ChromeUtils.defineESModuleGetters(lazy, {
  controller: "resource://gre/modules/TorControlPort.sys.mjs",
  configureControlPortModule: "resource://gre/modules/TorControlPort.sys.mjs",
  FileUtils: "resource://gre/modules/FileUtils.sys.mjs",
});

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
class TorProvider {
  #inited = false;

  // Maintain a map of tor settings set by Tor Browser so that we don't
  // repeatedly set the same key/values over and over.
  // This map contains string keys to primitives or array values.
  #settingsCache = new Map();

  #controlPort = null;
  #controlHost = null;
  #controlIPCFile = null; // An nsIFile if using IPC for control port.
  #controlPassword = null; // JS string that contains hex-encoded password.
  #SOCKSPortInfo = null; // An object that contains ipcFile, host, port.

  #controlConnection = null; // This is cached and reused.
  #connectionQueue = [];

  // Public methods

  async init() {
    if (this.#inited) {
      return;
    }
    this.#inited = true;

    Services.obs.addObserver(this, TorTopics.ProcessExited);
    Services.obs.addObserver(this, TorTopics.ProcessRestarted);

    await this.#setSockets();

    logger.debug("TorProtocolService initialized");
  }

  uninit() {
    Services.obs.removeObserver(this, TorTopics.ProcessExited);
    Services.obs.removeObserver(this, TorTopics.ProcessRestarted);
    this.#closeConnection();
  }

  observe(subject, topic, data) {
    if (topic === TorTopics.ProcessExited) {
      this.#closeConnection();
    } else if (topic === TorTopics.ProcessRestarted) {
      this.#reconnect();
    }
  }

  // takes a Map containing tor settings
  // throws on error
  async writeSettings(aSettingsObj) {
    // only write settings that have changed
    const newSettings = Array.from(aSettingsObj).filter(([setting, value]) => {
      // make sure we have valid data here
      this.#assertValidSetting(setting, value);

      if (!this.#settingsCache.has(setting)) {
        // no cached setting, so write
        return true;
      }

      const cachedValue = this.#settingsCache.get(setting);
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
        this.#settingsCache.set(setting, value);
      }
    }
  }

  async readStringArraySetting(aSetting) {
    const value = await this.#readSetting(aSetting);
    this.#settingsCache.set(aSetting, value);
    return value;
  }

  // writes current tor settings to disk
  async flushSettings() {
    await this.sendCommand("SAVECONF");
  }

  async connect() {
    const kTorConfKeyDisableNetwork = "DisableNetwork";
    const settings = {};
    settings[kTorConfKeyDisableNetwork] = false;
    await this.setConfWithReply(settings);
    await this.sendCommand("SAVECONF");
    lazy.TorMonitorService.clearBootstrapError();
    lazy.TorMonitorService.retrieveBootstrapStatus();
  }

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
  }

  async newnym() {
    return this.sendCommand("SIGNAL NEWNYM");
  }

  // Ask tor which ports it is listening to for SOCKS connections.
  // At the moment this is used only in TorCheckService.
  async getSocksListeners() {
    const cmd = "GETINFO";
    const keyword = "net/listeners/socks";
    const response = await this.sendCommand(cmd, keyword);
    return TorParsers.parseReply(cmd, keyword, response);
  }

  async getBridges() {
    // Ideally, we would not need this function, because we should be the one
    // setting them with TorSettings. However, TorSettings is not notified of
    // change of settings. So, asking tor directly with the control connection
    // is the most reliable way of getting the configured bridges, at the
    // moment. Also, we are using this for the circuit display, which should
    // work also when we are not configuring the tor daemon, but just using it.
    return this.#withConnection(conn => {
      return conn.getConf("bridge");
    });
  }

  /**
   * Returns tha data about a relay or a bridge.
   *
   * @param {string} id The fingerprint of the node to get data about
   * @returns {NodeData}
   */
  async getNodeInfo(id) {
    return this.#withConnection(async conn => {
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
  }

  async onionAuthAdd(hsAddress, b64PrivateKey, isPermanent) {
    return this.#withConnection(conn => {
      return conn.onionAuthAdd(hsAddress, b64PrivateKey, isPermanent);
    });
  }

  async onionAuthRemove(hsAddress) {
    return this.#withConnection(conn => {
      return conn.onionAuthRemove(hsAddress);
    });
  }

  async onionAuthViewKeys() {
    return this.#withConnection(conn => {
      return conn.onionAuthViewKeys();
    });
  }

  // TODO: transform the following 4 functions in getters.

  // Returns Tor password string or null if an error occurs.
  torGetPassword() {
    return this.#controlPassword;
  }

  torGetControlIPCFile() {
    return this.#controlIPCFile?.clone();
  }

  torGetControlPort() {
    return this.#controlPort;
  }

  torGetSOCKSPortInfo() {
    return this.#SOCKSPortInfo;
  }

  get torControlPortInfo() {
    const info = {
      password: this.#controlPassword,
    };
    if (this.#controlIPCFile) {
      info.ipcFile = this.#controlIPCFile?.clone();
    }
    if (this.#controlPort) {
      info.host = this.#controlHost;
      info.port = this.#controlPort;
    }
    return info;
  }

  get torSOCKSPortInfo() {
    return this.#SOCKSPortInfo;
  }

  // Public, but called only internally

  // Executes a command on the control port.
  // Return a reply object or null if a fatal error occurs.
  async sendCommand(cmd, args) {
    const maxTimeout = 1000;
    let leftConnAttempts = 5;
    let timeout = 250;
    let reply;
    while (leftConnAttempts-- > 0) {
      const response = await this.#trySend(cmd, args, leftConnAttempts === 0);
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
  }

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
  }

  // Public, never called?

  async readBoolSetting(aSetting) {
    let value = await this.#readBoolSetting(aSetting);
    this.#settingsCache.set(aSetting, value);
    return value;
  }

  async readStringSetting(aSetting) {
    let value = await this.#readStringSetting(aSetting);
    this.#settingsCache.set(aSetting, value);
    return value;
  }

  // Private

  async #setSockets() {
    try {
      const isWindows = TorLauncherUtil.isWindows;
      // Determine how Tor Launcher will connect to the Tor control port.
      // Environment variables get top priority followed by preferences.
      if (!isWindows && Services.env.exists("TOR_CONTROL_IPC_PATH")) {
        const ipcPath = Services.env.get("TOR_CONTROL_IPC_PATH");
        this.#controlIPCFile = new lazy.FileUtils.File(ipcPath);
      } else {
        // Check for TCP host and port environment variables.
        if (Services.env.exists("TOR_CONTROL_HOST")) {
          this.#controlHost = Services.env.get("TOR_CONTROL_HOST");
        }
        if (Services.env.exists("TOR_CONTROL_PORT")) {
          this.#controlPort = parseInt(
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
        if (!this.#controlHost && !this.#controlPort && useIPC) {
          this.#controlIPCFile = TorLauncherUtil.getTorFile(
            "control_ipc",
            false
          );
        } else {
          if (!this.#controlHost) {
            this.#controlHost = Services.prefs.getCharPref(
              "extensions.torlauncher.control_host",
              "127.0.0.1"
            );
          }
          if (!this.#controlPort) {
            this.#controlPort = Services.prefs.getIntPref(
              "extensions.torlauncher.control_port",
              9151
            );
          }
        }
      }

      // Populate _controlPassword so it is available when starting tor.
      if (Services.env.exists("TOR_CONTROL_PASSWD")) {
        this.#controlPassword = Services.env.get("TOR_CONTROL_PASSWD");
      } else if (Services.env.exists("TOR_CONTROL_COOKIE_AUTH_FILE")) {
        // TODO: test this code path (TOR_CONTROL_COOKIE_AUTH_FILE).
        const cookiePath = Services.env.get("TOR_CONTROL_COOKIE_AUTH_FILE");
        if (cookiePath) {
          this.#controlPassword = await this.#readAuthenticationCookie(
            cookiePath
          );
        }
      }
      if (!this.#controlPassword) {
        this.#controlPassword = this.#generateRandomPassword();
      }

      this.#SOCKSPortInfo = TorLauncherUtil.getPreferredSocksConfiguration();
      TorLauncherUtil.setProxyConfiguration(this.#SOCKSPortInfo);

      // Set the global control port info parameters.
      lazy.configureControlPortModule(
        this.#controlIPCFile,
        this.#controlHost,
        this.#controlPort,
        this.#controlPassword
      );
    } catch (e) {
      logger.error("Failed to get environment variables", e);
    }
  }

  #assertValidSettingKey(aSetting) {
    // ensure the 'key' is a string
    if (typeof aSetting !== "string") {
      throw new Error(
        `Expected setting of type string but received ${typeof aSetting}`
      );
    }
  }

  #assertValidSetting(aSetting, aValue) {
    this.#assertValidSettingKey(aSetting);
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
  }

  // Perform a GETCONF command.
  async #readSetting(aSetting) {
    this.#assertValidSettingKey(aSetting);

    const cmd = "GETCONF";
    let reply = await this.sendCommand(cmd, aSetting);
    return TorParsers.parseReply(cmd, aSetting, reply);
  }

  async #readStringSetting(aSetting) {
    let lineArray = await this.#readSetting(aSetting);
    if (lineArray.length !== 1) {
      throw new Error(
        `Expected an array with length 1 but received array of length ${lineArray.length}`
      );
    }
    return lineArray[0];
  }

  async #readBoolSetting(aSetting) {
    const value = this.#readStringSetting(aSetting);
    switch (value) {
      case "0":
        return false;
      case "1":
        return true;
      default:
        throw new Error(`Expected boolean (1 or 0) but received '${value}'`);
    }
  }

  async #trySend(cmd, args, rethrow) {
    let connected = false;
    let reply;
    let leftAttempts = 2;
    while (leftAttempts-- > 0) {
      let conn;
      try {
        conn = await this.#getConnection();
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
          this.#returnConnection();
        } else {
          // Connection is bad.
          logger.warn(
            "sendCommand returned an empty response, taking the connection as broken and closing it."
          );
          this.#closeConnection();
        }
      } catch (e) {
        logger.error(`Cannot send the command ${cmd}`, e);
        this.#closeConnection();
        if (leftAttempts == 0 && rethrow) {
          throw e;
        }
      }
    }
    return { connected, reply };
  }

  // Opens an authenticated connection, sets it to this.#controlConnection, and
  // return it.
  async #getConnection() {
    if (!this.#controlConnection) {
      this.#controlConnection = await lazy.controller();
    }
    if (this.#controlConnection.inUse) {
      await new Promise((resolve, reject) =>
        this.#connectionQueue.push({ resolve, reject })
      );
    } else {
      this.#controlConnection.inUse = true;
    }
    return this.#controlConnection;
  }

  #returnConnection() {
    if (this.#connectionQueue.length) {
      this.#connectionQueue.shift().resolve();
    } else {
      this.#controlConnection.inUse = false;
    }
  }

  async #withConnection(func) {
    // TODO: Make more robust?
    const conn = await this.#getConnection();
    try {
      return await func(conn);
    } finally {
      this.#returnConnection();
    }
  }

  // If aConn is omitted, the cached connection is closed.
  #closeConnection() {
    if (this.#controlConnection) {
      logger.info("Closing the control connection");
      this.#controlConnection.close();
      this.#controlConnection = null;
    }
    for (const promise of this.#connectionQueue) {
      promise.reject("Connection closed");
    }
    this.#connectionQueue = [];
  }

  async #reconnect() {
    this.#closeConnection();
    const conn = await this.#getConnection();
    logger.debug("Reconnected to the control port.");
    this.#returnConnection(conn);
  }

  async #readAuthenticationCookie(aPath) {
    const bytes = await IOUtils.read(aPath);
    return Array.from(bytes, b => this.#toHex(b, 2)).join("");
  }

  // Returns a random 16 character password, hex-encoded.
  #generateRandomPassword() {
    // Similar to Vidalia's crypto_rand_string().
    const kPasswordLen = 16;
    const kMinCharCode = "!".charCodeAt(0);
    const kMaxCharCode = "~".charCodeAt(0);
    let pwd = "";
    for (let i = 0; i < kPasswordLen; ++i) {
      const val = this.#cryptoRandInt(kMaxCharCode - kMinCharCode + 1);
      if (val < 0) {
        logger.error("_cryptoRandInt() failed");
        return null;
      }
      pwd += this.#toHex(kMinCharCode + val, 2);
    }

    return pwd;
  }

  // Returns -1 upon failure.
  #cryptoRandInt(aMax) {
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
  }

  #toHex(aValue, aMinLen) {
    return aValue.toString(16).padStart(aMinLen, "0");
  }
}

export const TorProtocolService = new TorProvider();
