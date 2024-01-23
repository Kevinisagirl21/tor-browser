"use strict";

const { TorStrings } = ChromeUtils.importESModule(
  "resource://gre/modules/TorStrings.sys.mjs"
);

const { TorSettings, TorBridgeSource, validateBridgeLines } =
  ChromeUtils.importESModule("resource://gre/modules/TorSettings.sys.mjs");

const { TorConnect, TorConnectTopics } = ChromeUtils.importESModule(
  "resource://gre/modules/TorConnect.sys.mjs"
);

const { TorParsers } = ChromeUtils.importESModule(
  "resource://gre/modules/TorParsers.sys.mjs"
);

const gProvideBridgeDialog = {
  init() {
    this._result = window.arguments[0];
    const mode = window.arguments[1].mode;

    let titleId;
    switch (mode) {
      case "edit":
        titleId = "user-provide-bridge-dialog-edit-title";
        break;
      case "add":
        titleId = "user-provide-bridge-dialog-add-title";
        break;
      case "replace":
      default:
        titleId = "user-provide-bridge-dialog-replace-title";
        break;
    }

    document.l10n.setAttributes(document.documentElement, titleId);

    document.l10n.setAttributes(
      document.getElementById("user-provide-bridge-textarea-label"),
      // TODO change string when we can also accept Lox share codes.
      "user-provide-bridge-dialog-textarea-addresses-label"
    );

    this._dialog = document.getElementById("user-provide-bridge-dialog");
    this._acceptButton = this._dialog.getButton("accept");
    this._textarea = document.getElementById("user-provide-bridge-textarea");
    this._errorEl = document.getElementById(
      "user-provide-bridge-error-message"
    );
    this._resultDescription = document.getElementById(
      "user-provide-result-description"
    );
    this._bridgeGrid = document.getElementById(
      "user-provide-bridge-grid-display"
    );
    this._rowTemplate = document.getElementById(
      "user-provide-bridge-row-template"
    );

    if (mode === "edit") {
      // Only expected if the bridge source is UseProvided, but verify to be
      // sure.
      if (TorSettings.bridges.source == TorBridgeSource.UserProvided) {
        this._textarea.value = TorSettings.bridges.bridge_strings.join("\n");
      }
    } else {
      // Set placeholder if not editing.
      document.l10n.setAttributes(
        this._textarea,
        // TODO: change string when we can also accept Lox share codes.
        "user-provide-bridge-dialog-textarea-addresses"
      );
    }

    this._textarea.addEventListener("input", () => this.onValueChange());

    this._dialog.addEventListener("dialogaccept", event =>
      this.onDialogAccept(event)
    );

    Services.obs.addObserver(this, TorConnectTopics.StateChange);

    this.setPage("entry");
    this.checkValue();
  },

  uninit() {
    Services.obs.removeObserver(this, TorConnectTopics.StateChange);
  },

  /**
   * Set the page to display.
   *
   * @param {string} page - The page to show.
   */
  setPage(page) {
    this._page = page;
    this._dialog.classList.toggle("show-entry-page", page === "entry");
    this._dialog.classList.toggle("show-result-page", page === "result");
    if (page === "entry") {
      this._textarea.focus();
    } else {
      // Move focus to the <xul:window> element.
      // In particular, we do not want to keep the focus on the (same) accept
      // button (with now different text).
      document.documentElement.focus();
    }

    this.updateAcceptDisabled();
    this.onAcceptStateChange();
  },

  /**
   * Callback for whenever the input value changes.
   */
  onValueChange() {
    this.updateAcceptDisabled();
    // Reset errors whenever the value changes.
    this.updateError(null);
  },

  /**
   * Callback for whenever the accept button may need to change.
   */
  onAcceptStateChange() {
    if (this._page === "entry") {
      document.l10n.setAttributes(
        this._acceptButton,
        "user-provide-bridge-dialog-next-button"
      );
      this._result.connect = false;
    } else {
      this._acceptButton.removeAttribute("data-l10n-id");
      const connect = TorConnect.canBeginBootstrap;
      this._result.connect = connect;

      this._acceptButton.setAttribute(
        "label",
        connect
          ? TorStrings.settings.bridgeButtonConnect
          : TorStrings.settings.bridgeButtonAccept
      );
    }
  },

  /**
   * Callback for whenever the accept button's might need to be disabled.
   */
  updateAcceptDisabled() {
    this._acceptButton.disabled =
      this._page === "entry" && validateBridgeLines(this._textarea.value).empty;
  },

  /**
   * Callback for when the accept button is pressed.
   *
   * @param {Event} event - The dialogaccept event.
   */
  onDialogAccept(event) {
    if (this._page === "result") {
      this._result.accepted = true;
      // Continue to close the dialog.
      return;
    }
    // Prevent closing the dialog.
    event.preventDefault();

    const bridges = this.checkValue();
    if (!bridges.length) {
      // Not valid
      return;
    }
    this._result.bridges = bridges;
    this.updateResult();
    this.setPage("result");
  },

  /**
   * The current timeout for updating the error.
   *
   * @type {integer?}
   */
  _updateErrorTimeout: null,

  /**
   * Update the displayed error.
   *
   * @param {object?} error - The error to show, or null if no error should be
   *   shown. Should include the "type" property.
   */
  updateError(error) {
    // First clear the existing error.
    if (this._updateErrorTimeout !== null) {
      clearTimeout(this._updateErrorTimeout);
    }
    this._updateErrorTimeout = null;
    this._errorEl.removeAttribute("data-l10n-id");
    this._errorEl.textContent = "";
    if (error) {
      this._textarea.setAttribute("aria-invalid", "true");
    } else {
      this._textarea.removeAttribute("aria-invalid");
    }
    this._textarea.classList.toggle("invalid-input", !!error);
    this._errorEl.classList.toggle("show-error", !!error);

    if (!error) {
      return;
    }

    let errorId;
    let errorArgs;
    switch (error.type) {
      case "invalid-address":
        errorId = "user-provide-bridge-dialog-address-error";
        errorArgs = { line: error.line };
        break;
    }

    // Wait a small amount of time to actually set the textContent. Otherwise
    // the screen reader (tested with Orca) may not pick up on the change in
    // text.
    this._updateErrorTimeout = setTimeout(() => {
      document.l10n.setAttributes(this._errorEl, errorId, errorArgs);
    }, 500);
  },

  /**
   * Check the current value in the textarea.
   *
   * @returns {string[]} - The bridge addresses, if the entry is valid.
   */
  checkValue() {
    let bridges = [];
    let error = null;
    const validation = validateBridgeLines(this._textarea.value);
    if (!validation.empty) {
      // If empty, we just disable the button, rather than show an error.
      if (validation.errorLines.length) {
        // Report first error.
        error = {
          type: "invalid-address",
          line: validation.errorLines[0],
        };
      } else {
        bridges = validation.validBridges;
      }
    }
    this.updateError(error);
    return bridges;
  },

  /**
   * Update the shown result on the last page.
   */
  updateResult() {
    document.l10n.setAttributes(
      this._resultDescription,
      // TODO: Use a different id when added through Lox invite.
      "user-provide-bridge-dialog-result-addresses"
    );

    this._bridgeGrid.replaceChildren();

    for (const bridgeLine of this._result.bridges) {
      let details;
      try {
        details = TorParsers.parseBridgeLine(bridgeLine);
      } catch (e) {
        console.error(`Detected invalid bridge line: ${bridgeLine}`, e);
      }

      const rowEl = this._rowTemplate.content.children[0].cloneNode(true);

      const emojiBlock = rowEl.querySelector(".tor-bridges-emojis-block");
      const BridgeEmoji = customElements.get("tor-bridge-emoji");
      for (const cell of BridgeEmoji.createForAddress(bridgeLine)) {
        // Each emoji is its own cell, we rely on the fact that createForAddress
        // always returns four elements.
        cell.setAttribute("role", "gridcell");
        cell.classList.add("tor-bridges-grid-cell", "tor-bridges-emoji-cell");
        emojiBlock.append(cell);
      }

      // TODO: properly handle "vanilla" bridges?
      document.l10n.setAttributes(
        rowEl.querySelector(".tor-bridges-type-cell"),
        "tor-bridges-type-prefix",
        { type: details?.transport ?? "vanilla" }
      );

      rowEl.querySelector(".tor-bridges-address-cell").textContent = bridgeLine;

      this._bridgeGrid.append(rowEl);
    }
  },

  observe(subject, topic, data) {
    switch (topic) {
      case TorConnectTopics.StateChange:
        this.onAcceptStateChange();
        break;
    }
  },
};

window.addEventListener(
  "DOMContentLoaded",
  () => {
    gProvideBridgeDialog.init();
    window.addEventListener(
      "unload",
      () => {
        gProvideBridgeDialog.uninit();
      },
      { once: true }
    );
  },
  { once: true }
);
