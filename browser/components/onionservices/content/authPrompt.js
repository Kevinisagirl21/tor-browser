/* eslint-env mozilla/browser-window */

"use strict";

var OnionAuthPrompt = {
  // Only import to our internal scope, rather than the global scope of
  // browser.xhtml.
  _lazy: {},

  _topics: {
    clientAuthMissing: "tor-onion-services-clientauth-missing",
    clientAuthIncorrect: "tor-onion-services-clientauth-incorrect",
  },

  /**
   * @typedef {object} PromptDetails
   *
   * @property {Browser} browser - The browser this prompt is for.
   * @property {string} cause - The notification that cause this prompt.
   * @property {string} onionHost - The onion host name.
   * @property {nsIURI} uri - The browser URI when the notification was
   *   triggered.
   * @property {string} onionServiceId - The onion service ID for this host.
   * @property {Notification} [notification] - The notification instance for
   *   this prompt.
   */

  /**
   * The currently shown details in the prompt.
   */
  _shownDetails: null,

  /**
   * Show a new prompt, using the given details.
   *
   * @param {PromptDetails} details - The details to show.
   */
  show(details) {
    let mainAction = {
      label: this.TorStrings.onionServices.authPrompt.done,
      accessKey: this.TorStrings.onionServices.authPrompt.doneAccessKey,
      leaveOpen: true, // Callback is responsible for closing the notification.
      callback: this._onDone.bind(this),
    };

    let dialogBundle = Services.strings.createBundle(
      "chrome://global/locale/dialog.properties"
    );

    let cancelAccessKey = dialogBundle.GetStringFromName("accesskey-cancel");
    if (!cancelAccessKey) {
      cancelAccessKey = "c";
    } // required by PopupNotifications.show()

    let cancelAction = {
      label: dialogBundle.GetStringFromName("button-cancel"),
      accessKey: cancelAccessKey,
      callback: this._onCancel.bind(this),
    };

    let options = {
      autofocus: true,
      hideClose: true,
      persistent: true,
      removeOnDismissal: false,
      eventCallback: topic => {
        if (topic === "showing") {
          this._onPromptShowing(details);
        } else if (topic === "shown") {
          this._onPromptShown();
        } else if (topic === "removed") {
          this._onPromptRemoved(details);
        }
      },
    };

    details.notification = PopupNotifications.show(
      details.browser,
      "tor-clientauth",
      "",
      "tor-clientauth-notification-icon",
      mainAction,
      [cancelAction],
      options
    );
  },

  _onPromptShowing(details) {
    if (details === this._shownDetails) {
      // The last shown details match this one exactly.
      // This happens when we switch tabs to a page that has no prompt and then
      // switch back.
      // We don't want to reset the current state in this case.
      // In particular, we keep the current _keyInput value and _persistCheckbox
      // the same.
      return;
    }

    this._shownDetails = details;

    // Clear the key input.
    // In particular, clear the input when switching tabs.
    this._keyInput.value = "";
    this._persistCheckbox.checked = false;

    // Handle replacement of the onion name within the localized
    // string ourselves so we can show the onion name as bold text.
    // We do this by splitting the localized string and creating
    // several HTML <span> elements.
    const fmtString = this.TorStrings.onionServices.authPrompt.description;
    const [prefix, suffix] = fmtString.split("%S");

    const domainEl = document.createElement("span");
    domainEl.id = "tor-clientauth-notification-onionname";
    domainEl.textContent = TorUIUtils.shortenOnionAddress(
      this._shownDetails?.onionHost ?? ""
    );

    this._descriptionEl.replaceChildren(prefix, domainEl, suffix);

    this._showWarning(undefined);
  },

  _onPromptShown() {
    this._keyInput.focus();
  },

  _onPromptRemoved(details) {
    if (details !== this._shownDetails) {
      // Removing the notification for some other page.
      // For example, closing another tab that also requires authentication.
      return;
    }
    // Reset the prompt as a precaution.
    // In particular, we want to clear the input so that the entered key does
    // not persist.
    this._onPromptShowing(null);
  },

  _onKeyFieldKeyPress(aEvent) {
    if (aEvent.keyCode == aEvent.DOM_VK_RETURN) {
      this._onDone();
    } else if (aEvent.keyCode == aEvent.DOM_VK_ESCAPE) {
      this._shownDetails.notification.remove();
      this._onCancel();
    }
  },

  _onKeyFieldInput(aEvent) {
    this._showWarning(undefined); // Remove the warning.
  },

  async _onDone() {
    // Grab the details before they might change as we await.
    const { browser, onionServiceId, notification } = this._shownDetails;
    const isPermanent = this._persistCheckbox.checked;

    const base64key = this._keyToBase64(this._keyInput.value);
    if (!base64key) {
      this._showWarning(this.TorStrings.onionServices.authPrompt.invalidKey);
      return;
    }

    const controllerFailureMsg =
      this.TorStrings.onionServices.authPrompt.failedToSetKey;
    try {
      const provider = await this._lazy.TorProviderBuilder.build();
      await provider.onionAuthAdd(onionServiceId, base64key, isPermanent);
    } catch (e) {
      if (e.torMessage) {
        this._showWarning(e.torMessage);
      } else {
        console.error(controllerFailureMsg, e);
        this._showWarning(controllerFailureMsg);
      }
      return;
    }

    notification.remove();
    // Success! Reload the page.
    browser.sendMessageToActor("Browser:Reload", {}, "BrowserTab");
  },

  _onCancel() {
    // Arrange for an error page to be displayed:
    // we build a short script calling docShell.displayError()
    // and we pass it as a data: URI to loadFrameScript(),
    // which runs it in the content frame which triggered
    // this authentication prompt.

    const { browser, cause, uri } = this._shownDetails;
    const errorCode =
      cause === this._topics.clientAuthMissing
        ? Cr.NS_ERROR_TOR_ONION_SVC_MISSING_CLIENT_AUTH
        : Cr.NS_ERROR_TOR_ONION_SVC_BAD_CLIENT_AUTH;
    const io =
      'ChromeUtils.import("resource://gre/modules/Services.jsm").Services.io';

    browser.messageManager.loadFrameScript(
      `data:application/javascript,${encodeURIComponent(
        `docShell.displayLoadError(${errorCode}, ${io}.newURI(${JSON.stringify(
          uri.spec
        )}), undefined, undefined);`
      )}`,
      false
    );
  },

  _showWarning(aWarningMessage) {
    if (aWarningMessage) {
      this._warningEl.textContent = aWarningMessage;
      this._warningEl.removeAttribute("hidden");
      this._keyInput.classList.add("invalid");
    } else {
      this._warningEl.setAttribute("hidden", "true");
      this._keyInput.classList.remove("invalid");
    }
  },

  // Returns undefined if the key is the wrong length or format.
  _keyToBase64(aKeyString) {
    if (!aKeyString) {
      return undefined;
    }

    let base64key;
    if (aKeyString.length == 52) {
      // The key is probably base32-encoded. Attempt to decode.
      // Although base32 specifies uppercase letters, we accept lowercase
      // as well because users may type in lowercase or copy a key out of
      // a tor onion-auth file (which uses lowercase).
      let rawKey;
      try {
        rawKey = this._lazy.CommonUtils.decodeBase32(aKeyString.toUpperCase());
      } catch (e) {}

      if (rawKey) {
        try {
          base64key = btoa(rawKey);
        } catch (e) {}
      }
    } else if (
      aKeyString.length == 44 &&
      /^[a-zA-Z0-9+/]*=*$/.test(aKeyString)
    ) {
      // The key appears to be a correctly formatted base64 value. If not,
      // tor will return an error when we try to add the key via the
      // control port.
      base64key = aKeyString;
    }

    return base64key;
  },

  init() {
    const { TorStrings } = ChromeUtils.importESModule(
      "resource://gre/modules/TorStrings.sys.mjs"
    );
    this.TorStrings = TorStrings;
    ChromeUtils.defineESModuleGetters(this._lazy, {
      TorProviderBuilder: "resource://gre/modules/TorProviderBuilder.sys.mjs",
      CommonUtils: "resource://services-common/utils.sys.mjs",
    });

    this._keyInput = document.getElementById("tor-clientauth-notification-key");
    this._persistCheckbox = document.getElementById(
      "tor-clientauth-persistkey-checkbox"
    );
    this._warningEl = document.getElementById("tor-clientauth-warning");
    this._descriptionEl = document.getElementById(
      "tor-clientauth-notification-desc"
    );

    // Set "Learn More" label and href.
    const learnMoreElem = document.getElementById(
      "tor-clientauth-notification-learnmore"
    );
    learnMoreElem.setAttribute(
      "value",
      this.TorStrings.onionServices.learnMore
    );

    this._keyInput.setAttribute(
      "placeholder",
      this.TorStrings.onionServices.authPrompt.keyPlaceholder
    );
    this._keyInput.addEventListener("keypress", event => {
      this._onKeyFieldKeyPress(event);
    });
    this._keyInput.addEventListener("input", event => {
      this._onKeyFieldInput(event);
    });

    Services.obs.addObserver(this, this._topics.clientAuthMissing);
    Services.obs.addObserver(this, this._topics.clientAuthIncorrect);
  },

  uninit() {
    Services.obs.removeObserver(this, this._topics.clientAuthMissing);
    Services.obs.removeObserver(this, this._topics.clientAuthIncorrect);
  },

  // aSubject is the DOM Window or browser where the prompt should be shown.
  // aData contains the .onion name.
  observe(aSubject, aTopic, aData) {
    if (
      aTopic != this._topics.clientAuthMissing &&
      aTopic != this._topics.clientAuthIncorrect
    ) {
      return;
    }

    let browser;
    if (aSubject instanceof Ci.nsIDOMWindow) {
      let contentWindow = aSubject.QueryInterface(Ci.nsIDOMWindow);
      browser = contentWindow.docShell.chromeEventHandler;
    } else {
      browser = aSubject.QueryInterface(Ci.nsIBrowser);
    }

    if (!gBrowser.browsers.some(aBrowser => aBrowser == browser)) {
      return; // This window does not contain the subject browser; ignore.
    }

    // ^(subdomain.)*onionserviceid.onion$ (case-insensitive)
    const onionServiceId = aData
      .match(/^(.*\.)?(?<onionServiceId>[a-z2-7]{56})\.onion$/i)
      ?.groups.onionServiceId.toLowerCase();
    if (!onionServiceId) {
      console.error(`Malformed onion address: ${aData}`);
      return;
    }

    const details = {
      browser,
      cause: aTopic,
      onionHost: aData,
      uri: browser.currentURI,
      onionServiceId,
    };
    this.show(details);
  },
};
