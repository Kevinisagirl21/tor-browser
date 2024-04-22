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

const lazy = {};

ChromeUtils.defineModuleGetter(
  lazy,
  "TorDomainIsolator",
  "resource://gre/modules/TorDomainIsolator.jsm"
);

ChromeUtils.defineLazyGetter(lazy, "CryptoStrings", function () {
  return new Localization(["toolkit/global/tor-browser.ftl"]);
});

XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "isCryptoSafetyEnabled",
  "security.cryptoSafety",
  true // Defaults to true.
);

class CryptoSafetyParent extends JSWindowActorParent {
  async receiveMessage(aMessage) {
    if (
      !lazy.isCryptoSafetyEnabled ||
      aMessage.name !== "CryptoSafety:CopiedText"
    ) {
      return;
    }

    let address = aMessage.data.selection;
    if (address.length > 32) {
      address = `${address.substring(0, 32)}…`;
    }

    const [titleText, bodyText, reloadText, dismissText] =
      await lazy.CryptoStrings.formatValues([
        { id: "crypto-safety-prompt-title" },
        {
          id: "crypto-safety-prompt-body",
          args: { address, host: aMessage.data.host },
        },
        { id: "crypto-safety-prompt-reload-button" },
        { id: "crypto-safety-prompt-dismiss-button" },
      ]);

    const buttonPressed = Services.prompt.confirmEx(
      this.browsingContext.topChromeWindow,
      titleText,
      bodyText,
      Services.prompt.BUTTON_TITLE_IS_STRING * Services.prompt.BUTTON_POS_0 +
        Services.prompt.BUTTON_TITLE_IS_STRING * Services.prompt.BUTTON_POS_1,
      reloadText,
      dismissText,
      null,
      null,
      {}
    );

    if (buttonPressed === 0) {
      const { browsingContext } = this.manager;
      const browser = browsingContext.embedderElement;
      if (browser) {
        lazy.TorDomainIsolator.newCircuitForBrowser(
          browser.ownerGlobal.gBrowser
        );
      }
    }
  }
}
