"use strict";

var EXPORTED_SYMBOLS = ["BuiltinBridgeDialog"];

const { TorStrings } = ChromeUtils.import("resource:///modules/TorStrings.jsm");

const {
  TorSettings,
  TorBridgeSource,
  TorBuiltinBridgeTypes,
} = ChromeUtils.import("resource:///modules/TorSettings.jsm");

class BuiltinBridgeDialog {
  constructor() {
    this._dialog = null;
    this._bridgeType = "";
    this._windowPadding = 0;
  }

  static get selectors() {
    return {
      header: "#torPreferences-builtinBridge-header",
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
    {
      dialogWin.setAttribute("title", TorStrings.settings.builtinBridgeTitle);
      let windowStyle = window.getComputedStyle(dialogWin);
      this._windowPadding =
        parseFloat(windowStyle.paddingLeft) +
        parseFloat(windowStyle.paddingRight);
    }
    const initialWidth = dialogWin.clientWidth - this._windowPadding;

    this._dialog.querySelector(selectors.header).textContent =
      TorStrings.settings.builtinBridgeHeader;
    this._dialog.querySelector(selectors.description).textContent =
      TorStrings.settings.builtinBridgeDescription;
    let radioGroup = this._dialog.querySelector(selectors.radiogroup);

    let types = {
      obfs4: {
        elemRadio: this._dialog.querySelector(selectors.obfsRadio),
        elemDescr: this._dialog.querySelector(selectors.obfsDescr),
        label: TorStrings.settings.builtinBridgeObfs4,
        descr: TorStrings.settings.builtinBridgeObfs4Description,
      },
      snowflake: {
        elemRadio: this._dialog.querySelector(selectors.snowflakeRadio),
        elemDescr: this._dialog.querySelector(selectors.snowflakeDescr),
        label: TorStrings.settings.builtinBridgeSnowflake,
        descr: TorStrings.settings.builtinBridgeSnowflakeDescription,
      },
      "meek-azure": {
        elemRadio: this._dialog.querySelector(selectors.meekAzureRadio),
        elemDescr: this._dialog.querySelector(selectors.meekAzureDescr),
        label: TorStrings.settings.builtinBridgeMeekAzure,
        descr: TorStrings.settings.builtinBridgeMeekAzureDescription,
      },
    };

    TorBuiltinBridgeTypes.forEach(type => {
      types[type].elemRadio.parentElement.setAttribute("hidden", "false");
      types[type].elemDescr.parentElement.setAttribute("hidden", "false");
      types[type].elemRadio.setAttribute("label", types[type].label);
      types[type].elemDescr.textContent = types[type].descr;
    });

    if (
      TorSettings.bridges.enabled &&
      TorSettings.bridges.source == TorBridgeSource.BuiltIn
    ) {
      radioGroup.selectedItem =
        types[TorSettings.bridges.builtin_type]?.elemRadio;
      this._bridgeType = TorSettings.bridges.builtin_type;
    } else {
      radioGroup.selectedItem = null;
      this._bridgeType = "";
    }

    // Use the initial width, because the window is expanded when we add texts
    this.resized(initialWidth);

    this._dialog.addEventListener("dialogaccept", e => {
      this._bridgeType = radioGroup.value;
    });
    this._dialog.addEventListener("dialoghelp", e => {
      window.top.openTrustedLinkIn(
        "https://tb-manual.torproject.org/circumvention/",
        "tab"
      );
    });
  }

  resized(width) {
    if (this._dialog === null) {
      return;
    }
    const dialogWin = this._dialog.parentElement;
    if (width === undefined) {
      width = dialogWin.clientWidth - this._windowPadding;
    }
    let windowPos = dialogWin.getBoundingClientRect();
    dialogWin.querySelectorAll("div").forEach(div => {
      let divPos = div.getBoundingClientRect();
      div.style.width = width - (divPos.left - windowPos.left) + "px";
    });
  }

  init(window, aDialog) {
    // defer to later until firefox has populated the dialog with all our elements
    window.setTimeout(() => {
      this._populateXUL(window, aDialog);
    }, 0);
  }

  openDialog(gSubDialog, aCloseCallback) {
    gSubDialog.open(
      "chrome://browser/content/torpreferences/builtinBridgeDialog.xhtml",
      {
        features: "resizable=yes",
        closingCallback: () => {
          aCloseCallback(this._bridgeType);
        },
      },
      this
    );
  }
}
