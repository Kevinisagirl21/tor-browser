// Copyright (c) 2021, The Tor Project, Inc.

"use strict";

var EXPORTED_SYMBOLS = [
  "TorProtocolService",
  "TorProcessStatus",
  "TorTopics",
  "TorBootstrapRequest",
];

const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");

const { setTimeout, clearTimeout } = ChromeUtils.import(
  "resource://gre/modules/Timer.jsm"
);

const { TorLauncherUtil } = ChromeUtils.import(
  "resource://torlauncher/modules/tl-util.jsm"
);

// see tl-process.js
const TorProcessStatus = Object.freeze({
  Unknown: 0,
  Starting: 1,
  Running: 2,
  Exited: 3,
});

/* tor-launcher observer topics */
const TorTopics = Object.freeze({
  BootstrapStatus: "TorBootstrapStatus",
  BootstrapError: "TorBootstrapError",
  ProcessExited: "TorProcessExited",
  LogHasWarnOrErr: "TorLogHasWarnOrErr",
});

/* Browser observer topis */
const BrowserTopics = Object.freeze({
  ProfileAfterChange: "profile-after-change",
});

var TorProtocolService = {
  _TorLauncherProtocolService: null,
  _TorProcessService: null,

  // maintain a map of tor settings set by Tor Browser so that we don't
  // repeatedly set the same key/values over and over
  // this map contains string keys to primitive or array values
  _settingsCache: new Map(),

  init() {
    Services.obs.addObserver(this, BrowserTopics.ProfileAfterChange);
  },

  observe(subject, topic, data) {
    if (topic === BrowserTopics.ProfileAfterChange) {
      // we have to delay init'ing this or else the crypto service inits too early without a profile
      // which breaks the password manager
      this._TorLauncherProtocolService = Cc[
        "@torproject.org/torlauncher-protocol-service;1"
      ].getService(Ci.nsISupports).wrappedJSObject;
      this._TorProcessService = Cc[
        "@torproject.org/torlauncher-process-service;1"
      ].getService(Ci.nsISupports).wrappedJSObject;
      Services.obs.removeObserver(this, topic);
    }
  },

  _typeof(aValue) {
    switch (typeof aValue) {
      case "boolean":
        return "boolean";
      case "string":
        return "string";
      case "object":
        if (aValue == null) {
          return "null";
        } else if (Array.isArray(aValue)) {
          return "array";
        }
        return "object";
    }
    return "unknown";
  },

  _assertValidSettingKey(aSetting) {
    // ensure the 'key' is a string
    if (typeof aSetting != "string") {
      throw new Error(
        `Expected setting of type string but received ${typeof aSetting}`
      );
    }
  },

  _assertValidSetting(aSetting, aValue) {
    this._assertValidSettingKey(aSetting);

    const valueType = this._typeof(aValue);
    switch (valueType) {
      case "boolean":
      case "string":
      case "null":
        return;
      case "array":
        for (const element of aValue) {
          if (typeof element != "string") {
            throw new Error(
              `Setting '${aSetting}' array contains value of invalid type '${typeof element}'`
            );
          }
        }
        return;
      default:
        throw new Error(
          `Invalid object type received for setting '${aSetting}'`
        );
    }
  },

  // takes a Map containing tor settings
  // throws on error
  async writeSettings(aSettingsObj) {
    // only write settings that have changed
    let newSettings = new Map();
    for (const [setting, value] of aSettingsObj) {
      let saveSetting = false;

      // make sure we have valid data here
      this._assertValidSetting(setting, value);

      if (!this._settingsCache.has(setting)) {
        // no cached setting, so write
        saveSetting = true;
      } else {
        const cachedValue = this._settingsCache.get(setting);
        if (value != cachedValue) {
          // compare arrays member-wise
          if (Array.isArray(value) && Array.isArray(cachedValue)) {
            if (value.length != cachedValue.length) {
              saveSetting = true;
            } else {
              const arrayLength = value.length;
              for (let i = 0; i < arrayLength; ++i) {
                if (value[i] != cachedValue[i]) {
                  saveSetting = true;
                  break;
                }
              }
            }
          } else {
            // some other different values
            saveSetting = true;
          }
        }
      }

      if (saveSetting) {
        newSettings.set(setting, value);
      }
    }

    // only write if new setting to save
    if (newSettings.size > 0) {
      // convert settingsObject map to js object for torlauncher-protocol-service
      let settingsObject = {};
      for (const [setting, value] of newSettings) {
        settingsObject[setting] = value;
      }

      let errorObject = {};
      if (
        !(await this._TorLauncherProtocolService.TorSetConfWithReply(
          settingsObject,
          errorObject
        ))
      ) {
        throw new Error(errorObject.details);
      }

      // save settings to cache after successfully writing to Tor
      for (const [setting, value] of newSettings) {
        this._settingsCache.set(setting, value);
      }
    }
  },

  async _readSetting(aSetting) {
    this._assertValidSettingKey(aSetting);
    let reply = await this._TorLauncherProtocolService.TorGetConf(aSetting);
    if (this._TorLauncherProtocolService.TorCommandSucceeded(reply)) {
      return reply.lineArray;
    }
    throw new Error(reply.lineArray.join("\n"));
  },

  async _readBoolSetting(aSetting) {
    let lineArray = await this._readSetting(aSetting);
    if (lineArray.length != 1) {
      throw new Error(
        `Expected an array with length 1 but received array of length ${lineArray.length}`
      );
    }

    let retval = lineArray[0];
    switch (retval) {
      case "0":
        return false;
      case "1":
        return true;
      default:
        throw new Error(`Expected boolean (1 or 0) but received '${retval}'`);
    }
  },

  async _readStringSetting(aSetting) {
    let lineArray = await this._readSetting(aSetting);
    if (lineArray.length != 1) {
      throw new Error(
        `Expected an array with length 1 but received array of length ${lineArray.length}`
      );
    }
    return lineArray[0];
  },

  async _readStringArraySetting(aSetting) {
    let lineArray = await this._readSetting(aSetting);
    return lineArray;
  },

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

  async readStringArraySetting(aSetting) {
    let value = await this._readStringArraySetting(aSetting);
    this._settingsCache.set(aSetting, value);
    return value;
  },

  // writes current tor settings to disk
  async flushSettings() {
    await this.sendCommand("SAVECONF");
  },

  getLog(countObj) {
    countObj = countObj || { value: 0 };
    let torLog = this._TorLauncherProtocolService.TorGetLog(countObj);
    return torLog;
  },

  // true if we launched and control tor, false if using system tor
  get ownsTorDaemon() {
    return TorLauncherUtil.shouldStartAndOwnTor;
  },

  // Assumes `ownsTorDaemon` is true
  isNetworkDisabled() {
    const reply = TorProtocolService._TorLauncherProtocolService.TorGetConfBool(
      "DisableNetwork",
      true
    );
    if (
      TorProtocolService._TorLauncherProtocolService.TorCommandSucceeded(reply)
    ) {
      return reply.retVal;
    }
    return true;
  },

  async enableNetwork() {
    let settings = {};
    settings.DisableNetwork = false;
    let errorObject = {};
    if (
      !(await this._TorLauncherProtocolService.TorSetConfWithReply(
        settings,
        errorObject
      ))
    ) {
      throw new Error(errorObject.details);
    }
  },

  async sendCommand(cmd) {
    return this._TorLauncherProtocolService.TorSendCommand(cmd);
  },

  retrieveBootstrapStatus() {
    return this._TorLauncherProtocolService.TorRetrieveBootstrapStatus();
  },

  _GetSaveSettingsErrorMessage(aDetails) {
    try {
      return TorLauncherUtil.getSaveSettingsErrorMessage(aDetails);
    } catch (e) {
      console.log("GetSaveSettingsErrorMessage error", e);
      return "Unexpected Error";
    }
  },

  async setConfWithReply(settings) {
    let result = false;
    const error = {};
    try {
      result = await this._TorLauncherProtocolService.TorSetConfWithReply(
        settings,
        error
      );
    } catch (e) {
      console.log("TorSetConfWithReply error", e);
      error.details = this._GetSaveSettingsErrorMessage(e.message);
    }
    return { result, error };
  },

  isBootstrapDone() {
    return this._TorProcessService.mIsBootstrapDone;
  },

  clearBootstrapError() {
    return this._TorProcessService.TorClearBootstrapError();
  },

  torBootstrapErrorOccurred() {
    return this._TorProcessService.TorBootstrapErrorOccurred;
  },

  _torBootstrapDebugSetError() {
    this._TorProcessService._TorSetBootstrapErrorForDebug();
  },

  // Resolves to null if ok, or an error otherwise
  async connect() {
    const kTorConfKeyDisableNetwork = "DisableNetwork";
    const settings = {};
    settings[kTorConfKeyDisableNetwork] = false;
    const { result, error } = await this.setConfWithReply(settings);
    if (!result) {
      return error;
    }
    try {
      await this.sendCommand("SAVECONF");
      this.clearBootstrapError();
      this.retrieveBootstrapStatus();
    } catch (e) {
      return error;
    }
    return null;
  },

  torLogHasWarnOrErr() {
    return this._TorLauncherProtocolService.TorLogHasWarnOrErr;
  },

  async torStopBootstrap() {
    // Tell tor to disable use of the network; this should stop the bootstrap
    // process.
    const kErrorPrefix = "Setting DisableNetwork=1 failed: ";
    try {
      let settings = {};
      settings.DisableNetwork = true;
      const { result, error } = await this.setConfWithReply(settings);
      if (!result) {
        console.log(
          `Error stopping bootstrap ${kErrorPrefix} ${error.details}`
        );
      }
    } catch (e) {
      console.log(`Error stopping bootstrap ${kErrorPrefix} ${e}`);
    }
    this.retrieveBootstrapStatus();
  },

  get torProcessStatus() {
    if (this._TorProcessService) {
      return this._TorProcessService.TorProcessStatus;
    }
    return TorProcessStatus.Unknown;
  },
};
TorProtocolService.init();

