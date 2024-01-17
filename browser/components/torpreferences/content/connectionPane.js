// Copyright (c) 2022, The Tor Project, Inc.
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

"use strict";

/* global Services, gSubDialog */

const { setTimeout, clearTimeout } = ChromeUtils.import(
  "resource://gre/modules/Timer.jsm"
);

const { TorSettings, TorSettingsTopics, TorBridgeSource } =
  ChromeUtils.importESModule("resource://gre/modules/TorSettings.sys.mjs");

const { TorParsers } = ChromeUtils.importESModule(
  "resource://gre/modules/TorParsers.sys.mjs"
);
const { TorProviderBuilder, TorProviderTopics } = ChromeUtils.importESModule(
  "resource://gre/modules/TorProviderBuilder.sys.mjs"
);

const { TorConnect, TorConnectTopics, TorConnectState, TorCensorshipLevel } =
  ChromeUtils.importESModule("resource://gre/modules/TorConnect.sys.mjs");

const { TorLogDialog } = ChromeUtils.importESModule(
  "chrome://browser/content/torpreferences/torLogDialog.mjs"
);

const { ConnectionSettingsDialog } = ChromeUtils.importESModule(
  "chrome://browser/content/torpreferences/connectionSettingsDialog.mjs"
);

const { BridgeQrDialog } = ChromeUtils.importESModule(
  "chrome://browser/content/torpreferences/bridgeQrDialog.mjs"
);

const { BuiltinBridgeDialog } = ChromeUtils.importESModule(
  "chrome://browser/content/torpreferences/builtinBridgeDialog.mjs"
);

const { RequestBridgeDialog } = ChromeUtils.importESModule(
  "chrome://browser/content/torpreferences/requestBridgeDialog.mjs"
);

const { ProvideBridgeDialog } = ChromeUtils.importESModule(
  "chrome://browser/content/torpreferences/provideBridgeDialog.mjs"
);

const { MoatRPC } = ChromeUtils.importESModule(
  "resource://gre/modules/Moat.sys.mjs"
);

const { QRCode } = ChromeUtils.importESModule(
  "resource://gre/modules/QRCode.sys.mjs"
);

const { TorStrings } = ChromeUtils.importESModule(
  "resource://gre/modules/TorStrings.sys.mjs"
);

const InternetStatus = Object.freeze({
  Unknown: 0,
  Online: 1,
  Offline: -1,
});

