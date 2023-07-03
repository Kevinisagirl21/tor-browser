// Copyright (c) 2022, The Tor Project, Inc.

import { clearTimeout, setTimeout } from "resource://gre/modules/Timer.sys.mjs";
import { ConsoleAPI } from "resource://gre/modules/Console.sys.mjs";

import {
  TorParsers,
  TorStatuses,
} from "resource://gre/modules/TorParsers.sys.mjs";
import { TorProcess } from "resource://gre/modules/TorProcess.sys.mjs";

import { TorLauncherUtil } from "resource://gre/modules/TorLauncherUtil.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  TorProtocolService: "resource://gre/modules/TorProtocolService.sys.mjs",
});

ChromeUtils.defineModuleGetter(
  lazy,
  "controller",
  "resource://torbutton/modules/tor-control-port.js"
);

ChromeUtils.defineESModuleGetters(lazy, {
  TorProtocolService: "resource://gre/modules/TorProtocolService.sys.mjs",
});

const logger = new ConsoleAPI({
  maxLogLevel: "warn",
  maxLogLevelPref: "browser.tor_monitor_service.log_level",
  prefix: "TorMonitorService",
});

const Preferences = Object.freeze({
  PromptAtStartup: "extensions.torlauncher.prompt_at_startup",
});

const TorTopics = Object.freeze({
  BootstrapError: "TorBootstrapError",
  HasWarnOrErr: "TorLogHasWarnOrErr",
  ProcessExited: "TorProcessExited",
  ProcessIsReady: "TorProcessIsReady",
  ProcessRestarted: "TorProcessRestarted",
});

export const TorMonitorTopics = Object.freeze({
  BridgeChanged: "TorBridgeChanged",
  StreamSucceeded: "TorStreamSucceeded",
});

const ControlConnTimings = Object.freeze({
  initialDelayMS: 25, // Wait 25ms after the process has started, before trying to connect
  maxRetryMS: 10000, // Retry at most every 10 seconds
  timeoutMS: 5 * 60 * 1000, // Wait at most 5 minutes for tor to start
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
 * This service monitors an existing Tor instance, or starts one, if needed, and
 * then starts monitoring it.
 *
 * This is the service which should be queried to know information about the
 * status of the bootstrap, the logs, etc...
 */
export const TorMonitorService = {
  _connection: null,
  _eventHandlers: {},
  _torLog: [], // Array of objects with date, type, and msg properties.
  _startTimeout: null,

  _isBootstrapDone: false,
  _lastWarningPhase: null,
  _lastWarningReason: null,

  _torProcess: null,

  _inited: false,

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
  _circuits: new Map(),
  /**
   * The last used bridge, or null if bridges are not in use or if it was not
   * possible to detect the bridge. This needs the user to have specified bridge
   * lines with fingerprints to work.
   *
   * @type {NodeFingerprint?}
   */
  _currentBridge: null,

  // Public methods

  // Starts Tor, if needed, and starts monitoring for events
  init() {
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
  },

  // Closes the connection that monitors for events.
  // When Tor is started by Tor Browser, it is configured to exit when the
  // control connection is closed. Therefore, as a matter of facts, calling this
  // function also makes the child Tor instance stop.
  uninit() {
    if (this._torProcess) {
      this._torProcess.forget();
      this._torProcess.onExit = null;
      this._torProcess.onRestart = null;
      this._torProcess = null;
    }
    this._shutDownEventMonitor();
  },

  async retrieveBootstrapStatus() {
    if (!this._connection) {
      throw new Error("Event monitor connection not available");
    }

    // TODO: Unify with TorProtocolService.sendCommand and put everything in the
    // reviewed torbutton replacement.
    const cmd = "GETINFO";
    const key = "status/bootstrap-phase";
    let reply = await this._connection.sendCommand(`${cmd} ${key}`);
    if (!reply) {
      throw new Error("We received an empty reply");
    }
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
  },

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
  },

  // true if we launched and control tor, false if using system tor
  get ownsTorDaemon() {
    return TorLauncherUtil.shouldStartAndOwnTor;
  },

  get isBootstrapDone() {
    return this._isBootstrapDone;
  },

  clearBootstrapError() {
    this._lastWarningPhase = null;
    this._lastWarningReason = null;
  },

  get isRunning() {
    return !!this._connection;
  },

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
  },

  // Private methods

  async _startProcess() {
    // TorProcess should be instanced once, then always reused and restarted
    // only through the prompt it exposes when the controlled process dies.
    if (!this._torProcess) {
      this._torProcess = new TorProcess(
        lazy.TorProtocolService.torControlPortInfo,
        lazy.TorProtocolService.torSOCKSPortInfo
      );
      this._torProcess.onExit = () => {
        this._shutDownEventMonitor();
        Services.obs.notifyObservers(null, TorTopics.ProcessExited);
      };
      this._torProcess.onRestart = async () => {
        this._shutDownEventMonitor();
        await this._controlTor();
        Services.obs.notifyObservers(null, TorTopics.ProcessRestarted);
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
  },

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
        logger.info(`Notifying ${TorTopics.ProcessIsReady}`);
        Services.obs.notifyObservers(null, TorTopics.ProcessIsReady);

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
  },

  async _startEventMonitor() {
    if (this._connection) {
      return true;
    }

    let conn;
    try {
      const avoidCache = true;
      conn = await lazy.controller(avoidCache);
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
    let reply = await conn.sendCommand(
      "SETEVENTS " + Array.from(this._eventHandlers.keys()).join(" ")
    );
    reply = TorParsers.parseCommandResponse(reply);
    if (!TorParsers.commandSucceeded(reply)) {
      logger.error("SETEVENTS failed");
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
  },

  // Try to become the primary controller (TAKEOWNERSHIP).
  async _takeTorOwnership(conn) {
    const takeOwnership = "TAKEOWNERSHIP";
    let reply = await conn.sendCommand(takeOwnership);
    reply = TorParsers.parseCommandResponse(reply);
    if (!TorParsers.commandSucceeded(reply)) {
      logger.warn("Take ownership failed");
    } else {
      const resetConf = "RESETCONF __OwningControllerProcess";
      reply = await conn.sendCommand(resetConf);
      reply = TorParsers.parseCommandResponse(reply);
      if (!TorParsers.commandSucceeded(reply)) {
        logger.warn("Clear owning controller process failed");
      }
    }
  },

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
  },

  _processLog(type, lines) {
    if (type === "WARN" || type === "ERR") {
      // Notify so that Copy Log can be enabled.
      Services.obs.notifyObservers(null, TorTopics.HasWarnOrErr);
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
  },

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
  },

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
        TorTopics.BootstrapError
      );
    }
  },

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
        const nodeInfo = await lazy.TorProtocolService.getNodeInfo(nodes[0]);
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
            TorMonitorTopics.BridgeChanged,
            this._currentBridge
          );
        }
      }
    } else if (closedEvent) {
      this._circuits.delete(closedEvent.groups.ID);
    }
  },

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
  },

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
      TorMonitorTopics.StreamSucceeded
    );
  },

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
  },
};
