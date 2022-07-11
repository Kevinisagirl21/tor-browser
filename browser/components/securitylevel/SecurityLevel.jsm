"use strict";

var EXPORTED_SYMBOLS = ["SecurityLevel"];

const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");

const BrowserTopics = Object.freeze({
  ProfileAfterChange: "profile-after-change",
});

const { ExtensionUtils } = ChromeUtils.import(
  "resource://gre/modules/ExtensionUtils.jsm"
);
const { MessageChannel } = ChromeUtils.import(
  "resource://gre/modules/MessageChannel.jsm"
);

const { XPCOMUtils } = ChromeUtils.import(
  "resource://gre/modules/XPCOMUtils.jsm"
);

XPCOMUtils.defineLazyModuleGetters(this, {
  ExtensionParent: "resource://gre/modules/ExtensionParent.jsm",
});

// Logger adapted from CustomizableUI.jsm
XPCOMUtils.defineLazyGetter(this, "logger", () => {
  let scope = {};
  ChromeUtils.import("resource://gre/modules/Console.jsm", scope);
  let consoleOptions = {
    maxLogLevel: "info",
    prefix: "SecurityLevel",
  };
  return new scope.ConsoleAPI(consoleOptions);
});

// The Security Settings prefs in question.
const kSliderPref = "extensions.torbutton.security_slider";
const kCustomPref = "extensions.torbutton.security_custom";
const kSliderMigration = "extensions.torbutton.security_slider_migration";

// __getPrefValue(prefName)__
// Returns the current value of a preference, regardless of its type.
var getPrefValue = function(prefName) {
  switch (Services.prefs.getPrefType(prefName)) {
    case Services.prefs.PREF_BOOL:
      return Services.prefs.getBoolPref(prefName);
    case Services.prefs.PREF_INT:
      return Services.prefs.getIntPref(prefName);
    case Services.prefs.PREF_STRING:
      return Services.prefs.getCharPref(prefName);
    default:
      return null;
  }
};

// __bindPref(prefName, prefHandler, init)__
// Applies prefHandler whenever the value of the pref changes.
// If init is true, applies prefHandler to the current value.
// Returns a zero-arg function that unbinds the pref.
var bindPref = function(prefName, prefHandler, init = false) {
  let update = () => {
      prefHandler(getPrefValue(prefName));
    },
    observer = {
      observe(subject, topic, data) {
        if (data === prefName) {
          update();
        }
      },
    };
  Services.prefs.addObserver(prefName, observer);
  if (init) {
    update();
  }
  return () => {
    Services.prefs.removeObserver(prefName, observer);
  };
};

// __bindPrefAndInit(prefName, prefHandler)__
// Applies prefHandler to the current value of pref specified by prefName.
// Re-applies prefHandler whenever the value of the pref changes.
// Returns a zero-arg function that unbinds the pref.
var bindPrefAndInit = (prefName, prefHandler) =>
  bindPref(prefName, prefHandler, true);

async function waitForExtensionMessage(extensionId, checker = () => {}) {
  const { torWaitForExtensionMessage } = ExtensionParent;
  if (torWaitForExtensionMessage) {
    return torWaitForExtensionMessage(extensionId, checker);
  }

  // Old messaging <= 78
  return new Promise(resolve => {
    const listener = ({ data }) => {
      for (const msg of data) {
        if (msg.recipient.extensionId === extensionId) {
          const deserialized = msg.data.deserialize({});
          if (checker(deserialized)) {
            Services.mm.removeMessageListener(
              "MessageChannel:Messages",
              listener
            );
            resolve(deserialized);
          }
        }
      }
    };
    Services.mm.addMessageListener("MessageChannel:Messages", listener);
  });
}

async function sendExtensionMessage(extensionId, message) {
  const { torSendExtensionMessage } = ExtensionParent;
  if (torSendExtensionMessage) {
    return torSendExtensionMessage(extensionId, message);
  }

  // Old messaging <= 78
  Services.cpmm.sendAsyncMessage("MessageChannel:Messages", [
    {
      messageName: "Extension:Message",
      sender: { id: extensionId, extensionId },
      recipient: { extensionId },
      data: new StructuredCloneHolder(message),
      channelId: ExtensionUtils.getUniqueId(),
      responseType: MessageChannel.RESPONSE_NONE,
    },
  ]);
  return undefined;
}

// ## NoScript settings

// Minimum and maximum capability states as controlled by NoScript.
const max_caps = [
  "fetch",
  "font",
  "frame",
  "media",
  "object",
  "other",
  "script",
  "webgl",
  "noscript",
];
const min_caps = ["frame", "other", "noscript"];

// Untrusted capabilities for [Standard, Safer, Safest] safety levels.
const untrusted_caps = [
  max_caps, // standard safety: neither http nor https
  ["frame", "font", "object", "other", "noscript"], // safer: http
  min_caps, // safest: neither http nor https
];

// Default capabilities for [Standard, Safer, Safest] safety levels.
const default_caps = [
  max_caps, // standard: both http and https
  ["fetch", "font", "frame", "object", "other", "script", "noscript"], // safer: https only
  min_caps, // safest: both http and https
];

