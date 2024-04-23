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

  show() {
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

    let _this = this;
    let options = {
      autofocus: true,
      hideClose: true,
      persistent: true,
      removeOnDismissal: false,
      eventCallback(aTopic) {
        if (aTopic === "showing") {
          _this._onPromptShowing();
        } else if (aTopic === "shown") {
          _this._onPromptShown();
        } else if (aTopic === "removed") {
          _this._onPromptRemoved();
        }
      },
    };

    this._prompt = PopupNotifications.show(
      this._browser,
      "tor-clientauth",
      "",
      "tor-clientauth-notification-icon",
      mainAction,
      [cancelAction],
      options
    );
  },

  _onPromptShowing() {
    let xulDoc = this._browser.ownerDocument;
    let descElem = xulDoc.getElementById("tor-clientauth-notification-desc");
    if (descElem) {
      // Handle replacement of the onion name within the localized
      // string ourselves so we can show the onion name as bold text.
      // We do this by splitting the localized string and creating
      // several HTML <span> elements.
      const fmtString = this.TorStrings.onionServices.authPrompt.description;
      const [prefix, suffix] = fmtString.split("%S");

      const domainEl = xulDoc.createElement("span");
      domainEl.id = "tor-clientauth-notification-onionname";
      domainEl.textContent = TorUIUtils.shortenOnionAddress(
        this._onionHostname
      );

      descElem.replaceChildren(prefix, domainEl, suffix);
    }

    // Set "Learn More" label and href.
    let learnMoreElem = xulDoc.getElementById(
      "tor-clientauth-notification-learnmore"
    );
    if (learnMoreElem) {
      learnMoreElem.setAttribute(
        "value",
        this.TorStrings.onionServices.learnMore
      );
      learnMoreElem.setAttribute(
        "href",
        "about:manual#onion-services_onion-service-authentication"
      );
      learnMoreElem.setAttribute("useoriginprincipal", "true");
    }

    this._showWarning(undefined);
    let checkboxElem = this._getCheckboxElement();
    if (checkboxElem) {
      checkboxElem.checked = false;
    }
  },

  _onPromptShown() {
    let keyElem = this._getKeyElement();
    if (keyElem) {
      keyElem.setAttribute(
        "placeholder",
        this.TorStrings.onionServices.authPrompt.keyPlaceholder
      );
      this._boundOnKeyFieldKeyPress = this._onKeyFieldKeyPress.bind(this);
      this._boundOnKeyFieldInput = this._onKeyFieldInput.bind(this);
      keyElem.addEventListener("keypress", this._boundOnKeyFieldKeyPress);
      keyElem.addEventListener("input", this._boundOnKeyFieldInput);
      keyElem.focus();
    }
  },

  _onPromptRemoved() {
    if (this._boundOnKeyFieldKeyPress) {
      let keyElem = this._getKeyElement();
      if (keyElem) {
        keyElem.value = "";
        keyElem.removeEventListener("keypress", this._boundOnKeyFieldKeyPress);
        this._boundOnKeyFieldKeyPress = undefined;
        keyElem.removeEventListener("input", this._boundOnKeyFieldInput);
        this._boundOnKeyFieldInput = undefined;
      }
    }
  },

  _onKeyFieldKeyPress(aEvent) {
    if (aEvent.keyCode == aEvent.DOM_VK_RETURN) {
      this._onDone();
    } else if (aEvent.keyCode == aEvent.DOM_VK_ESCAPE) {
      this._prompt.remove();
      this._onCancel();
    }
  },

  _onKeyFieldInput(aEvent) {
    this._showWarning(undefined); // Remove the warning.
  },

  async _onDone() {
    const keyElem = this._getKeyElement();
    if (!keyElem) {
      return;
    }

    const base64key = this._keyToBase64(keyElem.value);
    if (!base64key) {
      this._showWarning(this.TorStrings.onionServices.authPrompt.invalidKey);
      return;
    }

    const controllerFailureMsg =
      this.TorStrings.onionServices.authPrompt.failedToSetKey;
    const checkboxElem = this._getCheckboxElement();
    const isPermanent = checkboxElem && checkboxElem.checked;
    try {
      const provider = await this._lazy.TorProviderBuilder.build();
      await provider.onionAuthAdd(this._onionServiceId, base64key, isPermanent);
    } catch (e) {
      if (e.torMessage) {
        this._showWarning(e.torMessage);
      } else {
        console.error(controllerFailureMsg, e);
        this._showWarning(controllerFailureMsg);
      }
      return;
    }

    this._prompt.remove();
    // Success! Reload the page.
    this._browser.sendMessageToActor("Browser:Reload", {}, "BrowserTab");
  },

  _onCancel() {
    // Arrange for an error page to be displayed:
    // we build a short script calling docShell.displayError()
    // and we pass it as a data: URI to loadFrameScript(),
    // which runs it in the content frame which triggered
    // this authentication prompt.
    const failedURI = this._failedURI.spec;
    const errorCode =
      this._reasonForPrompt === this._topics.clientAuthMissing
        ? Cr.NS_ERROR_TOR_ONION_SVC_MISSING_CLIENT_AUTH
        : Cr.NS_ERROR_TOR_ONION_SVC_BAD_CLIENT_AUTH;
    const io =
      'ChromeUtils.import("resource://gre/modules/Services.jsm").Services.io';

    this._browser.messageManager.loadFrameScript(
      `data:application/javascript,${encodeURIComponent(
        `docShell.displayLoadError(${errorCode}, ${io}.newURI(${JSON.stringify(
          failedURI
        )}), undefined, undefined);`
      )}`,
      false
    );
  },

  _getKeyElement() {
    let xulDoc = this._browser.ownerDocument;
    return xulDoc.getElementById("tor-clientauth-notification-key");
  },

  _getCheckboxElement() {
    let xulDoc = this._browser.ownerDocument;
    return xulDoc.getElementById("tor-clientauth-persistkey-checkbox");
  },

  _showWarning(aWarningMessage) {
    let xulDoc = this._browser.ownerDocument;
    let warningElem = xulDoc.getElementById("tor-clientauth-warning");
    let keyElem = this._getKeyElement();
    if (warningElem) {
      if (aWarningMessage) {
        warningElem.textContent = aWarningMessage;
        warningElem.removeAttribute("hidden");
        if (keyElem) {
          keyElem.className = "invalid";
        }
      } else {
        warningElem.setAttribute("hidden", "true");
        if (keyElem) {
          keyElem.className = "";
        }
      }
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

    let failedURI = browser.currentURI;
    this._browser = browser;
    this._failedURI = failedURI;
    this._reasonForPrompt = aTopic;
    this._onionHostname = aData;
    this._onionServiceId = onionServiceId;
    this.show(undefined);
  },
};
