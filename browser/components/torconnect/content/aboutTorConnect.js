// Copyright (c) 2021, The Tor Project, Inc.

/* eslint-env mozilla/frame-script */

// populated in AboutTorConnect.init()
let TorStrings = {};
let TorConnectState = {};

class AboutTorConnect {
  selectors = Object.freeze({
    textContainer: {
      title: "div.title",
      titleText: "h1.title-text",
    },
    progress: {
      description: "p#connectShortDescText",
      meter: "div#progressBackground",
    },
    copyLog: {
      link: "span#copyLogLink",
      tooltip: "div#copyLogTooltip",
      tooltipText: "span#copyLogTooltipText",
    },
    quickstart: {
      checkbox: "input#quickstartCheckbox",
      label: "label#quickstartCheckboxLabel",
    },
    buttons: {
      connect: "button#connectButton",
      cancel: "button#cancelButton",
      advanced: "button#advancedButton",
    },
  })

  elements = Object.freeze({
    title: document.querySelector(this.selectors.textContainer.title),
    titleText: document.querySelector(this.selectors.textContainer.titleText),
    progressDescription: document.querySelector(this.selectors.progress.description),
    progressMeter: document.querySelector(this.selectors.progress.meter),
    copyLogLink: document.querySelector(this.selectors.copyLog.link),
    copyLogTooltip: document.querySelector(this.selectors.copyLog.tooltip),
    copyLogTooltipText: document.querySelector(this.selectors.copyLog.tooltipText),
    quickstartCheckbox: document.querySelector(this.selectors.quickstart.checkbox),
    quickstartLabel: document.querySelector(this.selectors.quickstart.label),
    connectButton: document.querySelector(this.selectors.buttons.connect),
    cancelButton: document.querySelector(this.selectors.buttons.cancel),
    advancedButton: document.querySelector(this.selectors.buttons.advanced),
  })

  // a redirect url can be passed as a query parameter for the page to
  // forward us to once bootstrap completes (otherwise the window will just close)
  redirect = null

  beginBootstrap() {
    this.hide(this.elements.connectButton);
    this.show(this.elements.cancelButton);
    this.elements.cancelButton.focus();
    RPMSendAsyncMessage("torconnect:begin-bootstrap");
  }

  cancelBootstrap() {
    RPMSendAsyncMessage("torconnect:cancel-bootstrap");
  }

  /*
  Element helper methods
  */

  show(element) {
    element.removeAttribute("hidden");
  }

  hide(element) {
    element.setAttribute("hidden", "true");
  }

  setTitle(title, error) {
    this.elements.titleText.textContent = title;
    document.title = title;

    if (error) {
      this.elements.title.classList.add("error");
    } else {
      this.elements.title.classList.remove("error");
    }
  }

  setProgress(description, visible, percent) {
    this.elements.progressDescription.textContent = description;
    if (visible) {
      this.show(this.elements.progressMeter);
      this.elements.progressMeter.style.width = `${percent}%`;
    } else {
      this.hide(this.elements.progressMeter);
    }
  }

  /*
  These methods update the UI based on the current TorConnect state
  */

  updateUI(state) {
    console.log(state);

    // calls update_$state()
    this[`update_${state.State}`](state);
    this.elements.quickstartCheckbox.checked = state.QuickStartEnabled;
  }

  /* Per-state updates */

  update_Initial(state) {
    const hasError = false;
    const showProgressbar = false;

    this.setTitle(TorStrings.torConnect.torConnect, hasError);
    this.setProgress(TorStrings.settings.torPreferencesDescription, showProgressbar);
    this.hide(this.elements.copyLogLink);
    this.hide(this.elements.connectButton);
    this.hide(this.elements.advancedButton);
    this.hide(this.elements.cancelButton);
  }

  update_Configuring(state) {
    const hasError = state.ErrorMessage != null;
    const showProgressbar = false;

    if (hasError) {
      this.setTitle(state.ErrorMessage, hasError);
      this.setProgress(state.ErrorDetails, showProgressbar);
      this.show(this.elements.copyLogLink);
      this.elements.connectButton.textContent = TorStrings.torConnect.tryAgain;
    } else {
      this.setTitle(TorStrings.torConnect.torConnect, hasError);
      this.setProgress(TorStrings.settings.torPreferencesDescription, showProgressbar);
      this.hide(this.elements.copyLogLink);
      this.elements.connectButton.textContent = TorStrings.torConnect.torConnectButton;
    }
    this.show(this.elements.connectButton);
    if (state.StateChanged) {
      this.elements.connectButton.focus();
    }
    this.show(this.elements.advancedButton);
    this.hide(this.elements.cancelButton);
  }

  update_AutoBootstrapping(state) {
    // TODO: noop until this state is used
  }