// __noscriptSettings(safetyLevel)__.
// Produces NoScript settings with policy according to
// the safetyLevel which can be:
// 0 = Standard, 1 = Safer, 2 = Safest
//
// At the "Standard" safety level, we leave all sites at
// default with maximal capabilities. Essentially no content
// is blocked.
//
// At "Safer", we set all http sites to untrusted,
// and all https sites to default. Scripts are only permitted
// on https sites. Neither type of site is supposed to allow
// media, but both allow fonts (as we used in legacy NoScript).
//
// At "Safest", all sites are at default with minimal
// capabilities. Most things are blocked.
let noscriptSettings = safetyLevel => ({
  __meta: {
    name: "updateSettings",
    recipientInfo: null,
  },
  policy: {
    DEFAULT: {
      capabilities: default_caps[safetyLevel],
      temp: false,
    },
    TRUSTED: {
      capabilities: max_caps,
      temp: false,
    },
    UNTRUSTED: {
      capabilities: untrusted_caps[safetyLevel],
      temp: false,
    },
    sites: {
      trusted: [],
      untrusted: [[], ["http:"], []][safetyLevel],
      custom: {},
      temp: [],
    },
    enforced: true,
    autoAllowTop: false,
  },
  isTorBrowser: true,
  tabId: -1,
});

// ## Communications

// The extension ID for NoScript (WebExtension)
const noscriptID = "{73a6fe31-595d-460b-a920-fcc0f8843232}";

// Ensure binding only occurs once.
let initialized = false;

// __initialize()__.
// The main function that binds the NoScript settings to the security
// slider pref state.
var initializeNoScriptControl = () => {
  if (initialized) {
    return;
  }
  initialized = true;

  try {
    // LegacyExtensionContext is not there anymore. Using raw
    // Services.cpmm.sendAsyncMessage mechanism to communicate with
    // NoScript.

    // The component that handles WebExtensions' sendMessage.

    // __setNoScriptSettings(settings)__.
    // NoScript listens for internal settings with onMessage. We can send
    // a new settings JSON object according to NoScript's
    // protocol and these are accepted! See the use of
    // `browser.runtime.onMessage.addListener(...)` in NoScript's bg/main.js.

    // TODO: Is there a better way?
    let sendNoScriptSettings = settings =>
      sendExtensionMessage(noscriptID, settings);

    // __setNoScriptSafetyLevel(safetyLevel)__.
    // Set NoScript settings according to a particular safety level
    // (security slider level): 0 = Standard, 1 = Safer, 2 = Safest
    let setNoScriptSafetyLevel = safetyLevel =>
      sendNoScriptSettings(noscriptSettings(safetyLevel));

    // __securitySliderToSafetyLevel(sliderState)__.
    // Converts the "extensions.torbutton.security_slider" pref value
    // to a "safety level" value: 0 = Standard, 1 = Safer, 2 = Safest
    let securitySliderToSafetyLevel = sliderState =>
      [undefined, 2, 1, 1, 0][sliderState];

    // Wait for the first message from NoScript to arrive, and then
    // bind the security_slider pref to the NoScript settings.
    let messageListener = a => {
      try {
        logger.debug("Message received from NoScript:", a);
        let noscriptPersist = Services.prefs.getBoolPref(
          "extensions.torbutton.noscript_persist",
          false
        );
        let noscriptInited = Services.prefs.getBoolPref(
          "extensions.torbutton.noscript_inited",
          false
        );
        // Set the noscript safety level once if we have never run noscript
        // before, or if we are not allowing noscript per-site settings to be
        // persisted between browser sessions. Otherwise make sure that the
        // security slider position, if changed, will rewrite the noscript
        // settings.
        bindPref(
          kSliderPref,
          sliderState =>
            setNoScriptSafetyLevel(securitySliderToSafetyLevel(sliderState)),
          !noscriptPersist || !noscriptInited
        );
        if (!noscriptInited) {
          Services.prefs.setBoolPref(
            "extensions.torbutton.noscript_inited",
            true
          );
        }
      } catch (e) {
        logger.exception(e);
      }
    };
    waitForExtensionMessage(noscriptID, a => a.__meta.name === "started").then(
      messageListener
    );
    logger.info("Listening for messages from NoScript.");
  } catch (e) {
    logger.exception(e);
  }
};

// ### Constants

// __kSecuritySettings__.
// A table of all prefs bound to the security slider, and the value
// for each security setting. Note that 2-m and 3-m are identical,
// corresponding to the old 2-medium-high setting. We also separately
// bind NoScript settings to the extensions.torbutton.security_slider
// (see noscript-control.js).
/* eslint-disable */
const kSecuritySettings = {
  // Preference name :                                          [0, 1-high 2-m    3-m    4-low]
  "javascript.options.ion" :                                    [,  false, false, false, true ],
  "javascript.options.baselinejit" :                            [,  false, false, false, true ],
  "javascript.options.native_regexp" :                          [,  false, false, false, true ],
  "mathml.disabled" :                                           [,  true,  true,  true,  false],
  "gfx.font_rendering.graphite.enabled" :                       [,  false, false, false, true ],
  "gfx.font_rendering.opentype_svg.enabled" :                   [,  false, false, false, true ],
  "svg.disabled" :                                              [,  true,  false, false, false],
  "javascript.options.asmjs" :                                  [,  false, false, false, true ],
  "javascript.options.wasm" :                                   [,  false, false, false, true ],
  "dom.security.https_only_mode_send_http_background_request" : [,  false, false, false, true ],
};
/* eslint-enable */

