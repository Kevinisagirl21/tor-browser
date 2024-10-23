// Copyright (c) 2021, The Tor Project, Inc.

import { TorStrings } from "resource://gre/modules/TorStrings.sys.mjs";
import {
  TorConnect,
  TorConnectTopics,
} from "resource://gre/modules/TorConnect.sys.mjs";
import {
  TorSettings,
  TorSettingsTopics,
} from "resource://gre/modules/TorSettings.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  HomePage: "resource:///modules/HomePage.sys.jsm",
});

/*
This object is basically a marshalling interface between the TorConnect module
and a particular about:torconnect page
*/

/**
 * Actor parent class for the about:torconnect page.
 * It adapts and relays the messages from and to the TorConnect module.
 */
export class TorConnectParent extends JSWindowActorParent {
  constructor(...args) {
    super(...args);

    const self = this;

    // JSWindowActiveParent derived objects cannot observe directly, so create a
    // member object to do our observing for us.
    //
    // This object converts the various lifecycle events from the TorConnect
    // module, and maintains a state object which we pass down to our
    // about:torconnect page, which uses the state object to update its UI.
    this.torConnectObserver = {
      observe(subject, topic) {
        const obj = subject?.wrappedJSObject;
        switch (topic) {
          case TorConnectTopics.StageChange:
            self.sendAsyncMessage("torconnect:stage-change", obj);
            break;
          case TorConnectTopics.BootstrapProgress:
            self.sendAsyncMessage("torconnect:bootstrap-progress", obj);
            break;
          case TorSettingsTopics.SettingsChanged:
            if (!obj.changes.includes("quickstart.enabled")) {
              break;
            }
          // eslint-disable-next-lined no-fallthrough
          case TorSettingsTopics.Ready:
            self.sendAsyncMessage(
              "torconnect:quickstart-changed",
              TorSettings.quickstart.enabled
            );
            break;
        }
      },
    };

    Services.obs.addObserver(
      this.torConnectObserver,
      TorConnectTopics.StageChange
    );
    Services.obs.addObserver(
      this.torConnectObserver,
      TorConnectTopics.BootstrapProgress
    );
    Services.obs.addObserver(this.torConnectObserver, TorSettingsTopics.Ready);
    Services.obs.addObserver(
      this.torConnectObserver,
      TorSettingsTopics.SettingsChanged
    );
  }

  willDestroy() {
    Services.obs.removeObserver(
      this.torConnectObserver,
      TorConnectTopics.StageChange
    );
    Services.obs.removeObserver(
      this.torConnectObserver,
      TorConnectTopics.BootstrapProgress
    );
    Services.obs.removeObserver(
      this.torConnectObserver,
      TorSettingsTopics.Ready
    );
    Services.obs.removeObserver(
      this.torConnectObserver,
      TorSettingsTopics.SettingsChanged
    );
  }

  async receiveMessage(message) {
    switch (message.name) {
      case "torconnect:should-show":
        return Promise.resolve(TorConnect.shouldShowTorConnect);
      case "torconnect:home-page":
        // If there are multiple home pages, just load the first one.
        return Promise.resolve(TorConnect.fixupURIs(lazy.HomePage.get())[0]);
      case "torconnect:set-quickstart":
        TorSettings.quickstart.enabled = message.data;
        TorSettings.saveToPrefs().applySettings();
        break;
      case "torconnect:open-tor-preferences":
        this.browsingContext.top.embedderElement.ownerGlobal.openPreferences(
          "connection"
        );
        break;
      case "torconnect:view-tor-logs":
        this.browsingContext.top.embedderElement.ownerGlobal.openPreferences(
          "connection-viewlogs"
        );
        break;
      case "torconnect:restart":
        Services.startup.quit(
          Ci.nsIAppStartup.eRestart | Ci.nsIAppStartup.eAttemptQuit
        );
        break;
      case "torconnect:start-again":
        TorConnect.startAgain();
        break;
      case "torconnect:choose-region":
        TorConnect.chooseRegion();
        break;
      case "torconnect:begin-bootstrapping":
        TorConnect.beginBootstrapping(message.data.regionCode);
        break;
      case "torconnect:cancel-bootstrapping":
        TorConnect.cancelBootstrapping();
        break;
      case "torconnect:get-init-args": {
        // Called on AboutTorConnect.init(), pass down all state data it needs
        // to init.

        let quickstartEnabled = false;

        // Workaround for a race condition, but we should fix it asap.
        // about:torconnect is loaded before TorSettings is actually initialized.
        // The getter might throw and the page not loaded correctly as a result.
        // Silence any warning for now, but we should really fix it.
        // See also tor-browser#41921.
        try {
          quickstartEnabled = TorSettings.quickstart.enabled;
        } catch (e) {
          // Do not throw.
        }

        return {
          TorStrings,
          Direction: Services.locale.isAppLocaleRTL ? "rtl" : "ltr",
          CountryNames: TorConnect.countryNames,
          stage: TorConnect.stage,
          quickstartEnabled,
        };
      }
      case "torconnect:get-country-codes":
        return TorConnect.getCountryCodes();
    }
    return undefined;
  }
}