// modeled after XMLHttpRequest
// nicely encapsulates the observer register/unregister logic
class TorBootstrapRequest {
  constructor() {
    // number of ms to wait before we abandon the bootstrap attempt
    // a value of 0 implies we never wait
    this.timeout = 0;
    // callbacks for bootstrap process status updates
    this.onbootstrapstatus = (progress, status) => {};
    this.onbootstrapcomplete = () => {};
    this.onbootstraperror = (message, details) => {};

    // internal resolve() method for bootstrap
    this._bootstrapPromiseResolve = null;
    this._bootstrapPromise = null;
    this._timeoutID = null;
  }

  async observe(subject, topic, data) {
    const obj = subject?.wrappedJSObject;
    switch (topic) {
      case TorTopics.BootstrapStatus: {
        const progress = obj.PROGRESS;
        const status = TorLauncherUtil.getLocalizedBootstrapStatus(obj, "TAG");
        if (this.onbootstrapstatus) {
          this.onbootstrapstatus(progress, status);
        }
        if (progress === 100) {
          if (this.onbootstrapcomplete) {
            this.onbootstrapcomplete();
          }
          this._bootstrapPromiseResolve(true);
          clearTimeout(this._timeoutID);
        }

        break;
      }
      case TorTopics.BootstrapError: {
        // first stop our bootstrap timeout before handling the error
        clearTimeout(this._timeoutID);

        await TorProtocolService.torStopBootstrap();

        const message = obj.message;
        const details = obj.details;
        if (this.onbootstraperror) {
          this.onbootstraperror(message, details);
        }
        this._bootstrapPromiseResolve(false);
        break;
      }
    }
  }

