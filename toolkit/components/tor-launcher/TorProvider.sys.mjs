/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { setTimeout } from "resource://gre/modules/Timer.sys.mjs";
import { ConsoleAPI } from "resource://gre/modules/Console.sys.mjs";

import { TorLauncherUtil } from "resource://gre/modules/TorLauncherUtil.sys.mjs";
import {
  TorParsers,
  TorStatuses,
} from "resource://gre/modules/TorParsers.sys.mjs";
import { TorProviderTopics } from "resource://gre/modules/TorProviderBuilder.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  FileUtils: "resource://gre/modules/FileUtils.sys.mjs",
  TorController: "resource://gre/modules/TorControlPort.sys.mjs",
  TorProcess: "resource://gre/modules/TorProcess.sys.mjs",
});

const logger = new ConsoleAPI({
  maxLogLevel: "warn",
  maxLogLevelPref: "browser.tor_provider.log_level",
  prefix: "TorProvider",
});

/**
 * @typedef {object} ControlPortSettings An object with the settings to use for
 * the control port. All the entries are optional, but an authentication
 * mechanism and a communication method must be specified.
 * @property {string=} password The clear text password. It must always be
 * defined, unless cookieFilePath is
 * @property {string=} cookieFilePath The path to the cookie file to use for
 * authentication
 * @property {nsIFile=} ipcFile The nsIFile object with the path to a Unix
 * socket to use for control socket
 * @property {string=} host The host to connect for a TCP control port
 * @property {number=} port The port number to use for a TCP control port
 */
/**
 * @typedef {object} LogEntry An object with a log message
 * @property {Date} date The date at which we received the message
 * @property {string} type The message level
 * @property {string} msg The message
 */
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
  ControlUseIpc: "extensions.torlauncher.control_port_use_ipc",
  ControlHost: "extensions.torlauncher.control_host",
  ControlPort: "extensions.torlauncher.control_port",
  MaxLogEntries: "extensions.torlauncher.max_tor_log_entries",
  PromptAtStartup: "extensions.torlauncher.prompt_at_startup",
});

/**
 * This is a Tor provider for the C Tor daemon.
 *
 * It can start a new tor instance, or connect to an existing one.
 * In the former case, it also takes its ownership by default.
 */
