// Copyright (c) 2021, The Tor Project, Inc.

"use strict";

 const TorConnectionStatus = {
   invalid: -1,
   offline: 0,
   connecting: 1,
   connected: 2,
   failure: 3,
 };
var TorBootstrapUrlbar;

{
  const { TorProtocolService } = ChromeUtils.import(
    "resource:///modules/TorProtocolService.jsm"
  );
  const { TorLauncherUtil } = ChromeUtils.import(
    "resource://torlauncher/modules/tl-util.jsm"
  );
  const { TorStrings } = ChromeUtils.import(
    "resource:///modules/TorStrings.jsm"
  );

  const kTorProcessReadyTopic = "TorProcessIsReady";
  const kTorProcessExitedTopic = "TorProcessExited";
  const kTorProcessDidNotStartTopic = "TorProcessDidNotStart";
  const kTorBootstrapStatusTopic = "TorBootstrapStatus";
  const kTorBootstrapErrorTopic = "TorBootstrapError";

  const gActiveTopics = [
    kTorProcessReadyTopic,
    kTorProcessExitedTopic,
    kTorProcessDidNotStartTopic,
    kTorBootstrapStatusTopic,
    kTorBootstrapErrorTopic,
  ];

  TorBootstrapUrlbar = {
    _connectionStatus: TorConnectionStatus.invalid,
    get ConnectionStatus() {
      return this._connectionStatus;
    },

    _torConnectBox : null,
    get TorConnectBox() {
      if (!this._torConnectBox) {
        this._torConnectBox =
          browser.ownerGlobal.document.getElementById("torconnect-box");
      }
      return this._torConnectBox;
    },

    _torConnectLabel : null,
    get TorConnectLabel() {
      if (!this._torConnectLabel) {
        this._torConnectLabel =
          browser.ownerGlobal.document.getElementById("torconnect-label");
      }
      return this._torConnectLabel;
    },

    _updateConnectionStatus(percentComplete = 0) {
      if (TorProtocolService.ownsTorDaemon &&
          !TorLauncherUtil.useLegacyLauncher) {
        if (TorProtocolService.isNetworkDisabled()) {
            if (TorProtocolService.torBootstrapErrorOccurred()) {
              this._connectionStatus = TorConnectionStatus.failure;
            } else {
              this._connectionStatus = TorConnectionStatus.offline;
            }
        } else if (percentComplete < 100) {
          this._connectionStatus = TorConnectionStatus.connecting;
        } else if (percentComplete === 100) {
          this._connectionStatus = TorConnectionStatus.connected;
        }
      }
      else
      {
        this._connectionStatus = TorConnectionStatus.invalid;
      }

      switch(this._connectionStatus)
      {
        case TorConnectionStatus.failure:
        case TorConnectionStatus.offline:
          this.TorConnectBox.removeAttribute("hidden");
          this.TorConnectLabel.textContent = TorStrings.torConnect.offline;
          gURLBar._inputContainer.setAttribute("torconnect", "offline");
          break;
        case TorConnectionStatus.connecting:
          this.TorConnectLabel.textContent =
            TorStrings.torConnect.torConnectingConcise;
          gURLBar._inputContainer.setAttribute("torconnect", "connecting");
          break;
        case TorConnectionStatus.connected:
          this.TorConnectLabel.textContent =
            TorStrings.torConnect.torConnectedConcise;
          gURLBar._inputContainer.setAttribute("torconnect", "connected");
          // hide torconnect box after 5 seconds
          let self = this;
          setTimeout(function() {
            self.TorConnectBox.setAttribute("hidden", "true");
          }, 5000);
          break;
      }
    },

    observe(aSubject, aTopic, aData) {
      const obj = aSubject?.wrappedJSObject;

      switch (aTopic) {
        case kTorProcessReadyTopic:
        case kTorProcessExitedTopic:
        case kTorProcessDidNotStartTopic:
        case kTorBootstrapErrorTopic:
          this._updateConnectionStatus();
          break;
        case kTorBootstrapStatusTopic:
          let percentComplete = obj.PROGRESS ? obj.PROGRESS : 0;
          this._updateConnectionStatus(percentComplete);
          break;
      }
    },
    init() {
      for (const topic of gActiveTopics) {
        Services.obs.addObserver(this, topic);
      }
    },
    uninit() {
      for (const topic of gActiveTopics) {
        Services.obs.removeObserver(this, topic);
      }
    },
  };
}
