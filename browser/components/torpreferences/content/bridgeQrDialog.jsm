"use strict";

var EXPORTED_SYMBOLS = ["BridgeQrDialog"];

const { QRCode } = ChromeUtils.import("resource://gre/modules/QRCode.jsm");

const { TorStrings } = ChromeUtils.import("resource:///modules/TorStrings.jsm");

class BridgeQrDialog {
  constructor() {
    this._bridgeString = "";
  }

  static get selectors() {
    return {
      target: "#bridgeQr-target",
    };
  }

  _populateXUL(window, dialog) {
    dialog.parentElement.setAttribute("title", TorStrings.settings.scanQrTitle);
    const target = dialog.querySelector(BridgeQrDialog.selectors.target);
    const style = window.getComputedStyle(target);
    const width = style.width.substr(0, style.width.length - 2);
    const height = style.height.substr(0, style.height.length - 2);
    new QRCode(target, {
      text: this._bridgeString,
      width,
      height,
      colorDark: style.color,
      colorLight: style.backgroundColor,
      document: window.document,
    });
  }

  init(window, dialog) {
    this._populateXUL(window, dialog);
  }

  openDialog(gSubDialog, bridgeString) {
    this._bridgeString = bridgeString;
    gSubDialog.open(
      "chrome://browser/content/torpreferences/bridgeQrDialog.xhtml",
      { features: "resizable=yes" },
      this
    );
  }
}
