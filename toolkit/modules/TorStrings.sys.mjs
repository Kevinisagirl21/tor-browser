// Copyright (c) 2022, The Tor Project, Inc.
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");
const { AppConstants } = ChromeUtils.import(
  "resource://gre/modules/AppConstants.jsm"
);

function getLocale() {
  const locale = Services.locale.appLocaleAsBCP47;
  return locale === "ja-JP-macos" ? "ja" : locale;
}

/*
  Tor Property String Bundle

  Property strings loaded from torbutton/tor-launcher, but provide a fallback in case they aren't available
*/
class TorPropertyStringBundle {
  constructor(aBundleURL, aPrefix) {
    try {
      this._bundle = Services.strings.createBundle(aBundleURL);
      this._bundleURL = aBundleURL;
    } catch (e) {
      console.error(`[TorStrings] Cannot load ${aBundleURL}`, e);
    }

    this._prefix = aPrefix;
  }

  getString(key, fallback) {
    const reportError =
      AppConstants.BASE_BROWSER_VERSION === "dev-build" && !!this._bundle;
    if (key) {
      try {
        return this._bundle.GetStringFromName(`${this._prefix}${key}`);
      } catch (e) {
        if (reportError) {
          console.warn(
            `[TorStrings] Cannot get ${this._prefix}${key} from ${this._bundleURL}`,
            e
          );
        }
      }
    }

    // on failure, assign the fallback if it exists
    if (fallback) {
      return fallback;
    }
    // otherwise return string key
    return `$(${key})`;
  }

  getStrings(strings) {
    return Object.fromEntries(
      Object.entries(strings).map(([key, fallback]) => [
        key,
        this.getString(key, fallback),
      ])
    );
  }
}

