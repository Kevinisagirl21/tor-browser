// Copyright (c) 2021, The Tor Project, Inc.

/* eslint-env mozilla/frame-script */

const kTorProcessReadyTopic = "TorProcessIsReady";
const kTorProcessExitedTopic = "TorProcessExited";
const kTorProcessDidNotStartTopic = "TorProcessDidNotStart";
const kTorBootstrapStatusTopic = "TorBootstrapStatus";
const kTorBootstrapErrorTopic = "TorBootstrapError";
const kTorLogHasWarnOrErrTopic = "TorLogHasWarnOrErr";

class AboutTorConnect {
  log(...args) {
    console.log(...args);
  }

  logError(...args) {
    console.error(...args);
  }

  logDebug(...args) {
    console.debug(...args);
  }

  getElem(id) {
    return document.getElementById(id);
  }
  get elemProgressContent() {
    return this.getElem("progressContent");
  }
  get elemProgressDesc() {
    return this.getElem("connectShortDescText");
  }
  get elemProgressMeter() {
    return this.getElem("progressBackground");
  }
  get elemConnectButton() {
    return this.getElem("connectButton");
  }
  get elemCopyLogButton() {
    return this.getElem("copyLogButton");
  }
  get elemCopyLogTooltip() {
    return this.getElem("copyLogTooltip");
  }
  get elemCopyLogTooltipText() {
    return this.getElem("copyLogTooltipText");
  }
  get elemAdvancedButton() {
    return this.getElem("advancedButton");
  }
  get elemCancelButton() {
    return this.getElem("cancelButton");
  }
  get elemTextContainer() {
    return this.getElem("text-container");
  }
  get elemTitle() {
    return this.elemTextContainer.getElementsByClassName("title")[0];
  }

  static get STATE_INITIAL() {
    return "STATE_INITIAL";
  }

  static get STATE_BOOTSTRAPPING() {
    return "STATE_BOOTSTRAPPING";
  }

  static get STATE_BOOTSTRAPPED() {
    return "STATE_BOOTSTRAPPED";
  }

  static get STATE_BOOTSTRAP_ERROR() {
    return "STATE_BOOTSTRAP_ERROR";
  }

  get state() {
    return this._state;
  }

  setInitialUI() {
    this.setTitle(this.torStrings.torConnect.torConnect);
    this.elemProgressDesc.textContent =
      this.torStrings.settings.torPreferencesDescription;
    this.showElem(this.elemConnectButton);
    this.showElem(this.elemAdvancedButton);
    this.hideElem(this.elemCopyLogButton);
    this.hideElem(this.elemCancelButton);
    this.hideElem(this.elemProgressContent);
    this.hideElem(this.elemProgressMeter);
    this.elemTitle.classList.remove("error");
  }

  setBootstrappingUI() {
    this.setTitle(this.torStrings.torConnect.torConnecting);
    this.hideElem(this.elemConnectButton);
    this.hideElem(this.elemAdvancedButton);
    this.hideElem(this.elemCopyLogButton);
    this.showElem(this.elemCancelButton);
    this.showElem(this.elemProgressContent);
    this.showElem(this.elemProgressMeter);
    this.elemTitle.classList.remove("error");
  }

  setBootstrapErrorUI() {
    this.setTitle(this.torStrings.torConnect.torBootstrapFailed);
    this.elemConnectButton.textContent = this.torStrings.torConnect.tryAgain;
    this.showElem(this.elemConnectButton);
    this.hideElem(this.elemCancelButton);
    this.showElem(this.elemAdvancedButton);
    this.showElem(this.elemProgressContent);
    this.hideElem(this.elemProgressMeter);
    this.elemTitle.classList.add("error");

    this.elem
  }

  goToBrowserHome() {
    this.hideElem(this.elemCancelButton);
    RPMSendAsyncMessage("GoToBrowserHome");
  }

  set state(state) {
    const oldState = this.state;
    if (oldState === state) {
      return;
    }
    this._state = state;
    switch (this.state) {
      case AboutTorConnect.STATE_INITIAL:
        this.setInitialUI();
        break;
      case AboutTorConnect.STATE_BOOTSTRAPPING:
        this.setBootstrappingUI();
        break;
      case AboutTorConnect.STATE_BOOTSTRAP_ERROR:
        this.setBootstrapErrorUI();
        break;
      case AboutTorConnect.STATE_BOOTSTRAPPED:
        this.goToBrowserHome();
        break;
    }
  }

  async showErrorMessage(aErrorObj) {
    if (aErrorObj && aErrorObj.message) {
      this.setTitle(aErrorObj.message);
      if (aErrorObj.details) {
        this.elemProgressDesc.textContent = aErrorObj.details;
      }
    }

    let haveErrorOrWarning =
      (await RPMSendQuery("TorBootstrapErrorOccurred")) ||
      (await RPMSendQuery("TorLogHasWarnOrErr"));
    this.showCopyLogButton(haveErrorOrWarning);
    this.showElem(this.elemConnectButton);
  }

