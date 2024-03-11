"use strict";

const { TorStrings } = ChromeUtils.importESModule(
  "resource://gre/modules/TorStrings.sys.mjs"
);

const { TorSettings, TorBridgeSource } = ChromeUtils.importESModule(
  "resource://gre/modules/TorSettings.sys.mjs"
);

const { TorConnect, TorConnectTopics } = ChromeUtils.importESModule(
  "resource://gre/modules/TorConnect.sys.mjs"
);

const gBuiltinBridgeDialog = {
  init() {
    this._result = window.arguments[0];

    document.documentElement.setAttribute(
      "title",
      TorStrings.settings.builtinBridgeHeader
    );

    document.getElementById(
      "torPreferences-builtinBridge-description"
    ).textContent = TorStrings.settings.builtinBridgeDescription2;

    this._radioGroup = document.getElementById(
      "torPreferences-builtinBridge-typeSelection"
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
      optionEl.hidden = !TorSettings.builtinBridgeTypes.includes(type);
      radio.label = typeStrings[type].label;
      const descriptionEl = optionEl.querySelector(
        ".builtin-bridges-option-description"
      );
      descriptionEl.textContent = typeStrings[type].descr;
      const currentBadge = optionEl.querySelector(".bridge-status-badge");
      if (type === currentBuiltinType) {
        const currentLabelEl = optionEl.querySelector(
          ".torPreferences-current-bridge-label"
        );
        // Described by both the current badge and the full description.
        // These will be concatenated together in the screen reader output.
        radio.setAttribute(
          "aria-describedby",
          `${currentLabelEl.id} ${descriptionEl.id}`
        );
        // Make visible.
        currentBadge.classList.add("bridge-status-current-built-in");
      } else {
        // No visible badge.
        radio.setAttribute("aria-describedby", descriptionEl.id);
      }
    }

    if (currentBuiltinType) {
      this._radioGroup.value = currentBuiltinType;
    } else {
      this._radioGroup.selectedItem = null;
    }

    this._radioGroup.addEventListener("select", () => this.onSelectChange());

    const dialog = document.getElementById(
      "torPreferences-builtinBridge-dialog"
    );
    dialog.addEventListener("dialogaccept", () => {
      this._result.accepted = true;
    });

    this._acceptButton = dialog.getButton("accept");

    Services.obs.addObserver(this, TorConnectTopics.StateChange);

    this.onSelectChange();
    this.onAcceptStateChange();
  },

  uninit() {
    Services.obs.removeObserver(this, TorConnectTopics.StateChange);
  },

  onSelectChange() {
    const value = this._radioGroup.value;
    this._acceptButton.disabled = !value;
    this._result.type = value;
  },

  onAcceptStateChange() {
    const connect = TorConnect.canBeginBootstrap;
    this._result.connect = connect;
    this._acceptButton.setAttribute(
      "label",
      connect
        ? TorStrings.settings.bridgeButtonConnect
        : TorStrings.settings.bridgeButtonAccept
    );
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
    gBuiltinBridgeDialog.init();
    window.addEventListener(
      "unload",
      () => {
        gBuiltinBridgeDialog.uninit();
      },
      { once: true }
    );
  },
  { once: true }
);
