// Copyright (c) 2021, The Tor Project, Inc.

import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";
import { ConsoleAPI } from "resource://gre/modules/Console.sys.mjs";

import { TorLauncherUtil } from "resource://gre/modules/TorLauncherUtil.sys.mjs";
import {
  TorParsers,
  TorStatuses,
} from "resource://gre/modules/TorParsers.sys.mjs";
import { TorProviderTopics } from "resource://gre/modules/TorProviderBuilder.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  controller: "resource://gre/modules/TorControlPort.sys.mjs",
  configureControlPortModule: "resource://gre/modules/TorControlPort.sys.mjs",
  FileUtils: "resource://gre/modules/FileUtils.sys.mjs",
  TorProcess: "resource://gre/modules/TorProcess.sys.mjs",
});

const logger = new ConsoleAPI({
  maxLogLevel: "warn",
  prefix: "TorProtocolService",
});

/**
 * From control-spec.txt:
 *   CircuitID = 1*16 IDChar
 *   IDChar = ALPHA / DIGIT
 *   Currently, Tor only uses digits, but this may change.
 *
 * @typedef {string} CircuitID
 */
/**
 * The fingerprint of a node.
 * From control-spec.txt:
 *   Fingerprint = "$" 40*HEXDIG
 * However, we do not keep the $ in our structures.
 *
 * @typedef {string} NodeFingerprint
 */
/**
 * Stores the data associated with a circuit node.
 *
 * @typedef NodeData
 * @property {NodeFingerprint} fingerprint The node fingerprint.
 * @property {string[]} ipAddrs - The ip addresses associated with this node.
 * @property {string?} bridgeType - The bridge type for this node, or "" if the
 *   node is a bridge but the type is unknown, or null if this is not a bridge
 *   node.
 * @property {string?} regionCode - An upper case 2-letter ISO3166-1 code for
 *   the first ip address, or null if there is no region. This should also be a
 *   valid BCP47 Region subtag.
 */

const Preferences = Object.freeze({
  PromptAtStartup: "extensions.torlauncher.prompt_at_startup",
});

const ControlConnTimings = Object.freeze({
  initialDelayMS: 25, // Wait 25ms after the process has started, before trying to connect
  maxRetryMS: 10000, // Retry at most every 10 seconds
  timeoutMS: 5 * 60 * 1000, // Wait at most 5 minutes for tor to start
});

