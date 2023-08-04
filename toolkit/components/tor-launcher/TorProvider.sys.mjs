/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

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
  maxLogLevelPref: "browser.tor_provider.log_level",
  prefix: "TorProvider",
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
export class TorProvider {
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
    const entries =
      aSettingsObj instanceof Map
        ? Array.from(aSettingsObj.entries())
        : Object.entries(aSettingsObj);
    // only write settings that have changed
    const newSettings = entries.filter(([setting, value]) => {
      if (!this.#settingsCache.has(setting)) {
        // no cached setting, so write
        return true;
      }

      const cachedValue = this.#settingsCache.get(setting);
      // Arrays are the only special case for which === could fail.
      // The other values we accept (strings, booleans, numbers, null and
      // undefined) work correctly with ===.
      if (Array.isArray(value) && Array.isArray(cachedValue)) {
        return (
          value.length !== cachedValue.length ||
          value.some((val, idx) => val !== cachedValue[idx])
        );
      }
      return value !== cachedValue;
    });

    // only write if new setting to save
    if (newSettings.length) {
      const conn = await this.#getConnection();
      await conn.setConf(Object.fromEntries(newSettings));

      // save settings to cache after successfully writing to Tor
      for (const [setting, value] of newSettings) {
        this.#settingsCache.set(setting, value);
      }
    }
  }

  // writes current tor settings to disk
  async flushSettings() {
    const conn = await this.#getConnection();
    await conn.flushSettings();
  }

  async connect() {
    const conn = await this.#getConnection();
    await conn.setNetworkEnabled(true);
    this.clearBootstrapError();
    this.retrieveBootstrapStatus();
  }

  async stopBootstrap() {
    // Tell tor to disable use of the network; this should stop the bootstrap
    // process.
    const conn = await this.#getConnection();
    await conn.setNetworkEnabled(false);
    // We are not interested in waiting for this, nor in **catching its error**,
    // so we do not await this. We just want to be notified when the bootstrap
    // status is actually updated through observers.
    this.retrieveBootstrapStatus();
  }

  async newnym() {
    const conn = await this.#getConnection();
    await conn.newnym();
  }

  // Ask tor which ports it is listening to for SOCKS connections.
  // At the moment this is used only in TorCheckService.
  async getSocksListeners() {
    const conn = await this.#getConnection();
    return conn.getSocksListeners();
  }

  async getBridges() {
    const conn = await this.#getConnection();
    // Ideally, we would not need this function, because we should be the one
    // setting them with TorSettings. However, TorSettings is not notified of
    // change of settings. So, asking tor directly with the control connection
    // is the most reliable way of getting the configured bridges, at the
    // moment. Also, we are using this for the circuit display, which should
    // work also when we are not configuring the tor daemon, but just using it.
    return conn.getBridges();
  }

  async getPluggableTransports() {
    const conn = await this.#getConnection();
    return conn.getPluggableTransports();
  }

  /**
   * Returns tha data about a relay or a bridge.
   *
   * @param {string} id The fingerprint of the node to get data about
   * @returns {Promise<NodeData>}
   */
  async getNodeInfo(id) {
    const conn = await this.#getConnection();
    const node = {
      fingerprint: id,
      ipAddrs: [],
      bridgeType: null,
      regionCode: null,
    };
    const bridge = (await conn.getBridges())?.find(
      foundBridge => foundBridge.id?.toUpperCase() === id.toUpperCase()
    );
    if (bridge) {
      node.bridgeType = bridge.transport ?? "";
      // Attempt to get an IP address from bridge address string.
      const ip = bridge.addr.match(/^\[?([^\]]+)\]?:\d+$/)?.[1];
      if (ip && !ip.startsWith("0.")) {
        node.ipAddrs.push(ip);
      }
    } else {
      node.ipAddrs = await conn.getNodeAddresses(id);
    }
    if (node.ipAddrs.length) {
      // Get the country code for the node's IP address.
      try {
        // Expect a 2-letter ISO3166-1 code, which should also be a valid
        // BCP47 Region subtag.
        const regionCode = await conn.getIPCountry(node.ipAddrs[0]);
        if (regionCode && regionCode !== "??") {
          node.regionCode = regionCode.toUpperCase();
        }
      } catch (e) {
        logger.warn(`Cannot get a country for IP ${node.ipAddrs[0]}`, e);
      }
    }
    return node;
  }

  async onionAuthAdd(address, b64PrivateKey, isPermanent) {
    const conn = await this.#getConnection();
    return conn.onionAuthAdd(address, b64PrivateKey, isPermanent);
  }

  async onionAuthRemove(address) {
    const conn = await this.#getConnection();
    return conn.onionAuthRemove(address);
  }

  async onionAuthViewKeys() {
    const conn = await this.#getConnection();
    return conn.onionAuthViewKeys();
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

  async #getConnection() {
    if (!this.#controlConnection?.isOpen) {
      this.#controlConnection = await lazy.controller();
    }
    return this.#controlConnection;
  }

  #closeConnection() {
    if (this.#controlConnection) {
      logger.info("Closing the control connection");
      this.#controlConnection.close();
      this.#controlConnection = null;
    }
  }

  async #reconnect() {
    this.#closeConnection();
    await this.#getConnection();
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
      this._eventHandlers.set(
        "STATUS_CLIENT",
        this._processStatusClient.bind(this)
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

    this._processBootstrapStatus(
      await this._connection.getBootstrapPhase(),
      true
    );
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
    this._connection.watchEvent(type, line => {
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
    });
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
  _processBootstrapStatus(statusObj, suppressErrors) {
    // Notify observers
    Services.obs.notifyObservers(
      { wrappedJSObject: statusObj },
      "TorBootstrapStatus"
    );

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
      !suppressErrors
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

  _processStatusClient(_type, lines) {
    const statusObj = TorParsers.parseBootstrapStatus(lines[0]);
    if (!statusObj) {
      // No `BOOTSTRAP` in the line
      return;
    }
    this._processBootstrapStatus(statusObj, false);
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
