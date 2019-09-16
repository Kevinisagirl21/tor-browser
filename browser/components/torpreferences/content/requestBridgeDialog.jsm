"use strict";

var EXPORTED_SYMBOLS = ["RequestBridgeDialog"];

const { BridgeDB } = ChromeUtils.import("resource:///modules/BridgeDB.jsm");
const { TorStrings } = ChromeUtils.import("resource:///modules/TorStrings.jsm");

class RequestBridgeDialog {
  constructor(onSubmit) {
    this.onSubmit = onSubmit;
    this._dialog = null;
    this._submitButton = null;
    this._dialogHeader = null;
    this._captchaImage = null;
    this._captchaEntryTextbox = null;
    this._captchaRefreshButton = null;
    this._incorrectCaptchaHbox = null;
    this._incorrectCaptchaLabel = null;
  }

  static get selectors() {
    return {
      submitButton:
        "accept" /* not really a selector but a key for dialog's getButton */,
      dialogHeader: "h3#torPreferences-requestBridge-header",
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

  _populateXUL(window, dialog) {
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
    this._dialog.addEventListener("dialoghelp", e => {
      window.top.openTrustedLinkIn(
        TorStrings.settings.learnMoreBridgesURL,
        "tab"
      );
    });

    this._dialogHeader = this._dialog.querySelector(selectors.dialogHeader);
    this._dialogHeader.textContent = TorStrings.settings.contactingBridgeDB;

    this._captchaImage = this._dialog.querySelector(selectors.captchaImage);

    // request captcha from bridge db
    BridgeDB.requestNewCaptchaImage().then(uri => {
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
      this._dialogHeader.textContent = TorStrings.settings.solveTheCaptcha;
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
      this._populateXUL(window, dialog);
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
        if (aBridges) {
          this.onSubmit(aBridges);
          this._submitButton.disabled = false;
          // This was successful, but use cancelDialog() to close, since
          // we intercept the `dialogaccept` event.
          this._dialog.cancelDialog();
        } else {
          this._setUIDisabled(false);
          this._incorrectCaptchaHbox.style.visibility = "visible";
        }
      })
      .catch(aError => {
        // TODO: handle other errors properly here when we do the bridge settings re-design
        this._setUIDisabled(false);
        this._incorrectCaptchaHbox.style.visibility = "visible";
        console.log(aError);
      });
  }

  onRefreshCaptcha() {
    this._setUIDisabled(true);
    this._captchaImage.src = "";
    this._dialogHeader.textContent = TorStrings.settings.contactingBridgeDB;
    this._captchaEntryTextbox.value = "";
    this._incorrectCaptchaHbox.style.visibility = "hidden";

    BridgeDB.requestNewCaptchaImage().then(uri => {
      this._setcaptchaImage(uri);
    });
  }

  openDialog(gSubDialog) {
    gSubDialog.open(
      "chrome://browser/content/torpreferences/requestBridgeDialog.xhtml",
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
