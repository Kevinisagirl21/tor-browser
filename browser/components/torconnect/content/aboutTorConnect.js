// Copyright (c) 2021, The Tor Project, Inc.

/* eslint-env mozilla/frame-script */

// populated in AboutTorConnect.init()
let TorStrings = {};
let TorConnectState = {};
let InternetStatus = {};

const BreadcrumbStatus = Object.freeze({
  Hidden: "hidden",
  Disabled: "disabled",
  Default: "default",
  Active: "active",
  Error: "error",
});

class AboutTorConnect {
  selectors = Object.freeze({
    textContainer: {
      title: "div.title",
      titleText: "h1.title-text",
      longContentText: "#connectLongContentText",
    },
    progress: {
      description: "p#connectShortDescText",
      meter: "div#progressBackground",
    },
    breadcrumbs: {
      container: "#breadcrumbs",
      connectToTor: {
        link: "#connect-to-tor",
        label: "#connect-to-tor .breadcrumb-label",
      },
      connectionAssist: {
        separator: "#connection-assist-separator",
        link: "#connection-assist",
        label: "#connection-assist .breadcrumb-label",
      },
      tryBridge: {
        separator: "#try-bridge-separator",
        link: "#try-bridge",
        label: "#try-bridge .breadcrumb-label",
      },
    },
    viewLog: {
      container: "#viewLogContainer",
      link: "span#viewLogLink",
    },
    quickstart: {
      container: "div#quickstartContainer",
      checkbox: "input#quickstartCheckbox",
      label: "label#quickstartCheckboxLabel",
    },
    buttons: {
      restart: "button#restartButton",
      configure: "button#configureButton",
      cancel: "button#cancelButton",
      connect: "button#connectButton",
      tryBridge: "button#tryBridgeButton",
      locationDropdownLabel: "#locationDropdownLabel",
      locationDropdown: "form#locationDropdown",
      locationDropdownSelect: "form#locationDropdown select",
    },
  });

  elements = Object.freeze({
    title: document.querySelector(this.selectors.textContainer.title),
    titleText: document.querySelector(this.selectors.textContainer.titleText),
    longContentText: document.querySelector(
      this.selectors.textContainer.longContentText
    ),
    progressDescription: document.querySelector(
      this.selectors.progress.description
    ),
    progressMeter: document.querySelector(this.selectors.progress.meter),
    breadcrumbContainer: document.querySelector(
      this.selectors.breadcrumbs.container
    ),
    connectToTorLink: document.querySelector(
      this.selectors.breadcrumbs.connectToTor.link
    ),
    connectToTorLabel: document.querySelector(
      this.selectors.breadcrumbs.connectToTor.label
    ),
    connectionAssistSeparator: document.querySelector(
      this.selectors.breadcrumbs.connectionAssist.separator
    ),
    connectionAssistLink: document.querySelector(
      this.selectors.breadcrumbs.connectionAssist.link
    ),
    connectionAssistLabel: document.querySelector(
      this.selectors.breadcrumbs.connectionAssist.label
    ),
    tryBridgeSeparator: document.querySelector(
      this.selectors.breadcrumbs.tryBridge.separator
    ),
    tryBridgeLink: document.querySelector(
      this.selectors.breadcrumbs.tryBridge.link
    ),
    tryBridgeLabel: document.querySelector(
      this.selectors.breadcrumbs.tryBridge.label
    ),
    viewLogContainer: document.querySelector(this.selectors.viewLog.container),
    viewLogLink: document.querySelector(this.selectors.viewLog.link),
    quickstartContainer: document.querySelector(
      this.selectors.quickstart.container
    ),
    quickstartCheckbox: document.querySelector(
      this.selectors.quickstart.checkbox
    ),
    quickstartLabel: document.querySelector(this.selectors.quickstart.label),
    restartButton: document.querySelector(this.selectors.buttons.restart),
    configureButton: document.querySelector(this.selectors.buttons.configure),
    cancelButton: document.querySelector(this.selectors.buttons.cancel),
    connectButton: document.querySelector(this.selectors.buttons.connect),
    locationDropdownLabel: document.querySelector(
      this.selectors.buttons.locationDropdownLabel
    ),
    locationDropdown: document.querySelector(
      this.selectors.buttons.locationDropdown
    ),
    locationDropdownSelect: document.querySelector(
      this.selectors.buttons.locationDropdownSelect
    ),
    tryBridgeButton: document.querySelector(this.selectors.buttons.tryBridge),
  });