  // resolves 'true' if bootstrap succeeds, false otherwise
  bootstrap() {
    if (this._bootstrapPromise) {
      return this._bootstrapPromise;
    }

    this._bootstrapPromise = new Promise((resolve, reject) => {
      this._bootstrapPromiseResolve = resolve;

      // register ourselves to listen for bootstrap events
      Services.obs.addObserver(this, TorTopics.BootstrapStatus);
      Services.obs.addObserver(this, TorTopics.BootstrapError);

      // optionally cancel bootstrap after a given timeout
      if (this.timeout > 0) {
        this._timeoutID = setTimeout(async () => {
          await TorProtocolService.torStopBootstrap();
          if (this.onbootstraperror) {
            this.onbootstraperror(
              "Tor Bootstrap process timed out",
              `Bootstrap attempt abandoned after waiting ${this.timeout} ms`
            );
          }
          this._bootstrapPromiseResolve(false);
        }, this.timeout);
      }

      // wait for bootstrapping to begin and maybe handle error
      TorProtocolService.connect()
        .then(async err => {
          if (!err) {
            return;
          }

          clearTimeout(this._timeoutID);
          await TorProtocolService.torStopBootstrap();

          const message = err.message;
          const details = err.details;
          if (this.onbootstraperror) {
            this.onbootstraperror(message, details);
          }
          this._bootstrapPromiseResolve(false);
        })
        .catch(err => {
          // Currently, TorProtocolService.connect() should never throw
          reject(err);
        });
    }).finally(() => {
      // and remove ourselves once bootstrap is resolved
      Services.obs.removeObserver(this, TorTopics.BootstrapStatus);
      Services.obs.removeObserver(this, TorTopics.BootstrapError);
    });

    return this._bootstrapPromise;
  }

  async cancel() {
    clearTimeout(this._timeoutID);

    await TorProtocolService.torStopBootstrap();

    this._bootstrapPromiseResolve(false);
  }
}
