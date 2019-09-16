"use strict";

var EXPORTED_SYMBOLS = ["TorLogDialog"];

const { setTimeout, clearTimeout } = ChromeUtils.importESModule(
  "resource://gre/modules/Timer.sys.mjs"
);

const { TorProviderBuilder } = ChromeUtils.importESModule(
  "resource://gre/modules/TorProviderBuilder.sys.mjs"
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

  async _populateXUL(aDialog) {
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

    // A waiting state should not be needed at this point.
    // Also, we probably cannot even arrive here if the provider failed to
    // initialize, otherwise we could use a try/catch, and write the exception
    // text in the logs, instead.
    const provider = await TorProviderBuilder.build();
    this._logTextarea.value = provider.getLog();
  }

  init(window, aDialog) {
    this._populateXUL(aDialog);
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
