"use strict";

var EXPORTED_SYMBOLS = ["ProvideBridgeDialog"];

const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");

const { TorStrings } = ChromeUtils.import("resource:///modules/TorStrings.jsm");

const { TorSettings, TorBridgeSource } = ChromeUtils.importESModule(
  "resource:///modules/TorSettings.sys.mjs"
);

const { TorConnect, TorConnectTopics } = ChromeUtils.importESModule(
  "resource:///modules/TorConnect.sys.mjs"
);

class ProvideBridgeDialog {
  constructor(onSubmit) {
    this.onSubmit = onSubmit;
    this._dialog = null;
    this._textarea = null;
    this._acceptButton = null;
  }

  static get selectors() {
    return {
      description: "#torPreferences-provideBridge-description",
      textarea: "#torPreferences-provideBridge-textarea",
    };
  }

  _populateXUL(window, aDialog) {
    const selectors = ProvideBridgeDialog.selectors;

    const openHelp = () => {
      window.top.openTrustedLinkIn(
        TorStrings.settings.learnMoreBridgesURL,
        "tab"
      );
    };

    this._dialog = aDialog;
    const dialogWin = this._dialog.parentElement;
    dialogWin.setAttribute("title", TorStrings.settings.provideBridgeTitleAdd);
    const learnMore = window.document.createXULElement("label");
    learnMore.className = "learnMore text-link";
    learnMore.setAttribute("is", "text-link");
    learnMore.setAttribute("value", TorStrings.settings.learnMore);
    learnMore.addEventListener("click", openHelp);
    const descr = this._dialog.querySelector(selectors.description);
    descr.textContent = "";
    const pieces = TorStrings.settings.provideBridgeDescription.split("%S");
    descr.append(pieces[0], learnMore, pieces[1] || "");
    this._textarea = this._dialog.querySelector(selectors.textarea);
    this._textarea.setAttribute(
      "placeholder",
      TorStrings.settings.provideBridgePlaceholder
    );

    this._textarea.addEventListener("input", () => this.onValueChange());
    if (TorSettings.bridges.source == TorBridgeSource.UserProvided) {
      this._textarea.value = TorSettings.bridges.bridge_strings.join("\n");
    }

    this._dialog.addEventListener("dialogaccept", e => {
      this.onSubmit(this._textarea.value, TorConnect.canBeginBootstrap);
    });
    this._dialog.addEventListener("dialoghelp", openHelp);

    this._acceptButton = this._dialog.getButton("accept");

    Services.obs.addObserver(this, TorConnectTopics.StateChange);

    this.onValueChange();
    this.onAcceptStateChange();
  }

  onValueChange() {
    // TODO: Do some proper value parsing and error reporting. See
    // tor-browser#40552.
    this._acceptButton.disabled = !this._textarea.value.trim();
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
      "chrome://browser/content/torpreferences/provideBridgeDialog.xhtml",
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