export class TorProvider {
  /**
   * The control port settings.
   *
   * @type {ControlPortSettings?}
   */
  #controlPortSettings = null;
  /**
   * An instance of the tor controller.
   * We take for granted that if it is not null, we connected to it and managed
   * to authenticate.
   * Public methods can use the #controller getter, which will throw an
   * exception whenever the control port is not open.
   *
   * @type {TorController?}
   */
  #controlConnection = null;
  /**
   * A helper that can be used to get the control port connection and assert it
   * is open and it can be used.
   * If this is not the case, this getter will throw.
   *
   * @returns {TorController}
   */
  get #controller() {
    if (!this.#controlConnection?.isOpen) {
      throw new Error("Control port connection not available.");
    }
    return this.#controlConnection;
  }

  /**
   * The tor process we launched.
   *
   * @type {TorProcess}
   */
  #torProcess = null;

  /**
   * The logs we received over the control port.
   * We store a finite number of log entries which can be configured with
   * extensions.torlauncher.max_tor_log_entries.
   *
   * @type {LogEntry[]}
   */
  #logs = [];

  #isBootstrapDone = false;
  /**
   * Keep the last warning to avoid broadcasting an async warning if it is the
   * same one as the last broadcast.
   */
  #lastWarning = {};

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
  #circuits = new Map();
  /**
   * The last used bridge, or null if bridges are not in use or if it was not
   * possible to detect the bridge. This needs the user to have specified bridge
   * lines with fingerprints to work.
   *
   * @type {NodeFingerprint?}
   */
  #currentBridge = null;

  /**
   * Maintain a map of tor settings set by Tor Browser so that we don't
   * repeatedly set the same key/values over and over.
   * This map contains string keys to primitives or array values.
   *
   * @type {Map<string, any>}
   */
  #settingsCache = new Map();

  /**
   * Starts a new tor process and connect to its control port, or connect to the
   * control port of an existing tor daemon.
   */
  async init() {
    logger.debug("Initializing the Tor provider.");

    const socksSettings = TorLauncherUtil.getPreferredSocksConfiguration();
    logger.debug("Requested SOCKS configuration", socksSettings);

    try {
      await this.#setControlPortConfiguration();
    } catch (e) {
      logger.error("We do not have a control port configuration", e);
      throw e;
    }

    if (socksSettings.transproxy) {
      logger.info("Transparent proxy required, not starting a Tor daemon.");
    } else if (TorLauncherUtil.shouldStartAndOwnTor) {
      try {
        await this.#startDaemon(socksSettings);
      } catch (e) {
        logger.error("Failed to start the tor daemon", e);
        throw e;
      }
    } else {
      logger.debug(
        "Not starting a tor daemon because we were requested not to."
      );
    }

    try {
      await this.#firstConnection();
    } catch (e) {
      logger.error("Cannot connect to the control port", e);
      throw e;
    }

    // We do not customize SOCKS settings, at least for now.
    TorLauncherUtil.setProxyConfiguration(socksSettings);

    logger.info("The Tor provider is ready.");

    logger.debug(`Notifying ${TorProviderTopics.ProcessIsReady}`);
    Services.obs.notifyObservers(null, TorProviderTopics.ProcessIsReady);
  }

  /**
   * Close the connection to the tor daemon.
   * When Tor is started by Tor Browser, it is configured to exit when the
   * control connection is closed. Therefore, as a matter of facts, calling this
   * function also makes the child Tor instance stop.
   */
  uninit() {
    logger.debug("Uninitializing the Tor provider.");
    this.#forgetProcess();
    this.#closeConnection();
    this.#isBootstrapDone = false;
    this.#lastWarning = {};
  }

  // Provider API

  async writeSettings(settingsObj) {
    // TODO: Move the translation from settings object to settings understood by
    // tor here.
    const entries =
      settingsObj instanceof Map
        ? Array.from(settingsObj.entries())
        : Object.entries(settingsObj);
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
      await this.#controller.setConf(Object.fromEntries(newSettings));

      // save settings to cache after successfully writing to Tor
      for (const [setting, value] of newSettings) {
        this.#settingsCache.set(setting, value);
      }
    }
  }

  async flushSettings() {
    await this.#controller.flushSettings();
  }

  async connect() {
    await this.#controller.setNetworkEnabled(true);
    this.#lastWarning = {};
    this.retrieveBootstrapStatus();
  }

  async stopBootstrap() {
    // Tell tor to disable use of the network; this should stop the bootstrap.
    await this.#controller.setNetworkEnabled(false);
    // We are not interested in waiting for this, nor in **catching its error**,
    // so we do not await this. We just want to be notified when the bootstrap
    // status is actually updated through observers.
    this.retrieveBootstrapStatus();
  }

  async newnym() {
    await this.#controller.newnym();
  }

  async getBridges() {
    // Ideally, we would not need this function, because we should be the one
    // setting them with TorSettings. However, TorSettings is not notified of
    // change of settings. So, asking tor directly with the control connection
    // is the most reliable way of getting the configured bridges, at the
    // moment. Also, we are using this for the circuit display, which should
    // work also when we are not configuring the tor daemon, but just using it.
    return this.#controller.getBridges();
  }

  async getPluggableTransports() {
    return this.#controller.getPluggableTransports();
  }

  async retrieveBootstrapStatus() {
    this.#processBootstrapStatus(
      await this.#controller.getBootstrapPhase(),
      false
    );
  }

  /**
   * Returns tha data about a relay or a bridge.
   *
   * @param {string} id The fingerprint of the node to get data about
   * @returns {Promise<NodeData>}
   */
  async getNodeInfo(id) {
    const node = {
      fingerprint: id,
      ipAddrs: [],
      bridgeType: null,
      regionCode: null,
    };
    const bridge = (await this.#controller.getBridges())?.find(
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
      node.ipAddrs = await this.#controller.getNodeAddresses(id);
    }
    if (node.ipAddrs.length) {
      // Get the country code for the node's IP address.
      try {
        // Expect a 2-letter ISO3166-1 code, which should also be a valid
        // BCP47 Region subtag.
        const regionCode = await this.#controller.getIPCountry(node.ipAddrs[0]);
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
    return this.#controller.onionAuthAdd(address, b64PrivateKey, isPermanent);
  }

  async onionAuthRemove(address) {
    return this.#controller.onionAuthRemove(address);
  }

  async onionAuthViewKeys() {
    return this.#controller.onionAuthViewKeys();
  }

  /**
   * Returns captured log message as a text string (one message per line).
   */
  getLog() {
    return this.#logs
      .map(logObj => {
        const timeStr = logObj.date
          .toISOString()
          .replace("T", " ")
          .replace("Z", "");
        return `${timeStr} [${logObj.type}] ${logObj.msg}`;
      })
      .join(TorLauncherUtil.isWindows ? "\r\n" : "\n");
  }

  /**
   * @returns {boolean} true if we launched and control tor, false if we are
   * using system tor.
   */
  get ownsTorDaemon() {
    return TorLauncherUtil.shouldStartAndOwnTor;
  }

  get isBootstrapDone() {
    return this.#isBootstrapDone;
  }

  /**
   * TODO: Rename to isReady once we remove finish the migration.
   *
   * @returns {boolean} true if we currently have a connection to the control
   * port. We take for granted that if we have one, we authenticated to it, and
   * so we have already verified we can send and receive data.
   */
  get isRunning() {
    return this.#controlConnection?.isOpen ?? false;
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
    return this.#currentBridge;
  }

  // Process management

  async #startDaemon(socksSettings) {
    // TorProcess should be instanced once, then always reused and restarted
    // only through the prompt it exposes when the controlled process dies.
    if (this.#torProcess) {
      logger.warn(
        "Ignoring a request to start a tor daemon because one is already running."
      );
      return;
    }

    this.#torProcess = new lazy.TorProcess(
      this.#controlPortSettings,
      socksSettings
    );
    this.#torProcess.onExit = exitCode => {
      logger.info(`The tor process exited with code ${exitCode}`);
      this.#forgetProcess();
      this.#isBootstrapDone = false;
      this.#lastWarning = {};
      Services.obs.notifyObservers(null, TorProviderTopics.ProcessExited);
      this.#closeConnection();
    };
    this.#torProcess.onRestart = async () => {
      logger.info("Restarting the tor process");
      try {
        this.#controlConnection.close();
      } catch (e) {
        logger.warn(
          "Error when closing the previos control port on restart",
          e
        );
      }
      this.#isBootstrapDone = false;
      this.#lastWarning = {};
      this.#circuits.clear();
      try {
        await this.#firstConnection();
      } catch (e) {
        // TODO: How to make surface this?
        logger.error("Could not reconnect after restarting the tor daemon");
        return;
      }
      Services.obs.notifyObservers(null, TorProviderTopics.ProcessRestarted);
    };

    logger.debug("Trying to start the tor process.");
    await this.#torProcess.start();
    logger.info("Started a tor process");
  }

  #forgetProcess() {
    if (this.#torProcess) {
      logger.trace('"Forgetting" the tor process.');
      this.#torProcess.forget();
      this.#torProcess.onExit = null;
      this.#torProcess.onRestart = null;
      this.#torProcess = null;
    }
  }

  // Control port setup and connection

  async #setControlPortConfiguration() {
    logger.debug("Reading the control port configuration");
    const settings = {};

    const isWindows = Services.appinfo.OS === "WINNT";
    // Determine how Tor Launcher will connect to the Tor control port.
    // Environment variables get top priority followed by preferences.
    if (!isWindows && Services.env.exists("TOR_CONTROL_IPC_PATH")) {
      const ipcPath = Services.env.get("TOR_CONTROL_IPC_PATH");
      settings.ipcFile = new lazy.FileUtils.File(ipcPath);
    } else {
      // Check for TCP host and port environment variables.
      if (Services.env.exists("TOR_CONTROL_HOST")) {
        settings.host = Services.env.get("TOR_CONTROL_HOST");
      }
      if (Services.env.exists("TOR_CONTROL_PORT")) {
        const port = parseInt(Services.env.get("TOR_CONTROL_PORT"), 10);
        if (Number.isInteger(port) && port > 0 && port <= 65535) {
          settings.port = port;
        }
      }
    }

    const useIPC =
      !isWindows &&
      Services.prefs.getBoolPref(Preferences.ControlUseIpc, false);
    if (!settings.host && !settings.port && useIPC) {
      settings.ipcFile = TorLauncherUtil.getTorFile("control_ipc", false);
    } else {
      if (!settings.host) {
        settings.host = Services.prefs.getCharPref(
          Preferences.ControlHost,
          "127.0.0.1"
        );
      }
      if (!settings.port) {
        settings.port = Services.prefs.getIntPref(
          Preferences.ControlPort,
          9151
        );
      }
    }

    if (Services.env.exists("TOR_CONTROL_PASSWD")) {
      settings.password = Services.env.get("TOR_CONTROL_PASSWD");
    } else if (Services.env.exists("TOR_CONTROL_COOKIE_AUTH_FILE")) {
      const cookiePath = Services.env.get("TOR_CONTROL_COOKIE_AUTH_FILE");
      if (cookiePath) {
        settings.cookieFilePath = cookiePath;
      }
    }
    if (!settings.password && !settings.cookieFilePath) {
      settings.password = this.#generateRandomPassword();
    }
    this.#controlPortSettings = settings;
    logger.debug("Control port configuration read");
  }

  async #firstConnection() {
    // FIXME: No way to cancel this connection! Do we need one?
    const initialDelay = 5;
    const maxDelay = 10_000;
    let delay = initialDelay;
    logger.debug("Connecting to the control port for the first time.");
    await new Promise((resolve, reject) => {
      const tryConnect = () => {
        this.#openControlPort()
          .then(resolve)
          .catch(e => {
            if (delay < maxDelay) {
              logger.error(
                `Failed to connect to the control port. Trying again in ${delay}ms.`,
                e
              );
              setTimeout(tryConnect, delay);
              delay *= 2;
            } else {
              reject(e);
            }
          });
      };
      tryConnect();
    });
    logger.info("Connected to the control port.");
    if (this.ownsTorDaemon && !TorLauncherUtil.shouldOnlyConfigureTor) {
      this.#takeOwnership();
    }
    this.#setupEvents();
  }

  /**
   * Try to become the primary controller. This will make tor exit when our
   * connection is closed.
   */
  async #takeOwnership() {
    logger.debug("Taking the ownership of the tor process.");
    try {
      await this.#controlConnection.takeOwnership();
    } catch (e) {
      logger.warn("Take ownership failed", e);
      return;
    }
    try {
      await this.#controlConnection.resetOwningControllerProcess();
    } catch (e) {
      logger.warn("Clear owning controller process failed", e);
    }
  }

  async #setupEvents() {
    // We always liten to these events, because they are needed for the circuit
    // display.
    this.#eventHandlers = new Map([
      ["CIRC", this.#processCircEvent.bind(this)],
      ["STREAM", this.#processStreamEvent.bind(this)],
    ]);
    if (this.ownsTorDaemon) {
      // When we own the tor daemon, we listen to more events, that are used
      // for about:torconnect or for showing the logs in the settings page.
      this.#eventHandlers.set(
        "STATUS_CLIENT",
        this.#processStatusClient.bind(this)
      );
      this.#eventHandlers.set("NOTICE", this.#processLog.bind(this));
      this.#eventHandlers.set("WARN", this.#processLog.bind(this));
      this.#eventHandlers.set("ERR", this.#processLog.bind(this));
    }
    const events = Array.from(this.#eventHandlers.keys());
    try {
      logger.debug(`Setting events: ${events.join(" ")}`);
      await this.#controlConnection.setEvents(events);
    } catch (e) {
      logger.error(
        "We could not enable all the events we need. Tor Browser's functionalities might be reduced.",
        e
      );
      return;
    }
    for (const [type, callback] of this.#eventHandlers.entries()) {
      this.#monitorEvent(type, callback);
    }
  }

  async #openControlPort() {
    if (this.#controlConnection?.isOpen) {
      logger.warn(
        "Tried to open a control port connection when the previous one was already open"
      );
      return;
    }

    let controlPort;
    if (this.#controlPortSettings.ipcFile) {
      controlPort = lazy.TorController.fromIpcFile(
        this.#controlPortSettings.ipcFile
      );
    } else {
      controlPort = lazy.TorController.fromSocketAddress(
        this.#controlPortSettings.host,
        this.#controlPortSettings.port
      );
    }
    try {
      let password = this.#controlPortSettings.password;
      if (password === undefined && this.#controlPortSettings.cookieFilePath) {
        password = await this.#readAuthenticationCookie(
          this.#controlPortSettings.cookieFilePath
        );
      }
      await controlPort.authenticate(password);
    } catch (e) {
      try {
        controlPort.close();
      } catch (ec) {
        // Tor already closes the control port when the authentication fails.
        logger.debug(
          "Expected exception when closing the control port for a failed authentication",
          ec
        );
      }
      throw e;
    }
    this.#controlConnection = controlPort;
  }

  #closeConnection() {
    if (this.#controlConnection) {
      logger.info("Closing the control connection");
      try {
        this.#controlConnection.close();
      } catch (e) {
        logger.error("Failed to close the control port connection", e);
      }
      this.#controlConnection = null;
    }
  }

  // Authentication

  async #readAuthenticationCookie(path) {
    const bytes = await IOUtils.read(path);
    return Array.from(bytes, b => this.#toHex(b, 2)).join("");
  }

  /**
   * @returns {string} A random 16 character password, hex-encoded.
   */
  #generateRandomPassword() {
    // Similar to Vidalia's crypto_rand_string().
    const kPasswordLen = 16;
    const kMinCharCode = "!".charCodeAt(0);
    const kMaxCharCode = "~".charCodeAt(0);
    let pwd = "";
    for (let i = 0; i < kPasswordLen; ++i) {
      const val = this.#cryptoRandInt(kMaxCharCode - kMinCharCode + 1);
      if (val < 0) {
        logger.error("#cryptoRandInt() failed");
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

  // Notification handlers

  onBootstrapStatus(status) {
    this.#processBootstrapStatus(status, true);
  }

  /**
   * Process a bootstrap status to update the current state, and broadcast it
   * to TorBootstrapStatus observers.
   *
   * @param {object} statusObj The status object that the controller returned.
   * Its entries depend on what Tor sent to us.
   * @param {boolean} isNotification We broadcast warnings only when we receive
   * them through an asynchronous notification.
   */
  #processBootstrapStatus(statusObj, isNotification) {
    // Notify observers
    Services.obs.notifyObservers(
      { wrappedJSObject: statusObj },
      TorProviderTopics.BootstrapStatus
    );

    if (statusObj.PROGRESS === 100) {
      this.#isBootstrapDone = true;
      try {
        Services.prefs.setBoolPref(Preferences.PromptAtStartup, false);
      } catch (e) {
        logger.warn(`Cannot set ${Preferences.PromptAtStartup}`, e);
      }
      return;
    }

    this.#isBootstrapDone = false;

    if (
      isNotification &&
      statusObj.TYPE === "WARN" &&
      statusObj.RECOMMENDATION !== "ignore"
    ) {
      this.#notifyBootstrapError(statusObj);
    }
  }

  #notifyBootstrapError(statusObj) {
    try {
      Services.prefs.setBoolPref(Preferences.PromptAtStartup, true);
    } catch (e) {
      logger.warn(`Cannot set ${Preferences.PromptAtStartup}`, e);
    }
    // TODO: Move l10n to the above layers?
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
      statusObj.TAG !== this.#lastWarning.phase ||
      statusObj.REASON !== this.#lastWarning.reason
    ) {
      this.#lastWarning.phase = statusObj.TAG;
      this.#lastWarning.reason = statusObj.REASON;

      const message = TorLauncherUtil.getLocalizedString(
        "tor_bootstrap_failed"
      );
      Services.obs.notifyObservers(
        { message, details },
        TorProviderTopics.BootstrapError
      );
    }
  }

  onLogMessage(type, msg) {
    if (type === "WARN" || type === "ERR") {
      // Notify so that Copy Log can be enabled.
      Services.obs.notifyObservers(null, TorProviderTopics.HasWarnOrErr);
    }

    const date = new Date();
    const maxEntries = Services.prefs.getIntPref(
      Preferences.MaxLogEntries,
      1000
    );
    if (maxEntries > 0 && this.#logs.length >= maxEntries) {
      this.#logs.splice(0, 1);
    }

    this.#logs.push({ date, type, msg });
    switch (type) {
      case "ERR":
        logger.error(`[Tor error] ${msg}`);
        break;
      case "WARN":
        logger.warn(`[Tor warning] ${msg}`);
        break;
      default:
        logger.info(`[Tor ${type.toLowerCase()}] ${msg}`);
    }
  }

  async onCircuitBuilt(id, nodes) {
    this.#circuits.set(id, nodes);
    // Ignore circuits of length 1, that are used, for example, to probe
    // bridges. So, only store them, since we might see streams that use them,
    // but then early-return.
    if (nodes.length === 1) {
      return;
    }

    if (this.#currentBridge?.fingerprint !== nodes[0]) {
      const nodeInfo = await this.getNodeInfo(nodes[0]);
      let notify = false;
      if (nodeInfo?.bridgeType) {
        logger.info(`Bridge changed to ${nodes[0]}`);
        this.#currentBridge = nodeInfo;
        notify = true;
      } else if (this.#currentBridge) {
        logger.info("Bridges disabled");
        this.#currentBridge = null;
        notify = true;
      }
      if (notify) {
        Services.obs.notifyObservers(
          null,
          TorProviderTopics.BridgeChanged,
          this.#currentBridge
        );
      }
    }
  }

  onCircuitClosed(id) {
    logger.debug("Circuit closed event", id);
    this.#circuits.delete(id);
  }

  onStreamSucceeded(streamId, circuitId, username, password) {
    if (!username || !password) {
      return;
    }
    logger.debug("Stream succeeded event", username, password, circuitId);
    const circuit = this.#circuits.get(circuitId);
    if (!circuit) {
      logger.error(
        "Seen a STREAM SUCCEEDED with an unknown circuit. Not notifying observers."
      );
      return;
    }
    Services.obs.notifyObservers(
      {
        wrappedJSObject: {
          username,
          password,
          circuit,
        },
      },
      TorProviderTopics.StreamSucceeded
    );
  }

  // TODO: These are all parsing functions that should be moved to
  // TorControlPort.

  #eventHandlers = null;

  #monitorEvent(type, callback) {
    logger.info(`Watching events of type ${type}.`);
    let replyObj = {};
    this.#controlConnection.watchEvent(type, line => {
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

  #processStatusClient(_type, lines) {
    const statusObj = TorParsers.parseBootstrapStatus(lines[0]);
    if (!statusObj) {
      // No `BOOTSTRAP` in the line
      return;
    }
    this.onBootstrapStatus(statusObj);
  }

  #processLog(type, lines) {
    this.onLogMessage(type, lines.join("\n"));
  }

  async #processCircEvent(_type, lines) {
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
      // In some cases, we might already receive SOCKS credentials in the line.
      // However, this might be a problem with onion services: we get also a
      // 4-hop circuit that we likely do not want to show to the user,
      // especially because it is used only temporarily, and it would need a
      // technical explaination.
      // const credentials = this.#parseCredentials(lines[0]);
      this.onCircuitBuilt(builtEvent.groups.CircuitID, nodes);
    } else if (closedEvent) {
      this.onCircuitClosed(closedEvent.groups.ID);
    }
  }

  #processStreamEvent(_type, lines) {
    const succeeedEvent =
      /^(?<StreamID>[a-zA-Z0-9]){1,16}\sSUCCEEDED\s(?<CircuitID>[a-zA-Z0-9]{1,16})/.exec(
        lines[0]
      );
    if (!succeeedEvent) {
      return;
    }
    const credentials = this.#parseCredentials(lines[0]);
    if (credentials !== null) {
      this.onStreamSucceeded(
        succeeedEvent.groups.StreamID,
        succeeedEvent.groups.CircuitID,
        credentials.username,
        credentials.password
      );
    }
  }

  /**
   * Check if a STREAM or CIRC response line contains SOCKS_USERNAME and
   * SOCKS_PASSWORD.
   *
   * @param {string} line The circ or stream line to check
   * @returns {object?} The credentials, or null if not found
   */
  #parseCredentials(line) {
    const username = /SOCKS_USERNAME=("(?:[^"\\]|\\.)*")/.exec(line);
    const password = /SOCKS_PASSWORD=("(?:[^"\\]|\\.)*")/.exec(line);
    return username && password
      ? {
          username: TorParsers.unescapeString(username[1]),
          password: TorParsers.unescapeString(password[1]),
        }
      : null;
  }
}
