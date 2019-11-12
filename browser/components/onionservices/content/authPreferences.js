// Copyright (c) 2020, The Tor Project, Inc.

"use strict";

ChromeUtils.defineESModuleGetters(this, {
  TorStrings: "resource://gre/modules/TorStrings.sys.mjs",
});

/* globals gSubDialog */

/*
  Onion Services Client Authentication Preferences Code

  Code to handle init and update of onion services authentication section
  in about:preferences#privacy
*/

const OnionServicesAuthPreferences = {
  selector: {
    groupBox: "#torOnionServiceKeys",
    header: "#torOnionServiceKeys-header",
    overview: "#torOnionServiceKeys-overview",
    learnMore: "#torOnionServiceKeys-learnMore",
    savedKeysButton: "#torOnionServiceKeys-savedKeys",
  },

  init() {
    // populate XUL with localized strings
    this._populateXUL();
  },

  _populateXUL() {
    const groupbox = document.querySelector(this.selector.groupBox);

    let elem = groupbox.querySelector(this.selector.header);
    elem.textContent = TorStrings.onionServices.authPreferences.header;

    elem = groupbox.querySelector(this.selector.overview);
    elem.textContent = TorStrings.onionServices.authPreferences.overview;

    elem = groupbox.querySelector(this.selector.learnMore);
    elem.setAttribute("value", TorStrings.onionServices.learnMore);
    elem.setAttribute(
      "href",
      "about:manual#onion-services_onion-service-authentication"
    );
    elem.setAttribute("useoriginprincipal", "true");

    elem = groupbox.querySelector(this.selector.savedKeysButton);
    elem.setAttribute(
      "label",
      TorStrings.onionServices.authPreferences.savedKeys
    );
    elem.addEventListener("command", () =>
      OnionServicesAuthPreferences.onViewSavedKeys()
    );
  },

  onViewSavedKeys() {
    gSubDialog.open(
      "chrome://browser/content/onionservices/savedKeysDialog.xhtml"
    );
  },
}; // OnionServicesAuthPreferences

Object.defineProperty(this, "OnionServicesAuthPreferences", {
  value: OnionServicesAuthPreferences,
  enumerable: true,
  writable: false,
});