  update_Bootstrapping(state) {
    const hasError = false;
    const showProgressbar = true;

    this.setTitle(state.BootstrapStatus ? state.BootstrapStatus : TorStrings.torConnect.torConnecting, hasError);
    this.setProgress(TorStrings.settings.torPreferencesDescription, showProgressbar, state.BootstrapProgress);
    if (state.ShowCopyLog) {
      this.show(this.elements.copyLogLink);
    } else {
      this.hide(this.elements.copyLogLink);
    }
    this.hide(this.elements.connectButton);
    this.hide(this.elements.advancedButton);
    this.show(this.elements.cancelButton);
    if (state.StateChanged) {
      this.elements.cancelButton.focus();
    }
  }

  update_Error(state) {
    const hasError = true;
    const showProgressbar = false;

    this.setTitle(state.ErrorMessage, hasError);
    this.setProgress(state.ErrorDetails, showProgressbar);
    this.show(this.elements.copyLogLink);
    this.elements.connectButton.textContent = TorStrings.torConnect.tryAgain;
    this.show(this.elements.connectButton);
    this.show(this.elements.advancedButton);
    this.hide(this.elements.cancelButton);
  }

  update_Bootstrapped(state) {
    const hasError = false;
    const showProgressbar = true;

    this.setTitle(TorStrings.torConnect.torConnected, hasError);
    this.setProgress(TorStrings.settings.torPreferencesDescription, showProgressbar, 100);
    this.hide(this.elements.connectButton);
    this.hide(this.elements.advancedButton);
    this.hide(this.elements.cancelButton);

    // redirects page to the requested redirect url, removes about:torconnect
    // from the page stack, so users cannot accidentally go 'back' to the
    // now unresponsive page
    window.location.replace(this.redirect);
  }

  update_Disabled(state) {
    // TODO: we should probably have some UX here if a user goes to about:torconnect when
    // it isn't in use (eg using tor-launcher or system tor)
  }

  async initElements(direction) {

    document.documentElement.setAttribute("dir", direction);

    // sets the text content while keeping the child elements intact
    this.elements.copyLogLink.childNodes[0].nodeValue =
      TorStrings.torConnect.copyLog;
    this.elements.copyLogLink.addEventListener("click", async (event) => {
      const copiedMessage = await RPMSendQuery("torconnect:copy-tor-logs");
      this.elements.copyLogTooltipText.textContent = copiedMessage;
      this.elements.copyLogTooltipText.style.visibility = "visible";

      // clear previous timeout if one already exists
      if (this.copyLogTimeoutId) {
        clearTimeout(this.copyLogTimeoutId);
      }

      // hide tooltip after X ms
      const TOOLTIP_TIMEOUT = 2000;
      this.copyLogTimeoutId = setTimeout(() => {
        this.elements.copyLogTooltipText.style.visibility = "hidden";
        this.copyLogTimeoutId = 0;
      }, TOOLTIP_TIMEOUT);
    });

    this.elements.quickstartCheckbox.addEventListener("change", () => {
      const quickstart = this.elements.quickstartCheckbox.checked;
      RPMSendAsyncMessage("torconnect:set-quickstart", quickstart);
    });
    this.elements.quickstartLabel.textContent = TorStrings.settings.quickstartCheckbox;

    this.elements.connectButton.textContent =
      TorStrings.torConnect.torConnectButton;
    this.elements.connectButton.addEventListener("click", () => {
      this.beginBootstrap();
    });

    this.elements.advancedButton.textContent = TorStrings.torConnect.torConfigure;
    this.elements.advancedButton.addEventListener("click", () => {
      RPMSendAsyncMessage("torconnect:open-tor-preferences");
    });

    this.elements.cancelButton.textContent = TorStrings.torConnect.cancel;
    this.elements.cancelButton.addEventListener("click", () => {
      this.cancelBootstrap();
    });
  }

  initObservers() {
    // TorConnectParent feeds us state blobs to we use to update our UI
    RPMAddMessageListener("torconnect:state-change", ({ data }) => {
      this.updateUI(data);
    });
  }

  initKeyboardShortcuts() {
    document.onkeydown = (evt) => {
      // unfortunately it looks like we still haven't standardized keycodes to
      // integers, so we must resort to a string compare here :(
      // see https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/code for relevant documentation
      if (evt.code === "Escape") {
        this.cancelBootstrap();
      }
    };
  }

  async init() {
    // see if a user has a final destination after bootstrapping
    let params = new URLSearchParams(new URL(document.location.href).search);
    if (params.has("redirect")) {
      const encodedRedirect = params.get("redirect");
      this.redirect = decodeURIComponent(encodedRedirect);
    } else {
      // if the user gets here manually or via the button in the urlbar
      // then we will redirect to about:tor
      this.redirect = "about:tor";
    }

    let args = await RPMSendQuery("torconnect:get-init-args");

    // various constants
    TorStrings = Object.freeze(args.TorStrings);
    TorConnectState = Object.freeze(args.TorConnectState);

    this.initElements(args.Direction);
    this.initObservers();
    this.initKeyboardShortcuts();

    // populate UI based on current state
    this.updateUI(args.State);
  }
}

const aboutTorConnect = new AboutTorConnect();
aboutTorConnect.init();
