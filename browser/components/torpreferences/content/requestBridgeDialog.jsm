"use strict";

var EXPORTED_SYMBOLS = ["RequestBridgeDialog"];

const { BridgeDB } = ChromeUtils.import("resource:///modules/BridgeDB.jsm");
const { TorStrings } = ChromeUtils.import("resource:///modules/TorStrings.jsm");

class RequestBridgeDialog {
  constructor() {
    this._dialog = null;
    this._submitButton = null;
    this._dialogDescription = null;
    this._captchaImage = null;
    this._captchaEntryTextbox = null;
    this._captchaRefreshButton = null;
    this._incorrectCaptchaHbox = null;
    this._incorrectCaptchaLabel = null;
    this._bridges = [];
    this._proxyURI = null;
  }

  static get selectors() {
    return {
      submitButton:
        "accept" /* not really a selector but a key for dialog's getButton */,
      dialogDescription: "description#torPreferences-requestBridge-description",
      captchaImage: "image#torPreferences-requestBridge-captchaImage",
      captchaEntryTextbox: "input#torPreferences-requestBridge-captchaTextbox",
      refreshCaptchaButton:
        "button#torPreferences-requestBridge-refreshCaptchaButton",
      incorrectCaptchaHbox:
        "hbox#torPreferences-requestBridge-incorrectCaptchaHbox",
      incorrectCaptchaLabel:
        "label#torPreferences-requestBridge-incorrectCaptchaError",
    };
  }

  _populateXUL(dialog) {
    const selectors = RequestBridgeDialog.selectors;

    this._dialog = dialog;
    const dialogWin = dialog.parentElement;
    dialogWin.setAttribute(
      "title",
      TorStrings.settings.requestBridgeDialogTitle
    );
    // user may have opened a Request Bridge dialog in another tab, so update the
    // CAPTCHA image or close out the dialog if we have a bridge list
    this._dialog.addEventListener("focusin", () => {
      const uri = BridgeDB.currentCaptchaImage;
      const bridges = BridgeDB.currentBridges;

      // new captcha image
      if (uri) {
        this._setcaptchaImage(uri);
      } else if (bridges) {
        this._bridges = bridges;
        this._submitButton.disabled = false;
        this._dialog.cancelDialog();
      }
    });

    this._submitButton = this._dialog.getButton(selectors.submitButton);
    this._submitButton.setAttribute("label", TorStrings.settings.submitCaptcha);
    this._submitButton.disabled = true;
    this._dialog.addEventListener("dialogaccept", e => {
      e.preventDefault();
      this.onSubmitCaptcha();
    });

    this._dialogDescription = this._dialog.querySelector(
      selectors.dialogDescription
    );
    this._dialogDescription.textContent =
      TorStrings.settings.contactingBridgeDB;

    this._captchaImage = this._dialog.querySelector(selectors.captchaImage);

    // request captcha from bridge db
    BridgeDB.requestNewCaptchaImage(this._proxyURI).then(uri => {
      this._setcaptchaImage(uri);
    });

    this._captchaEntryTextbox = this._dialog.querySelector(
      selectors.captchaEntryTextbox
    );
    this._captchaEntryTextbox.setAttribute(
      "placeholder",
      TorStrings.settings.captchaTextboxPlaceholder
    );
    this._captchaEntryTextbox.disabled = true;
    // disable submit if entry textbox is empty
    this._captchaEntryTextbox.oninput = () => {
      this._submitButton.disabled = this._captchaEntryTextbox.value == "";
    };

    this._captchaRefreshButton = this._dialog.querySelector(
      selectors.refreshCaptchaButton
    );
    this._captchaRefreshButton.disabled = true;

    this._incorrectCaptchaHbox = this._dialog.querySelector(
      selectors.incorrectCaptchaHbox
    );
    this._incorrectCaptchaLabel = this._dialog.querySelector(
      selectors.incorrectCaptchaLabel
    );
    this._incorrectCaptchaLabel.setAttribute(
      "value",
      TorStrings.settings.incorrectCaptcha
    );

    return true;
  }

  _setcaptchaImage(uri) {
    if (uri != this._captchaImage.src) {
      this._captchaImage.src = uri;
      this._dialogDescription.textContent = TorStrings.settings.solveTheCaptcha;
      this._setUIDisabled(false);
      this._captchaEntryTextbox.focus();
      this._captchaEntryTextbox.select();
    }
  }

  _setUIDisabled(disabled) {
    this._submitButton.disabled = this._captchaGuessIsEmpty() || disabled;
    this._captchaEntryTextbox.disabled = disabled;
    this._captchaRefreshButton.disabled = disabled;
  }

  _captchaGuessIsEmpty() {
    return this._captchaEntryTextbox.value == "";
  }

  init(window, dialog) {
    // defer to later until firefox has populated the dialog with all our elements
    window.setTimeout(() => {
      this._populateXUL(dialog);
    }, 0);
  }

  close() {
    BridgeDB.close();
  }

  /*
    Event Handlers
  */
  onSubmitCaptcha() {
    let captchaText = this._captchaEntryTextbox.value.trim();
    // noop if the field is empty
    if (captchaText == "") {
      return;
    }

    // freeze ui while we make request
    this._setUIDisabled(true);
    this._incorrectCaptchaHbox.style.visibility = "hidden";

    BridgeDB.submitCaptchaGuess(captchaText)
      .then(aBridges => {
        this._bridges = aBridges;

        this._submitButton.disabled = false;
        // This was successful, but use cancelDialog() to close, since
        // we intercept the `dialogaccept` event.
        this._dialog.cancelDialog();
      })
      .catch(aError => {
        this._bridges = [];
        this._setUIDisabled(false);
        this._incorrectCaptchaHbox.style.visibility = "visible";
      });
  }

  onRefreshCaptcha() {
    this._setUIDisabled(true);
    this._captchaImage.src = "";
    this._dialogDescription.textContent =
      TorStrings.settings.contactingBridgeDB;
    this._captchaEntryTextbox.value = "";
    this._incorrectCaptchaHbox.style.visibility = "hidden";

    BridgeDB.requestNewCaptchaImage(this._proxyURI).then(uri => {
      this._setcaptchaImage(uri);
    });
  }

  openDialog(gSubDialog, aProxyURI, aCloseCallback) {
    this._proxyURI = aProxyURI;
    gSubDialog.open(
      "chrome://browser/content/torpreferences/requestBridgeDialog.xhtml",
      {
        features: "resizable=yes",
        closingCallback: () => {
          this.close();
          aCloseCallback(this._bridges);
        }
      },
      this,
    );
  }
}
