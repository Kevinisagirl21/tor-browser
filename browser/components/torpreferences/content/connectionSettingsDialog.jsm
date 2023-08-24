"use strict";

var EXPORTED_SYMBOLS = ["ConnectionSettingsDialog"];

const { TorSettings, TorProxyType } = ChromeUtils.importESModule(
  "resource:///modules/TorSettings.sys.mjs"
);

const { TorStrings } = ChromeUtils.import("resource:///modules/TorStrings.jsm");

class ConnectionSettingsDialog {
  constructor() {
    this._dialog = null;
    this._useProxyCheckbox = null;
    this._proxyTypeLabel = null;
    this._proxyTypeMenulist = null;
    this._proxyAddressLabel = null;
    this._proxyAddressTextbox = null;
    this._proxyPortLabel = null;
    this._proxyPortTextbox = null;
    this._proxyUsernameLabel = null;
    this._proxyUsernameTextbox = null;
    this._proxyPasswordLabel = null;
    this._proxyPasswordTextbox = null;
    this._useFirewallCheckbox = null;
    this._allowedPortsLabel = null;
    this._allowedPortsTextbox = null;
  }

  static get selectors() {
    return {
      header: "#torPreferences-connection-header",
      useProxyCheckbox: "checkbox#torPreferences-connection-toggleProxy",
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
      useFirewallCheckbox: "checkbox#torPreferences-connection-toggleFirewall",
      firewallAllowedPortsLabel: "label#torPreferences-connection-allowedPorts",
      firewallAllowedPortsTextbox:
        "input#torPreferences-connection-textboxAllowedPorts",
    };
  }

  // disables the provided list of elements
  _setElementsDisabled(elements, disabled) {
    for (let currentElement of elements) {
      currentElement.disabled = disabled;
    }
  }

