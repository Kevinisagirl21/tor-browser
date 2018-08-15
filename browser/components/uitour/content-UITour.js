/* This Source Code Form is subject to the terms of the Mozilla Public
* License, v. 2.0. If a copy of the MPL was not distributed with this
* file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* eslint-env mozilla/frame-script */

ChromeUtils.import("resource://gre/modules/Services.jsm");

const PREF_TEST_WHITELIST = "browser.uitour.testingOrigins";
const UITOUR_PERMISSION   = "uitour";

var UITourListener = {
  handleEvent(event) {
    if (!Services.prefs.getBoolPref("browser.uitour.enabled")) {
      return;
    }
    if (!this.ensureTrustedOrigin()) {
      return;
    }
    addMessageListener("UITour:SendPageCallback", this);
    addMessageListener("UITour:SendPageNotification", this);
    sendAsyncMessage("UITour:onPageEvent", {
      detail: event.detail,
      type: event.type,
      pageVisibilityState: content.document.visibilityState,
    });
  },

  // This function is copied from UITour.jsm.
  isSafeScheme(aURI) {
    let allowedSchemes = new Set(["about"]);

    if (!allowedSchemes.has(aURI.scheme))
      return false;

    return true;
  },

  ensureTrustedOrigin() {
    if (content.top != content)
      return false;

    let uri = content.document.documentURIObject;

    if (uri.schemeIs("chrome"))
      return true;

    if (!this.isSafeScheme(uri))
      return false;

    let permission = Services.perms.testPermission(uri, UITOUR_PERMISSION);
    if (permission == Services.perms.ALLOW_ACTION)
      return true;

    return false;
  },

  receiveMessage(aMessage) {
    switch (aMessage.name) {
      case "UITour:SendPageCallback":
        this.sendPageEvent("Response", aMessage.data);
        break;
      case "UITour:SendPageNotification":
        this.sendPageEvent("Notification", aMessage.data);
        break;
      }
  },

  sendPageEvent(type, detail) {
    if (!this.ensureTrustedOrigin()) {
      return;
    }

    let doc = content.document;
    let eventName = "mozUITour" + type;
    let event = new doc.defaultView.CustomEvent(eventName, {
      bubbles: true,
      detail: Cu.cloneInto(detail, doc.defaultView)
    });
    doc.dispatchEvent(event);
  }
};

addEventListener("mozUITour", UITourListener, false, true);