/**
 * This is a Tor provider for the C Tor daemon.
 *
 * It can start a new tor instance, or connect to an existing one.
 * In the former case, it also takes its ownership by default.
 */
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

    Services.obs.addObserver(this, TorProviderTopics.ProcessExited);
    Services.obs.addObserver(this, TorProviderTopics.ProcessRestarted);

    await this.#setSockets();

    this._monitorInit();

    logger.debug("TorProvider initialized");
  }

  uninit() {
    Services.obs.removeObserver(this, TorProviderTopics.ProcessExited);
    Services.obs.removeObserver(this, TorProviderTopics.ProcessRestarted);
    this.#closeConnection();
    this._monitorUninit();
  }

  observe(subject, topic, data) {
    if (topic === TorProviderTopics.ProcessExited) {
      this.#closeConnection();
    } else if (topic === TorProviderTopics.ProcessRestarted) {
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
    this.clearBootstrapError();
    this.retrieveBootstrapStatus();
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
    this.retrieveBootstrapStatus();
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
   * @returns {Promise<NodeData>}
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

  // Former TorMonitorService implementation.
  // FIXME: Refactor and integrate more with the rest of the class.

  _connection = null;
  _eventHandlers = {};
  _torLog = []; // Array of objects with date, type, and msg properties
  _startTimeout = null;

  _isBootstrapDone = false;
  _lastWarningPhase = null;
  _lastWarningReason = null;

  _torProcess = null;

  _inited = false;

  /**
   * Stores the nodes of a circuit. Keys are cicuit IDs, and values are the node
   * fingerprints.
   *
   * Theoretically, we could hook this map up to the new identity notification,
   * but in practice it does not work. Tor pre-builds circuits, and the NEWNYM
   * signal does not affect them. So, we might end up using a circuit that was
   * built before the new identity but not yet used. If we cleaned the map, we
   * risked of not having the data about it.
   *
   * @type {Map<CircuitID, NodeFingerprint[]>}
   */
  _circuits = new Map();
  /**
   * The last used bridge, or null if bridges are not in use or if it was not
   * possible to detect the bridge. This needs the user to have specified bridge
   * lines with fingerprints to work.
   *
   * @type {NodeFingerprint?}
   */
  _currentBridge = null;

  // Public methods

  // Starts Tor, if needed, and starts monitoring for events
  _monitorInit() {
    if (this._inited) {
      return;
    }
    this._inited = true;

    // We always liten to these events, because they are needed for the circuit
    // display.
    this._eventHandlers = new Map([
      ["CIRC", this._processCircEvent.bind(this)],
      ["STREAM", this._processStreamEvent.bind(this)],
    ]);

    if (this.ownsTorDaemon) {
      // When we own the tor daemon, we listen to more events, that are used
      // for about:torconnect or for showing the logs in the settings page.
      this._eventHandlers.set("STATUS_CLIENT", (_eventType, lines) =>
        this._processBootstrapStatus(lines[0], false)
      );
      this._eventHandlers.set("NOTICE", this._processLog.bind(this));
      this._eventHandlers.set("WARN", this._processLog.bind(this));
      this._eventHandlers.set("ERR", this._processLog.bind(this));
      this._controlTor();
    } else {
      this._startEventMonitor();
    }
    logger.info("TorMonitorService initialized");
  }

  // Closes the connection that monitors for events.
  // When Tor is started by Tor Browser, it is configured to exit when the
  // control connection is closed. Therefore, as a matter of facts, calling this
  // function also makes the child Tor instance stop.
  _monitorUninit() {
    if (this._torProcess) {
      this._torProcess.forget();
      this._torProcess.onExit = null;
      this._torProcess.onRestart = null;
      this._torProcess = null;
    }
    this._shutDownEventMonitor();
  }

  async retrieveBootstrapStatus() {
    if (!this._connection) {
      throw new Error("Event monitor connection not available");
    }

    // TODO: Unify with TorProtocolService.sendCommand and put everything in the
    // reviewed torbutton replacement.
    const cmd = "GETINFO";
    const key = "status/bootstrap-phase";
    let reply = await this._connection.sendCommand(`${cmd} ${key}`);

    // A typical reply looks like:
    //  250-status/bootstrap-phase=NOTICE BOOTSTRAP PROGRESS=100 TAG=done SUMMARY="Done"
    //  250 OK
    reply = TorParsers.parseCommandResponse(reply);
    if (!TorParsers.commandSucceeded(reply)) {
      throw new Error(`${cmd} failed`);
    }
    reply = TorParsers.parseReply(cmd, key, reply);
    if (reply.length) {
      this._processBootstrapStatus(reply[0], true);
    }
  }

  // Returns captured log message as a text string (one message per line).
  getLog() {
    return this._torLog
      .map(logObj => {
        const timeStr = logObj.date
          .toISOString()
          .replace("T", " ")
          .replace("Z", "");
        return `${timeStr} [${logObj.type}] ${logObj.msg}`;
      })
      .join(TorLauncherUtil.isWindows ? "\r\n" : "\n");
  }

  // true if we launched and control tor, false if using system tor
  get ownsTorDaemon() {
    return TorLauncherUtil.shouldStartAndOwnTor;
  }

  get isBootstrapDone() {
    return this._isBootstrapDone;
  }

  clearBootstrapError() {
    this._lastWarningPhase = null;
    this._lastWarningReason = null;
  }

  get isRunning() {
    return !!this._connection;
  }

  /**
   * Return the data about the current bridge, if any, or null.
   * We can detect bridge only when the configured bridge lines include the
   * fingerprints.
   *
   * @returns {NodeData?} The node information, or null if the first node
   * is not a bridge, or no circuit has been opened, yet.
   */
  get currentBridge() {
    return this._currentBridge;
  }

  // Private methods

  async _startProcess() {
    // TorProcess should be instanced once, then always reused and restarted
    // only through the prompt it exposes when the controlled process dies.
    if (!this._torProcess) {
      this._torProcess = new lazy.TorProcess(
        this.torControlPortInfo,
        this.torSOCKSPortInfo
      );
      this._torProcess.onExit = () => {
        this._shutDownEventMonitor();
        Services.obs.notifyObservers(null, TorProviderTopics.ProcessExited);
      };
      this._torProcess.onRestart = async () => {
        this._shutDownEventMonitor();
        await this._controlTor();
        Services.obs.notifyObservers(null, TorProviderTopics.ProcessRestarted);
      };
    }

    // Already running, but we did not start it
    if (this._torProcess.isRunning) {
      return false;
    }

    try {
      await this._torProcess.start();
      if (this._torProcess.isRunning) {
        logger.info("tor started");
        this._torProcessStartTime = Date.now();
      }
    } catch (e) {
      // TorProcess already logs the error.
      this._lastWarningPhase = "startup";
      this._lastWarningReason = e.toString();
    }
    return this._torProcess.isRunning;
  }

  async _controlTor() {
    if (!this._torProcess?.isRunning && !(await this._startProcess())) {
      logger.error("Tor not running, not starting to monitor it.");
      return;
    }

    let delayMS = ControlConnTimings.initialDelayMS;
    const callback = async () => {
      if (await this._startEventMonitor()) {
        this.retrieveBootstrapStatus().catch(e => {
          logger.warn("Could not get the initial bootstrap status", e);
        });

        // FIXME: TorProcess is misleading here. We should use a topic related
        // to having a control port connection, instead.
        logger.info(`Notifying ${TorProviderTopics.ProcessIsReady}`);
        Services.obs.notifyObservers(null, TorProviderTopics.ProcessIsReady);

        // We reset this here hoping that _shutDownEventMonitor can interrupt
        // the current monitor, either by calling clearTimeout and preventing it
        // from starting, or by closing the control port connection.
        if (this._startTimeout === null) {
          logger.warn("Someone else reset _startTimeout!");
        }
        this._startTimeout = null;
      } else if (
        Date.now() - this._torProcessStartTime >
        ControlConnTimings.timeoutMS
      ) {
        let s = TorLauncherUtil.getLocalizedString("tor_controlconn_failed");
        this._lastWarningPhase = "startup";
        this._lastWarningReason = s;
        logger.info(s);
        if (this._startTimeout === null) {
          logger.warn("Someone else reset _startTimeout!");
        }
        this._startTimeout = null;
      } else {
        delayMS *= 2;
        if (delayMS > ControlConnTimings.maxRetryMS) {
          delayMS = ControlConnTimings.maxRetryMS;
        }
        this._startTimeout = setTimeout(() => {
          logger.debug(`Control port not ready, waiting ${delayMS / 1000}s.`);
          callback();
        }, delayMS);
      }
    };
    // Check again, in the unfortunate case in which the execution was alrady
    // queued, but was waiting network code.
    if (this._startTimeout === null) {
      this._startTimeout = setTimeout(callback, delayMS);
    } else {
      logger.error("Possible race? Refusing to start the timeout again");
    }
  }

  async _startEventMonitor() {
    if (this._connection) {
      return true;
    }

    let conn;
    try {
      conn = await lazy.controller();
    } catch (e) {
      logger.error("Cannot open a control port connection", e);
      if (conn) {
        try {
          conn.close();
        } catch (e) {
          logger.error(
            "Also, the connection is not null but cannot be closed",
            e
          );
        }
      }
      return false;
    }

    // TODO: optionally monitor INFO and DEBUG log messages.
    try {
      await conn.setEvents(Array.from(this._eventHandlers.keys()));
    } catch (e) {
      logger.error("SETEVENTS failed", e);
      conn.close();
      return false;
    }

    if (this._torProcess) {
      this._torProcess.connectionWorked();
    }
    if (this.ownsTorDaemon && !TorLauncherUtil.shouldOnlyConfigureTor) {
      try {
        await this._takeTorOwnership(conn);
      } catch (e) {
        logger.warn("Could not take ownership of the Tor daemon", e);
      }
    }

    this._connection = conn;

    for (const [type, callback] of this._eventHandlers.entries()) {
      this._monitorEvent(type, callback);
    }

    // Populate the circuit map already, in case we are connecting to an
    // external tor daemon.
    try {
      const reply = await this._connection.sendCommand(
        "GETINFO circuit-status"
      );
      const lines = reply.split(/\r?\n/);
      if (lines.shift() === "250+circuit-status=") {
        for (const line of lines) {
          if (line === ".") {
            break;
          }
          // _processCircEvent processes only one line at a time
          this._processCircEvent("CIRC", [line]);
        }
      }
    } catch (e) {
      logger.warn("Could not populate the initial circuit map", e);
    }

    return true;
  }

  // Try to become the primary controller (TAKEOWNERSHIP).
  async _takeTorOwnership(conn) {
    try {
      conn.takeOwnership();
    } catch (e) {
      logger.warn("Take ownership failed", e);
      return;
    }
    try {
      conn.resetOwningControllerProcess();
    } catch (e) {
      logger.warn("Clear owning controller process failed", e);
    }
  }

  _monitorEvent(type, callback) {
    logger.info(`Watching events of type ${type}.`);
    let replyObj = {};
    this._connection.watchEvent(
      type,
      null,
      line => {
        if (!line) {
          return;
        }
        logger.debug("Event response: ", line);
        const isComplete = TorParsers.parseReplyLine(line, replyObj);
        if (!isComplete || replyObj._parseError || !replyObj.lineArray.length) {
          return;
        }
        const reply = replyObj;
        replyObj = {};
        if (reply.statusCode !== TorStatuses.EventNotification) {
          logger.error("Unexpected event status code:", reply.statusCode);
          return;
        }
        if (!reply.lineArray[0].startsWith(`${type} `)) {
          logger.error("Wrong format for the first line:", reply.lineArray[0]);
          return;
        }
        reply.lineArray[0] = reply.lineArray[0].substring(type.length + 1);
        try {
          callback(type, reply.lineArray);
        } catch (e) {
          logger.error("Exception while handling an event", reply, e);
        }
      },
      true
    );
  }

  _processLog(type, lines) {
    if (type === "WARN" || type === "ERR") {
      // Notify so that Copy Log can be enabled.
      Services.obs.notifyObservers(null, TorProviderTopics.HasWarnOrErr);
    }

    const date = new Date();
    const maxEntries = Services.prefs.getIntPref(
      "extensions.torlauncher.max_tor_log_entries",
      1000
    );
    if (maxEntries > 0 && this._torLog.length >= maxEntries) {
      this._torLog.splice(0, 1);
    }

    const msg = lines.join("\n");
    this._torLog.push({ date, type, msg });
    const logString = `Tor ${type}: ${msg}`;
    logger.info(logString);
  }

  // Process a bootstrap status to update the current state, and broadcast it
  // to TorBootstrapStatus observers.
  // If aSuppressErrors is true, errors are ignored. This is used when we
  // are handling the response to a "GETINFO status/bootstrap-phase" command.
  _processBootstrapStatus(aStatusMsg, aSuppressErrors) {
    const statusObj = TorParsers.parseBootstrapStatus(aStatusMsg);
    if (!statusObj) {
      return;
    }

    // Notify observers
    statusObj.wrappedJSObject = statusObj;
    Services.obs.notifyObservers(statusObj, "TorBootstrapStatus");

    if (statusObj.PROGRESS === 100) {
      this._isBootstrapDone = true;
      try {
        Services.prefs.setBoolPref(Preferences.PromptAtStartup, false);
      } catch (e) {
        logger.warn(`Cannot set ${Preferences.PromptAtStartup}`, e);
      }
      return;
    }

    this._isBootstrapDone = false;

    if (
      statusObj.TYPE === "WARN" &&
      statusObj.RECOMMENDATION !== "ignore" &&
      !aSuppressErrors
    ) {
      this._notifyBootstrapError(statusObj);
    }
  }

  _notifyBootstrapError(statusObj) {
    try {
      Services.prefs.setBoolPref(Preferences.PromptAtStartup, true);
    } catch (e) {
      logger.warn(`Cannot set ${Preferences.PromptAtStartup}`, e);
    }
    const phase = TorLauncherUtil.getLocalizedBootstrapStatus(statusObj, "TAG");
    const reason = TorLauncherUtil.getLocalizedBootstrapStatus(
      statusObj,
      "REASON"
    );
    const details = TorLauncherUtil.getFormattedLocalizedString(
      "tor_bootstrap_failed_details",
      [phase, reason],
      2
    );
    logger.error(
      `Tor bootstrap error: [${statusObj.TAG}/${statusObj.REASON}] ${details}`
    );

    if (
      statusObj.TAG !== this._lastWarningPhase ||
      statusObj.REASON !== this._lastWarningReason
    ) {
      this._lastWarningPhase = statusObj.TAG;
      this._lastWarningReason = statusObj.REASON;

      const message = TorLauncherUtil.getLocalizedString(
        "tor_bootstrap_failed"
      );
      Services.obs.notifyObservers(
        { message, details },
        TorProviderTopics.BootstrapError
      );
    }
  }

  async _processCircEvent(_type, lines) {
    const builtEvent =
      /^(?<CircuitID>[a-zA-Z0-9]{1,16})\sBUILT\s(?<Path>(?:,?\$[0-9a-fA-F]{40}(?:~[a-zA-Z0-9]{1,19})?)+)/.exec(
        lines[0]
      );
    const closedEvent = /^(?<ID>[a-zA-Z0-9]{1,16})\sCLOSED/.exec(lines[0]);
    if (builtEvent) {
      const fp = /\$([0-9a-fA-F]{40})/g;
      const nodes = Array.from(builtEvent.groups.Path.matchAll(fp), g =>
        g[1].toUpperCase()
      );
      this._circuits.set(builtEvent.groups.CircuitID, nodes);
      // Ignore circuits of length 1, that are used, for example, to probe
      // bridges. So, only store them, since we might see streams that use them,
      // but then early-return.
      if (nodes.length === 1) {
        return;
      }
      // In some cases, we might already receive SOCKS credentials in the line.
      // However, this might be a problem with onion services: we get also a
      // 4-hop circuit that we likely do not want to show to the user,
      // especially because it is used only temporarily, and it would need a
      // technical explaination.
      // this._checkCredentials(lines[0], nodes);
      if (this._currentBridge?.fingerprint !== nodes[0]) {
        const nodeInfo = await this.getNodeInfo(nodes[0]);
        let notify = false;
        if (nodeInfo?.bridgeType) {
          logger.info(`Bridge changed to ${nodes[0]}`);
          this._currentBridge = nodeInfo;
          notify = true;
        } else if (this._currentBridge) {
          logger.info("Bridges disabled");
          this._currentBridge = null;
          notify = true;
        }
        if (notify) {
          Services.obs.notifyObservers(
            null,
            TorProviderTopics.BridgeChanged,
            this._currentBridge
          );
        }
      }
    } else if (closedEvent) {
      this._circuits.delete(closedEvent.groups.ID);
    }
  }

  _processStreamEvent(_type, lines) {
    // The first block is the stream ID, which we do not need at the moment.
    const succeeedEvent =
      /^[a-zA-Z0-9]{1,16}\sSUCCEEDED\s(?<CircuitID>[a-zA-Z0-9]{1,16})/.exec(
        lines[0]
      );
    if (!succeeedEvent) {
      return;
    }
    const circuit = this._circuits.get(succeeedEvent.groups.CircuitID);
    if (!circuit) {
      logger.error(
        "Seen a STREAM SUCCEEDED with an unknown circuit. Not notifying observers.",
        lines[0]
      );
      return;
    }
    this._checkCredentials(lines[0], circuit);
  }

  /**
   * Check if a STREAM or CIRC response line contains SOCKS_USERNAME and
   * SOCKS_PASSWORD. In case, notify observers that we could associate a certain
   * circuit to these credentials.
   *
   * @param {string} line The circ or stream line to check
   * @param {NodeFingerprint[]} circuit The fingerprints of the nodes in the
   * circuit.
   */
  _checkCredentials(line, circuit) {
    const username = /SOCKS_USERNAME=("(?:[^"\\]|\\.)*")/.exec(line);
    const password = /SOCKS_PASSWORD=("(?:[^"\\]|\\.)*")/.exec(line);
    if (!username || !password) {
      return;
    }
    Services.obs.notifyObservers(
      {
        wrappedJSObject: {
          username: TorParsers.unescapeString(username[1]),
          password: TorParsers.unescapeString(password[1]),
          circuit,
        },
      },
      TorProviderTopics.StreamSucceeded
    );
  }

  _shutDownEventMonitor() {
    try {
      this._connection?.close();
    } catch (e) {
      logger.error("Could not close the connection to the control port", e);
    }
    this._connection = null;
    if (this._startTimeout !== null) {
      clearTimeout(this._startTimeout);
      this._startTimeout = null;
    }
    this._isBootstrapDone = false;
    this.clearBootstrapError();
  }
}

// TODO: Stop defining TorProtocolService, make the builder instance the
// TorProvider.
export const TorProtocolService = new TorProvider();
