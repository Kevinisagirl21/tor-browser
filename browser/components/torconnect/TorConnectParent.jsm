// Copyright (c) 2021, The Tor Project, Inc.

var EXPORTED_SYMBOLS = ["TorConnectParent"];

const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");
const { TorStrings } = ChromeUtils.import("resource:///modules/TorStrings.jsm");
const {
  InternetStatus,
  TorConnect,
  TorConnectTopics,
  TorConnectState,
} = ChromeUtils.import("resource:///modules/TorConnect.jsm");
const { TorSettings, TorSettingsTopics, TorSettingsData } = ChromeUtils.import(
  "resource:///modules/TorSettings.jsm"
);

const BroadcastTopic = "about-torconnect:broadcast";

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
      StateChanged: false,
      PreviousState: TorConnectState.Initial,
      ErrorMessage: TorConnect.errorMessage,
      ErrorDetails: TorConnect.errorDetails,
      BootstrapProgress: TorConnect.bootstrapProgress,
      BootstrapStatus: TorConnect.bootstrapStatus,
      InternetStatus: TorConnect.internetStatus,
      DetectedLocation: TorConnect.detectedLocation,
      ShowViewLog: TorConnect.logHasWarningOrError,
      HasEverFailed: TorConnect.hasEverFailed,
      QuickStartEnabled: TorSettings.quickstart.enabled,
      UIState: TorConnect.uiState,
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
            self.state.PreviousState = self.state.State;
            self.state.State = obj.state;
            self.state.StateChanged = true;

            // clear any previous error information if we are bootstrapping
            if (self.state.State === TorConnectState.Bootstrapping) {
              self.state.ErrorMessage = null;
              self.state.ErrorDetails = null;
            }
            self.state.HasEverFailed = TorConnect.hasEverFailed;
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
            self.state.InternetStatus = TorConnect.internetStatus;
            self.state.DetectedLocation = TorConnect.detectedLocation;
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

    this.userActionObserver = {
      observe(aSubject, aTopic, aData) {
        let obj = aSubject?.wrappedJSObject;
        if (obj) {
          obj.connState = self.state;
          self.sendAsyncMessage("torconnect:user-action", obj);
        }
      },
    };
    Services.obs.addObserver(this.userActionObserver, BroadcastTopic);
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
    Services.obs.removeObserver(this.userActionObserver, BroadcastTopic);
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
      case "torconnect:cancel-bootstrap":
        TorConnect.cancelBootstrap();
        break;
      case "torconnect:begin-bootstrap":
        TorConnect.beginBootstrap();
        break;
      case "torconnect:begin-autobootstrap":
        TorConnect.beginAutoBootstrap(message.data);
        break;
      case "torconnect:view-tor-logs":
        TorConnect.viewTorLogs();
        break;
      case "torconnect:restart":
        Services.startup.quit(
          Ci.nsIAppStartup.eRestart | Ci.nsIAppStartup.eAttemptQuit
        );
        break;
      case "torconnect:set-ui-state":
        TorConnect.uiState = message.data;
        this.state.UIState = TorConnect.uiState;
        break;
      case "torconnect:broadcast-user-action":
        Services.obs.notifyObservers(message.data, BroadcastTopic);
        break;
      case "torconnect:get-init-args":
        // called on AboutTorConnect.init(), pass down all state data it needs to init

        // pretend this is a state transition on init
        // so we always get fresh UI
        this.state.StateChanged = true;
        this.state.UIState = TorConnect.uiState;
        return {
          TorStrings,
          TorConnectState,
          InternetStatus,
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