const Loader = {
  /*
    Tor about:preferences#connection Strings
  */
  settings() {
    const strings = {
      categoryTitle: "Connection",
      // Message box
      torPreferencesDescription:
        "Tor Browser routes your traffic over the Tor Network, run by thousands of volunteers around the world.",
      // Status
      statusInternetLabel: "Internet:",
      statusInternetTest: "Test",
      statusInternetOnline: "Online",
      statusInternetOffline: "Offline",
      statusTorLabel: "Tor Network:",
      statusTorConnected: "Connected",
      statusTorNotConnected: "Not Connected",
      statusTorBlocked: "Potentially Blocked",
      learnMore: "Learn more",
      // Quickstart
      quickstartHeading: "Quickstart",
      quickstartDescription:
        "Quickstart connects Tor Browser to the Tor Network automatically when launched, based on your last used connection settings.",
      quickstartCheckbox: "Always connect automatically",
      // Bridge settings
      bridgesHeading: "Bridges",
      bridgesDescription2:
        "Bridges help you securely access the Tor Network in places where Tor is blocked. Depending on where you are, one bridge may work better than another.",
      bridgeLocation: "Your location",
      bridgeLocationAutomatic: "Automatic",
      bridgeLocationFrequent: "Frequently selected locations",
      bridgeLocationOther: "Other locations",
      bridgeChooseForMe: "Choose a Bridge For Me…",
      currentBridge: "Current bridge",
      remove: "Remove",
      bridgeDisableBuiltIn: "Disable built-in bridges",
      copied: "Copied!",
      bridgeRemoveAllDialogTitle: "Remove all bridges?",
      bridgeRemoveAllDialogDescription:
        "If these bridges were received from torproject.org or added manually, this action cannot be undone",
      // Advanced settings
      advancedHeading: "Advanced",
      advancedLabel: "Configure how Tor Browser connects to the internet",
      advancedButton: "Settings…",
      showTorDaemonLogs: "View the Tor logs",
      showLogs: "View Logs…",
      // Remove all bridges dialog
      removeBridgesQuestion: "Remove all the bridges?",
      removeBridgesWarning: "This action cannot be undone.",
      cancel: "Cancel",
      // Scan bridge QR dialog
      scanQrTitle: "Scan the QR code",
      // Builtin bridges dialog
      builtinBridgeHeader: "Select a Built-In Bridge",
      builtinBridgeDescription2:
        "Tor Browser includes some specific types of bridges known as “pluggable transports”, which can help conceal the fact you’re using Tor.",
      builtinBridgeObfs4Title: "obfs4 (Built-in)",
      builtinBridgeObfs4Description2:
        "Makes your Tor traffic look like random data. May not work in heavily censored regions.",
      builtinBridgeSnowflake: "Snowflake",
      builtinBridgeSnowflakeDescription2:
        "Routes your connection through Snowflake proxies to make it look like you’re placing a video call, for example.",
      builtinBridgeMeekAzure: "meek-azure",
      builtinBridgeMeekAzureDescription2:
        "Makes it look like you’re connected to a Microsoft website, instead of using Tor. May work in heavily censored regions, but is usually very slow.",
      bridgeButtonConnect: "Connect",
      bridgeButtonAccept: "OK",
      // Request bridges dialog
      requestBridgeDialogTitle: "Request Bridge",
      submitCaptcha: "Submit",
      contactingBridgeDB: "Contacting BridgeDB. Please Wait.",
      solveTheCaptcha: "Solve the CAPTCHA to request a bridge.",
      captchaTextboxPlaceholder: "Enter the characters from the image",
      incorrectCaptcha: "The solution is not correct. Please try again.",
      // Connection settings dialog
      connectionSettingsDialogTitle: "Connection Settings",
      connectionSettingsDialogHeader:
        "Configure how Tor Browser connects to the Internet",
      useLocalProxy: "I use a proxy to connect to the Internet",
      proxyType: "Proxy Type",
      proxyTypeSOCKS4: "SOCKS4",
      proxyTypeSOCKS5: "SOCKS5",
      proxyTypeHTTP: "HTTP/HTTPS",
      proxyAddress: "Address",
      proxyAddressPlaceholder: "IP address or hostname",
      proxyPort: "Port",
      proxyUsername: "Username",
      proxyPassword: "Password",
      proxyUsernamePasswordPlaceholder: "Optional",
      useFirewall:
        "This computer goes through a firewall that only allows connections to certain ports",
      allowedPorts: "Allowed Ports",
      allowedPortsPlaceholder: "Comma-seperated values",
      // Log dialog
      torLogDialogTitle: "Tor Logs",
      copyLog: "Copy Tor Log to Clipboard",
    };

    const tsb = new TorPropertyStringBundle(
      "chrome://torbutton/locale/settings.properties",
      "settings."
    );
    return {
      ...tsb.getStrings(strings),
      learnMoreTorBrowserURL: "about:manual#about",
      learnMoreBridgesURL: "about:manual#bridges",
    };
  } /* Tor Network Settings Strings */,

  torConnect() {
    const strings = {
      torConnect: "Connect to Tor",

      torConnecting: "Establishing a Connection",

      tryingAgain: "Trying again…",

      noInternet: "Tor Browser couldn’t reach the Internet",
      noInternetDescription:
        "This could be due to a connection issue rather than Tor being blocked. Check your Internet connection, proxy and firewall settings before trying again.",
      torBootstrapFailed: "Tor failed to establish a Tor network connection.",
      couldNotConnect: "Tor Browser could not connect to Tor",
      configureConnection: "configure your connection",
      assistDescription:
        "If Tor is blocked in your location, trying a bridge may help. Connection assist can choose one for you using your location, or you can %S manually instead.",
      tryingBridge: "Trying a bridge…",

      tryingBridgeAgain: "Trying one more time…",
      errorLocation: "Tor Browser couldn’t locate you",
      errorLocationDescription:
        "Tor Browser needs to know your location in order to choose the right bridge for you. If you’d rather not share your location, %S manually instead.",
      isLocationCorrect: "Are these location settings correct?",
      isLocationCorrectDescription:
        "Tor Browser still couldn’t connect to Tor. Please check your location settings are correct and try again, or %S instead.",
      finalError: "Tor Browser still cannot connect",

      finalErrorDescription:
        "Despite its best efforts, connection assist was not able to connect to Tor. Try troubleshooting your connection and adding a bridge manually instead.",
      breadcrumbAssist: "Connection assist",
      breadcrumbLocation: "Location settings",
      breadcrumbTryBridge: "Try a bridge",

      restartTorBrowser: "Restart Tor Browser",

      torConfigure: "Configure Connection…",

      viewLog: "View logs…",

      torConnectButton: "Connect",

      cancel: "Cancel",

      torConnected: "Connected to the Tor network",

      tryAgain: "Try Again",

      yourLocation: "Your Location",
      unblockInternetIn: "Unblock the Internet in",

      tryBridge: "Try a Bridge",

      automatic: "Automatic",
      selectCountryRegion: "Select Country or Region",
      frequentLocations: "Frequently selected locations",
      otherLocations: "Other locations",

      // TorConnect.jsm error messages
      offline: "Internet not reachable",
      autoBootstrappingFailed: "Automatic configuration failed",
      autoBootstrappingAllFailed: "None of the configurations we tried worked",
      cannotDetermineCountry: "Unable to determine user country",
      noSettingsForCountry: "No settings available for your location",

      // Titlebar status.
      titlebarStatusName: "Tor connection",
      titlebarStatusNotConnected: "Not connected",
      titlebarStatusConnecting: "Connecting…",
      titlebarStatusPotentiallyBlocked: "Potentially blocked",
      titlebarStatusConnected: "Connected",
    };

    const tsb = new TorPropertyStringBundle(
      "chrome://torbutton/locale/torConnect.properties",
      "torConnect."
    );
    return tsb.getStrings(strings);
  },

  /*
    Tor Onion Services Strings, e.g., for the authentication prompt.
  */
  onionServices() {
    const tsb = new TorPropertyStringBundle(
      "chrome://torbutton/locale/torbutton.properties",
      "onionServices."
    );
    const getString = tsb.getString.bind(tsb);

    const kProblemLoadingSiteFallback = "Problem Loading Onionsite";
    const kLongDescFallback = "Details: %S";

    const retval = {
      learnMore: getString("learnMore", "Learn more"),
      errorPage: {
        browser: getString("errorPage.browser", "Browser"),
        network: getString("errorPage.network", "Network"),
        onionSite: getString("errorPage.onionSite", "Onionsite"),
      },
      descNotFound: {
        // Tor SOCKS error 0xF0
        pageTitle: getString(
          "descNotFound.pageTitle",
          kProblemLoadingSiteFallback
        ),
        header: getString("descNotFound.header", "Onionsite Not Found"),
        longDescription: getString(
          "descNotFound.longDescription",
          kLongDescFallback
        ),
      },
      descInvalid: {
        // Tor SOCKS error 0xF1
        pageTitle: getString(
          "descInvalid.pageTitle",
          kProblemLoadingSiteFallback
        ),
        header: getString("descInvalid.header", "Onionsite Cannot Be Reached"),
        longDescription: getString(
          "descInvalid.longDescription",
          kLongDescFallback
        ),
      },
      introFailed: {
        // Tor SOCKS error 0xF2
        pageTitle: getString(
          "introFailed.pageTitle",
          kProblemLoadingSiteFallback
        ),
        header: getString("introFailed.header", "Onionsite Has Disconnected"),
        longDescription: getString(
          "introFailed.longDescription",
          kLongDescFallback
        ),
      },
      rendezvousFailed: {
        // Tor SOCKS error 0xF3
        pageTitle: getString(
          "rendezvousFailed.pageTitle",
          kProblemLoadingSiteFallback
        ),
        header: getString(
          "rendezvousFailed.header",
          "Unable to Connect to Onionsite"
        ),
        longDescription: getString(
          "rendezvousFailed.longDescription",
          kLongDescFallback
        ),
      },
      clientAuthMissing: {
        // Tor SOCKS error 0xF4
        pageTitle: getString(
          "clientAuthMissing.pageTitle",
          "Authorization Required"
        ),
        header: getString(
          "clientAuthMissing.header",
          "Onionsite Requires Authentication"
        ),
        longDescription: getString(
          "clientAuthMissing.longDescription",
          kLongDescFallback
        ),
      },
      clientAuthIncorrect: {
        // Tor SOCKS error 0xF5
        pageTitle: getString(
          "clientAuthIncorrect.pageTitle",
          "Authorization Failed"
        ),
        header: getString(
          "clientAuthIncorrect.header",
          "Onionsite Authentication Failed"
        ),
        longDescription: getString(
          "clientAuthIncorrect.longDescription",
          kLongDescFallback
        ),
      },
      badAddress: {
        // Tor SOCKS error 0xF6
        pageTitle: getString(
          "badAddress.pageTitle",
          kProblemLoadingSiteFallback
        ),
        header: getString("badAddress.header", "Invalid Onionsite Address"),
        longDescription: getString(
          "badAddress.longDescription",
          kLongDescFallback
        ),
      },
      introTimedOut: {
        // Tor SOCKS error 0xF7
        pageTitle: getString(
          "introTimedOut.pageTitle",
          kProblemLoadingSiteFallback
        ),
        header: getString(
          "introTimedOut.header",
          "Onionsite Circuit Creation Timed Out"
        ),
        longDescription: getString(
          "introTimedOut.longDescription",
          kLongDescFallback
        ),
      },
      authPrompt: {
        description: getString(
          "authPrompt.description2",
          "%S is requesting that you authenticate."
        ),
        keyPlaceholder: getString(
          "authPrompt.keyPlaceholder",
          "Enter your key"
        ),
        done: getString("authPrompt.done", "Done"),
        doneAccessKey: getString("authPrompt.doneAccessKey", "d"),
        invalidKey: getString("authPrompt.invalidKey", "Invalid key"),
        failedToSetKey: getString(
          "authPrompt.failedToSetKey",
          "Failed to set key"
        ),
      },
      authPreferences: {
        header: getString(
          "authPreferences.header",
          "Onion Services Authentication"
        ),
        overview: getString(
          "authPreferences.overview",
          "Some onion services require that you identify yourself with a key"
        ),
        savedKeys: getString("authPreferences.savedKeys", "Saved Keys"),
        dialogTitle: getString(
          "authPreferences.dialogTitle",
          "Onion Services Keys"
        ),
        dialogIntro: getString(
          "authPreferences.dialogIntro",
          "Keys for the following onionsites are stored on your computer"
        ),
        onionSite: getString("authPreferences.onionSite", "Onionsite"),
        onionKey: getString("authPreferences.onionKey", "Key"),
        remove: getString("authPreferences.remove", "Remove"),
        removeAll: getString("authPreferences.removeAll", "Remove All"),
        failedToGetKeys: getString(
          "authPreferences.failedToGetKeys",
          "Failed to get keys"
        ),
        failedToRemoveKey: getString(
          "authPreferences.failedToRemoveKey",
          "Failed to remove key"
        ),
      },
    };

    return retval;
  } /* Tor Onion Services Strings */,

  /*
    OnionLocation
  */
  onionLocation() {
    const strings = {
      learnMore: "Learn more…",
      loadOnion: "Visit the .onion",
      loadOnionAccessKey: "V",
      notNow: "Not Now",
      notNowAccessKey: "n",
      description:
        "There's a more private and secure version of this site available over the Tor network via onion services. Onion services help website publishers and their visitors defeat surveillance and censorship.",
      tryThis: "Try Onion Services",
      onionAvailable: ".onion available",
    };

    const tsb = new TorPropertyStringBundle(
      ["chrome://torbutton/locale/onionLocation.properties"],
      "onionLocation."
    );
    return {
      ...tsb.getStrings(strings),
      learnMoreURL: "about:manual#onion-services",
      // XUL popups cannot open about: URLs, but we are online when showing the notification, so just use the online version
      learnMoreURLNotification: `https://tb-manual.torproject.org/${getLocale()}/onion-services/`,
    };
  } /* OnionLocation */,

  /*
    Rulesets
  */
  rulesets() {
    const strings = {
      // Initial warning
      warningTitle: "Proceed with Caution",
      warningDescription:
        "Adding or modifying rulesets can cause attackers to hijack your browser. Proceed only if you know what you are doing.",
      warningEnable: "Warn me when I attempt to access these preferences",
      warningButton: "Accept the Risk and Continue",
      // Ruleset list
      rulesets: "Rulesets",
      noRulesets: "No rulesets found",
      noRulesetsDescr:
        "When you save a ruleset in Tor Browser, it will show up here.",
      lastUpdated: "Last updated %S",
      neverUpdated: "Never updated, or last update failed",
      enabled: "Enabled",
      disabled: "Disabled",
      // Ruleset details
      edit: "Edit",
      name: "Name",
      jwk: "JWK",
      pathPrefix: "Path Prefix",
      scope: "Scope",
      enable: "Enable this ruleset",
      checkUpdates: "Check for Updates",
      // Add ruleset
      jwkPlaceholder:
        "The key used to sign this ruleset in the JWK (JSON Web Key) format",
      jwkInvalid: "The JWK could not be parsed, or it is not a valid key",
      pathPrefixPlaceholder:
        "URL prefix that contains the files needed by the ruleset",
      pathPrefixInvalid: "The path prefix is not a valid HTTP(S) URL",
      scopePlaceholder: "Regular expression for the scope of the rules",
      scopeInvalid: "The scope could not be parsed as a regular expression",
      save: "Save",
      cancel: "Cancel",
    };

    const tsb = new TorPropertyStringBundle(
      ["chrome://torbutton/locale/rulesets.properties"],
      "rulesets."
    );
    return tsb.getStrings(strings);
  } /* Rulesets */,
};

export const TorStrings = {
  get settings() {
    if (!this._settings) {
      this._settings = Loader.settings();
    }
    return this._settings;
  },

  get torConnect() {
    if (!this._torConnect) {
      this._torConnect = Loader.torConnect();
    }
    return this._torConnect;
  },

  get onionServices() {
    if (!this._onionServices) {
      this._onionServices = Loader.onionServices();
    }
    return this._onionServices;
  },

  get onionLocation() {
    if (!this._onionLocation) {
      this._onionLocation = Loader.onionLocation();
    }
    return this._onionLocation;
  },

  get rulesets() {
    if (!this._rulesets) {
      this._rulesets = Loader.rulesets();
    }
    return this._rulesets;
  },
};
