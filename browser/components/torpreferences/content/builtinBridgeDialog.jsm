"use strict";

var EXPORTED_SYMBOLS = ["BuiltinBridgeDialog"];

const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");

const { TorStrings } = ChromeUtils.import("resource:///modules/TorStrings.jsm");

const { TorSettings, TorBridgeSource, TorBuiltinBridgeTypes } =
  ChromeUtils.importESModule("resource:///modules/TorSettings.sys.mjs");

const { TorConnect, TorConnectTopics } = ChromeUtils.importESModule(
  "resource:///modules/TorConnect.sys.mjs"
);

class BuiltinBridgeDialog {
  /**
   * Create a new instance.
   *
   * @param {Function} onSubmit - A callback for when the user accepts the
   *   dialog selection.
   */
  constructor(onSubmit) {
    this.onSubmit = onSubmit;
    this._acceptButton = null;
    this._radioGroup = null;
  }

  _populateXUL(window, dialog) {
    const dialogWin = dialog.parentElement;
    dialogWin.setAttribute("title", TorStrings.settings.builtinBridgeHeader);

    dialog.querySelector(
      "#torPreferences-builtinBridge-description"
    ).textContent = TorStrings.settings.builtinBridgeDescription2;

    this._radioGroup = dialog.querySelector(
      "#torPreferences-builtinBridge-typeSelection"
    );

    const typeStrings = {
      obfs4: {
        label: TorStrings.settings.builtinBridgeObfs4Title,
        descr: TorStrings.settings.builtinBridgeObfs4Description2,
      },
      snowflake: {
        label: TorStrings.settings.builtinBridgeSnowflake,
        descr: TorStrings.settings.builtinBridgeSnowflakeDescription2,
      },
      "meek-azure": {
        label: TorStrings.settings.builtinBridgeMeekAzure,
        descr: TorStrings.settings.builtinBridgeMeekAzureDescription2,
      },
    };

    const currentBuiltinType =
      TorSettings.bridges.enabled &&
      TorSettings.bridges.source == TorBridgeSource.BuiltIn
        ? TorSettings.bridges.builtin_type
        : null;

    for (const optionEl of this._radioGroup.querySelectorAll(
      ".builtin-bridges-option"
    )) {
      const radio = optionEl.querySelector("radio");
      const type = radio.value;
      optionEl.hidden = !TorBuiltinBridgeTypes.includes(type);
      radio.label = typeStrings[type].label;
      optionEl.querySelector(
        ".builtin-bridges-option-description"
      ).textContent = typeStrings[type].descr;
      optionEl.querySelector(
        ".torPreferences-current-bridge-label"
      ).textContent = TorStrings.settings.currentBridge;
      optionEl.classList.toggle(
        "current-builtin-bridge-type",
        type === currentBuiltinType
      );
    }

    if (currentBuiltinType) {
      this._radioGroup.value = currentBuiltinType;
    } else {
      this._radioGroup.selectedItem = null;
    }

    this._radioGroup.addEventListener("select", () => this.onSelectChange());
    dialog.addEventListener("dialogaccept", () => {
      this.onSubmit(this._radioGroup.value, TorConnect.canBeginBootstrap);
    });
    dialog.addEventListener("dialoghelp", e => {
      window.top.openTrustedLinkIn(
        TorStrings.settings.learnMoreCircumventionURL,
        "tab"
      );
    });

    this._acceptButton = dialog.getButton("accept");

    Services.obs.addObserver(this, TorConnectTopics.StateChange);

    this.onSelectChange();
    this.onAcceptStateChange();
  }

  onSelectChange() {
    this._acceptButton.disabled = !this._radioGroup.value;
  }

  onAcceptStateChange() {
    this._acceptButton.setAttribute(
      "label",
      TorConnect.canBeginBootstrap
        ? TorStrings.settings.bridgeButtonConnect
        : TorStrings.settings.bridgeButtonAccept
    );
  }

  observe(subject, topic, data) {
    switch (topic) {
      case TorConnectTopics.StateChange:
        this.onAcceptStateChange();
        break;
    }
  }

  init(window, aDialog) {
    this._populateXUL(window, aDialog);
  }

  close() {
    // Unregister our observer topics.
    Services.obs.removeObserver(this, TorConnectTopics.StateChange);
  }

  openDialog(gSubDialog) {
    gSubDialog.open(
      "chrome://browser/content/torpreferences/builtinBridgeDialog.xhtml",
      {
        features: "resizable=yes",
        closingCallback: () => {
          this.close();
        },
      },
      this
    );
  }
}
