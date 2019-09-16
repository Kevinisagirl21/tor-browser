"use strict";

var EXPORTED_SYMBOLS = ["TorLogDialog"];

const { setTimeout, clearTimeout } = ChromeUtils.import(
  "resource://gre/modules/Timer.jsm"
);

const { TorProtocolService } = ChromeUtils.import(
  "resource:///modules/TorProtocolService.jsm"
);
const { TorStrings } = ChromeUtils.import("resource:///modules/TorStrings.jsm");

class TorLogDialog {
  constructor() {
    this._dialog = null;
    this._logTextarea = null;
    this._copyLogButton = null;
    this._restoreButtonTimeout = null;
  }

  static get selectors() {
    return {
      copyLogButton: "extra1",
      logTextarea: "textarea#torPreferences-torDialog-textarea",
    };
  }

  _populateXUL(aDialog) {
    this._dialog = aDialog;
    const dialogWin = this._dialog.parentElement;
    dialogWin.setAttribute("title", TorStrings.settings.torLogDialogTitle);

    this._logTextarea = this._dialog.querySelector(
      TorLogDialog.selectors.logTextarea
    );

    this._copyLogButton = this._dialog.getButton(
      TorLogDialog.selectors.copyLogButton
    );
    this._copyLogButton.setAttribute("label", TorStrings.settings.copyLog);
    this._copyLogButton.addEventListener("command", () => {
      this.copyTorLog();
      const label = this._copyLogButton.querySelector("label");
      label.setAttribute("value", TorStrings.settings.copied);
      this._copyLogButton.classList.add("primary");

      const RESTORE_TIME = 1200;
      if (this._restoreButtonTimeout !== null) {
        clearTimeout(this._restoreButtonTimeout);
      }
      this._restoreButtonTimeout = setTimeout(() => {
        label.setAttribute("value", TorStrings.settings.copyLog);
        this._copyLogButton.classList.remove("primary");
        this._restoreButtonTimeout = null;
      }, RESTORE_TIME);
    });

    this._logTextarea.value = TorProtocolService.getLog();
  }

  init(window, aDialog) {
    // defer to later until firefox has populated the dialog with all our elements
    window.setTimeout(() => {
      this._populateXUL(aDialog);
    }, 0);
  }

  copyTorLog() {
    // Copy tor log messages to the system clipboard.
    let clipboard = Cc["@mozilla.org/widget/clipboardhelper;1"].getService(
      Ci.nsIClipboardHelper
    );
    clipboard.copyString(this._logTextarea.value);
  }

  openDialog(gSubDialog) {
    gSubDialog.open(
      "chrome://browser/content/torpreferences/torLogDialog.xhtml",
      { features: "resizable=yes" },
      this
    );
  }
}