// ### Prefs

// __write_setting_to_prefs(settingIndex)__.
// Take a given setting index and write the appropriate pref values
// to the pref database.
var write_setting_to_prefs = function(settingIndex) {
  Object.keys(kSecuritySettings).forEach(prefName =>
    Services.prefs.setBoolPref(
      prefName,
      kSecuritySettings[prefName][settingIndex]
    )
  );
};

// __read_setting_from_prefs()__.
// Read the current pref values, and decide if any of our
// security settings matches. Otherwise return null.
var read_setting_from_prefs = function(prefNames) {
  prefNames = prefNames || Object.keys(kSecuritySettings);
  for (let settingIndex of [1, 2, 3, 4]) {
    let possibleSetting = true;
    // For the given settingIndex, check if all current pref values
    // match the setting.
    for (let prefName of prefNames) {
      if (
        kSecuritySettings[prefName][settingIndex] !==
        Services.prefs.getBoolPref(prefName)
      ) {
        possibleSetting = false;
      }
    }
    if (possibleSetting) {
      // We have a match!
      return settingIndex;
    }
  }
  // No matching setting; return null.
  return null;
};

// __watch_security_prefs(onSettingChanged)__.
// Whenever a pref bound to the security slider changes, onSettingChanged
// is called with the new security setting value (1,2,3,4 or null).
// Returns a zero-arg function that ends this binding.
var watch_security_prefs = function(onSettingChanged) {
  let prefNames = Object.keys(kSecuritySettings);
  let unbindFuncs = [];
  for (let prefName of prefNames) {
    unbindFuncs.push(
      bindPrefAndInit(prefName, () =>
        onSettingChanged(read_setting_from_prefs())
      )
    );
  }
  // Call all the unbind functions.
  return () => unbindFuncs.forEach(unbind => unbind());
};

// __initialized__.
// Have we called initialize() yet?
var initializedSecPrefs = false;

// __initialize()__.
// Defines the behavior of "extensions.torbutton.security_custom",
// "extensions.torbutton.security_slider", and the security-sensitive
// prefs declared in kSecuritySettings.
var initializeSecurityPrefs = function() {
  // Only run once.
  if (initializedSecPrefs) {
    return;
  }
  logger.info("Initializing security-prefs.js");
  initializedSecPrefs = true;
  // When security_custom is set to false, apply security_slider setting
  // to the security-sensitive prefs.
  bindPrefAndInit(kCustomPref, function(custom) {
    if (custom === false) {
      write_setting_to_prefs(Services.prefs.getIntPref(kSliderPref));
    }
  });
  // If security_slider is given a new value, then security_custom should
  // be set to false.
  bindPref(kSliderPref, function(prefIndex) {
    Services.prefs.setBoolPref(kCustomPref, false);
    write_setting_to_prefs(prefIndex);
  });
  // If a security-sensitive pref changes, then decide if the set of pref values
  // constitutes a security_slider setting or a custom value.
  watch_security_prefs(settingIndex => {
    if (settingIndex === null) {
      Services.prefs.setBoolPref(kCustomPref, true);
    } else {
      Services.prefs.setIntPref(kSliderPref, settingIndex);
      Services.prefs.setBoolPref(kCustomPref, false);
    }
  });
  // Migrate from old medium-low (3) to new medium (2).
  if (
    Services.prefs.getBoolPref(kCustomPref) === false &&
    Services.prefs.getIntPref(kSliderPref) === 3
  ) {
    Services.prefs.setIntPref(kSliderPref, 2);
    write_setting_to_prefs(2);
  }

  // Revert #33613 fix
  if (Services.prefs.getIntPref(kSliderMigration, 0) < 2) {
    // We can't differentiate between users having flipped `javascript.enabled`
    // to `false` before it got governed by the security settings vs. those who
    // had it flipped due to #33613. Reset the preference for everyone.
    if (Services.prefs.getIntPref(kSliderPref) === 1) {
      Services.prefs.setBoolPref("javascript.enabled", true);
    }
    Services.prefs.clearUserPref("media.webaudio.enabled");
    Services.prefs.setIntPref(kSliderMigration, 2);
  }
  logger.info("security-prefs.js initialization complete");
};

// This class is used to initialize the security level stuff at the startup
class SecurityLevel {
  QueryInterface = ChromeUtils.generateQI(["nsIObserver"]);

  init() {
    initializeNoScriptControl();
    initializeSecurityPrefs();
  }

  observe(aSubject, aTopic, aData) {
    if (aTopic == BrowserTopics.ProfileAfterChange) {
      this.init();
      Services.obs.removeObserver(this, aTopic);
    }
  }
}