  // a redirect url can be passed as a query parameter for the page to
  // forward us to once bootstrap completes (otherwise the window will just close)
  redirect = null;

  showNext = state => {};

  allowAutomaticLocation = true;

  bootstrappingTitle = "";
  bootstrappingDescription = "";
  bootstrappingBreadcrumb = -1;

  locations = {};

  beginBootstrap() {
    this.hide(this.elements.connectButton);
    this.hide(this.elements.quickstartContainer);
    this.show(this.elements.cancelButton);
    this.elements.cancelButton.focus();
    RPMSendAsyncMessage("torconnect:begin-bootstrap");
  }

  beginAutoBootstrap(countryCode) {
    this.hide(this.elements.tryBridgeButton);
    this.show(this.elements.cancelButton);
    this.elements.cancelButton.focus();
    if (countryCode === "automatic") {
      countryCode = "";
    }
    RPMSendAsyncMessage("torconnect:begin-autobootstrap", countryCode);
  }

  cancelBootstrap() {
    RPMSendAsyncMessage("torconnect:cancel-bootstrap");
  }

  /*
  Element helper methods
  */

  show(element, primary) {
    element.classList.toggle("primary", primary !== undefined && primary);
    element.removeAttribute("hidden");
  }

  hide(element) {
    element.setAttribute("hidden", "true");
  }

  hideButtons() {
    this.hide(this.elements.restartButton);
    this.hide(this.elements.configureButton);
    this.hide(this.elements.cancelButton);
    this.hide(this.elements.connectButton);
    this.hide(this.elements.locationDropdownLabel);
    this.hide(this.elements.locationDropdown);
    this.hide(this.elements.tryBridgeButton);
  }

  populateLocations() {
    const selectCountryRegion = document.createElement("option");
    selectCountryRegion.textContent = TorStrings.torConnect.selectCountryRegion;
    selectCountryRegion.value = "";

    // get all codes and names from TorStrings
    const locationNodes = [];
    for (const [code, name] of Object.entries(this.locations)) {
      let option = document.createElement("option");
      option.value = code;
      option.textContent = name;
      locationNodes.push(option);
    }
    // locale sort by name
    locationNodes.sort((left, right) =>
      left.textContent.localeCompare(right.textContent)
    );
    this.elements.locationDropdownSelect.append(
      selectCountryRegion,
      ...locationNodes
    );
  }

  populateFrequentLocations(locations) {
    this.removeFrequentLocations();
    if (!locations || !locations.length) {
      return;
    }

    const locationNodes = [];
    for (const code of locations) {
      const option = document.createElement("option");
      option.value = code;
      option.className = "frequent-location";
      // codes (partially) come from rdsys service, so make sure we have a
      // string defined for it
      let name = this.locations[code];
      if (!name) {
        name = code;
      }
      option.textContent = name;
      locationNodes.push(option);
    }
    // locale sort by name
    locationNodes.sort((left, right) =>
      left.textContent.localeCompare(right.textContent)
    );

    const frequentGroup = document.createElement("optgroup");
    frequentGroup.setAttribute(
      "label",
      TorStrings.torConnect.frequentLocations
    );
    frequentGroup.className = "frequent-location";
    const locationGroup = document.createElement("optgroup");
    locationGroup.setAttribute("label", TorStrings.torConnect.otherLocations);
    locationGroup.className = "frequent-location";
    // options[0] is either "Select Country or Region" or "Automatic"
    this.elements.locationDropdownSelect.options[0].after(
      frequentGroup,
      ...locationNodes,
      locationGroup
    );
  }

