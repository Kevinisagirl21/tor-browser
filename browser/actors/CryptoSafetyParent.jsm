/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*- */
/* Copyright (c) 2020, The Tor Project, Inc.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var EXPORTED_SYMBOLS = ["CryptoSafetyParent"];

const { XPCOMUtils } = ChromeUtils.import(
  "resource://gre/modules/XPCOMUtils.jsm"
);

XPCOMUtils.defineLazyModuleGetters(this, {
  TorStrings: "resource:///modules/TorStrings.jsm",
});

const kPrefCryptoSafety = "security.cryptoSafety";

XPCOMUtils.defineLazyPreferenceGetter(
  this,
  "isCryptoSafetyEnabled",
  kPrefCryptoSafety,
  true /* defaults to true */
);

class CryptoSafetyParent extends JSWindowActorParent {
  getBrowser() {
    return this.browsingContext.top.embedderElement;
  }

  receiveMessage(aMessage) {
    if (isCryptoSafetyEnabled) {
      if (aMessage.name == "CryptoSafety:CopiedText") {
        showPopup(this.getBrowser(), aMessage.data.selection);
      }
    }
  }
}

function trimAddress(cryptoAddr) {
  if (cryptoAddr.length <= 32) {
    return cryptoAddr;
  }
  return cryptoAddr.substring(0, 32) + "...";
}

function showPopup(aBrowser, cryptoAddr) {
  const chromeDoc = aBrowser.ownerDocument;
  if (chromeDoc) {
    const win = chromeDoc.defaultView;
    const cryptoSafetyPrompt = new CryptoSafetyPrompt(
      aBrowser,
      win,
      cryptoAddr
    );
    cryptoSafetyPrompt.show();
  }
}

class CryptoSafetyPrompt {
  constructor(aBrowser, aWin, cryptoAddr) {
    this._browser = aBrowser;
    this._win = aWin;
    this._cryptoAddr = cryptoAddr;
  }

  show() {
    const primaryAction = {
      label: TorStrings.cryptoSafetyPrompt.primaryAction,
      accessKey: TorStrings.cryptoSafetyPrompt.primaryActionAccessKey,
      callback: () => {
        this._win.torbutton_new_circuit();
      },
    };

    const secondaryAction = {
      label: TorStrings.cryptoSafetyPrompt.secondaryAction,
      accessKey: TorStrings.cryptoSafetyPrompt.secondaryActionAccessKey,
      callback: () => {},
    };

    let _this = this;
    const options = {
      popupIconURL: "chrome://browser/skin/cert-error.svg",
      eventCallback(aTopic) {
        if (aTopic === "showing") {
          _this._onPromptShowing();
        }
      },
    };

    const cryptoWarningText = TorStrings.cryptoSafetyPrompt.cryptoWarning.replace(
      "%S",
      trimAddress(this._cryptoAddr)
    );

    if (this._win.PopupNotifications) {
      this._prompt = this._win.PopupNotifications.show(
        this._browser,
        "crypto-safety-warning",
        cryptoWarningText,
        null /* anchor ID */,
        primaryAction,
        [secondaryAction],
        options
      );
    }
  }

  _onPromptShowing() {
    let xulDoc = this._browser.ownerDocument;

    let whatCanHeading = xulDoc.getElementById(
      "crypto-safety-warning-notification-what-can-heading"
    );
    if (whatCanHeading) {
      whatCanHeading.textContent = TorStrings.cryptoSafetyPrompt.whatCanHeading;
    }

    let whatCanBody = xulDoc.getElementById(
      "crypto-safety-warning-notification-what-can-body"
    );
    if (whatCanBody) {
      whatCanBody.textContent = TorStrings.cryptoSafetyPrompt.whatCanBody;
    }

    let learnMoreElem = xulDoc.getElementById(
      "crypto-safety-warning-notification-learnmore"
    );
    if (learnMoreElem) {
      learnMoreElem.setAttribute(
        "value",
        TorStrings.cryptoSafetyPrompt.learnMore
      );
      learnMoreElem.setAttribute(
        "href",
        TorStrings.cryptoSafetyPrompt.learnMoreURL
      );
    }
  }
}
