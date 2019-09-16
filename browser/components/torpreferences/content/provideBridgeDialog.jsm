"use strict";

var EXPORTED_SYMBOLS = ["ProvideBridgeDialog"];

const { TorStrings } = ChromeUtils.import("resource:///modules/TorStrings.jsm");

const { TorSettings, TorBridgeSource } = ChromeUtils.import(
  "resource:///modules/TorSettings.jsm"
);

class ProvideBridgeDialog {
  constructor(onSubmit) {
    this.onSubmit = onSubmit;
    this._dialog = null;
    this._textarea = null;
  }

  static get selectors() {
    return {
      header: "#torPreferences-provideBridge-header",
      textarea: "#torPreferences-provideBridge-textarea",
    };
  }

  _populateXUL(window, aDialog) {
    const selectors = ProvideBridgeDialog.selectors;

    this._dialog = aDialog;
    const dialogWin = this._dialog.parentElement;
    dialogWin.setAttribute("title", TorStrings.settings.provideBridgeTitle);
    this._dialog.querySelector(selectors.header).textContent =
      TorStrings.settings.provideBridgeHeader;
    this._textarea = this._dialog.querySelector(selectors.textarea);
    this._textarea.setAttribute(
      "placeholder",
      TorStrings.settings.provideBridgePlaceholder
    );
    if (TorSettings.bridges.source == TorBridgeSource.UserProvided) {
      this._textarea.value = TorSettings.bridges.bridge_strings.join("\n");
    }

    this._dialog.addEventListener("dialogaccept", e => {
      this.onSubmit(this._textarea.value);
    });
    this._dialog.addEventListener("dialoghelp", e => {
      window.top.openTrustedLinkIn(
        TorStrings.settings.learnMoreBridgesURL,
        "tab"
      );
    });
  }

  init(window, aDialog) {
    // defer to later until firefox has populated the dialog with all our elements
    window.setTimeout(() => {
      this._populateXUL(window, aDialog);
    }, 0);
  }

  openDialog(gSubDialog) {
    gSubDialog.open(
      "chrome://browser/content/torpreferences/provideBridgeDialog.xhtml",
      { features: "resizable=yes" },
      this
    );
  }
}