  _populateXUL(window, aDialog) {
    const selectors = ConnectionSettingsDialog.selectors;

    this._dialog = aDialog;
    const dialogWin = this._dialog.parentElement;
    dialogWin.setAttribute(
      "title",
      TorStrings.settings.connectionSettingsDialogTitle
    );
    this._dialog.querySelector(selectors.header).textContent =
      TorStrings.settings.connectionSettingsDialogHeader;

    // Local Proxy
    this._useProxyCheckbox = this._dialog.querySelector(
      selectors.useProxyCheckbox
    );
    this._useProxyCheckbox.setAttribute(
      "label",
      TorStrings.settings.useLocalProxy
    );
    this._useProxyCheckbox.addEventListener("command", e => {
      const checked = this._useProxyCheckbox.checked;
      this.onToggleProxy(checked);
    });
    this._proxyTypeLabel = this._dialog.querySelector(selectors.proxyTypeLabel);
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
    this._proxyTypeMenulist = this._dialog.querySelector(
      selectors.proxyTypeList
    );
    this._proxyTypeMenulist.addEventListener("command", e => {
      const value = this._proxyTypeMenulist.value;
      this.onSelectProxyType(value);
    });
    for (let currentProxy of mockProxies) {
      let menuEntry = window.document.createXULElement("menuitem");
      menuEntry.setAttribute("value", currentProxy.value);
      menuEntry.setAttribute("label", currentProxy.label);
      this._proxyTypeMenulist.querySelector("menupopup").appendChild(menuEntry);
    }

    this._proxyAddressLabel = this._dialog.querySelector(
      selectors.proxyAddressLabel
    );
    this._proxyAddressLabel.setAttribute(
      "value",
      TorStrings.settings.proxyAddress
    );
    this._proxyAddressTextbox = this._dialog.querySelector(
      selectors.proxyAddressTextbox
    );
    this._proxyAddressTextbox.setAttribute(
      "placeholder",
      TorStrings.settings.proxyAddressPlaceholder
    );
    this._proxyAddressTextbox.addEventListener("blur", e => {
      let value = this._proxyAddressTextbox.value.trim();
      let colon = value.lastIndexOf(":");
      if (colon != -1) {
        let maybePort = parseInt(value.substr(colon + 1));
        if (!isNaN(maybePort) && maybePort > 0 && maybePort < 65536) {
          this._proxyAddressTextbox.value = value.substr(0, colon);
          this._proxyPortTextbox.value = maybePort;
        }
      }
    });
    this._proxyPortLabel = this._dialog.querySelector(selectors.proxyPortLabel);
    this._proxyPortLabel.setAttribute("value", TorStrings.settings.proxyPort);
    this._proxyPortTextbox = this._dialog.querySelector(
      selectors.proxyPortTextbox
    );
    this._proxyUsernameLabel = this._dialog.querySelector(
      selectors.proxyUsernameLabel
    );
    this._proxyUsernameLabel.setAttribute(
      "value",
      TorStrings.settings.proxyUsername
    );
    this._proxyUsernameTextbox = this._dialog.querySelector(
      selectors.proxyUsernameTextbox
    );
    this._proxyUsernameTextbox.setAttribute(
      "placeholder",
      TorStrings.settings.proxyUsernamePasswordPlaceholder
    );
    this._proxyPasswordLabel = this._dialog.querySelector(
      selectors.proxyPasswordLabel
    );
    this._proxyPasswordLabel.setAttribute(
      "value",
      TorStrings.settings.proxyPassword
    );
    this._proxyPasswordTextbox = this._dialog.querySelector(
      selectors.proxyPasswordTextbox
    );
    this._proxyPasswordTextbox.setAttribute(
      "placeholder",
      TorStrings.settings.proxyUsernamePasswordPlaceholder
    );

    this.onToggleProxy(false);
    if (TorSettings.proxy.enabled) {
      this.onToggleProxy(true);
      this.onSelectProxyType(TorSettings.proxy.type);
      this._proxyAddressTextbox.value = TorSettings.proxy.address;
      this._proxyPortTextbox.value = TorSettings.proxy.port;
      this._proxyUsernameTextbox.value = TorSettings.proxy.username;
      this._proxyPasswordTextbox.value = TorSettings.proxy.password;
    }

    // Local firewall
    this._useFirewallCheckbox = this._dialog.querySelector(
      selectors.useFirewallCheckbox
    );
    this._useFirewallCheckbox.setAttribute(
      "label",
      TorStrings.settings.useFirewall
    );
    this._useFirewallCheckbox.addEventListener("command", e => {
      const checked = this._useFirewallCheckbox.checked;
      this.onToggleFirewall(checked);
    });
    this._allowedPortsLabel = this._dialog.querySelector(
      selectors.firewallAllowedPortsLabel
    );
    this._allowedPortsLabel.setAttribute(
      "value",
      TorStrings.settings.allowedPorts
    );
    this._allowedPortsTextbox = this._dialog.querySelector(
      selectors.firewallAllowedPortsTextbox
    );
    this._allowedPortsTextbox.setAttribute(
      "placeholder",
      TorStrings.settings.allowedPortsPlaceholder
    );

    this.onToggleFirewall(false);
    if (TorSettings.firewall.enabled) {
      this.onToggleFirewall(true);
      this._allowedPortsTextbox.value =
        TorSettings.firewall.allowed_ports.join(", ");
    }

    this._dialog.addEventListener("dialogaccept", e => {
      this._applySettings();
    });
  }

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
    if (enabled) {
      this.onSelectProxyType(this._proxyTypeMenulist.value);
    }
  }

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
  }

  // callback when firewall proxy is toggled
  onToggleFirewall(enabled) {
    this._useFirewallCheckbox.checked = enabled;
    let disabled = !enabled;

    this._setElementsDisabled(
      [this._allowedPortsLabel, this._allowedPortsTextbox],
      disabled
    );
  }

  // pushes settings from UI to tor
  _applySettings() {
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
  }

  init(window, aDialog) {
    this._populateXUL(window, aDialog);
  }

  openDialog(gSubDialog) {
    gSubDialog.open(
      "chrome://browser/content/torpreferences/connectionSettingsDialog.xhtml",
      { features: "resizable=yes" },
      this
    );
  }
}
