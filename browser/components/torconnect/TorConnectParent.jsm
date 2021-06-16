// Copyright (c) 2021, The Tor Project, Inc.

var EXPORTED_SYMBOLS = ["TorConnectParent"];

const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");
const { TorProtocolService } = ChromeUtils.import(
  "resource:///modules/TorProtocolService.jsm"
);
const { TorStrings } = ChromeUtils.import("resource:///modules/TorStrings.jsm");
const { TorLauncherUtil } = ChromeUtils.import(
  "resource://torlauncher/modules/tl-util.jsm"
);

const kTorProcessReadyTopic = "TorProcessIsReady";
const kTorProcessExitedTopic = "TorProcessExited";
const kTorProcessDidNotStartTopic = "TorProcessDidNotStart";
const kTorShowProgressPanelTopic = "TorShowProgressPanel";
const kTorBootstrapStatusTopic = "TorBootstrapStatus";
const kTorBootstrapErrorTopic = "TorBootstrapError";
const kTorLogHasWarnOrErrTopic = "TorLogHasWarnOrErr";

const gActiveTopics = [
  kTorProcessReadyTopic,
  kTorProcessExitedTopic,
  kTorProcessDidNotStartTopic,
  kTorShowProgressPanelTopic,
  kTorBootstrapStatusTopic,
  kTorBootstrapErrorTopic,
  kTorLogHasWarnOrErrTopic,
];

const gTorLauncherPrefs = {
  quickstart: "extensions.torlauncher.quickstart",
}

class TorConnectParent extends JSWindowActorParent {
  constructor(...args) {
    super(...args);

    const self = this;
    this.gObserver = {
      observe(aSubject, aTopic, aData) {
        const obj = aSubject?.wrappedJSObject;
        if (obj) {
          obj.handled = true;
        }
        self.sendAsyncMessage(aTopic, obj);

        // we need to tell the IOService that we are not online
        // setting offline to false will make the io service send out
        // 'network:offline-status-changed' message to observers
        // the app updater (among other things) listens for this message
        // and will attempt to check for updates when receiving this message
        // to recover from a previously failed attempt
        if (aTopic === kTorBootstrapStatusTopic &&
            obj.PROGRESS === 100) {
          Services.io.offline = false;
        }
      },
    };

    for (const topic of gActiveTopics) {
      Services.obs.addObserver(this.gObserver, topic);
    }

    this.quickstartObserver = {
      observe(aSubject, aTopic, aData) {
        if (aTopic === "nsPref:changed" &&
            aData == gTorLauncherPrefs.quickstart) {
          self.sendAsyncMessage("TorQuickstartPrefChanged", Services.prefs.getBoolPref(gTorLauncherPrefs.quickstart));
        }
      },
    }
    Services.prefs.addObserver(gTorLauncherPrefs.quickstart, this.quickstartObserver);
  }

  willDestroy() {
    for (const topic of gActiveTopics) {
      Services.obs.removeObserver(this.gObserver, topic);
    }
  }

  get browser() {
    return this.browsingContext.top.embedderElement;
  }

  _OpenTorAdvancedPreferences() {
    const win = this.browsingContext.top.embedderElement.ownerGlobal;
    win.openTrustedLinkIn("about:preferences#tor", "tab");
  }

  _TorCopyLog() {
    // Copy tor log messages to the system clipboard.
    const chSvc = Cc["@mozilla.org/widget/clipboardhelper;1"].getService(
      Ci.nsIClipboardHelper
    );
    const countObj = { value: 0 };
    chSvc.copyString(TorProtocolService.getLog(countObj));
    const count = countObj.value;
    return TorLauncherUtil.getFormattedLocalizedString(
      "copiedNLogMessagesShort",
      [count],
      1
    );
  }

  _GoToBrowserHome() {
    const window = this.browser.ownerGlobal;
    window.BrowserHome();
  }

  receiveMessage(message) {
    switch (message.name) {
      case "TorBootstrapErrorOccurred":
        return TorProtocolService.torBootstrapErrorOccurred();
      case "TorRetrieveBootstrapStatus":
        return TorProtocolService.retrieveBootstrapStatus();
      case "OpenTorAdvancedPreferences":
        return this._OpenTorAdvancedPreferences();
      case "GoToBrowserHome":
        return this._GoToBrowserHome();
      case "GetLocalizedBootstrapStatus":
        const { status, keyword } = message.data;
        return TorLauncherUtil.getLocalizedBootstrapStatus(status, keyword);
      case "TorCopyLog":
        return this._TorCopyLog();
      case "TorIsNetworkDisabled":
        return TorProtocolService.isNetworkDisabled();
      case "TorStopBootstrap":
        return TorProtocolService.torStopBootstrap();
      case "TorConnect":
        return TorProtocolService.connect();
      case "GetDirection":
        return Services.locale.isAppLocaleRTL ? "rtl" : "ltr";
      case "GetTorStrings":
        return TorStrings;
      case "TorLogHasWarnOrErr":
        return TorProtocolService.torLogHasWarnOrErr();
    }
    return undefined;
  }
}
