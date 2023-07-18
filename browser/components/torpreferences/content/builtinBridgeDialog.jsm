"use strict";

var EXPORTED_SYMBOLS = ["BuiltinBridgeDialog"];

const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");

const { TorStrings } = ChromeUtils.import("resource:///modules/TorStrings.jsm");

const { TorSettings, TorBridgeSource, TorBuiltinBridgeTypes } =
  ChromeUtils.import("resource:///modules/TorSettings.jsm");

const { TorConnect, TorConnectTopics } = ChromeUtils.import(
  "resource:///modules/TorConnect.jsm"
);

class BuiltinBridgeDialog {
  constructor(onSubmit) {
    this.onSubmit = onSubmit;
    this._dialog = null;
    this._acceptButton = null;
  }

  static get selectors() {
    return {
      description: "#torPreferences-builtinBridge-description",
      radiogroup: "#torPreferences-builtinBridge-typeSelection",
      obfsRadio: "#torPreferences-builtinBridges-radioObfs",
      obfsDescr: "#torPreferences-builtinBridges-descrObfs",
      snowflakeRadio: "#torPreferences-builtinBridges-radioSnowflake",
      snowflakeDescr: "#torPreferences-builtinBridges-descrSnowflake",
      meekAzureRadio: "#torPreferences-builtinBridges-radioMeekAzure",
      meekAzureDescr: "#torPreferences-builtinBridges-descrMeekAzure",
    };
  }

  _populateXUL(window, aDialog) {
    const selectors = BuiltinBridgeDialog.selectors;

    this._dialog = aDialog;
    const dialogWin = this._dialog.parentElement;
    dialogWin.setAttribute("title", TorStrings.settings.builtinBridgeHeader);

    this._dialog.querySelector(selectors.description).textContent =
      TorStrings.settings.builtinBridgeDescription2;

    this._acceptButton = this._dialog.getButton("accept");
    this.onTorStateChange();

    let radioGroup = this._dialog.querySelector(selectors.radiogroup);

    let types = {
      obfs4: {
        elemRadio: this._dialog.querySelector(selectors.obfsRadio),
        elemDescr: this._dialog.querySelector(selectors.obfsDescr),
        label: TorStrings.settings.builtinBridgeObfs4Title,
        descr: TorStrings.settings.builtinBridgeObfs4Description2,
      },
      snowflake: {
        elemRadio: this._dialog.querySelector(selectors.snowflakeRadio),
        elemDescr: this._dialog.querySelector(selectors.snowflakeDescr),
        label: TorStrings.settings.builtinBridgeSnowflake,
        descr: TorStrings.settings.builtinBridgeSnowflakeDescription2,
      },
      "meek-azure": {
        elemRadio: this._dialog.querySelector(selectors.meekAzureRadio),
        elemDescr: this._dialog.querySelector(selectors.meekAzureDescr),
        label: TorStrings.settings.builtinBridgeMeekAzure,
        descr: TorStrings.settings.builtinBridgeMeekAzureDescription2,
      },
    };

    TorBuiltinBridgeTypes.forEach(type => {
      types[type].elemRadio.setAttribute("label", types[type].label);
      types[type].elemRadio.setAttribute("hidden", "false");
      types[type].elemDescr.textContent = types[type].descr;
      types[type].elemDescr.removeAttribute("hidden");
    });

    if (
      TorSettings.bridges.enabled &&
      TorSettings.bridges.source == TorBridgeSource.BuiltIn
    ) {
      radioGroup.selectedItem =
        types[TorSettings.bridges.builtin_type]?.elemRadio;
    } else {
      radioGroup.selectedItem = null;
    }

    this._dialog.addEventListener("dialogaccept", () => {
      this.onSubmit(radioGroup.value, TorConnect.canBeginBootstrap);
    });
    this._dialog.addEventListener("dialoghelp", e => {
      window.top.openTrustedLinkIn(
        TorStrings.settings.learnMoreCircumventionURL,
        "tab"
      );
    });

    // Hack: see the CSS
    this._dialog.style.minWidth = "0";
    this._dialog.style.minHeight = "0";

    Services.obs.addObserver(this, TorConnectTopics.StateChange);
  }

  onTorStateChange() {
    if (TorConnect.canBeginBootstrap) {
      this._acceptButton.setAttribute(
        "label",
        TorStrings.settings.bridgeButtonConnect
      );
    } else {
      this._acceptButton.setAttribute(
        "label",
        TorStrings.settings.bridgeButtonAccept
      );
    }
  }

  init(window, aDialog) {
    // defer to later until firefox has populated the dialog with all our elements
    window.setTimeout(() => {
      this._populateXUL(window, aDialog);
    }, 0);
  }

  observe(subject, topic, data) {
    switch (topic) {
      case TorConnectTopics.StateChange:
        this.onTorStateChange();
        break;
    }
  }

  close() {
    // unregister our observer topics
    Services.obs.removeObserver(this, TorConnectTopics.StateChange);
  }

  openDialog(gSubDialog) {
    gSubDialog.open(
      "chrome://browser/content/torpreferences/builtinBridgeDialog.xhtml",
      {
        features: "resizable=yes",
        closingCallback: () => {
          this.close();
        },
      },
      this
    );
  }
}
