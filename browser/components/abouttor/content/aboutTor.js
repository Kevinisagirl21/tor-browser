"use strict";

const SearchWidget = {
  _initialized: false,
  _initialOnionize: false,

  /**
   * Initialize the search form elements.
   */
  init() {
    this._initialized = true;

    this.searchForm = document.getElementById("search-form");
    this.onionizeToggle = document.getElementById("onionize-toggle");
    this.onionizeToggle.pressed = this._initialOnionize;
    this._updateOnionize();
    this.onionizeToggle.addEventListener("toggle", () =>
      this._updateOnionize()
    );

    // If the user submits, save the onionize search state for the next about:tor
    // page.
    this.searchForm.addEventListener("submit", () => {
      dispatchEvent(
        new CustomEvent("SubmitSearchOnionize", {
          detail: this.onionizeToggle.pressed,
          bubbles: true,
        })
      );
    });

    // By default, Enter on the onionizeToggle will toggle the button rather
    // than submit the <form>.
    // Moreover, our <form> has no submit button, so can only be submitted by
    // pressing Enter.
    // For keyboard users, Space will also toggle the form. We do not want to
    // require users to have to Tab back to the search input in order to press
    // Enter to submit the form.
    // For mouse users, clicking the toggle button will give it focus, so they
    // would have to Tab back or click the search input in order to submit the
    // form.
    // So we want to intercept the Enter keydown event to submit the form.
    this.onionizeToggle.addEventListener(
      "keydown",
      event => {
        if (event.key !== "Enter") {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        this.searchForm.requestSubmit();
      },
      { capture: true }
    );

    // Focus styling on form.
    const searchInput = document.getElementById("search-input");
    const updateInputFocus = () => {
      this.searchForm.classList.toggle(
        "search-input-focus-visible",
        searchInput.matches(":focus-visible")
      );
    };
    updateInputFocus();
    searchInput.addEventListener("focus", updateInputFocus);
    searchInput.addEventListener("blur", updateInputFocus);
  },

  _updateOnionize() {
    // Change submit URL based on the onionize toggle.
    this.searchForm.action = this.onionizeToggle.pressed
      ? "https://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion"
      : "https://duckduckgo.com";
    this.searchForm.classList.toggle(
      "onionized-search",
      this.onionizeToggle.pressed
    );
  },

  /**
   * Set what the "Onionize" toggle state.
   *
   * @param {boolean} state - Whether the "Onionize" toggle should be switched
   *   on.
   */
  setOnionizeState(state) {
    if (!this._initialized) {
      this._initialOnionize = state;
      return;
    }
    this.onionizeToggle.pressed = state;
    this._updateOnionize();
  },
};

const MessageArea = {
  _initialized: false,
  _messageData: null,
  _isStable: null,
  _torConnectEnabled: null,

  /**
   * Initialize the message area and heading once elements are available.
   */
  init() {
    this._initialized = true;
    this._update();
  },

  /**
   * Set the message data and stable release flag.
   *
   * @param {MessageData} messageData - The message data, indicating which
   *   message to show.
   * @param {boolean} isStable - Whether this is the stable release version.
   * @param {boolean} torConnectEnabled - Whether TorConnect is enabled, and
   *   therefore the Tor process was configured with about:torconnect.
   */
  setMessageData(messageData, isStable, torConnectEnabled) {
    this._messageData = messageData;
    this._isStable = isStable;
    this._torConnectEnabled = torConnectEnabled;
    this._update();
  },

  _update() {
    if (!this._initialized) {
      return;
    }

    document
      .querySelector(".home-message.shown-message")
      ?.classList.remove("shown-message");

    if (!this._messageData) {
      return;
    }

    // Set heading.
    document.l10n.setAttributes(
      document.getElementById("tor-browser-home-heading-text"),
      this._isStable
        ? "tor-browser-home-heading-stable"
        : "tor-browser-home-heading-testing"
    );

    document.body.classList.toggle("show-tor-check", !this._torConnectEnabled);

    const { updateVersion, updateURL, number } = this._messageData;

    if (updateVersion) {
      const updatedElement = document.getElementById("home-message-updated");
      updatedElement.querySelector("a").href = updateURL;
      document.l10n.setAttributes(
        updatedElement.querySelector("span"),
        "tor-browser-home-message-updated",
        { version: updateVersion }
      );
      updatedElement.classList.add("shown-message");
    } else {
      const messageElements = document.querySelectorAll(
        this._isStable
          ? ".home-message-rotating-stable"
          : ".home-message-rotating-testing"
      );
      messageElements[number % messageElements.length].classList.add(
        "shown-message"
      );
    }
  },
};

window.addEventListener("DOMContentLoaded", () => {
  SearchWidget.init();
  MessageArea.init();
});

window.addEventListener("InitialData", event => {
  const { torConnectEnabled, isStable, searchOnionize, messageData } =
    event.detail;
  SearchWidget.setOnionizeState(!!searchOnionize);
  MessageArea.setMessageData(messageData, !!isStable, !!torConnectEnabled);
});

// YEC 2023 (year end campaign).
// See tor-browser#42072
const YecWidget = {
  _initialized: false,
  _locale: null,

  /**
   * Initialize the widget.
   */
  init() {
    this._initialized = true;

    const now = Date.now();
    const yecStart = Date.UTC(2023, 9, 16); // October 16th
    const yecEnd = Date.UTC(2024); // 2024 January 1st

    this.isActive = now >= yecStart && now < yecEnd;
    document.getElementById("yec-2023-close").addEventListener("click", () => {
      dispatchEvent(new CustomEvent("YECHidden", { bubbles: true }));
      this.isOpen = false;
    });

    const donateMatchStart = Date.UTC(2023, 10, 22); // November 22nd
    document.body.classList.toggle(
      "yec-2023-is-donation-matching",
      now >= donateMatchStart
    );

    this._updateDonateLocale();
  },

  _isStable: false,
  _isActive: false,
  _isOpen: false,

  /**
   * Whether this is a stable release.
   *
   * @type {boolean}
   */
  get isStable() {
    return this._isStable;
  },

  set isStable(isStable) {
    this._isStable = isStable;
    this._updateShown();
  },

  /**
   * Whether the year end campaign is active.
   *
   * @type {boolean}
   */
  get isActive() {
    return this._isActive;
  },

  set isActive(isActive) {
    this._isActive = isActive;
    this._updateShown();
  },

  /**
   * Whether the banner is open or has been closed by the user.
   *
   * @type {boolean}
   */
  get isOpen() {
    return this._isOpen;
  },

  set isOpen(isOpen) {
    this._isOpen = isOpen;
    this._updateShown();
  },

  _updateShown() {
    if (!this._initialized) {
      return;
    }
    document.body.classList.toggle(
      "yec-2023-is-shown",
      this.isActive && this.isOpen && this.isStable
    );
  },

  _updateDonateLocale() {
    if (!this._initialized) {
      return;
    }
    const donateLink = document.getElementById("yec-2023-donate-link");
    const base = "https://www.torproject.org/donate";
    donateLink.href = this._locale ? `${base}/2023yec-${this._locale}` : base;
  },

  /**
   * Set the locale to use for the donation link.
   *
   * @param {string} locale - The new locale, as BCP47.
   */
  setDonateLocale(locale) {
    this._locale = locale;
    this._updateDonateLocale();
  },
};

window.addEventListener("DOMContentLoaded", () => {
  YecWidget.init();
});

window.addEventListener("InitialData", event => {
  const { appLocale, isStable, hideYEC } = event.detail;
  YecWidget.setDonateLocale(appLocale);
  YecWidget.isStable = isStable;
  YecWidget.isOpen = !hideYEC;
});
