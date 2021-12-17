"use strict";

/* global Services */

const { TorSettings, TorSettingsTopics, TorSettingsData, TorBridgeSource, TorBuiltinBridgeTypes, TorProxyType } = ChromeUtils.import(
  "resource:///modules/TorSettings.jsm"
);

const { TorProtocolService } = ChromeUtils.import(
  "resource:///modules/TorProtocolService.jsm"
);

const { TorConnect, TorConnectTopics, TorConnectState } = ChromeUtils.import(
  "resource:///modules/TorConnect.jsm"
);

const { TorLogDialog } = ChromeUtils.import(
  "chrome://browser/content/torpreferences/torLogDialog.jsm"
);

const { RequestBridgeDialog } = ChromeUtils.import(
  "chrome://browser/content/torpreferences/requestBridgeDialog.jsm"
);

ChromeUtils.defineModuleGetter(
  this,
  "TorStrings",
  "resource:///modules/TorStrings.jsm"
);

/*
  Tor Pane

  Code for populating the XUL in about:preferences#tor, handling input events, interfacing with tor-launcher
*/
const gTorPane = (function() {
  /* CSS selectors for all of the Tor Network DOM elements we need to access */
  const selectors = {
    category: {
      title: "label#torPreferences-labelCategory",
    },
    messageBox: {
      box: "div#torPreferences-connectMessageBox",
      message: "td#torPreferences-connectMessageBox-message",
      button: "button#torPreferences-connectMessageBox-button",
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
      header: "h2#torPreferences-bridges-header",
      description: "span#torPreferences-bridges-description",
      learnMore: "label#torPreferences-bridges-learnMore",
      useBridgeCheckbox: "checkbox#torPreferences-bridges-toggle",
      bridgeSelectionRadiogroup:
        "radiogroup#torPreferences-bridges-bridgeSelection",
      builtinBridgeOption: "radio#torPreferences-bridges-radioBuiltin",
      builtinBridgeList: "menulist#torPreferences-bridges-builtinList",
      requestBridgeOption: "radio#torPreferences-bridges-radioRequestBridge",
      requestBridgeButton: "button#torPreferences-bridges-buttonRequestBridge",
      requestBridgeTextarea:
        "textarea#torPreferences-bridges-textareaRequestBridge",
      provideBridgeOption: "radio#torPreferences-bridges-radioProvideBridge",
      provideBridgeDescription:
        "description#torPreferences-bridges-descriptionProvideBridge",
      provideBridgeTextarea:
        "textarea#torPreferences-bridges-textareaProvideBridge",
    },
    advanced: {
      header: "h2#torPreferences-advanced-header",
      description: "span#torPreferences-advanced-description",
      learnMore: "label#torPreferences-advanced-learnMore",
      useProxyCheckbox: "checkbox#torPreferences-advanced-toggleProxy",
      proxyTypeLabel: "label#torPreferences-localProxy-type",
      proxyTypeList: "menulist#torPreferences-localProxy-builtinList",
      proxyAddressLabel: "label#torPreferences-localProxy-address",
      proxyAddressTextbox: "input#torPreferences-localProxy-textboxAddress",
      proxyPortLabel: "label#torPreferences-localProxy-port",
      proxyPortTextbox: "input#torPreferences-localProxy-textboxPort",
      proxyUsernameLabel: "label#torPreferences-localProxy-username",
      proxyUsernameTextbox: "input#torPreferences-localProxy-textboxUsername",
      proxyPasswordLabel: "label#torPreferences-localProxy-password",
      proxyPasswordTextbox: "input#torPreferences-localProxy-textboxPassword",
      useFirewallCheckbox: "checkbox#torPreferences-advanced-toggleFirewall",
      firewallAllowedPortsLabel: "label#torPreferences-advanced-allowedPorts",
      firewallAllowedPortsTextbox:
        "input#torPreferences-advanced-textboxAllowedPorts",
      torLogsLabel: "label#torPreferences-torLogs",
      torLogsButton: "button#torPreferences-buttonTorLogs",
    },
  }; /* selectors */

  let retval = {
    // cached frequently accessed DOM elements
    _messageBox: null,
    _messageBoxMessage: null,
    _messageBoxButton: null,
    _enableQuickstartCheckbox: null,
    _useBridgeCheckbox: null,
    _bridgeSelectionRadiogroup: null,
    _builtinBridgeOption: null,
    _builtinBridgeMenulist: null,
    _requestBridgeOption: null,
    _requestBridgeButton: null,
    _requestBridgeTextarea: null,
    _provideBridgeOption: null,
    _provideBridgeTextarea: null,
    _useProxyCheckbox: null,
    _proxyTypeLabel: null,
    _proxyTypeMenulist: null,
    _proxyAddressLabel: null,
    _proxyAddressTextbox: null,
    _proxyPortLabel: null,
    _proxyPortTextbox: null,
    _proxyUsernameLabel: null,
    _proxyUsernameTextbox: null,
    _proxyPasswordLabel: null,
    _proxyPasswordTextbox: null,
    _useFirewallCheckbox: null,
    _allowedPortsLabel: null,
    _allowedPortsTextbox: null,

    // tor network settings
    _bridgeSettings: null,
    _proxySettings: null,
    _firewallSettings: null,

    // disables the provided list of elements
    _setElementsDisabled(elements, disabled) {
      for (let currentElement of elements) {
        currentElement.disabled = disabled;
      }
    },

    // populate xul with strings and cache the relevant elements
    _populateXUL() {
      // saves tor settings to disk when navigate away from about:preferences
      window.addEventListener("blur", val => {
        TorProtocolService.flushSettings();
      });

      document
        .querySelector(selectors.category.title)
        .setAttribute("value", TorStrings.settings.categoryTitle);

      let prefpane = document.getElementById("mainPrefPane");

      // 'Connect to Tor' Message Bar

      this._messageBox = prefpane.querySelector(selectors.messageBox.box);
      this._messageBoxMessage = prefpane.querySelector(selectors.messageBox.message);
      this._messageBoxButton = prefpane.querySelector(selectors.messageBox.button);
      // wire up connect button
      this._messageBoxButton.addEventListener("click", () => {
        TorConnect.beginBootstrap();
        TorConnect.openTorConnect();
      });

      this._populateMessagebox = () => {
        if (TorConnect.shouldShowTorConnect &&
            TorConnect.state === TorConnectState.Configuring) {
          // set messagebox style and text
          if (TorProtocolService.torBootstrapErrorOccurred()) {
            this._messageBox.parentNode.style.display = null;
            this._messageBox.className = "error";
            this._messageBoxMessage.innerText = TorStrings.torConnect.tryAgainMessage;
            this._messageBoxButton.innerText = TorStrings.torConnect.tryAgain;
          } else {
            this._messageBox.parentNode.style.display = null;
            this._messageBox.className = "warning";
            this._messageBoxMessage.innerText = TorStrings.torConnect.connectMessage;
            this._messageBoxButton.innerText = TorStrings.torConnect.torConnectButton;
          }
        } else {
          // we need to explicitly hide the groupbox, as switching between
          // the tor pane and other panes will 'unhide' (via the 'hidden'
          // attribute) the groupbox, offsetting all of the content down
          // by the groupbox's margin (even if content is 0 height)
          this._messageBox.parentNode.style.display = "none";
          this._messageBox.className = "hidden";
          this._messageBoxMessage.innerText = "";
          this._messageBoxButton.innerText = "";
        }
      }
      this._populateMessagebox();
      Services.obs.addObserver(this, TorConnectTopics.StateChange);

      // update the messagebox whenever we come back to the page
      window.addEventListener("focus", val => {
        this._populateMessagebox();
      });

      // Heading
      prefpane.querySelector(selectors.torPreferences.header).innerText =
        TorStrings.settings.torPreferencesHeading;
      prefpane.querySelector(selectors.torPreferences.description).textContent =
        TorStrings.settings.torPreferencesDescription;
      {
        let learnMore = prefpane.querySelector(
          selectors.torPreferences.learnMore
        );
        learnMore.setAttribute("value", TorStrings.settings.learnMore);
        learnMore.setAttribute(
          "href",
          TorStrings.settings.learnMoreTorBrowserURL
        );
      }

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
      Services.obs.addObserver(this, TorSettingsTopics.SettingChanged);

      // Bridge setup
      prefpane.querySelector(selectors.bridges.header).innerText =
        TorStrings.settings.bridgesHeading;
      prefpane.querySelector(selectors.bridges.description).textContent =
        TorStrings.settings.bridgesDescription;
      {
        let learnMore = prefpane.querySelector(selectors.bridges.learnMore);
        learnMore.setAttribute("value", TorStrings.settings.learnMore);
        learnMore.setAttribute("href", TorStrings.settings.learnMoreBridgesURL);
      }

      this._useBridgeCheckbox = prefpane.querySelector(
        selectors.bridges.useBridgeCheckbox
      );
      this._useBridgeCheckbox.setAttribute(
        "label",
        TorStrings.settings.useBridge
      );
      this._useBridgeCheckbox.addEventListener("command", e => {
        const checked = this._useBridgeCheckbox.checked;
        gTorPane.onToggleBridge(checked).onUpdateBridgeSettings();
      });
      this._bridgeSelectionRadiogroup = prefpane.querySelector(
        selectors.bridges.bridgeSelectionRadiogroup
      );
      this._bridgeSelectionRadiogroup.value = TorBridgeSource.BuiltIn;
      this._bridgeSelectionRadiogroup.addEventListener("command", e => {
        const value = this._bridgeSelectionRadiogroup.value;
        gTorPane.onSelectBridgeOption(value).onUpdateBridgeSettings();
      });

      // Builtin bridges
      this._builtinBridgeOption = prefpane.querySelector(
        selectors.bridges.builtinBridgeOption
      );
      this._builtinBridgeOption.setAttribute(
        "label",
        TorStrings.settings.selectBridge
      );
      this._builtinBridgeOption.setAttribute("value", TorBridgeSource.BuiltIn);
      this._builtinBridgeMenulist = prefpane.querySelector(
        selectors.bridges.builtinBridgeList
      );
      this._builtinBridgeMenulist.addEventListener("command", e => {
        gTorPane.onUpdateBridgeSettings();
      });

      // Request bridge
      this._requestBridgeOption = prefpane.querySelector(
        selectors.bridges.requestBridgeOption
      );
      this._requestBridgeOption.setAttribute(
        "label",
        TorStrings.settings.requestBridgeFromTorProject
      );
      this._requestBridgeOption.setAttribute("value", TorBridgeSource.BridgeDB);
      this._requestBridgeButton = prefpane.querySelector(
        selectors.bridges.requestBridgeButton
      );
      this._requestBridgeButton.setAttribute(
        "label",
        TorStrings.settings.requestNewBridge
      );
      this._requestBridgeButton.addEventListener("command", () =>
        gTorPane.onRequestBridge()
      );
      this._requestBridgeTextarea = prefpane.querySelector(
        selectors.bridges.requestBridgeTextarea
      );

      // Provide a bridge
      this._provideBridgeOption = prefpane.querySelector(
        selectors.bridges.provideBridgeOption
      );
      this._provideBridgeOption.setAttribute(
        "label",
        TorStrings.settings.provideBridge
      );
      this._provideBridgeOption.setAttribute(
        "value",
        TorBridgeSource.UserProvided
      );
      prefpane.querySelector(
        selectors.bridges.provideBridgeDescription
      ).textContent = TorStrings.settings.provideBridgeDirections;
      this._provideBridgeTextarea = prefpane.querySelector(
        selectors.bridges.provideBridgeTextarea
      );
      this._provideBridgeTextarea.setAttribute(
        "placeholder",
        TorStrings.settings.provideBridgePlaceholder
      );
      this._provideBridgeTextarea.addEventListener("blur", () => {
        gTorPane.onUpdateBridgeSettings();
      });

      // Advanced setup
      prefpane.querySelector(selectors.advanced.header).innerText =
        TorStrings.settings.advancedHeading;
      prefpane.querySelector(selectors.advanced.description).textContent =
        TorStrings.settings.advancedDescription;
      {
        let learnMore = prefpane.querySelector(selectors.advanced.learnMore);
        learnMore.setAttribute("value", TorStrings.settings.learnMore);
        learnMore.setAttribute(
          "href",
          TorStrings.settings.learnMoreNetworkSettingsURL
        );
      }

      // Local Proxy
      this._useProxyCheckbox = prefpane.querySelector(
        selectors.advanced.useProxyCheckbox
      );
      this._useProxyCheckbox.setAttribute(
        "label",
        TorStrings.settings.useLocalProxy
      );
      this._useProxyCheckbox.addEventListener("command", e => {
        const checked = this._useProxyCheckbox.checked;
        gTorPane.onToggleProxy(checked).onUpdateProxySettings();
      });
      this._proxyTypeLabel = prefpane.querySelector(
        selectors.advanced.proxyTypeLabel
      );
      this._proxyTypeLabel.setAttribute("value", TorStrings.settings.proxyType);

      let mockProxies = [
        {
          value: TorProxyType.Socks4,
          label: TorStrings.settings.proxyTypeSOCKS4,
        },
        {
          value: TorProxyType.Socks5,
          label: TorStrings.settings.proxyTypeSOCKS5,
        },
        { value: TorProxyType.HTTPS, label: TorStrings.settings.proxyTypeHTTP },
      ];
      this._proxyTypeMenulist = prefpane.querySelector(
        selectors.advanced.proxyTypeList
      );
      this._proxyTypeMenulist.addEventListener("command", e => {
        const value = this._proxyTypeMenulist.value;
        gTorPane.onSelectProxyType(value).onUpdateProxySettings();
      });
      for (let currentProxy of mockProxies) {
        let menuEntry = document.createXULElement("menuitem");
        menuEntry.setAttribute("value", currentProxy.value);
        menuEntry.setAttribute("label", currentProxy.label);
        this._proxyTypeMenulist
          .querySelector("menupopup")
          .appendChild(menuEntry);
      }

      this._proxyAddressLabel = prefpane.querySelector(
        selectors.advanced.proxyAddressLabel
      );
      this._proxyAddressLabel.setAttribute(
        "value",
        TorStrings.settings.proxyAddress
      );
      this._proxyAddressTextbox = prefpane.querySelector(
        selectors.advanced.proxyAddressTextbox
      );
      this._proxyAddressTextbox.setAttribute(
        "placeholder",
        TorStrings.settings.proxyAddressPlaceholder
      );
      this._proxyAddressTextbox.addEventListener("blur", () => {
        gTorPane.onUpdateProxySettings();
      });
      this._proxyPortLabel = prefpane.querySelector(
        selectors.advanced.proxyPortLabel
      );
      this._proxyPortLabel.setAttribute("value", TorStrings.settings.proxyPort);
      this._proxyPortTextbox = prefpane.querySelector(
        selectors.advanced.proxyPortTextbox
      );
      this._proxyPortTextbox.addEventListener("blur", () => {
        gTorPane.onUpdateProxySettings();
      });
      this._proxyUsernameLabel = prefpane.querySelector(
        selectors.advanced.proxyUsernameLabel
      );
      this._proxyUsernameLabel.setAttribute(
        "value",
        TorStrings.settings.proxyUsername
      );
      this._proxyUsernameTextbox = prefpane.querySelector(
        selectors.advanced.proxyUsernameTextbox
      );
      this._proxyUsernameTextbox.setAttribute(
        "placeholder",
        TorStrings.settings.proxyUsernamePasswordPlaceholder
      );
      this._proxyUsernameTextbox.addEventListener("blur", () => {
        gTorPane.onUpdateProxySettings();
      });
      this._proxyPasswordLabel = prefpane.querySelector(
        selectors.advanced.proxyPasswordLabel
      );
      this._proxyPasswordLabel.setAttribute(
        "value",
        TorStrings.settings.proxyPassword
      );
      this._proxyPasswordTextbox = prefpane.querySelector(
        selectors.advanced.proxyPasswordTextbox
      );
      this._proxyPasswordTextbox.setAttribute(
        "placeholder",
        TorStrings.settings.proxyUsernamePasswordPlaceholder
      );
      this._proxyPasswordTextbox.addEventListener("blur", () => {
        gTorPane.onUpdateProxySettings();
      });

      // Local firewall
      this._useFirewallCheckbox = prefpane.querySelector(
        selectors.advanced.useFirewallCheckbox
      );
      this._useFirewallCheckbox.setAttribute(
        "label",
        TorStrings.settings.useFirewall
      );
      this._useFirewallCheckbox.addEventListener("command", e => {
        const checked = this._useFirewallCheckbox.checked;
        gTorPane.onToggleFirewall(checked).onUpdateFirewallSettings();
      });
      this._allowedPortsLabel = prefpane.querySelector(
        selectors.advanced.firewallAllowedPortsLabel
      );
      this._allowedPortsLabel.setAttribute(
        "value",
        TorStrings.settings.allowedPorts
      );
      this._allowedPortsTextbox = prefpane.querySelector(
        selectors.advanced.firewallAllowedPortsTextbox
      );
      this._allowedPortsTextbox.setAttribute(
        "placeholder",
        TorStrings.settings.allowedPortsPlaceholder
      );
      this._allowedPortsTextbox.addEventListener("blur", () => {
        gTorPane.onUpdateFirewallSettings();
      });

      // Tor logs
      prefpane
        .querySelector(selectors.advanced.torLogsLabel)
        .setAttribute("value", TorStrings.settings.showTorDaemonLogs);
      let torLogsButton = prefpane.querySelector(
        selectors.advanced.torLogsButton
      );
      torLogsButton.setAttribute("label", TorStrings.settings.showLogs);
      torLogsButton.addEventListener("command", () => {
        gTorPane.onViewTorLogs();
      });

      // Disable all relevant elements by default
      this._setElementsDisabled(
        [
          this._builtinBridgeOption,
          this._builtinBridgeMenulist,
          this._requestBridgeOption,
          this._requestBridgeButton,
          this._requestBridgeTextarea,
          this._provideBridgeOption,
          this._provideBridgeTextarea,
          this._proxyTypeLabel,
          this._proxyTypeMenulist,
          this._proxyAddressLabel,
          this._proxyAddressTextbox,
          this._proxyPortLabel,
          this._proxyPortTextbox,
          this._proxyUsernameLabel,
          this._proxyUsernameTextbox,
          this._proxyPasswordLabel,
          this._proxyPasswordTextbox,
          this._allowedPortsLabel,
          this._allowedPortsTextbox,
        ],
        true
      );

      // init bridge UI
      for (let currentBridge of TorBuiltinBridgeTypes) {
        let menuEntry = document.createXULElement("menuitem");
        menuEntry.setAttribute("value", currentBridge);
        menuEntry.setAttribute("label", currentBridge);
        this._builtinBridgeMenulist
          .querySelector("menupopup")
          .appendChild(menuEntry);
      }

      if (TorSettings.bridges.enabled) {
        this.onSelectBridgeOption(TorSettings.bridges.source);
        this.onToggleBridge(
          TorSettings.bridges.source != TorBridgeSource.Invalid
        );
        switch (TorSettings.bridges.source) {
          case TorBridgeSource.Invalid:
            break;
          case TorBridgeSource.BuiltIn:
            this._builtinBridgeMenulist.value = TorSettings.bridges.builtin_type;
            break;
          case TorBridgeSource.BridgeDB:
            this._requestBridgeTextarea.value = TorSettings.bridges.bridge_strings.join("\n");
            break;
          case TorBridgeSource.UserProvided:
            this._provideBridgeTextarea.value = TorSettings.bridges.bridge_strings.join("\n");
            break;
        }
      }

      // init proxy UI
      if (TorSettings.proxy.enabled) {
        this.onToggleProxy(true);
        this.onSelectProxyType(TorSettings.proxy.type);
        this._proxyAddressTextbox.value = TorSettings.proxy.address;
        this._proxyPortTextbox.value = TorSettings.proxy.port;
        this._proxyUsernameTextbox.value = TorSettings.proxy.username;
        this._proxyPasswordTextbox.value = TorSettings.proxy.password;
      }

      // init firewall
      if (TorSettings.firewall.enabled) {
        this.onToggleFirewall(true);
        this._allowedPortsTextbox.value = TorSettings.firewall.allowed_ports.join(", ");
      }
    },

    init() {
      this._populateXUL();

      let onUnload = () => {
        window.removeEventListener("unload", onUnload);
        gTorPane.uninit();
      };
      window.addEventListener("unload", onUnload);
    },

    uninit() {
      // unregister our observer topics
      Services.obs.removeObserver(this, TorSettingsTopics.SettingChanged);
      Services.obs.removeObserver(this, TorConnectTopics.StateChange);
    },

    // whether the page should be present in about:preferences
    get enabled() {
      return TorProtocolService.ownsTorDaemon;
    },

    //
    // Callbacks
    //

    observe(subject, topic, data) {
      switch (topic) {
       // triggered when a TorSettings param has changed
        case TorSettingsTopics.SettingChanged: {
          let obj = subject?.wrappedJSObject;
          switch(data) {
            case TorSettingsData.QuickStartEnabled: {
              this._enableQuickstartCheckbox.checked = obj.value;
              break;
            }
          }
          break;
        }
        // triggered when tor connect state changes and we may
        // need to update the messagebox
        case TorConnectTopics.StateChange: {
          this._populateMessagebox();
          break;
        }
      }
    },

    // callback when using bridges toggled
    onToggleBridge(enabled) {
      this._useBridgeCheckbox.checked = enabled;
      let disabled = !enabled;

      // first disable all the bridge related elements
      this._setElementsDisabled(
        [
          this._builtinBridgeOption,
          this._builtinBridgeMenulist,
          this._requestBridgeOption,
          this._requestBridgeButton,
          this._requestBridgeTextarea,
          this._provideBridgeOption,
          this._provideBridgeTextarea,
        ],
        disabled
      );

      // and selectively re-enable based on the radiogroup's current value
      if (enabled) {
        this.onSelectBridgeOption(this._bridgeSelectionRadiogroup.value);
      } else {
        this.onSelectBridgeOption(TorBridgeSource.Invalid);
      }
      return this;
    },

    // callback when a bridge option is selected
    onSelectBridgeOption(source) {
      if (typeof source === "string") {
        source = parseInt(source);
      }

      // disable all of the bridge elements under radio buttons
      this._setElementsDisabled(
        [
          this._builtinBridgeMenulist,
          this._requestBridgeButton,
          this._requestBridgeTextarea,
          this._provideBridgeTextarea,
        ],
        true
      );

      if (source != TorBridgeSource.Invalid) {
        this._bridgeSelectionRadiogroup.value = source;
      }

      switch (source) {
        case TorBridgeSource.BuiltIn: {
          this._setElementsDisabled([this._builtinBridgeMenulist], false);
          break;
        }
        case TorBridgeSource.BridgeDB: {
          this._setElementsDisabled(
            [this._requestBridgeButton, this._requestBridgeTextarea],
            false
          );
          break;
        }
        case TorBridgeSource.UserProvided: {
          this._setElementsDisabled([this._provideBridgeTextarea], false);
          break;
        }
      }
      return this;
    },

    // called when the request bridge button is activated
    onRequestBridge() {
      let requestBridgeDialog = new RequestBridgeDialog();
      requestBridgeDialog.openDialog(
        gSubDialog,
        TorSettings.proxy.uri,
        aBridges => {
          if (aBridges.length > 0) {
            let bridgeStrings = aBridges.join("\n");
            TorSettings.bridges.enabled = true;
            TorSettings.bridges.source = TorBridgeSource.BridgeDB;
            TorSettings.bridges.bridge_strings = bridgeStrings;
            TorSettings.saveToPrefs();
            TorSettings.applySettings().then((result) => {
              this._requestBridgeTextarea.value = bridgeStrings;
            });
          }
        }
      );
      return this;
    },

    // pushes bridge settings from UI to tor
    onUpdateBridgeSettings() {
      let source = this._useBridgeCheckbox.checked
        ? parseInt(this._bridgeSelectionRadiogroup.value)
        : TorBridgeSource.Invalid;

      switch (source) {
        case TorBridgeSource.Invalid: {
          TorSettings.bridges.enabled = false;
        }
        break;
        case TorBridgeSource.BuiltIn: {
          // if there is a built-in bridge already selected, use that
          let bridgeType = this._builtinBridgeMenulist.value;
          console.log(`bridge type: ${bridgeType}`);
          if (bridgeType) {
            TorSettings.bridges.enabled = true;
            TorSettings.bridges.source = TorBridgeSource.BuiltIn;
            TorSettings.bridges.builtin_type = bridgeType;
          } else {
            TorSettings.bridges.enabled = false;
          }
          break;
        }
        case TorBridgeSource.BridgeDB: {
          // if there are bridgedb bridges saved in the text area, use them
          let bridgeStrings = this._requestBridgeTextarea.value;
          if (bridgeStrings) {
            TorSettings.bridges.enabled = true;
            TorSettings.bridges.source = TorBridgeSource.BridgeDB;
            TorSettings.bridges.bridge_strings = bridgeStrings;
          } else {
            TorSettings.bridges.enabled = false;
          }
          break;
        }
        case TorBridgeSource.UserProvided: {
          // if bridges already exist in the text area, use them
          let bridgeStrings = this._provideBridgeTextarea.value;
          if (bridgeStrings) {
            TorSettings.bridges.enabled = true;
            TorSettings.bridges.source = TorBridgeSource.UserProvided;
            TorSettings.bridges.bridge_strings = bridgeStrings;
          } else {
            TorSettings.bridges.enabled = false;
          }
          break;
        }
      }
      TorSettings.saveToPrefs();
      TorSettings.applySettings();

      return this;
    },

    // callback when proxy is toggled
    onToggleProxy(enabled) {
      this._useProxyCheckbox.checked = enabled;
      let disabled = !enabled;

      this._setElementsDisabled(
        [
          this._proxyTypeLabel,
          this._proxyTypeMenulist,
          this._proxyAddressLabel,
          this._proxyAddressTextbox,
          this._proxyPortLabel,
          this._proxyPortTextbox,
          this._proxyUsernameLabel,
          this._proxyUsernameTextbox,
          this._proxyPasswordLabel,
          this._proxyPasswordTextbox,
        ],
        disabled
      );
      this.onSelectProxyType(this._proxyTypeMenulist.value);
      return this;
    },

    // callback when proxy type is changed
    onSelectProxyType(value) {
      if (typeof value === "string") {
        value = parseInt(value);
      }

      this._proxyTypeMenulist.value = value;
      switch (value) {
        case TorProxyType.Invalid: {
          this._setElementsDisabled(
            [
              this._proxyAddressLabel,
              this._proxyAddressTextbox,
              this._proxyPortLabel,
              this._proxyPortTextbox,
              this._proxyUsernameLabel,
              this._proxyUsernameTextbox,
              this._proxyPasswordLabel,
              this._proxyPasswordTextbox,
            ],
            true
          ); // DISABLE

          this._proxyAddressTextbox.value = "";
          this._proxyPortTextbox.value = "";
          this._proxyUsernameTextbox.value = "";
          this._proxyPasswordTextbox.value = "";
          break;
        }
        case TorProxyType.Socks4: {
          this._setElementsDisabled(
            [
              this._proxyAddressLabel,
              this._proxyAddressTextbox,
              this._proxyPortLabel,
              this._proxyPortTextbox,
            ],
            false
          ); // ENABLE
          this._setElementsDisabled(
            [
              this._proxyUsernameLabel,
              this._proxyUsernameTextbox,
              this._proxyPasswordLabel,
              this._proxyPasswordTextbox,
            ],
            true
          ); // DISABLE

          this._proxyUsernameTextbox.value = "";
          this._proxyPasswordTextbox.value = "";
          break;
        }
        case TorProxyType.Socks5:
        case TorProxyType.HTTPS: {
          this._setElementsDisabled(
            [
              this._proxyAddressLabel,
              this._proxyAddressTextbox,
              this._proxyPortLabel,
              this._proxyPortTextbox,
              this._proxyUsernameLabel,
              this._proxyUsernameTextbox,
              this._proxyPasswordLabel,
              this._proxyPasswordTextbox,
            ],
            false
          ); // ENABLE
          break;
        }
      }
      return this;
    },

    // pushes proxy settings from UI to tor
    onUpdateProxySettings() {
      const type = this._useProxyCheckbox.checked
        ? parseInt(this._proxyTypeMenulist.value)
        : TorProxyType.Invalid;
      const address = this._proxyAddressTextbox.value;
      const port = this._proxyPortTextbox.value;
      const username = this._proxyUsernameTextbox.value;
      const password = this._proxyPasswordTextbox.value;

      switch (type) {
        case TorProxyType.Invalid:
          TorSettings.proxy.enabled = false;
          break;
        case TorProxyType.Socks4:
          TorSettings.proxy.enabled = true;
          TorSettings.proxy.type = type;
          TorSettings.proxy.address = address;
          TorSettings.proxy.port = port;

          break;
        case TorProxyType.Socks5:
          TorSettings.proxy.enabled = true;
          TorSettings.proxy.type = type;
          TorSettings.proxy.address = address;
          TorSettings.proxy.port = port;
          TorSettings.proxy.username = username;
          TorSettings.proxy.password = password;
          break;
        case TorProxyType.HTTPS:
          TorSettings.proxy.enabled = true;
          TorSettings.proxy.type = type;
          TorSettings.proxy.address = address;
          TorSettings.proxy.port = port;
          TorSettings.proxy.username = username;
          TorSettings.proxy.password = password;
          break;
      }
      TorSettings.saveToPrefs();
      TorSettings.applySettings();

      return this;
    },

    // callback when firewall proxy is toggled
    onToggleFirewall(enabled) {
      this._useFirewallCheckbox.checked = enabled;
      let disabled = !enabled;

      this._setElementsDisabled(
        [this._allowedPortsLabel, this._allowedPortsTextbox],
        disabled
      );

      return this;
    },

    // pushes firewall settings from UI to tor
    onUpdateFirewallSettings() {

      let portListString = this._useFirewallCheckbox.checked
        ? this._allowedPortsTextbox.value
        : "";

      if (portListString) {
        TorSettings.firewall.enabled = true;
        TorSettings.firewall.allowed_ports = portListString;
      } else {
        TorSettings.firewall.enabled = false;
      }
      TorSettings.saveToPrefs();
      TorSettings.applySettings();

      return this;
    },

    onViewTorLogs() {
      let torLogDialog = new TorLogDialog();
      torLogDialog.openDialog(gSubDialog);
    },
  };
  return retval;
})(); /* gTorPane */
