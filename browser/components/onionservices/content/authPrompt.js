/* eslint-env mozilla/browser-window */

"use strict";

var OnionAuthPrompt = {
  // Only import to our internal scope, rather than the global scope of
  // browser.xhtml.
  _lazy: {},

  /**
   * The topics to listen to.
   *
   * @type {Object<string, string>}
   */
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
   * Used for logging to represent PromptDetails.
   *
   * @param {PromptDetails} details - The details to represent.
   * @returns {string} - The representation of these details.
   */
  _detailsRepr(details) {
    if (!details) {
      return "none";
    }
    return `${details.browser.browserId}:${details.onionHost}`;
  },

  /**
   * Show a new prompt, using the given details.
   *
   * @param {PromptDetails} details - The details to show.
   */
  show(details) {
    this._logger.debug(`New Notification: ${this._detailsRepr(details)}`);

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

    // The first secondarybuttoncommand (cancelAction) should be triggered when
    // the user presses "Escape".
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

  /**
   * Callback when the prompt is about to be shown.
   *
   * @param {PromptDetails?} details - The details to show, or null to shown
   *   none.
   */
  _onPromptShowing(details) {
    if (details === this._shownDetails) {
      // The last shown details match this one exactly.
      // This happens when we switch tabs to a page that has no prompt and then
      // switch back.
      // We don't want to reset the current state in this case.
      // In particular, we keep the current _keyInput value and _persistCheckbox
      // the same.
      this._logger.debug(`Already showing: ${this._detailsRepr(details)}`);
      return;
    }

    this._logger.debug(`Now showing: ${this._detailsRepr(details)}`);

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

  /**
   * Callback after the prompt is shown.
   */
  _onPromptShown() {
    this._keyInput.focus();
  },

  /**
   * Callback when a Notification is removed.
   *
   * @param {PromptDetails} details - The details for the removed notification.
   */
  _onPromptRemoved(details) {
    if (details !== this._shownDetails) {
      // Removing the notification for some other page.
      // For example, closing another tab that also requires authentication.
      this._logger.debug(`Removed not shown: ${this._detailsRepr(details)}`);
      return;
    }
    this._logger.debug(`Removed shown: ${this._detailsRepr(details)}`);
    // Reset the prompt as a precaution.
    // In particular, we want to clear the input so that the entered key does
    // not persist.
    this._onPromptShowing(null);
  },

  /**
   * Callback when the user submits the key.
   */
  async _onDone() {
    this._logger.debug(
      `Sumbitting key: ${this._detailsRepr(this._shownDetails)}`
    );

    // Grab the details before they might change as we await.
    const { browser, onionServiceId, notification } = this._shownDetails;
    const isPermanent = this._persistCheckbox.checked;

    const base64key = this._keyToBase64(this._keyInput.value);
    if (!base64key) {
      this._showWarning(this.TorStrings.onionServices.authPrompt.invalidKey);
      return;
    }

    try {
      const provider = await this._lazy.TorProviderBuilder.build();
      await provider.onionAuthAdd(onionServiceId, base64key, isPermanent);
    } catch (e) {
      if (e.torMessage) {
        this._showWarning(e.torMessage);
      } else {
        this._logger.error(`Failed to set key for ${onionServiceId}`, e);
        this._showWarning(
          this.TorStrings.onionServices.authPrompt.failedToSetKey
        );
      }
      return;
    }

    notification.remove();
    // Success! Reload the page.
    browser.sendMessageToActor("Browser:Reload", {}, "BrowserTab");
  },

  /**
   * Callback when the user dismisses the prompt.
   */
  _onCancel() {
    // Arrange for an error page to be displayed:
    // we build a short script calling docShell.displayError()
    // and we pass it as a data: URI to loadFrameScript(),
    // which runs it in the content frame which triggered
    // this authentication prompt.
    this._logger.debug(`Cancelling: ${this._detailsRepr(this._shownDetails)}`);

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

  /**
   * Show a warning message to the user or clear the warning.
   *
   * @param {string?} warningMessage - The message to show, or undefined to
   *   clear the current message.
   */
  _showWarning(warningMessage) {
    this._logger.debug(`Showing warning: ${warningMessage}`);
    if (warningMessage) {
      this._warningEl.textContent = warningMessage;
      this._warningEl.removeAttribute("hidden");
      this._keyInput.classList.add("invalid");
    } else {
      this._warningEl.setAttribute("hidden", "true");
      this._keyInput.classList.remove("invalid");
    }
  },

  /**
   * Convert the user-entered key into base64.
   *
   * @param {string} keyString - The key to convert.
   * @returns {string?} - The base64 representation, or undefined if the given
   *   key was not the correct format.
   */
  _keyToBase64(keyString) {
    if (!keyString) {
      return undefined;
    }

    let base64key;
    if (keyString.length === 52) {
      // The key is probably base32-encoded. Attempt to decode.
      // Although base32 specifies uppercase letters, we accept lowercase
      // as well because users may type in lowercase or copy a key out of
      // a tor onion-auth file (which uses lowercase).
      let rawKey;
      try {
        rawKey = this._lazy.CommonUtils.decodeBase32(keyString.toUpperCase());
      } catch (e) {}

      if (rawKey) {
        try {
          base64key = btoa(rawKey);
        } catch (e) {}
      }
    } else if (
      keyString.length === 44 &&
      /^[a-zA-Z0-9+/]*=*$/.test(keyString)
    ) {
      // The key appears to be a correctly formatted base64 value. If not,
      // tor will return an error when we try to add the key via the
      // control port.
      base64key = keyString;
    }

    return base64key;
  },

  /**
   * Initialize the authentication prompt.
   */
  init() {
    this._logger = console.createInstance({
      prefix: "OnionAuthPrompt",
      maxLogLevel: "Warn",
      maxLogLevelPref: "browser.onionAuthPrompt.loglevel",
    });

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
    this._keyInput.addEventListener("keydown", event => {
      if (event.key === "Enter") {
        event.preventDefault();
        this._onDone();
      }
    });
    this._keyInput.addEventListener("input", event => {
      // Remove the warning.
      this._showWarning(undefined);
    });

    // Force back focus on click: tor-browser#41856
    document
      .getElementById("tor-clientauth-notification")
      .addEventListener("click", () => {
        window.focus();
      });

    Services.obs.addObserver(this, this._topics.clientAuthMissing);
    Services.obs.addObserver(this, this._topics.clientAuthIncorrect);
  },

  /**
   * Un-initialize the authentication prompt.
   */
  uninit() {
    Services.obs.removeObserver(this, this._topics.clientAuthMissing);
    Services.obs.removeObserver(this, this._topics.clientAuthIncorrect);
  },

  observe(subject, topic, data) {
    if (
      topic !== this._topics.clientAuthMissing &&
      topic !== this._topics.clientAuthIncorrect
    ) {
      return;
    }

    // "subject" is the DOM window or browser where the prompt should be shown.
    let browser;
    if (subject instanceof Ci.nsIDOMWindow) {
      let contentWindow = subject.QueryInterface(Ci.nsIDOMWindow);
      browser = contentWindow.docShell.chromeEventHandler;
    } else {
      browser = subject.QueryInterface(Ci.nsIBrowser);
    }

    if (!gBrowser.browsers.includes(browser)) {
      // This window does not contain the subject browser.
      this._logger.debug(
        `Window ${window.docShell.outerWindowID}: Ignoring ${topic}`
      );
      return;
    }
    this._logger.debug(
      `Window ${window.docShell.outerWindowID}: Handling ${topic}`
    );

    const onionHost = data;
    // ^(subdomain.)*onionserviceid.onion$ (case-insensitive)
    const onionServiceId = onionHost
      .match(/^(.*\.)?(?<onionServiceId>[a-z2-7]{56})\.onion$/i)
      ?.groups.onionServiceId.toLowerCase();
    if (!onionServiceId) {
      this._logger.error(`Malformed onion address: ${onionHost}`);
      return;
    }

    const details = {
      browser,
      cause: topic,
      onionHost,
      uri: browser.currentURI,
      onionServiceId,
    };
    this.show(details);
  },
};
