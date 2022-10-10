// Copyright (c) 2022, The Tor Project, Inc.

"use strict";

var EXPORTED_SYMBOLS = ["TorMonitorService"];

const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");
const { setTimeout } = ChromeUtils.import("resource://gre/modules/Timer.jsm");
const { XPCOMUtils } = ChromeUtils.import(
  "resource://gre/modules/XPCOMUtils.jsm"
);

const { TorParsers, TorStatuses } = ChromeUtils.import(
  "resource://gre/modules/TorParsers.jsm"
);
const { TorProcess, TorProcessStatus } = ChromeUtils.import(
  "resource://gre/modules/TorProcess.jsm"
);

const { TorLauncherUtil } = ChromeUtils.import(
  "resource://gre/modules/TorLauncherUtil.jsm"
);
ChromeUtils.defineModuleGetter(
  this,
  "controller",
  "resource://torbutton/modules/tor-control-port.js"
);

// TODO: Write a helper to create these logs
XPCOMUtils.defineLazyGetter(this, "logger", () => {
  const { ConsoleAPI } = ChromeUtils.import(
    "resource://gre/modules/Console.jsm"
  );
  // TODO: Use a preference to set the log level.
  const consoleOptions = {
    // maxLogLevel: "warn",
    maxLogLevel: "all",
    prefix: "TorMonitorService",
  };
  return new ConsoleAPI(consoleOptions);
});

const Preferences = Object.freeze({
  PromptAtStartup: "extensions.torlauncher.prompt_at_startup",
});

const TorTopics = Object.freeze({
  BootstrapError: "TorBootstrapError",
  HasWarnOrErr: "TorLogHasWarnOrErr",
  ProcessDidNotStart: "TorProcessDidNotStart",
  ProcessExited: "TorProcessExited",
  ProcessIsReady: "TorProcessIsReady",
  ProcessRestarted: "TorProcessRestarted",
});

const ControlConnTimings = Object.freeze({
  initialDelayMS: 25, // Wait 25ms after the process has started, before trying to connect
  maxRetryMS: 10000, // Retry at most every 10 seconds
  timeoutMS: 5 * 60 * 1000, // Wait at most 5 minutes for tor to start
});

/**
 * This service monitors an existing Tor instance, or starts one, if needed, and
 * then starts monitoring it.
 *
 * This is the service which should be queried to know information about the
 * status of the bootstrap, the logs, etc...
 */