  removeFrequentLocations() {
    const select = this.elements.locationDropdownSelect;
    for (const option of select.querySelectorAll(".frequent-location")) {
      option.remove();
    }
  }

  validateLocation() {
    const selectedIndex = this.elements.locationDropdownSelect.selectedIndex;
    const selectedOption = this.elements.locationDropdownSelect.options[
      selectedIndex
    ];
    if (!selectedOption.value) {
      this.elements.tryBridgeButton.setAttribute("disabled", "disabled");
    } else {
      this.elements.tryBridgeButton.removeAttribute("disabled");
    }
  }

  setTitle(title, className) {
    this.elements.titleText.textContent = title;
    this.elements.title.className = "title";
    if (className) {
      this.elements.title.classList.add(className);
    }
    document.title = title;
  }

  setLongText(...args) {
    this.elements.longContentText.textContent = "";
    this.elements.longContentText.append(...args);
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

  setBreadcrumbsStatus(connectToTor, connectionAssist, tryBridge) {
    this.elements.breadcrumbContainer.classList.remove("hidden");
    const elems = [
      [this.elements.connectToTorLink, connectToTor, null],
      [
        this.elements.connectionAssistLink,
        connectionAssist,
        this.elements.connectionAssistSeparator,
      ],
      [
        this.elements.tryBridgeLink,
        tryBridge,
        this.elements.tryBridgeSeparator,
      ],
    ];
    elems.forEach(([elem, status, separator]) => {
      elem.classList.remove(BreadcrumbStatus.Hidden);
      elem.classList.remove(BreadcrumbStatus.Disabled);
      elem.classList.remove(BreadcrumbStatus.Active);
      elem.classList.remove(BreadcrumbStatus.Error);
      if (status !== "") {
        elem.classList.add(status);
      }
      separator?.classList.toggle("hidden", status === BreadcrumbStatus.Hidden);
    });
  }

  hideBreadcrumbs() {
    this.elements.breadcrumbContainer.classList.add("hidden");
  }

  /*
  These methods update the UI based on the current TorConnect state
  */

  updateUI(state) {
    // calls update_$state()
    this[`update_${state.State}`](state);
    this.elements.quickstartCheckbox.checked = state.QuickStartEnabled;
  }

  /* Per-state updates */

  update_Initial(state) {
    this.showConnectToTor(state, false);
  }

  update_Configuring(state) {
    this.hide(this.elements.quickstartContainer);
    this.hide(this.elements.viewLogContainer);
    this.hideButtons();

    if (state.ErrorMessage === null) {
      this.showConnectToTor(state, false);
    } else if (state.InternetStatus === InternetStatus.Offline) {
      this.showOffline(state.ErrorMessage);
    } else {
      this.showNext(state);
    }
  }

  update_AutoBootstrapping(state) {
    this.showBootstrapping(state);
  }

  update_Bootstrapping(state) {
    this.showBootstrapping(state);
  }

  update_Error(state) {
    const showProgressbar = false;

    this.setTitle(state.ErrorMessage, "error");
    this.setLongText("");
    this.setProgress(state.ErrorDetails, showProgressbar);
    this.hideButtons();
    this.show(this.elements.viewLogContainer);
  }

  update_Bootstrapped(state) {
    const showProgressbar = true;

    this.setTitle(TorStrings.torConnect.torConnected, "");
    this.setLongText(TorStrings.settings.torPreferencesDescription);
    this.setProgress("", showProgressbar, 100);
    this.hideButtons();

    // redirects page to the requested redirect url, removes about:torconnect
    // from the page stack, so users cannot accidentally go 'back' to the
    // now unresponsive page
    window.location.replace(this.redirect);
  }

  update_Disabled(state) {
    // TODO: we should probably have some UX here if a user goes to about:torconnect when
    // it isn't in use (eg using tor-launcher or system tor)
  }

  showConnectToTor(state, tryAgain) {
    this.setTitle(TorStrings.torConnect.torConnect, "");
    this.setLongText(TorStrings.settings.torPreferencesDescription);
    this.setProgress("", false);
    this.hideButtons();
    this.show(this.elements.quickstartContainer);
    this.show(this.elements.configureButton);
    this.show(this.elements.connectButton, true);
    if (state?.StateChanged) {
      this.elements.connectButton.focus();
    }
    if (tryAgain) {
      this.setBreadcrumbsStatus(
        BreadcrumbStatus.Active,
        BreadcrumbStatus.Default,
        BreadcrumbStatus.Disabled
      );
      this.elements.connectButton.textContent = TorStrings.torConnect.tryAgain;
    }
    this.bootstrappingDescription =
      TorStrings.settings.torPreferencesDescription;
    this.showNext = fromState => {
      this.showConnectionAssistant(fromState.ErrorDetails);
      if (fromState.StateChanged) {
        this.elements.tryBridgeButton.focus();
      }
    };
  }

  showBootstrapping(state) {
    const showProgressbar = true;
    this.setTitle(this.bootstrappingTitle, "");
    this.showConfigureConnectionLink(this.bootstrappingDescription);
    this.setProgress("", showProgressbar, state.BootstrapProgress);
    if (this.bootstrappingBreadcrumb < 0) {
      this.hideBreadcrumbs();
    } else {
      const breadcrumbs = [
        BreadcrumbStatus.Disabled,
        BreadcrumbStatus.Disabled,
        BreadcrumbStatus.Disabled,
      ];
      breadcrumbs[this.bootstrappingBreadcrumb] = BreadcrumbStatus.Active;
      this.setBreadcrumbsStatus(...breadcrumbs);
    }
    if (state.ShowViewLog) {
      this.show(this.elements.viewLogContainer);
    } else {
      this.hide(this.elements.viewLogContainer);
    }
    this.hideButtons();
    this.show(this.elements.cancelButton, true);
    if (state.StateChanged) {
      this.elements.cancelButton.focus();
    }
  }

  showOffline(error) {
    this.setTitle(TorStrings.torConnect.noInternet, "error");
    this.setLongText("Some long text from 🍩️");
    this.setProgress(error, false);
    this.setBreadcrumbsStatus(
      BreadcrumbStatus.Default,
      BreadcrumbStatus.Active,
      BreadcrumbStatus.Hidden
    );
    this.hideButtons();
    this.show(this.elements.configureButton);
    this.show(this.elements.connectButton, true);
    this.elements.connectButton.textContent = TorStrings.torConnect.tryAgain;
  }

  showConnectionAssistant(errorMessage) {
    this.setTitle(TorStrings.torConnect.couldNotConnect, "assit");
    this.showConfigureConnectionLink(TorStrings.torConnect.assistDescription);
    this.setProgress(errorMessage, false);
    this.setBreadcrumbsStatus(
      BreadcrumbStatus.Default,
      BreadcrumbStatus.Active,
      BreadcrumbStatus.Disabled
    );
    this.showLocationForm(false, TorStrings.torConnect.tryBridge);
    this.bootstrappingBreadcrumb = 2;
    this.bootstrappingTitle = TorStrings.torConnect.tryingBridge;
    this.bootstrappingDescription = TorStrings.torConnect.assistDescription;
    this.showNext = state => {
      if (this.getLocation() === "automatic") {
        this.showCannotLocate(state.ErrorMessage);
      } else {
        this.showLocationConfirmation(state.ErrorMessage);
      }
      if (state.StateChanged) {
        this.elements.tryBridgeButton.focus();
      }
    };
  }

  showCannotLocate(errorMessage) {
    this.allowAutomaticLocation = false;
    this.setTitle(TorStrings.torConnect.errorLocation, "location");
    this.showConfigureConnectionLink(
      TorStrings.torConnect.errorLocationDescription
    );
    this.setProgress(errorMessage, false);
    this.setBreadcrumbsStatus(
      BreadcrumbStatus.Default,
      BreadcrumbStatus.Active,
      BreadcrumbStatus.Disabled
    );
    this.showLocationForm(true, TorStrings.torConnect.tryBridge);
    this.bootstrappingBreadcrumb = 2;
    this.bootstrappingTitle = TorStrings.torConnect.tryingBridgeAgain;
    this.bootstrappingDescription =
      TorStrings.torConnect.errorLocationDescription;
    this.showNext = state => {
      this.showFinalError(state);
    };
  }

  showLocationConfirmation(errorMessage) {
    this.setTitle(TorStrings.torConnect.isLocationCorrect, "location");
    this.showConfigureConnectionLink(
      TorStrings.torConnect.isLocationCorrectDescription
    );
    this.setProgress(errorMessage, false);
    this.setBreadcrumbsStatus(
      BreadcrumbStatus.Default,
      BreadcrumbStatus.Default,
      BreadcrumbStatus.Active
    );
    this.showLocationForm(true, TorStrings.torConnect.tryAgain);
    this.bootstrappingBreadcrumb = 2;
    this.bootstrappingTitle = TorStrings.torConnect.tryingBridgeAgain;
    this.bootstrappingDescription =
      TorStrings.torConnect.isLocationCorrectDescription;
    this.showNext = state => {
      this.showFinalError(state);
    };
  }

  showFinalError(state) {
    this.setTitle(TorStrings.torConnect.finalError, "error");
    this.setLongText(TorStrings.torConnect.finalErrorDescription);
    this.setProgress(state ? state.ErrorDetails : "", false);
    this.setBreadcrumbsStatus(
      BreadcrumbStatus.Default,
      BreadcrumbStatus.Default,
      BreadcrumbStatus.Active
    );
    this.hideButtons();
    this.show(this.elements.restartButton);
    this.show(this.elements.configureButton, true);
    this.showNext = fromState => {
      this.showFinalError(fromState);
    };
  }

  showConfigureConnectionLink(text) {
    const pieces = text.split("#1");
    const link = document.createElement("a");
    link.textContent = TorStrings.torConnect.configureConnection;
    link.setAttribute("href", "#");
    link.addEventListener("click", e => {
      e.preventDefault();
      RPMSendAsyncMessage("torconnect:open-tor-preferences");
    });
    if (pieces.length > 1) {
      const first = pieces.shift();
      this.setLongText(first, link, ...pieces);
    } else {
      this.setLongText(text);
    }
  }

  showLocationForm(isError, buttonLabel) {
    this.hideButtons();
    RPMSendQuery("torconnect:get-country-codes").then(codes => {
      if (codes && codes.length) {
        this.populateFrequentLocations(codes);
      }
    });
    let firstOpt = this.elements.locationDropdownSelect.options[0];
    if (this.allowAutomaticLocation) {
      firstOpt.value = "automatic";
      firstOpt.textContent = TorStrings.torConnect.automatic;
    } else {
      firstOpt.value = "";
      firstOpt.textContent = TorStrings.torConnect.selectCountryRegion;
    }
    this.validateLocation();
    this.show(this.elements.locationDropdownLabel);
    this.show(this.elements.locationDropdown);
    this.elements.locationDropdownLabel.classList.toggle("error", isError);
    this.show(this.elements.tryBridgeButton, true);
    this.elements.tryBridgeButton.classList.toggle("danger-button", isError);
    if (buttonLabel !== undefined) {
      this.elements.tryBridgeButton.textContent = buttonLabel;
    }
  }

  getLocation() {
    const selectedIndex = this.elements.locationDropdownSelect.selectedIndex;
    return this.elements.locationDropdownSelect.options[selectedIndex].value;
  }

  initElements(direction) {
    document.documentElement.setAttribute("dir", direction);

    this.bootstrappingTitle = TorStrings.torConnect.torConnecting;

    this.elements.connectToTorLink.addEventListener("click", event => {
      if (
        this.elements.connectToTorLink.classList.contains(
          BreadcrumbStatus.Active
        )
      ) {
        return;
      }
      this.showConnectToTor(null, true);
    });
    this.elements.connectToTorLabel.textContent =
      TorStrings.torConnect.torConnect;
    this.elements.connectionAssistLink.addEventListener("click", event => {
      if (
        this.elements.connectionAssistLink.classList.contains(
          BreadcrumbStatus.Active
        ) ||
        this.elements.connectionAssistLink.classList.contains(
          BreadcrumbStatus.Disabled
        )
      ) {
        return;
      }
      this.showConnectionAssistant();
    });
    this.elements.connectionAssistLabel.textContent =
      TorStrings.torConnect.breadcrumbAssist;
    this.elements.tryBridgeLabel.textContent =
      TorStrings.torConnect.breadcrumbTryBridge;

    this.hide(this.elements.viewLogContainer);
    this.elements.viewLogLink.textContent = TorStrings.torConnect.viewLog;
    this.elements.viewLogLink.addEventListener("click", event => {
      RPMSendAsyncMessage("torconnect:view-tor-logs");
    });

    this.elements.quickstartCheckbox.addEventListener("change", () => {
      const quickstart = this.elements.quickstartCheckbox.checked;
      RPMSendAsyncMessage("torconnect:set-quickstart", quickstart);
    });
    this.elements.quickstartLabel.textContent =
      TorStrings.settings.quickstartCheckbox;

    this.elements.restartButton.textContent =
      TorStrings.torConnect.restartTorBrowser;
    this.elements.restartButton.addEventListener("click", () => {
      RPMSendAsyncMessage("torconnect:restart");
    });

    this.elements.configureButton.textContent =
      TorStrings.torConnect.torConfigure;
    this.elements.configureButton.addEventListener("click", () => {
      RPMSendAsyncMessage("torconnect:open-tor-preferences");
    });

    this.elements.cancelButton.textContent = TorStrings.torConnect.cancel;
    this.elements.cancelButton.addEventListener("click", () => {
      this.cancelBootstrap();
    });

    this.elements.connectButton.textContent =
      TorStrings.torConnect.torConnectButton;
    this.elements.connectButton.addEventListener("click", () => {
      if (
        this.elements.connectButton.textContent ===
        TorStrings.torConnect.tryAgain
      ) {
        this.bootstrappingBreadcrumb = 0;
        this.bootstrappingTitle = TorStrings.torConnect.tryingAgain;
      }
      this.beginBootstrap();
    });

    this.populateLocations();
    this.elements.locationDropdownSelect.addEventListener("change", () => {
      this.validateLocation();
    });

    this.elements.locationDropdownLabel.textContent =
      TorStrings.torConnect.yourLocation;

    this.elements.tryBridgeButton.textContent = TorStrings.torConnect.tryBridge;
    this.elements.tryBridgeButton.addEventListener("click", () => {
      const value = this.getLocation();
      if (value === "automatic") {
        this.beginAutoBootstrap();
      } else {
        this.beginAutoBootstrap(value);
      }
    });
  }

  initObservers() {
    // TorConnectParent feeds us state blobs to we use to update our UI
    RPMAddMessageListener("torconnect:state-change", ({ data }) => {
      this.updateUI(data);
    });
  }

  initKeyboardShortcuts() {
    document.onkeydown = evt => {
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
    InternetStatus = Object.freeze(args.InternetStatus);
    this.locations = args.CountryNames;

    this.initElements(args.Direction);
    this.initObservers();
    this.initKeyboardShortcuts();

    // populate UI based on current state
    this.updateUI(args.State);
  }
}

const aboutTorConnect = new AboutTorConnect();
aboutTorConnect.init();
