// Copyright (c) 2021, The Tor Project, Inc.

var EXPORTED_SYMBOLS = ["TorConnectParent"];

const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");
const { TorStrings } = ChromeUtils.import("resource:///modules/TorStrings.jsm");
const { TorConnect, TorConnectTopics, TorConnectState, TorCensorshipLevel } = ChromeUtils.import(
  "resource:///modules/TorConnect.jsm"
);
const { TorSettings, TorSettingsTopics, TorSettingsData } = ChromeUtils.import(
  "resource:///modules/TorSettings.jsm"
);

/*
This object is basically a marshalling interface between the TorConnect module
and a particular about:torconnect page
*/

class TorConnectParent extends JSWindowActorParent {
  constructor(...args) {
    super(...args);

    const self = this;

    this.state = {
      State: TorConnect.state,
      DetectedCensorshiplevel: TorConnect.detectedCensorshiplevel,
      StateChanged: false,
      ErrorMessage: TorConnect.errorMessage,
      ErrorDetails: TorConnect.errorDetails,
      BootstrapProgress: TorConnect.bootstrapProgress,
      BootstrapStatus: TorConnect.bootstrapStatus,
      ShowViewLog: TorConnect.logHasWarningOrError,
      QuickStartEnabled: TorSettings.quickstart.enabled,
      CountryCodes: TorConnect.countryCodes,
    };

    // JSWindowActiveParent derived objects cannot observe directly, so create a member
    // object to do our observing for us
    //
    // This object converts the various lifecycle events from the TorConnect module, and
    // maintains a state object which we pass down to our about:torconnect page, which uses
    // the state object to update its UI
    this.torConnectObserver = {
      observe(aSubject, aTopic, aData) {
        let obj = aSubject?.wrappedJSObject;

        // update our state struct based on received torconnect topics and forward on
        // to aboutTorConnect.js
        self.state.StateChanged = false;
        switch (aTopic) {
          case TorConnectTopics.StateChange: {
            self.state.State = obj.state;
            self.state.StateChanged = true;

            // clear any previous error information if we are bootstrapping
            if (self.state.State === TorConnectState.Bootstrapping) {
              self.state.ErrorMessage = null;
              self.state.ErrorDetails = null;
            }
            break;
          }
          case TorConnectTopics.BootstrapProgress: {
            self.state.BootstrapProgress = obj.progress;
            self.state.BootstrapStatus = obj.status;
            self.state.ShowViewLog = obj.hasWarnings;
            break;
          }
          case TorConnectTopics.BootstrapComplete: {
            // noop
            break;
          }
          case TorConnectTopics.BootstrapError: {
            self.state.ErrorMessage = obj.message;
            self.state.ErrorDetails = obj.details;
            self.state.DetectedCensorshiplevel = obj.censorshipLevel;

            // With severe censorshp, we offer user list of countries to try
            if (self.state.DetectedCensorshiplevel == TorCensorshipLevel.Severe) {
              self.state.CountryCodes = TorConnect.countryCodes;
            }

            self.state.ShowViewLog = true;
            break;
          }
          case TorConnectTopics.FatalError: {
            // TODO: handle
            break;
          }
          case TorSettingsTopics.SettingChanged: {
            if (aData === TorSettingsData.QuickStartEnabled) {
              self.state.QuickStartEnabled = obj.value;
            } else {
              // this isn't a setting torconnect cares about
              return;
            }
            break;
          }
          default: {
            console.log(`TorConnect: unhandled observe topic '${aTopic}'`);
          }
        }

        self.sendAsyncMessage("torconnect:state-change", self.state);
      },
    };

    // observe all of the torconnect:.* topics
    for (const key in TorConnectTopics) {
      const topic = TorConnectTopics[key];
      Services.obs.addObserver(this.torConnectObserver, topic);
    }
    Services.obs.addObserver(
      this.torConnectObserver,
      TorSettingsTopics.SettingChanged
    );
  }

  willDestroy() {
    // stop observing all of our torconnect:.* topics
    for (const key in TorConnectTopics) {
      const topic = TorConnectTopics[key];
      Services.obs.removeObserver(this.torConnectObserver, topic);
    }
    Services.obs.removeObserver(
      this.torConnectObserver,
      TorSettingsTopics.SettingChanged
    );
  }

  async receiveMessage(message) {
    switch (message.name) {
      case "torconnect:set-quickstart":
        TorSettings.quickstart.enabled = message.data;
        TorSettings.saveToPrefs().applySettings();
        break;
      case "torconnect:open-tor-preferences":
        TorConnect.openTorPreferences();
        break;
      case "torconnect:view-tor-logs":
        TorConnect.viewTorLogs();
        break;
      case "torconnect:cancel-bootstrap":
        TorConnect.cancelBootstrap();
        break;
      case "torconnect:begin-bootstrap":
        TorConnect.beginBootstrap();
        break;
      case "torconnect:begin-autobootstrap":
        TorConnect.beginAutoBootstrap(message.data);
        break;
      case "torconnect:restart":
        Services.startup.quit(
          Ci.nsIAppStartup.eRestart | Ci.nsIAppStartup.eAttemptQuit
        );
        break;
      case "torconnect:get-init-args":
        // called on AboutTorConnect.init(), pass down all state data it needs to init

        // pretend this is a state transition on init
        // so we always get fresh UI
        this.state.StateChanged = true;
        return {
          TorStrings,
          TorConnectState,
          TorCensorshipLevel,
          Direction: Services.locale.isAppLocaleRTL ? "rtl" : "ltr",
          State: this.state,
          CountryNames: TorConnect.countryNames,
        };
      case "torconnect:get-country-codes":
        return TorConnect.getCountryCodes();
    }
    return undefined;
  }
}