const TorMonitorService = {
  _connection: null,
  _eventsToMonitor: Object.freeze(["STATUS_CLIENT", "NOTICE", "WARN", "ERR"]),
  _torLog: [], // Array of objects with date, type, and msg properties.

  _isBootstrapDone: false,
  _bootstrapErrorOccurred: false,
  _lastWarningPhase: null,
  _lastWarningReason: null,

  _torProcess: null,

  _inited: false,

  // Public methods

  // Starts Tor, if needed, and starts monitoring for events
  init() {
    if (this._inited) {
      return;
    }
    this._inited = true;
    if (this.ownsTorDaemon) {
      this._controlTor();
    } else {
      logger.info(
        "Not starting the event monitor, as e do not own the Tor daemon."
      );
    }
    logger.debug("TorMonitorService initialized");
  },

  // Closes the connection that monitors for events.
  // When Tor is started by Tor Browser, it is configured to exit when the
  // control connection is closed. Therefore, as a matter of facts, calling this
  // function also makes the child Tor instance stop.
  uninit() {
    if (this._torProcess) {
      this._torProcess.forget();
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
    if (reply.lineArray) {
      this._processBootstrapStatus(reply.lineArray[0], true);
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

  get bootstrapErrorOccurred() {
    return this._bootstrapErrorOccurred;
  },

  clearBootstrapError() {
    this._bootstrapErrorOccurred = false;
    this._lastWarningPhase = null;
    this._lastWarningReason = null;
  },

  // This should be used for debug only
  setBootstrapError() {
    this._bootstrapErrorOccurred = true;
  },

  get isRunning() {
    return this.ownsTorDaemon
      ? !!this._torProcess?.isRunning
      : !!this._connection;
  },

  // Private methods

  async _startProcess() {
    this._torProcess = new TorProcess();
    this._torProcess.onExit = () => {
      Services.obs.notifyObservers(null, TorTopics.ProcessExited);
    };
    this._torProcess.onRestart = async () => {
      this._shutDownEventMonitor();
      await this._controlTor();
      Services.obs.notifyObservers(null, TorTopics.ProcessRestarted);
    };
    await this._torProcess.start();
    if (!this._torProcess.isRunning) {
      this._torProcess = null;
      return false;
    }
    logger.info("tor started");
    return true;
  },

  async _controlTor() {
    if (!this._torProcess && !(await this._startProcess())) {
      logger.error("Tor not running, not starting to monitor it.");
      return;
    }

    let delayMS = ControlConnTimings.initialDelayMS;
    const callback = async () => {
      if (await this._startEventMonitor()) {
        this._status = TorProcessStatus.Running;
        this.retrieveBootstrapStatus().catch(e => {
          logger.warn("Could not get the initial bootstrap status", e);
        });

        // FIXME: TorProcess is misleading here. We should use a topic related
        // to having a control port connection, instead.
        Services.obs.notifyObservers(null, TorTopics.ProcessIsReady);
      } else if (
        Date.now() - this._torProcessStartTime >
        ControlConnTimings.timeoutMS
      ) {
        let s = TorLauncherUtil.getLocalizedString("tor_controlconn_failed");
        TorLauncherUtil.notifyUserOfError(
          s,
          null,
          TorTopics.ProcessDidNotStart
        );
        logger.info(s);
      } else {
        delayMS *= 2;
        if (delayMS > ControlConnTimings.maxRetryMS) {
          delayMS = ControlConnTimings.maxRetryMS;
        }
        setTimeout(() => {
          logger.debug(`Control port not ready, waiting ${delayMS / 1000}s.`);
          callback();
        }, delayMS);
      }
    };
    setTimeout(callback, delayMS);
  },

  async _startEventMonitor() {
    if (this._connection) {
      return true;
    }

    let conn;
    try {
      const avoidCache = true;
      conn = await controller(avoidCache);
    } catch (e) {
      logger.error("Cannot open a control port connection", e);
      return false;
    }

    // TODO: optionally monitor INFO and DEBUG log messages.
    let reply = await conn.sendCommand(
      "SETEVENTS " + this._eventsToMonitor.join(" ")
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

    if (!TorLauncherUtil.shouldOnlyConfigureTor) {
      this._takeTorOwnership(conn);
    }

    this._connection = conn;
    this._waitForEventData();
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

  _waitForEventData() {
    if (!this._connection) {
      return;
    }
    logger.debug("Start watching events:", this._eventsToMonitor);
    let replyObj = {};
    for (const torEvent of this._eventsToMonitor) {
      this._connection.watchEvent(
        torEvent,
        null,
        line => {
          if (!line) {
            return;
          }
          logger.debug("Event response: ", line);
          const isComplete = TorParsers.parseReplyLine(line, replyObj);
          if (isComplete) {
            this._processEventReply(replyObj);
            replyObj = {};
          }
        },
        true
      );
    }
  },

  _processEventReply(aReply) {
    if (aReply._parseError || !aReply.lineArray.length) {
      return;
    }

    if (aReply.statusCode !== TorStatuses.EventNotification) {
      logger.warn("Unexpected event status code:", aReply.statusCode);
      return;
    }

    // TODO: do we need to handle multiple lines?
    const s = aReply.lineArray[0];
    const idx = s.indexOf(" ");
    if (idx === -1) {
      return;
    }
    const eventType = s.substring(0, idx);
    const msg = s.substring(idx + 1).trim();

    if (eventType === "STATUS_CLIENT") {
      this._processBootstrapStatus(msg, false);
      return;
    } else if (!this._eventsToMonitor.includes(eventType)) {
      logger.debug(`Dropping unlistened event ${eventType}`);
      return;
    }

    if (eventType === "WARN" || eventType === "ERR") {
      // Notify so that Copy Log can be enabled.
      Services.obs.notifyObservers(null, TorTopics.HasWarnOrErr);
    }

    const now = new Date();
    const maxEntries = Services.prefs.getIntPref(
      "extensions.torlauncher.max_tor_log_entries",
      1000
    );
    if (maxEntries > 0 && this._torLog.length >= maxEntries) {
      this._torLog.splice(0, 1);
    }
    this._torLog.push({ date: now, type: eventType, msg });
    const logString = `Tor ${eventType}: ${msg}`;
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
      this._bootstrapErrorOccurred = false;
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
    this._bootstrapErrorOccurred = true;
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

      const msg = TorLauncherUtil.getLocalizedString("tor_bootstrap_failed");
      TorLauncherUtil.notifyUserOfError(msg, details, TorTopics.BootstrapError);
    }
  },

  _shutDownEventMonitor() {
    if (this._connection) {
      this._connection.close();
      this._connection = null;
      this._eventMonitorInProgressReply = null;
      this._isBootstrapDone = false;
      this.clearBootstrapError();
    }
  },
};
