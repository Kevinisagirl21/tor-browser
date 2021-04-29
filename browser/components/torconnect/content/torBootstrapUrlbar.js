// Copyright (c) 2021, The Tor Project, Inc.

"use strict";

const { TorConnect, TorConnectTopics, TorConnectState } = ChromeUtils.import(
  "resource:///modules/TorConnect.jsm"
);
const { TorStrings } = ChromeUtils.import("resource:///modules/TorStrings.jsm");

/* globals browser, gURLBar, Services */

var TorBootstrapUrlbar = {
  selectors: Object.freeze({
    torConnect: {
      box: "hbox#torconnect-box",
      label: "label#torconnect-label",
    },
  }),

  elements: null,

  updateTorConnectBox(state) {
    switch (state) {
      case TorConnectState.Initial:
      case TorConnectState.Configuring:
      case TorConnectState.AutoConfiguring:
      case TorConnectState.Error:
      case TorConnectState.FatalError: {
        this.elements.torConnectBox.removeAttribute("hidden");
        this.elements.torConnectLabel.textContent =
          TorStrings.torConnect.torNotConnectedConcise;
        this.elements.inputContainer.setAttribute("torconnect", "offline");
        break;
      }
      case TorConnectState.Bootstrapping: {
        this.elements.torConnectBox.removeAttribute("hidden");
        this.elements.torConnectLabel.textContent =
          TorStrings.torConnect.torConnectingConcise;
        this.elements.inputContainer.setAttribute("torconnect", "connecting");
        break;
      }
      case TorConnectState.Bootstrapped: {
        this.elements.torConnectBox.removeAttribute("hidden");
        this.elements.torConnectLabel.textContent =
          TorStrings.torConnect.torConnectedConcise;
        this.elements.inputContainer.setAttribute("torconnect", "connected");
        // hide torconnect box after 5 seconds
        setTimeout(() => {
          this.elements.torConnectBox.setAttribute("hidden", "true");
        }, 5000);
        break;
      }
      case TorConnectState.Disabled: {
        this.elements.torConnectBox.setAttribute("hidden", "true");
        break;
      }
      default:
        break;
    }
  },

  observe(aSubject, aTopic, aData) {
    if (aTopic === TorConnectTopics.StateChange) {
      const obj = aSubject?.wrappedJSObject;
      this.updateTorConnectBox(obj?.state);
    }
  },

  init() {
    if (TorConnect.shouldShowTorConnect) {
      // browser isn't populated until init
      this.elements = Object.freeze({
        torConnectBox: browser.ownerGlobal.document.querySelector(
          this.selectors.torConnect.box
        ),
        torConnectLabel: browser.ownerGlobal.document.querySelector(
          this.selectors.torConnect.label
        ),
        inputContainer: gURLBar._inputContainer,
      });
      this.elements.torConnectBox.addEventListener("click", () => {
        TorConnect.openTorConnect();
      });
      Services.obs.addObserver(this, TorConnectTopics.StateChange);
      this.observing = true;
      this.updateTorConnectBox(TorConnect.state);
    }
  },

  uninit() {
    if (this.observing) {
      Services.obs.removeObserver(this, TorConnectTopics.StateChange);
    }
  },
};
