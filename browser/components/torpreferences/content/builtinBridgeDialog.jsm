"use strict";

var EXPORTED_SYMBOLS = ["BuiltinBridgeDialog"];

const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");

const { TorStrings } = ChromeUtils.import("resource:///modules/TorStrings.jsm");

const {
  TorSettings,
  TorBridgeSource,
  TorBuiltinBridgeTypes,
} = ChromeUtils.import("resource:///modules/TorSettings.jsm");

const { TorConnect, TorConnectTopics } = ChromeUtils.import(
  "resource:///modules/TorConnect.jsm"
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
  }

  _populateXUL(window, dialog) {
    const dialogWin = dialog.parentElement;
    dialogWin.setAttribute("title", TorStrings.settings.builtinBridgeHeader);

    dialog.querySelector(
      "#torPreferences-builtinBridge-description"
    ).textContent = TorStrings.settings.builtinBridgeDescription2;

    const radioGroup = dialog.querySelector(
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
    if (currentBuiltinType) {
      radioGroup.value = currentBuiltinType;
    } else {
      radioGroup.selectedItem = null;
    }

    for (const optionEl of radioGroup.querySelectorAll(
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

    dialog.addEventListener("dialogaccept", () => {
      this.onSubmit(radioGroup.value, TorConnect.canBeginBootstrap);
    });
    dialog.addEventListener("dialoghelp", e => {
      window.top.openTrustedLinkIn(
        TorStrings.settings.learnMoreCircumventionURL,
        "tab"
      );
    });

    // Hack: see the CSS
    dialog.style.minWidth = "0";
    dialog.style.minHeight = "0";

    this._acceptButton = dialog.getButton("accept");

    Services.obs.addObserver(this, TorConnectTopics.StateChange);
    this.onAcceptStateChange();
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
    // defer to later until firefox has populated the dialog with all our elements
    window.setTimeout(() => {
      this._populateXUL(window, aDialog);
    }, 0);
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
