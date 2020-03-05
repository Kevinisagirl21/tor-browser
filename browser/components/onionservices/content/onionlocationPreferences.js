// Copyright (c) 2020, The Tor Project, Inc.

"use strict";

ChromeUtils.defineESModuleGetters(this, {
  TorStrings: "resource://gre/modules/TorStrings.sys.mjs",
});

const OnionLocationPreferences = {
  init() {
    document.getElementById("onionServicesTitle").textContent =
      TorStrings.onionLocation.onionServicesTitle;
    document.getElementById("prioritizeOnionsDesc").textContent =
      TorStrings.onionLocation.prioritizeOnionsDescription;
    const learnMore = document.getElementById("onionServicesLearnMore");
    learnMore.textContent = TorStrings.onionLocation.learnMore;
    learnMore.href = TorStrings.onionLocation.learnMoreURL;
    if (TorStrings.onionLocation.learnMoreURL.startsWith("about:")) {
      learnMore.setAttribute("useoriginprincipal", "true");
    }
    document.getElementById("onionServicesRadioAlways").label =
      TorStrings.onionLocation.always;
    document.getElementById("onionServicesRadioAsk").label =
      TorStrings.onionLocation.askEverytime;
  },
};

Object.defineProperty(this, "OnionLocationPreferences", {
  value: OnionLocationPreferences,
  enumerable: true,
  writable: false,
});
