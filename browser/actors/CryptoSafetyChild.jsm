/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*- */
/* Copyright (c) 2020, The Tor Project, Inc.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var EXPORTED_SYMBOLS = ["CryptoSafetyChild"];

const { Bech32Decode } = ChromeUtils.import(
  "resource://gre/modules/Bech32Decode.jsm"
);

const { XPCOMUtils } = ChromeUtils.import(
  "resource://gre/modules/XPCOMUtils.jsm"
);

const lazy = {};

XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "isCryptoSafetyEnabled",
  "security.cryptoSafety",
  true // Defaults to true.
);

function looksLikeCryptoAddress(s) {
  // P2PKH and P2SH addresses
  // https://stackoverflow.com/a/24205650
  const bitcoinAddr = /^[13][a-km-zA-HJ-NP-Z1-9]{25,39}$/;
  if (bitcoinAddr.test(s)) {
    return true;
  }

  // Bech32 addresses
  if (Bech32Decode(s) !== null) {
    return true;
  }

  // regular addresses
  const etherAddr = /^0x[a-fA-F0-9]{40}$/;
  if (etherAddr.test(s)) {
    return true;
  }

  // t-addresses
  // https://www.reddit.com/r/zec/comments/8mxj6x/simple_regex_to_validate_a_zcash_tz_address/dzr62p5/
  const zcashAddr = /^t1[a-zA-Z0-9]{33}$/;
  if (zcashAddr.test(s)) {
    return true;
  }

  // Standard, Integrated, and 256-bit Integrated addresses
  // https://monero.stackexchange.com/a/10627
  const moneroAddr =
    /^4(?:[0-9AB]|[1-9A-HJ-NP-Za-km-z]{12}(?:[1-9A-HJ-NP-Za-km-z]{30})?)[1-9A-HJ-NP-Za-km-z]{93}$/;
  if (moneroAddr.test(s)) {
    return true;
  }

  return false;
}

class CryptoSafetyChild extends JSWindowActorChild {
  handleEvent(event) {
    if (
      !lazy.isCryptoSafetyEnabled ||
      // Ignore non-HTTP addresses.
      // We do this before reading the host property since this is not available
      // for about: pages.
      !this.document.documentURIObject.schemeIs("http") ||
      // Ignore onion addresses.
      this.document.documentURIObject.host.endsWith(".onion") ||
      (event.type !== "copy" && event.type !== "cut")
    ) {
      return;
    }

    this.contentWindow.navigator.clipboard.readText().then(clipText => {
      const selection = clipText.replace(/\s+/g, "");
      if (!looksLikeCryptoAddress(selection)) {
        return;
      }
      this.sendAsyncMessage("CryptoSafety:CopiedText", {
        selection,
        host: this.document.documentURIObject.host,
      });
    });
  }
}
