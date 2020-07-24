"use strict";

var EXPORTED_SYMBOLS = ["TorStrings"];

const { XPCOMUtils } = ChromeUtils.import(
  "resource://gre/modules/XPCOMUtils.jsm"
);
const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");
const { getLocale } = ChromeUtils.import(
  "resource://torbutton/modules/utils.js"
);

XPCOMUtils.defineLazyGlobalGetters(this, ["DOMParser"]);
XPCOMUtils.defineLazyGetter(this, "domParser", () => {
  const parser = new DOMParser();
  parser.forceEnableDTD();
  return parser;
});

/*
  Tor DTD String Bundle

  DTD strings loaded from torbutton/tor-launcher, but provide a fallback in case they aren't available
*/
class TorDTDStringBundle {
  constructor(aBundleURLs, aPrefix) {
    let locations = [];
    for (const [index, url] of aBundleURLs.entries()) {
      locations.push(`<!ENTITY % dtd_${index} SYSTEM "${url}">%dtd_${index};`);
    }
    this._locations = locations;
    this._prefix = aPrefix;
  }

  // copied from testing/marionette/l10n.js
  localizeEntity(urls, id) {
    // Use the DOM parser to resolve the entity and extract its real value
    let header = `<?xml version="1.0"?><!DOCTYPE elem [${this._locations.join(
      ""
    )}]>`;
    let elem = `<elem id="elementID">&${id};</elem>`;
    let doc = domParser.parseFromString(header + elem, "text/xml");
    let element = doc.querySelector("elem[id='elementID']");

    if (element === null) {
      throw new Error(`Entity with id='${id}' hasn't been found`);
    }

    return element.textContent;
  }

  getString(key, fallback) {
    if (key) {
      try {
        return this.localizeEntity(this._bundleURLs, `${this._prefix}${key}`);
      } catch (e) {}
    }

    // on failure, assign the fallback if it exists
    if (fallback) {
      return fallback;
    }
    // otherwise return string key
    return `$(${key})`;
  }
}

/*
  Tor Property String Bundle

  Property strings loaded from torbutton/tor-launcher, but provide a fallback in case they aren't available
*/
class TorPropertyStringBundle {
  constructor(aBundleURL, aPrefix) {
    try {
      this._bundle = Services.strings.createBundle(aBundleURL);
    } catch (e) {}

    this._prefix = aPrefix;
  }

  getString(key, fallback) {
    if (key) {
      try {
        return this._bundle.GetStringFromName(`${this._prefix}${key}`);
      } catch (e) {}
    }

    // on failure, assign the fallback if it exists
    if (fallback) {
      return fallback;
    }
    // otherwise return string key
    return `$(${key})`;
  }
}