/*
  Connection Pane

  Code for populating the XUL in about:preferences#connection, handling input events, interfacing with tor-launcher
*/
const gConnectionPane = (function () {
  /* CSS selectors for all of the Tor Network DOM elements we need to access */
  const selectors = {
    category: {
      title: "label#torPreferences-labelCategory",
    },
    torPreferences: {
      header: "h1#torPreferences-header",
      description: "span#torPreferences-description",
      learnMore: "label#torPreferences-learnMore",
    },
    quickstart: {
      header: "h2#torPreferences-quickstart-header",
      description: "span#torPreferences-quickstart-description",
      enableQuickstartCheckbox: "checkbox#torPreferences-quickstart-toggle",
    },
    bridges: {
      header: "h1#torPreferences-bridges-header",
      description: "span#torPreferences-bridges-description",
      learnMore: "label#torPreferences-bridges-learnMore",
      locationGroup: "#torPreferences-bridges-locationGroup",
      locationLabel: "#torPreferences-bridges-locationLabel",
      location: "#torPreferences-bridges-location",
      locationEntries: "#torPreferences-bridges-locationEntries",
      chooseForMe: "#torPreferences-bridges-buttonChooseBridgeForMe",
      addHeader: "#torPreferences-addBridge-header",
      addBuiltinLabel: "#torPreferences-addBridge-labelBuiltinBridge",
      addBuiltinButton: "#torPreferences-addBridge-buttonBuiltinBridge",
      requestLabel: "#torPreferences-addBridge-labelRequestBridge",
      requestButton: "#torPreferences-addBridge-buttonRequestBridge",
      enterLabel: "#torPreferences-addBridge-labelEnterBridge",
      enterButton: "#torPreferences-addBridge-buttonEnterBridge",
    },
    advanced: {
      header: "h1#torPreferences-advanced-header",
      label: "#torPreferences-advanced-label",
      button: "#torPreferences-advanced-button",
      torLogsLabel: "label#torPreferences-torLogs",
      torLogsButton: "button#torPreferences-buttonTorLogs",
    },
  }; /* selectors */

  const retval = {
    // cached frequently accessed DOM elements
    _enableQuickstartCheckbox: null,

    _internetStatus: InternetStatus.Unknown,

    // populate xul with strings and cache the relevant elements
    _populateXUL() {
      // saves tor settings to disk when navigate away from about:preferences
      window.addEventListener("blur", async () => {
        try {
          // Build a new provider each time because this might be called also
          // when closing the browser (if about:preferences was open), maybe
          // when the provider was already uninitialized.
          const provider = await TorProviderBuilder.build();
          provider.flushSettings();
        } catch (e) {
          console.warn("Could not save the tor settings.", e);
        }
      });

      document
        .querySelector(selectors.category.title)
        .setAttribute("value", TorStrings.settings.categoryTitle);

      const prefpane = document.getElementById("mainPrefPane");

      // Heading
      prefpane.querySelector(selectors.torPreferences.header).innerText =
        TorStrings.settings.categoryTitle;
      prefpane.querySelector(selectors.torPreferences.description).textContent =
        TorStrings.settings.torPreferencesDescription;
      {
        const learnMore = prefpane.querySelector(
          selectors.torPreferences.learnMore
        );
        learnMore.setAttribute("value", TorStrings.settings.learnMore);
        learnMore.setAttribute(
          "href",
          TorStrings.settings.learnMoreTorBrowserURL
        );
        if (TorStrings.settings.learnMoreTorBrowserURL.startsWith("about:")) {
          learnMore.setAttribute("useoriginprincipal", "true");
        }
      }

      // Internet and Tor status
      const internetStatus = document.getElementById(
        "torPreferences-status-internet"
      );
      internetStatus.querySelector(".torPreferences-status-name").textContent =
        TorStrings.settings.statusInternetLabel;
      const internetResult = internetStatus.querySelector(
        ".torPreferences-status-result"
      );
      const internetTest = document.getElementById(
        "torPreferences-status-internet-test"
      );
      internetTest.setAttribute(
        "label",
        TorStrings.settings.statusInternetTest
      );
      internetTest.addEventListener("command", () => {
        this.onInternetTest();
      });

      const torConnectStatus = document.getElementById(
        "torPreferences-status-tor-connect"
      );
      torConnectStatus.querySelector(
        ".torPreferences-status-name"
      ).textContent = TorStrings.settings.statusTorLabel;
      const torConnectResult = torConnectStatus.querySelector(
        ".torPreferences-status-result"
      );
      const torConnectButton = document.getElementById(
        "torPreferences-status-tor-connect-button"
      );
      torConnectButton.setAttribute(
        "label",
        TorStrings.torConnect.torConnectButton
      );
      torConnectButton.addEventListener("command", () => {
        TorConnect.openTorConnect({ beginBootstrap: true });
      });

      this._populateStatus = () => {
        switch (this._internetStatus) {
          case InternetStatus.Online:
            internetStatus.classList.remove("offline");
            internetResult.textContent =
              TorStrings.settings.statusInternetOnline;
            internetResult.hidden = false;
            break;
          case InternetStatus.Offline:
            internetStatus.classList.add("offline");
            internetResult.textContent =
              TorStrings.settings.statusInternetOffline;
            internetResult.hidden = false;
            break;
          case InternetStatus.Unknown:
          default:
            internetStatus.classList.remove("offline");
            internetResult.hidden = true;
            break;
        }
        // FIXME: What about the TorConnectState.Disabled state?
        if (TorConnect.state === TorConnectState.Bootstrapped) {
          torConnectStatus.classList.add("connected");
          torConnectStatus.classList.remove("blocked");
          torConnectResult.textContent = TorStrings.settings.statusTorConnected;
          // NOTE: If the button is focused when we hide it, the focus may be
          // lost. But we don't have an obvious place to put the focus instead.
          torConnectButton.hidden = true;
        } else {
          torConnectStatus.classList.remove("connected");
          torConnectStatus.classList.toggle(
            "blocked",
            TorConnect.potentiallyBlocked
          );
          torConnectResult.textContent = TorConnect.potentiallyBlocked
            ? TorStrings.settings.statusTorBlocked
            : TorStrings.settings.statusTorNotConnected;
          torConnectButton.hidden = false;
        }
      };
      this._populateStatus();

      // Quickstart
      prefpane.querySelector(selectors.quickstart.header).innerText =
        TorStrings.settings.quickstartHeading;
      prefpane.querySelector(selectors.quickstart.description).textContent =
        TorStrings.settings.quickstartDescription;

      this._enableQuickstartCheckbox = prefpane.querySelector(
        selectors.quickstart.enableQuickstartCheckbox
      );
      this._enableQuickstartCheckbox.setAttribute(
        "label",
        TorStrings.settings.quickstartCheckbox
      );
      this._enableQuickstartCheckbox.addEventListener("command", e => {
        const checked = this._enableQuickstartCheckbox.checked;
        TorSettings.quickstart.enabled = checked;
        TorSettings.saveToPrefs().applySettings();
      });
      this._enableQuickstartCheckbox.checked = TorSettings.quickstart.enabled;
      Services.obs.addObserver(this, TorSettingsTopics.SettingsChanged);

      // Bridge setup
      prefpane.querySelector(selectors.bridges.header).innerText =
        TorStrings.settings.bridgesHeading;
      prefpane.querySelector(selectors.bridges.description).textContent =
        TorStrings.settings.bridgesDescription2;
      {
        const learnMore = prefpane.querySelector(selectors.bridges.learnMore);
        learnMore.setAttribute("value", TorStrings.settings.learnMore);
        learnMore.setAttribute("href", TorStrings.settings.learnMoreBridgesURL);
        if (TorStrings.settings.learnMoreBridgesURL.startsWith("about:")) {
          learnMore.setAttribute("useoriginprincipal", "true");
        }
      }

      // Location
      {
        const locationGroup = prefpane.querySelector(
          selectors.bridges.locationGroup
        );
        prefpane.querySelector(selectors.bridges.locationLabel).textContent =
          TorStrings.settings.bridgeLocation;
        const location = prefpane.querySelector(selectors.bridges.location);
        const locationEntries = prefpane.querySelector(
          selectors.bridges.locationEntries
        );
        const chooseForMe = prefpane.querySelector(
          selectors.bridges.chooseForMe
        );
        chooseForMe.setAttribute(
          "label",
          TorStrings.settings.bridgeChooseForMe
        );
        chooseForMe.addEventListener("command", e => {
          TorConnect.openTorConnect({
            beginAutoBootstrap: location.value,
          });
        });
        this._populateLocations = () => {
          const currentValue = location.value;
          locationEntries.textContent = "";
          const createItem = (value, label, disabled) => {
            const item = document.createXULElement("menuitem");
            item.setAttribute("value", value);
            item.setAttribute("label", label);
            if (disabled) {
              item.setAttribute("disabled", "true");
            }
            return item;
          };
          const addLocations = codes => {
            const items = [];
            for (const code of codes) {
              items.push(
                createItem(
                  code,
                  TorConnect.countryNames[code]
                    ? TorConnect.countryNames[code]
                    : code
                )
              );
            }
            items.sort((left, right) => left.label.localeCompare(right.label));
            locationEntries.append(...items);
          };
          locationEntries.append(
            createItem("", TorStrings.settings.bridgeLocationAutomatic)
          );
          if (TorConnect.countryCodes.length) {
            locationEntries.append(
              createItem("", TorStrings.settings.bridgeLocationFrequent, true)
            );
            addLocations(TorConnect.countryCodes);
            locationEntries.append(
              createItem("", TorStrings.settings.bridgeLocationOther, true)
            );
          }
          addLocations(Object.keys(TorConnect.countryNames));
          location.value = currentValue;
        };
        this._showAutoconfiguration = () => {
          if (
            !TorConnect.canBeginAutoBootstrap ||
            !TorConnect.potentiallyBlocked
          ) {
            locationGroup.setAttribute("hidden", "true");
            return;
          }
          // Populate locations, even though we will show only the automatic
          // item for a moment. In my opinion showing the button immediately is
          // better then waiting for the Moat query to finish (after a while)
          // and showing the controls only after that.
          this._populateLocations();
          locationGroup.removeAttribute("hidden");
          if (!TorConnect.countryCodes.length) {
            TorConnect.getCountryCodes().then(() => this._populateLocations());
          }
        };
        this._showAutoconfiguration();
      }

      // Add a new bridge
      prefpane.querySelector(selectors.bridges.addHeader).textContent =
        TorStrings.settings.bridgeAdd;
      prefpane.querySelector(selectors.bridges.addBuiltinLabel).textContent =
        TorStrings.settings.bridgeSelectBrowserBuiltin;
      {
        const button = prefpane.querySelector(
          selectors.bridges.addBuiltinButton
        );
        button.setAttribute("label", TorStrings.settings.bridgeSelectBuiltin);
        button.addEventListener("command", e => {
          this.onAddBuiltinBridge();
        });
      }
      prefpane.querySelector(selectors.bridges.requestLabel).textContent =
        TorStrings.settings.bridgeRequestFromTorProject;
      {
        const button = prefpane.querySelector(selectors.bridges.requestButton);
        button.setAttribute("label", TorStrings.settings.bridgeRequest);
        button.addEventListener("command", e => {
          this.onRequestBridge();
        });
      }
      prefpane.querySelector(selectors.bridges.enterLabel).textContent =
        TorStrings.settings.bridgeEnterKnown;
      {
        const button = prefpane.querySelector(selectors.bridges.enterButton);
        button.setAttribute("label", TorStrings.settings.bridgeAddManually);
        button.addEventListener("command", e => {
          this.onAddBridgeManually();
        });
      }

      // Advanced setup
      prefpane.querySelector(selectors.advanced.header).innerText =
        TorStrings.settings.advancedHeading;
      prefpane.querySelector(selectors.advanced.label).textContent =
        TorStrings.settings.advancedLabel;
      {
        const settingsButton = prefpane.querySelector(
          selectors.advanced.button
        );
        settingsButton.setAttribute(
          "label",
          TorStrings.settings.advancedButton
        );
        settingsButton.addEventListener("command", () => {
          this.onAdvancedSettings();
        });
      }

      // Tor logs
      prefpane.querySelector(selectors.advanced.torLogsLabel).textContent =
        TorStrings.settings.showTorDaemonLogs;
      const torLogsButton = prefpane.querySelector(
        selectors.advanced.torLogsButton
      );
      torLogsButton.setAttribute("label", TorStrings.settings.showLogs);
      torLogsButton.addEventListener("command", () => {
        this.onViewTorLogs();
      });

      Services.obs.addObserver(this, TorConnectTopics.StateChange);
    },

    init() {
      TorSettings.initializedPromise.then(() => this._populateXUL());

      const onUnload = () => {
        window.removeEventListener("unload", onUnload);
        gConnectionPane.uninit();
      };
      window.addEventListener("unload", onUnload);
    },

    uninit() {
      // unregister our observer topics
      Services.obs.removeObserver(this, TorSettingsTopics.SettingsChanged);
      Services.obs.removeObserver(this, TorConnectTopics.StateChange);
    },

    // whether the page should be present in about:preferences
    get enabled() {
      return TorConnect.enabled;
    },

    //
    // Callbacks
    //

    observe(subject, topic, data) {
      switch (topic) {
        // triggered when a TorSettings param has changed
        case TorSettingsTopics.SettingsChanged: {
          if (subject.wrappedJSObject.changes.includes("quickstart.enabled")) {
            this._enableQuickstartCheckbox.checked =
              TorSettings.quickstart.enabled;
          }
          break;
        }
        // triggered when tor connect state changes and we may
        // need to update the messagebox
        case TorConnectTopics.StateChange: {
          this.onStateChange();
          break;
        }
      }
    },

    async onInternetTest() {
      const mrpc = new MoatRPC();
      let status = null;
      try {
        await mrpc.init();
        status = await mrpc.testInternetConnection();
      } catch (err) {
        console.log("Error while checking the Internet connection", err);
      } finally {
        mrpc.uninit();
      }
      if (status) {
        this._internetStatus = status.successful
          ? InternetStatus.Online
          : InternetStatus.Offline;
        this._populateStatus();
      }
    },

    onStateChange() {
      this._populateStatus();
      this._showAutoconfiguration();
    },

    /**
     * Save and apply settings, then optionally open about:torconnect and start
     * bootstrapping.
     *
     * @param {boolean} connect - Whether to open about:torconnect and start
     *   bootstrapping if possible.
     */
    async saveBridgeSettings(connect) {
      TorSettings.saveToPrefs();
      // FIXME: This can throw if the user adds a bridge manually with invalid
      // content. Should be addressed by tor-browser#41913.
      try {
        await TorSettings.applySettings();
      } catch (e) {
        console.error("Applying settings failed", e);
      }

      if (!connect) {
        return;
      }

      // The bridge dialog button is "connect" when Tor is not bootstrapped,
      // so do the connect.

      // Start Bootstrapping, which should use the configured bridges.
      // NOTE: We do this regardless of any previous TorConnect Error.
      if (TorConnect.canBeginBootstrap) {
        TorConnect.beginBootstrap();
      }
      // Open "about:torconnect".
      // FIXME: If there has been a previous bootstrapping error then
      // "about:torconnect" will be trying to get the user to use
      // AutoBootstrapping. It is not set up to handle a forced direct
      // entry to plain Bootstrapping from this dialog so the UI will not
      // be aligned. In particular the
      // AboutTorConnect.uiState.bootstrapCause will be aligned to
      // whatever was shown previously in "about:torconnect" instead.
      TorConnect.openTorConnect();
    },

    onAddBuiltinBridge() {
      const builtinBridgeDialog = new BuiltinBridgeDialog(
        (bridgeType, connect) => {
          TorSettings.bridges.enabled = true;
          TorSettings.bridges.source = TorBridgeSource.BuiltIn;
          TorSettings.bridges.builtin_type = bridgeType;

          this.saveBridgeSettings(connect);
        }
      );
      builtinBridgeDialog.openDialog(gSubDialog);
    },

    // called when the request bridge button is activated
    onRequestBridge() {
      const requestBridgeDialog = new RequestBridgeDialog(
        (aBridges, connect) => {
          if (!aBridges.length) {
            return;
          }
          const bridgeStrings = aBridges.join("\n");
          TorSettings.bridges.enabled = true;
          TorSettings.bridges.source = TorBridgeSource.BridgeDB;
          TorSettings.bridges.bridge_strings = bridgeStrings;

          this.saveBridgeSettings(connect);
        }
      );
      requestBridgeDialog.openDialog(gSubDialog);
    },

    onAddBridgeManually() {
      const provideBridgeDialog = new ProvideBridgeDialog(
        (aBridgeString, connect) => {
          TorSettings.bridges.enabled = true;
          TorSettings.bridges.source = TorBridgeSource.UserProvided;
          TorSettings.bridges.bridge_strings = aBridgeString;

          this.saveBridgeSettings(connect);
        }
      );
      provideBridgeDialog.openDialog(gSubDialog);
    },

    onAdvancedSettings() {
      const connectionSettingsDialog = new ConnectionSettingsDialog();
      connectionSettingsDialog.openDialog(gSubDialog);
    },

    onViewTorLogs() {
      const torLogDialog = new TorLogDialog();
      torLogDialog.openDialog(gSubDialog);
    },
  };
  return retval;
})(); /* gConnectionPane */

/**
 * Convert the given bridgeString into an array of emoji indices between 0 and
 * 255.
 *
 * @param {string} bridgeString - The bridge string.
 *
 * @returns {integer[]} - A list of emoji indices between 0 and 255.
 */
function makeBridgeId(bridgeString) {
  // JS uses UTF-16. While most of these emojis are surrogate pairs, a few
  // ones fit one UTF-16 character. So we could not use neither indices,
  // nor substr, nor some function to split the string.
  // FNV-1a implementation that is compatible with other languages
  const prime = 0x01000193;
  const offset = 0x811c9dc5;
  let hash = offset;
  const encoder = new TextEncoder();
  for (const byte of encoder.encode(bridgeString)) {
    hash = Math.imul(hash ^ byte, prime);
  }

  return [
    ((hash & 0x7f000000) >> 24) | (hash < 0 ? 0x80 : 0),
    (hash & 0x00ff0000) >> 16,
    (hash & 0x0000ff00) >> 8,
    hash & 0x000000ff,
  ];
}
