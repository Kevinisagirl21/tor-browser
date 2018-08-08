/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var EXPORTED_SYMBOLS = ["UITourChild"];

const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");

const PREF_TEST_WHITELIST = "browser.uitour.testingOrigins";
const UITOUR_PERMISSION = "uitour";

class UITourChild extends JSWindowActorChild {
  handleEvent(event) {
    if (!Services.prefs.getBoolPref("browser.uitour.enabled")) {
      return;
    }
    if (!this.ensureTrustedOrigin()) {
      return;
    }

    this.sendAsyncMessage("UITour:onPageEvent", {
      detail: event.detail,
      type: event.type,
      pageVisibilityState: this.document.visibilityState,
    });
  }

  // This function is copied from UITour.jsm.
  isSafeScheme(aURI) {
    let allowedSchemes = new Set(["about", "https"]);

    if (!allowedSchemes.has(aURI.scheme)) {
      return false;
    }

    return true;
  }

  ensureTrustedOrigin() {
    if (this.browsingContext.top != this.browsingContext) {
      return false;
    }

    let uri = this.document.documentURIObject;

    if (uri.schemeIs("chrome")) {
      return true;
    }

    if (!this.isSafeScheme(uri)) {
      return false;
    }

    let principal = Services.scriptSecurityManager.principalWithOA(
      this.document.nodePrincipal,
      {}
    );
    let permission = Services.perms.testPermissionFromPrincipal(
      principal,
      UITOUR_PERMISSION
    );
    if (permission == Services.perms.ALLOW_ACTION) {
      return true;
    }

    return false;
  }

  receiveMessage(aMessage) {
    switch (aMessage.name) {
      case "UITour:SendPageCallback":
        this.sendPageEvent("Response", aMessage.data);
        break;
      case "UITour:SendPageNotification":
        this.sendPageEvent("Notification", aMessage.data);
        break;
    }
  }

  sendPageEvent(type, detail) {
    if (!this.ensureTrustedOrigin()) {
      return;
    }

    let win = this.contentWindow;
    let eventName = "mozUITour" + type;
    let event = new win.CustomEvent(eventName, {
      bubbles: true,
      detail: Cu.cloneInto(detail, win),
    });
    win.document.dispatchEvent(event);
  }
}