var TorStrings = {
  /*
    Tor about:preferences#connection Strings
  */
  settings: (function() {
    let tsb = new TorDTDStringBundle(
      ["chrome://torlauncher/locale/network-settings.dtd"],
      ""
    );
    let getString = function(key, fallback) {
      return tsb.getString(key, fallback);
    };

    let retval = {
      categoryTitle: getString("torPreferences.categoryTitle", "Connection"),
      // Message box
      torPreferencesDescription: getString(
        "torPreferences.torSettingsDescription",
        "Tor Browser routes your traffic over the Tor Network, run by thousands of volunteers around the world."
      ),
      // Status
      statusInternetLabel: getString(
        "torPreferences.statusInternetLabel",
        "Internet:"
      ),
      statusInternetTest: getString(
        "torPreferences.statusInternetTest",
        "Test"
      ),
      statusInternetOnline: getString(
        "torPreferences.statusInternetOnline",
        "Online"
      ),
      statusInternetOffline: getString(
        "torPreferences.statusInternetOffline",
        "Offline"
      ),
      statusTorLabel: getString(
        "torPreferences.statusTorLabel",
        "Tor Network:"
      ),
      statusTorConnected: getString(
        "torPreferences.statusTorConnected",
        "Connected"
      ),
      statusTorNotConnected: getString(
        "torPreferences.statusTorNotConnected",
        "Not Connected"
      ),
      statusTorBlocked: getString(
        "torPreferences.statusTorBlocked",
        "Potentially Blocked"
      ),
      learnMore: getString("torPreferences.learnMore", "Learn more"),
      // Quickstart
      quickstartHeading: getString("torPreferences.quickstart", "Quickstart"),
      quickstartDescription: getString(
        "torPreferences.quickstartDescriptionLong",
        "Quickstart connects Tor Browser to the Tor Network automatically when launched, based on your last used connection settings."
      ),
      quickstartCheckbox: getString(
        "torPreferences.quickstartCheckbox",
        "Always connect automatically"
      ),
      // Bridge settings
      bridgesHeading: getString("torPreferences.bridges", "Bridges"),
      bridgesDescription: getString(
        "torPreferences.bridgesDescription",
        "Bridges help you access the Tor Network in places where Tor is blocked. Depending on where you are, one bridge may work better than another."
      ),
      bridgeLocation: getString(
        "torPreferences.bridgeLocation",
        "Your location"
      ),
      bridgeLocationAutomatic: getString(
        "torPreferences.bridgeLocationAutomatic",
        "Automatic"
      ),
      bridgeLocationFrequent: getString(
        "torPreferences.bridgeLocationFrequent",
        "Frequently selected locations"
      ),
      bridgeLocationOther: getString(
        "torPreferences.bridgeLocationOther",
        "Other locations"
      ),
      bridgeChooseForMe: getString(
        "torPreferences.bridgeChooseForMe",
        "Choose a Bridge For Me\u2026"
      ),
      bridgeCurrent: getString(
        "torPreferences.bridgeBadgeCurrent",
        "Your Current Bridges"
      ),
      bridgeCurrentDescription: getString(
        "torPreferences.bridgeBadgeCurrentDescription",
        "You can keep one or more bridges saved, and Tor will choose which one to use when you connect. Tor will automatically switch to use another bridge when needed."
      ),
      bridgeId: getString("torPreferences.bridgeId", "#1 bridge: #2"),
      remove: getString("torPreferences.remove", "Remove"),
      bridgeDisableBuiltIn: getString(
        "torPreferences.bridgeDisableBuiltIn",
        "Disable built-in bridges"
      ),
      bridgeShare: getString(
        "torPreferences.bridgeShare",
        "Share this bridge using the QR code or by copying its address:"
      ),
      bridgeCopy: getString("torPreferences.bridgeCopy", "Copy Bridge Address"),
      copied: getString("torPreferences.copied", "Copied!"),
      bridgeShowAll: getString(
        "torPreferences.bridgeShowAll",
        "Show All Bridges"
      ),
      bridgeRemoveAll: getString(
        "torPreferences.bridgeRemoveAll",
        "Remove All Bridges"
      ),
      bridgeAdd: getString("torPreferences.bridgeAdd", "Add a New Bridge"),
      bridgeSelectBrowserBuiltin: getString(
        "torPreferences.bridgeSelectBrowserBuiltin",
        "Choose from one of Tor Browser’s built-in bridges"
      ),
      bridgeSelectBuiltin: getString(
        "torPreferences.bridgeSelectBuiltin",
        "Select a Built-In Bridge\u2026"
      ),
      bridgeRequestFromTorProject: getString(
        "torsettings.useBridges.bridgeDB",
        "Request a bridge from torproject.org"
      ),
      bridgeRequest: getString(
        "torPreferences.bridgeRequest",
        "Request a Bridge\u2026"
      ),
      bridgeEnterKnown: getString(
        "torPreferences.bridgeEnterKnown",
        "Enter a bridge address you already know"
      ),
      bridgeAddManually: getString(
        "torPreferences.bridgeAddManually",
        "Add a Bridge Manually\u2026"
      ),
      // Advanced settings
      advancedHeading: getString("torPreferences.advanced", "Advanced"),
      advancedLabel: getString(
        "torPreferences.advancedDescription",
        "Configure how Tor Browser connects to the internet"
      ),
      advancedButton: getString(
        "torPreferences.advancedButton",
        "Settings\u2026"
      ),
      showTorDaemonLogs: getString(
        "torPreferences.viewTorLogs",
        "View the Tor logs"
      ),
      showLogs: getString("torPreferences.viewLogs", "View Logs\u2026"),
      // Remove all bridges dialog
      removeBridgesQuestion: getString(
        "torPreferences.removeBridgesQuestion",
        "Remove all the bridges?"
      ),
      removeBridgesWarning: getString(
        "torPreferences.removeBridgesWarning",
        "This action cannot be undone."
      ),
      cancel: getString("torPreferences.cancel", "Cancel"),
      // Scan bridge QR dialog
      scanQrTitle: getString("torPreferences.scanQrTitle", "Scan the QR code"),
      // Builtin bridges dialog
      builtinBridgeTitle: getString(
        "torPreferences.builtinBridgeTitle",
        "Built-In Bridges"
      ),
      builtinBridgeHeader: getString(
        "torPreferences.builtinBridgeHeader",
        "Select a Built-In Bridge"
      ),
      builtinBridgeDescription: getString(
        "torPreferences.builtinBridgeDescription",
        "Tor Browser includes some specific types of bridges known as “pluggable transports”."
      ),
      builtinBridgeObfs4: getString(
        "torPreferences.builtinBridgeObfs4",
        "obfs4"
      ),
      builtinBridgeObfs4Description: getString(
        "torPreferences.builtinBridgeObfs4Description",
        "obfs4 is a type of built-in bridge that makes your Tor traffic look random. They are also less likely to be blocked than their predecessors, obfs3 bridges."
      ),
      builtinBridgeSnowflake: getString(
        "torPreferences.builtinBridgeSnowflake",
        "Snowflake"
      ),
      builtinBridgeSnowflakeDescription: getString(
        "torPreferences.builtinBridgeSnowflakeDescription",
        "Snowflake is a built-in bridge that defeats censorship by routing your connection through Snowflake proxies, ran by volunteers."
      ),
      builtinBridgeMeekAzure: getString(
        "torPreferences.builtinBridgeMeekAzure",
        "meek-azure"
      ),
      builtinBridgeMeekAzureDescription: getString(
        "torPreferences.builtinBridgeMeekAzureDescription",
        "meek-azure is a built-in bridge that makes it look like you are using a Microsoft web site instead of using Tor."
      ),
      // Request bridges dialog
      requestBridgeDialogTitle: getString(
        "torPreferences.requestBridgeDialogTitle",
        "Request Bridge"
      ),
      submitCaptcha: getString(
        "torsettings.useBridges.captchaSubmit",
        "Submit"
      ),
      contactingBridgeDB: getString(
        "torPreferences.requestBridgeDialogWaitPrompt",
        "Contacting BridgeDB. Please Wait."
      ),
      solveTheCaptcha: getString(
        "torPreferences.requestBridgeDialogSolvePrompt",
        "Solve the CAPTCHA to request a bridge."
      ),
      captchaTextboxPlaceholder: getString(
        "torsettings.useBridges.captchaSolution.placeholder",
        "Enter the characters from the image"
      ),
      incorrectCaptcha: getString(
        "torPreferences.requestBridgeErrorBadSolution",
        "The solution is not correct. Please try again."
      ),
      // Provide bridge dialog
      provideBridgeTitle: getString(
        "torPreferences.provideBridgeTitle",
        "Provide Bridge"
      ),
      provideBridgeHeader: getString(
        "torPreferences.provideBridgeHeader",
        "Enter bridge information from a trusted source"
      ),
      provideBridgePlaceholder: getString(
        "torsettings.bridgePlaceholder",
        "type address:port (one per line)"
      ),
      // Connection settings dialog
      connectionSettingsDialogTitle: getString(
        "torPreferences.connectionSettingsDialogTitle",
        "Connection Settings"
      ),
      connectionSettingsDialogHeader: getString(
        "torPreferences.connectionSettingsDialogHeader",
        "Configure how Tor Browser connects to the Internet"
      ),
      useLocalProxy: getString(
        "torsettings.useProxy.checkbox",
        "I use a proxy to connect to the Internet"
      ),
      proxyType: getString("torsettings.useProxy.type", "Proxy Type"),
      proxyTypeSOCKS4: getString("torsettings.useProxy.type.socks4", "SOCKS4"),
      proxyTypeSOCKS5: getString("torsettings.useProxy.type.socks5", "SOCKS5"),
      proxyTypeHTTP: getString("torsettings.useProxy.type.http", "HTTP/HTTPS"),
      proxyAddress: getString("torsettings.useProxy.address", "Address"),
      proxyAddressPlaceholder: getString(
        "torsettings.useProxy.address.placeholder",
        "IP address or hostname"
      ),
      proxyPort: getString("torsettings.useProxy.port", "Port"),
      proxyUsername: getString("torsettings.useProxy.username", "Username"),
      proxyPassword: getString("torsettings.useProxy.password", "Password"),
      proxyUsernamePasswordPlaceholder: getString(
        "torsettings.optional",
        "Optional"
      ),
      useFirewall: getString(
        "torsettings.firewall.checkbox",
        "This computer goes through a firewall that only allows connections to certain ports"
      ),
      allowedPorts: getString(
        "torsettings.firewall.allowedPorts",
        "Allowed Ports"
      ),
      allowedPortsPlaceholder: getString(
        "torPreferences.firewallPortsPlaceholder",
        "Comma-seperated values"
      ),
      // Log dialog
      torLogDialogTitle: getString(
        "torPreferences.torLogsDialogTitle",
        "Tor Logs"
      ),
      copyLog: getString("torsettings.copyLog", "Copy Tor Log to Clipboard"),

      learnMoreTorBrowserURL: "about:manual#about",
      learnMoreBridgesURL: "about:manual#bridges",
      learnMoreBridgesCardURL: "about:manual#bridges_bridge-moji",
      learnMoreCircumventionURL: "about:manual#circumvention",
    };

    return retval;
  })() /* Tor Network Settings Strings */,

  torConnect: (() => {
    const tsbNetwork = new TorDTDStringBundle(
      ["chrome://torlauncher/locale/network-settings.dtd"],
      ""
    );
    const tsbLauncher = new TorPropertyStringBundle(
      "chrome://torlauncher/locale/torlauncher.properties",
      "torlauncher."
    );
    const tsbCommon = new TorPropertyStringBundle(
      "chrome://global/locale/commonDialogs.properties",
      ""
    );

    const getStringNet = tsbNetwork.getString.bind(tsbNetwork);
    const getStringLauncher = tsbLauncher.getString.bind(tsbLauncher);
    const getStringCommon = tsbCommon.getString.bind(tsbCommon);

    return {
      torConnect: getStringNet(
        "torsettings.wizard.title.default",
        "Connect to Tor"
      ),

      torConnecting: getStringNet(
        "torsettings.wizard.title.connecting",
        "Establishing a Connection"
      ),

      torNotConnectedConcise: getStringNet(
        "torConnect.notConnectedConcise",
        "Not Connected"
      ),

      torConnectingConcise: getStringNet(
        "torConnect.connectingConcise",
        "Connecting…"
      ),

      tryingAgain: getStringNet("torConnect.tryingAgain", "Trying again…"),

      noInternet: getStringNet(
        "torConnect.noInternet",
        "Tor Browser couldn’t reach the Internet"
      ),

      noInternetDescription: getStringNet(
        "torConnect.noInternetDescription",
        "This could be due to a connection issue rather than Tor being blocked. Check your Internet connection, proxy and firewall settings before trying again."
      ),

      torBootstrapFailed: getStringLauncher(
        "tor_bootstrap_failed",
        "Tor failed to establish a Tor network connection."
      ),

      couldNotConnect: getStringNet(
        "torConnect.couldNotConnect",
        "Tor Browser could not connect to Tor"
      ),

      configureConnection: getStringNet(
        "torConnect.assistDescriptionConfigure",
        "configure your connection"
      ),

      assistDescription: getStringNet(
        "torConnect.assistDescription",
        "If Tor is blocked in your location, trying a bridge may help. Connection assist can choose one for you using your location, or you can #1 manually instead."
      ),

      tryingBridge: getStringNet("torConnect.tryingBridge", "Trying a bridge…"),

      tryingBridgeAgain: getStringNet(
        "torConnect.tryingBridgeAgain",
        "Trying one more time…"
      ),

      errorLocation: getStringNet(
        "torConnect.errorLocation",
        "Tor Browser couldn’t locate you"
      ),

      errorLocationDescription: getStringNet(
        "torConnect.errorLocationDescription",
        "Tor Browser needs to know your location in order to choose the right bridge for you. If you’d rather not share your location, #1 manually instead."
      ),

      isLocationCorrect: getStringNet(
        "torConnect.isLocationCorrect",
        "Are these location settings correct?"
      ),

      isLocationCorrectDescription: getStringNet(
        "torConnect.isLocationCorrectDescription",
        "Tor Browser still couldn’t connect to Tor. Please check your location settings are correct and try again, or #1 instead."
      ),

      finalError: getStringNet(
        "torConnect.finalError",
        "Tor Browser still cannot connect"
      ),

      finalErrorDescription: getStringNet(
        "torConnect.finalErrorDescription",
        "Despite its best efforts, connection assist was not able to connect to Tor. Try troubleshooting your connection and adding a bridge manually instead."
      ),

      breadcrumbAssist: getStringNet(
        "torConnect.breadcrumbAssist",
        "Connection assist"
      ),

      breadcrumbLocation: getStringNet(
        "torConnect.breadcrumbLocation",
        "Location settings"
      ),

      breadcrumbTryBridge: getStringNet(
        "torConnect.breadcrumbTryBridge",
        "Try a bridge"
      ),

      restartTorBrowser: getStringNet(
        "torConnect.restartTorBrowser",
        "Restart Tor Browser"
      ),

      torConfigure: getStringNet(
        "torConnect.configureConnection",
        "Configure Connection…"
      ),

      viewLog: getStringNet("torConnect.viewLog", "View logs…"),

      torConnectButton: getStringNet("torSettings.connect", "Connect"),

      cancel: getStringCommon("Cancel", "Cancel"),

      torConnected: getStringLauncher(
        "torlauncher.bootstrapStatus.done",
        "Connected to the Tor network"
      ),

      torConnectedConcise: getStringLauncher(
        "torConnect.connectedConcise",
        "Connected"
      ),

      tryAgain: getStringNet("torConnect.tryAgain", "Try Again"),

      // tor connect strings for message box in about:preferences#connection
      connectMessage: getStringNet(
        "torConnect.connectMessage",
        "Changes to Tor Settings will not take effect until you connect"
      ),
      tryAgainMessage: getStringNet(
        "torConnect.tryAgainMessage",
        "Tor Browser has failed to establish a connection to the Tor Network"
      ),

      yourLocation: getStringNet("torConnect.yourLocation", "Your Location"),

      tryBridge: getStringNet("torConnect.tryBridge", "Try a Bridge"),

      automatic: getStringNet("torConnect.automatic", "Automatic"),
      selectCountryRegion: getStringNet(
        "torConnect.selectCountryRegion",
        "Select Country or Region"
      ),
      frequentLocations: getStringNet(
        "torConnect.frequentLocations",
        "Frequently selected locations"
      ),
      otherLocations: getStringNet(
        "torConnect.otherLocations",
        "Other locations"
      ),

      // TorConnect.jsm error messages
      offline: getStringNet("torConnect.offline", "Internet not reachable"),
      autoBootstrappingFailed: getStringNet(
        "torConnect.autoBootstrappingFailed",
        "Automatic configuration failed"
      ),
      autoBootstrappingAllFailed: getStringNet(
        "torConnect.autoBootstrappingFailed",
        "None of the configurations we tried worked"
      ),
      cannotDetermineCountry: getStringNet(
        "torConnect.cannotDetermineCountry",
        "Unable to determine user country"
      ),
      noSettingsForCountry: getStringNet(
        "torConnect.noSettingsForCountry",
        "No settings available for your location"
      ),
    };
  })(),

  /*
    Tor Onion Services Strings, e.g., for the authentication prompt.
  */
  onionServices: (function() {
    let tsb = new TorPropertyStringBundle(
      "chrome://torbutton/locale/torbutton.properties",
      "onionServices."
    );
    let getString = function(key, fallback) {
      return tsb.getString(key, fallback);
    };

    const kProblemLoadingSiteFallback = "Problem Loading Onionsite";
    const kLongDescFallback = "Details: %S";

    let retval = {
      learnMore: getString("learnMore", "Learn more"),
      learnMoreURL: `https://support.torproject.org/${getLocale()}/onionservices/client-auth/`,
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
  })() /* Tor Onion Services Strings */,

  /*
    OnionLocation
  */
  onionLocation: (function() {
    const tsb = new TorPropertyStringBundle(
      ["chrome://torbutton/locale/torbutton.properties"],
      "onionLocation."
    );
    const getString = function(key, fallback) {
      return tsb.getString(key, fallback);
    };

    const retval = {
      alwaysPrioritize: getString(
        "alwaysPrioritize",
        "Always Prioritize Onionsites"
      ),
      alwaysPrioritizeAccessKey: getString("alwaysPrioritizeAccessKey", "a"),
      notNow: getString("notNow", "Not Now"),
      notNowAccessKey: getString("notNowAccessKey", "n"),
      description: getString(
        "description",
        "Website publishers can protect users by adding a security layer. This prevents eavesdroppers from knowing that you are the one visiting that website."
      ),
      tryThis: getString("tryThis", "Try this: Onionsite"),
      onionAvailable: getString("onionAvailable", "Onionsite available"),
      learnMore: getString("learnMore", "Learn more"),
      learnMoreURL: "about:manual#onion-services",
      // XUL popups cannot open about: URLs, but we are online when showing the notification, so just use the online version
      learnMoreURLNotification: `https://tb-manual.torproject.org/${getLocale()}/onion-services/`,
      always: getString("always", "Always"),
      askEverytime: getString("askEverytime", "Ask you every time"),
      prioritizeOnionsDescription: getString(
        "prioritizeOnionsDescription",
        "Prioritize onionsites when they are available."
      ),
      onionServicesTitle: getString("onionServicesTitle", "Onion Services"),
    };

    return retval;
  })() /* OnionLocation */,

  /*
    Rulesets
  */
  rulesets: (() => {
    const tsb = new TorPropertyStringBundle(
      ["chrome://torbutton/locale/torbutton.properties"],
      "rulesets."
    );
    const getString /*(key, fallback)*/ = tsb.getString;

    const retval = {
      // Initial warning
      warningTitle: getString("warningTitle", "Proceed with Caution"),
      warningDescription: getString(
        "warningDescription",
        "Adding or modifying rulesets can cause attackers to hijack your browser. Proceed only if you know what you are doing."
      ),
      warningEnable: getString(
        "warningEnable",
        "Warn me when I attempt to access these preferences"
      ),
      warningButton: getString("warningButton", "Accept the Risk and Continue"),
      // Ruleset list
      rulesets: getString("rulesets", "Rulesets"),
      noRulesets: getString("noRulesets", "No rulesets found"),
      noRulesetsDescr: getString(
        "noRulesetsDescr",
        "When you save a ruleset in Tor Browser, it will show up here."
      ),
      lastUpdated: getString("lastUpdated", "Last updated %S"),
      neverUpdated: getString(
        "neverUpdated",
        "Never updated, or last update failed"
      ),
      enabled: getString("enabled", "Enabled"),
      disabled: getString("disabled", "Disabled"),
      // Ruleset details
      edit: getString("edit", "Edit"),
      name: getString("name", "Name"),
      jwk: getString("jwk", "JWK"),
      pathPrefix: getString("pathPrefix", "Path Prefix"),
      scope: getString("scope", "Scope"),
      enable: getString("enable", "Enable this ruleset"),
      checkUpdates: getString("checkUpdates", "Check for Updates"),
      // Add ruleset
      jwkPlaceholder: getString(
        "jwkPlaceholder",
        "The key used to sign this ruleset in the JWK (JSON Web Key) format"
      ),
      jwkInvalid: getString(
        "jwkInvalid",
        "The JWK could not be parsed, or it is not a valid key"
      ),
      pathPrefixPlaceholder: getString(
        "pathPrefixPlaceholder",
        "URL prefix that contains the files needed by the ruleset"
      ),
      pathPrefixInvalid: getString(
        "pathPrefixInvalid",
        "The path prefix is not a valid HTTP(S) URL"
      ),
      scopePlaceholder: getString(
        "scopePlaceholder",
        "Regular expression for the scope of the rules"
      ),
      scopeInvalid: getString(
        "scopeInvalid",
        "The scope could not be parsed as a regular expression"
      ),
      save: getString("save", "Save"),
      cancel: getString("cancel", "Cancel"),
    };

    return retval;
  })() /* Rulesets */,

  /*
    Tor Deamon Configuration Key Strings
  */

  // TODO: proper camel case
  configKeys: {
    /* Bridge Conf Settings */
    useBridges: "UseBridges",
    bridgeList: "Bridge",
    /* Proxy Conf Strings */
    socks4Proxy: "Socks4Proxy",
    socks5Proxy: "Socks5Proxy",
    socks5ProxyUsername: "Socks5ProxyUsername",
    socks5ProxyPassword: "Socks5ProxyPassword",
    httpsProxy: "HTTPSProxy",
    httpsProxyAuthenticator: "HTTPSProxyAuthenticator",
    /* Firewall Conf Strings */
    reachableAddresses: "ReachableAddresses",

    /* BridgeDB Strings */
    clientTransportPlugin: "ClientTransportPlugin",
  },

  /*
    about:config preference keys
  */

  preferenceKeys: {
    defaultBridgeType: "extensions.torlauncher.default_bridge_type",
    recommendedBridgeType:
      "extensions.torlauncher.default_bridge_recommended_type",
  },

  /*
    about:config preference branches
  */
  preferenceBranches: {
    defaultBridge: "extensions.torlauncher.default_bridge.",
    bridgeDBBridges: "extensions.torlauncher.bridgedb_bridge.",
  },
};
