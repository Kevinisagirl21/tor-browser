// Copyright (c) 2020, The Tor Project, Inc.

"use strict";

var EXPORTED_SYMBOLS = ["OnionAuthUtil"];

var { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");

const OnionAuthUtil = {
  topic: {
    clientAuthMissing: "tor-onion-services-clientauth-missing",
    clientAuthIncorrect: "tor-onion-services-clientauth-incorrect",
  },
  message: {
    authPromptCanceled: "Tor:OnionServicesAuthPromptCanceled",
  },
  domid: {
    anchor: "tor-clientauth-notification-icon",
    notification: "tor-clientauth",
    description: "tor-clientauth-notification-desc",
    learnMore: "tor-clientauth-notification-learnmore",
    onionNameSpan: "tor-clientauth-notification-onionname",
    keyElement: "tor-clientauth-notification-key",
    warningElement: "tor-clientauth-warning",
    checkboxElement: "tor-clientauth-persistkey-checkbox",
  },
};
