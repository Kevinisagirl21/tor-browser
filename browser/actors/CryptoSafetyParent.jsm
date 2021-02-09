/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*- */
/* Copyright (c) 2020, The Tor Project, Inc.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var EXPORTED_SYMBOLS = ["CryptoSafetyParent"];

const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");
const { XPCOMUtils } = ChromeUtils.import(
  "resource://gre/modules/XPCOMUtils.jsm"
);

XPCOMUtils.defineLazyGetter(this, "cryptoSafetyBundle", () => {
  return Services.strings.createBundle(
    "chrome://browser/locale/cryptoSafetyPrompt.properties"
  );
});

// en-US fallback in case a locale is missing a string.
XPCOMUtils.defineLazyGetter(this, "fallbackCryptoSafetyBundle", () => {
  return Services.strings.createBundle(
    "resource:///chrome/en-US/locale/browser/cryptoSafetyPrompt.properties"
  );
});

XPCOMUtils.defineLazyPreferenceGetter(
  this,
  "isCryptoSafetyEnabled",
  "security.cryptoSafety",
  true // Defaults to true.
);

/**
 * Get a formatted string from the locale's bundle, or the en-US bundle if the
 * string is missing.
 *
 * @param {string} name - The string's name.
 * @param {string[]} [args] - Positional arguments to pass to the format string,
 *   or leave empty if none are needed.
 *
 * @returns {string} - The formatted string.
 */
function getString(name, args = []) {
  try {
    return cryptoSafetyBundle.formatStringFromName(name, args);
  } catch {
    return fallbackCryptoSafetyBundle.formatStringFromName(name, args);
  }
}

class CryptoSafetyParent extends JSWindowActorParent {
  receiveMessage(aMessage) {
    if (!isCryptoSafetyEnabled || aMessage.name !== "CryptoSafety:CopiedText") {
      return;
    }

    let address = aMessage.data.selection;
    if (address.length > 32) {
      address = `${address.substring(0, 32)}…`;
    }

    const buttonPressed = Services.prompt.confirmEx(
      this.browsingContext.topChromeWindow,
      getString("cryptoSafetyPrompt.cryptoTitle"),
      getString("cryptoSafetyPrompt.cryptoBody", [address, aMessage.data.host]),
      Services.prompt.BUTTON_TITLE_IS_STRING * Services.prompt.BUTTON_POS_0 +
        Services.prompt.BUTTON_TITLE_IS_STRING * Services.prompt.BUTTON_POS_1,
      getString("cryptoSafetyPrompt.primaryAction"),
      getString("cryptoSafetyPrompt.secondaryAction"),
      null,
      null,
      {}
    );

    if (buttonPressed === 0) {
      this.browsingContext.topChromeWindow.torbutton_new_circuit();
    }
  }
}
