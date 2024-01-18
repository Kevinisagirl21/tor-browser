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

const gProvideBridgeDialog = {
  init() {
    this._result = window.arguments[0];

    document.documentElement.setAttribute(
      "title",
      TorStrings.settings.provideBridgeTitleAdd
    );
    const learnMore = document.createXULElement("label");
    learnMore.className = "learnMore text-link";
    learnMore.setAttribute("is", "text-link");
    learnMore.setAttribute("value", TorStrings.settings.learnMore);
    learnMore.addEventListener("click", () => {
      window.top.openTrustedLinkIn(
        TorStrings.settings.learnMoreBridgesURL,
        "tab"
      );
    });

    const pieces = TorStrings.settings.provideBridgeDescription.split("%S");
    document
      .getElementById("torPreferences-provideBridge-description")
      .replaceChildren(pieces[0], learnMore, pieces[1] || "");

    this._textarea = document.getElementById(
      "torPreferences-provideBridge-textarea"
    );
    this._textarea.setAttribute(
      "placeholder",
      TorStrings.settings.provideBridgePlaceholder
    );

    this._textarea.addEventListener("input", () => this.onValueChange());
    if (TorSettings.bridges.source == TorBridgeSource.UserProvided) {
      this._textarea.value = TorSettings.bridges.bridge_strings.join("\n");
    }

    const dialog = document.getElementById(
      "torPreferences-provideBridge-dialog"
    );
    dialog.addEventListener("dialogaccept", e => {
      this._result.accepted = true;
    });

    this._acceptButton = dialog.getButton("accept");

    Services.obs.addObserver(this, TorConnectTopics.StateChange);

    this.onValueChange();
    this.onAcceptStateChange();
  },

  uninit() {
    Services.obs.removeObserver(this, TorConnectTopics.StateChange);
  },

  onValueChange() {
    // TODO: Do some proper value parsing and error reporting. See
    // tor-browser#40552.
    const value = this._textarea.value.trim();
    this._acceptButton.disabled = !value;
    this._result.bridgeStrings = value;
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
