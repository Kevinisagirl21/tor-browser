// Copyright (c) 2020, The Tor Project, Inc.

"use strict";

var EXPORTED_SYMBOLS = [
  "OnionAuthUtil",
];

var { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");

const OnionAuthUtil = {
  string: {
    authPromptTopic: "tor-onion-services-auth-prompt",
    authPromptCanceledMessage: "Tor:OnionServicesAuthPromptCanceled",
    anchorID: "tor-clientauth-notification-icon",
    notificationID: "tor-clientauth",
    descriptionID: "tor-clientauth-notification-desc",
    learnMoreID: "tor-clientauth-notification-learnmore",
    onionNameSpanID: "tor-clientauth-notification-onionname",
    keyElementID: "tor-clientauth-notification-key",
    warningElementID: "tor-clientauth-warning",
  },

  addCancelMessageListener(aTabContent, aDocShell) {
    aTabContent.addMessageListener(this.string.authPromptCanceledMessage,
                                   (aMessage) => {
      let failedURI = Services.io.newURI(aMessage.data.failedURI);
      aDocShell.displayLoadError(Cr.NS_ERROR_CONNECTION_REFUSED, failedURI,
                                 undefined, undefined);
    });
  },
};
