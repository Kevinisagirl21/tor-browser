// Copyright (c) 2021, The Tor Project, Inc.

"use strict";

var EXPORTED_SYMBOLS = ["TorProtocolService", "TorProcessStatus"];

const { Services } = ChromeUtils.import(
    "resource://gre/modules/Services.jsm"
);

// see tl-process.js
const TorProcessStatus = Object.freeze({
  Unknown: 0,
  Starting: 1,
  Running: 2,
  Exited: 3,
});

/* Browser observer topis */
const BrowserTopics = Object.freeze({
    ProfileAfterChange: "profile-after-change",
});

var TorProtocolService = {
  _TorLauncherUtil: function() {
      let { TorLauncherUtil } = ChromeUtils.import(
        "resource://torlauncher/modules/tl-util.jsm"
      );
      return TorLauncherUtil;
    }(),
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
      this._TorLauncherProtocolService = Cc["@torproject.org/torlauncher-protocol-service;1"].getService(
        Ci.nsISupports
      ).wrappedJSObject;
      this._TorProcessService = Cc["@torproject.org/torlauncher-process-service;1"].getService(
        Ci.nsISupports
      ).wrappedJSObject,

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
  writeSettings(aSettingsObj) {
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
      if (!this._TorLauncherProtocolService.TorSetConfWithReply(settingsObject, errorObject)) {
        throw new Error(errorObject.details);
      }

      // save settings to cache after successfully writing to Tor
      for (const [setting, value] of newSettings) {
        this._settingsCache.set(setting, value);
      }
    }
  },

  _readSetting(aSetting) {
    this._assertValidSettingKey(aSetting);
    let reply = this._TorLauncherProtocolService.TorGetConf(aSetting);
    if (this._TorLauncherProtocolService.TorCommandSucceeded(reply)) {
      return reply.lineArray;
    }
    throw new Error(reply.lineArray.join("\n"));
  },

  _readBoolSetting(aSetting) {
    let lineArray = this._readSetting(aSetting);
    if (lineArray.length != 1) {
      throw new Error(
        `Expected an array with length 1 but received array of length ${
          lineArray.length
        }`
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

  _readStringSetting(aSetting) {
    let lineArray = this._readSetting(aSetting);
    if (lineArray.length != 1) {
      throw new Error(
        `Expected an array with length 1 but received array of length ${
          lineArray.length
        }`
      );
    }
    return lineArray[0];
  },

  _readStringArraySetting(aSetting) {
    let lineArray = this._readSetting(aSetting);
    return lineArray;
  },

  readBoolSetting(aSetting) {
    let value = this._readBoolSetting(aSetting);
    this._settingsCache.set(aSetting, value);
    return value;
  },

  readStringSetting(aSetting) {
    let value = this._readStringSetting(aSetting);
    this._settingsCache.set(aSetting, value);
    return value;
  },

  readStringArraySetting(aSetting) {
    let value = this._readStringArraySetting(aSetting);
    this._settingsCache.set(aSetting, value);
    return value;
  },

  // writes current tor settings to disk
  flushSettings() {
    this.sendCommand("SAVECONF");
  },

  getLog(countObj) {
    countObj = countObj || { value: 0 };
    let torLog = this._TorLauncherProtocolService.TorGetLog(countObj);
    return torLog;
  },

  // true if we launched and control tor, false if using system tor
  get ownsTorDaemon() {
    return this._TorLauncherUtil.shouldStartAndOwnTor;
  },

  // Assumes `ownsTorDaemon` is true
  isNetworkDisabled() {
    const reply = TorProtocolService._TorLauncherProtocolService.TorGetConfBool(
      "DisableNetwork",
      true
    );
    if (TorProtocolService._TorLauncherProtocolService.TorCommandSucceeded(reply)) {
      return reply.retVal;
    }
    return true;
  },

  enableNetwork() {
    let settings = {};
    settings.DisableNetwork = false;
    let errorObject = {};
    if (!this._TorLauncherProtocolService.TorSetConfWithReply(settings, errorObject)) {
      throw new Error(errorObject.details);
    }
  },

  sendCommand(cmd) {
    return this._TorLauncherProtocolService.TorSendCommand(cmd);
  },

  retrieveBootstrapStatus() {
    return this._TorLauncherProtocolService.TorRetrieveBootstrapStatus();
  },

  _GetSaveSettingsErrorMessage(aDetails) {
    try {
      return this._TorLauncherUtil.getSaveSettingsErrorMessage(aDetails);
    } catch (e) {
      console.log("GetSaveSettingsErrorMessage error", e);
      return "Unexpected Error";
    }
  },

  setConfWithReply(settings) {
    let result = false;
    const error = {};
    try {
      result = this._TorLauncherProtocolService.TorSetConfWithReply(settings, error);
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

  // Resolves to null if ok, or an error otherwise
  connect() {
    const kTorConfKeyDisableNetwork = "DisableNetwork";
    const settings = {};
    settings[kTorConfKeyDisableNetwork] = false;
    const { result, error } = this.setConfWithReply(settings);
    if (!result) {
      return error;
    }
    try {
      this.sendCommand("SAVECONF");
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

  torStopBootstrap() {
    // Tell tor to disable use of the network; this should stop the bootstrap
    // process.
    const kErrorPrefix = "Setting DisableNetwork=1 failed: ";
    try {
      let settings = {};
      settings.DisableNetwork = true;
      const { result, error } = this.setConfWithReply(settings);
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