  showElem(elem) {
    elem.removeAttribute("hidden");
  }

  hideElem(elem) {
    elem.setAttribute("hidden", "true");
  }

  async connect() {
    this.state = AboutTorConnect.STATE_BOOTSTRAPPING;
    const error = await RPMSendQuery("TorConnect");
    if (error) {
      if (error.details) {
        this.showErrorMessage({ message: error.details }, true);
        this.showSaveSettingsError(error.details);
      }
    }
  }

  restoreCopyLogVisibility() {
    this.elemCopyLogButton.setAttribute("hidden", true);
  }

  showCopyLogButton() {
    this.elemCopyLogButton.removeAttribute("hidden");
  }

  async updateBootstrapProgress(status) {
    let labelText = await RPMSendQuery("GetLocalizedBootstrapStatus", {
      status,
      keyword: "TAG",
    });
    let percentComplete = status.PROGRESS ? status.PROGRESS : 0;
    this.elemProgressMeter.style.width = `${percentComplete}%`;

    if (await RPMSendQuery("TorBootstrapErrorOccurred")) {
      this.state = AboutTorConnect.STATE_BOOTSTRAP_ERROR;
      return;
    } else if (await RPMSendQuery("TorIsNetworkDisabled")) {
      // If tor network is not connected, let's go to the initial state, even
      // if bootstrap state is greater than 0.
      this.state = AboutTorConnect.STATE_INITIAL;
      return;
    } else if (percentComplete >= 100) {
      this.state = AboutTorConnect.STATE_BOOTSTRAPPED;
    } else if (percentComplete > 0) {
      this.state = AboutTorConnect.STATE_BOOTSTRAPPING;
    }

    // Due to async, status might have changed. Do not override desc if so.
    if (this.state === AboutTorConnect.STATE_BOOTSTRAPPING) {
      this.hideElem(this.elemConnectButton);
    }
  }

  stopTorBootstrap() {
    RPMSendAsyncMessage("TorStopBootstrap");
  }

  setTitle(title) {
    const titleElement = document.querySelector(".title-text");
    titleElement.textContent = title;
    document.title = title;
  }

  initButtons() {
    this.elemAdvancedButton.textContent = this.torStrings.torConnect.torConfigure;
    this.elemAdvancedButton.addEventListener("click", () => {
      RPMSendAsyncMessage("OpenTorAdvancedPreferences");
    });

    this.elemConnectButton.textContent =
      this.torStrings.torConnect.torConnectButton;
    this.elemConnectButton.addEventListener("click", () => {
      this.connect();
    });

    this.elemCancelButton.textContent = this.torStrings.torConnect.cancel;
    this.elemCancelButton.addEventListener("click", () => {
      this.stopTorBootstrap();
    });

    // sets the text content while keping the child elements intact
    this.elemCopyLogButton.childNodes[0].nodeValue =
      this.torStrings.torConnect.copyLog;
    this.elemCopyLogButton.addEventListener("click", async () => {
      const copiedMessage = await RPMSendQuery("TorCopyLog");
      aboutTorConnect.elemCopyLogTooltipText.textContent = copiedMessage;
      aboutTorConnect.elemCopyLogTooltip.style.visibility = "visible";

      // clear previous timeout if one already exists
      if (aboutTorConnect.copyLogTimeoutId) {
        clearTimeout(aboutTorConnect.copyLogTimeoutId);
      }

      // hide tooltip after X ms
      const TOOLTIP_TIMEOUT = 2000;
      aboutTorConnect.copyLogTimeoutId = setTimeout(function() {
        aboutTorConnect.elemCopyLogTooltip.style.visibility = "hidden";
        aboutTorConnect.copyLogTimeoutId = 0;
      }, TOOLTIP_TIMEOUT);
    });
  }

  initObservers() {
    RPMAddMessageListener(kTorBootstrapErrorTopic, ({ data }) => {
      this.showCopyLogButton(true);
      this.stopTorBootstrap();
      this.showErrorMessage(data);
    });
    RPMAddMessageListener(kTorLogHasWarnOrErrTopic, () => {
      this.showCopyLogButton(true);
    });
    RPMAddMessageListener(kTorProcessDidNotStartTopic, ({ data }) => {
      this.showErrorMessage(data);
    });
    RPMAddMessageListener(kTorBootstrapStatusTopic, ({ data }) => {
      this.updateBootstrapProgress(data);
    });
  }

  async init() {
    this.torStrings = await RPMSendQuery("GetTorStrings");
    document.documentElement.setAttribute(
      "dir",
      await RPMSendQuery("GetDirection")
    );
    this.initButtons();
    this.initObservers();
    this.state = AboutTorConnect.STATE_INITIAL;

    // Request the most recent bootstrap status info so that a
    // TorBootstrapStatus notification is generated as soon as possible.
    RPMSendAsyncMessage("TorRetrieveBootstrapStatus");
  }
}

const aboutTorConnect = new AboutTorConnect();
aboutTorConnect.init();
