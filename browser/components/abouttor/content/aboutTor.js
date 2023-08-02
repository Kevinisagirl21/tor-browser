"use strict";

const SearchWidget = {
  _initialized: false,
  _initialOnionize: false,

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

  setOnionizeState(state) {
    if (!this._initialized) {
      this._initialOnionize = state;
      return;
    }
    this.onionizeToggle.pressed = state;
    this._updateOnionize();
  },
};

window.addEventListener("DOMContentLoaded", () => {
  SearchWidget.init();
});

window.addEventListener("InitialSearchOnionize", event => {
  SearchWidget.setOnionizeState(!!event.detail);
});

window.addEventListener("MessageData", event => {
  const updatedElement = document.getElementById("home-message-updated");
  const { updateVersion, updateURL, number } = event.detail;
  document
    .querySelector(".home-message.shown-message")
    ?.classList.remove("shown-message");
  if (updateVersion) {
    updatedElement.querySelector("a").href = updateURL;
    document.l10n.setAttributes(
      updatedElement.querySelector("span"),
      "tor-browser-home-message-updated",
      { version: updateVersion }
    );
    updatedElement.classList.add("shown-message");
  } else {
    const messageElements = document.querySelectorAll(".home-message-rotating");
    messageElements[number % messageElements.length].classList.add(
      "shown-message"
    );
  }
});
