// Copyright (c) 2021, The Tor Project, Inc.

/* eslint-env mozilla/frame-script */

// populated in AboutTorConnect.init()
let TorStrings = {};
let TorConnectState = {};
let InternetStatus = {};

const UIStates = Object.freeze({
  ConnectToTor: "ConnectToTor",
  Offline: "Offline",
  ConnectionAssist: "ConnectionAssist",
  CouldNotLocate: "CouldNotLocate",
  LocationConfirm: "LocationConfirm",
  FinalError: "FinalError",
});

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

  uiState = {
    currentState: UIStates.ConnectToTor,
    connectIsTryAgain: false,
    allowAutomaticLocation: true,
    selectedLocation: "automatic",
    bootstrapCause: UIStates.ConnectToTor,
  };

  locations = {};

  constructor() {
    this.uiStates = Object.freeze(
      Object.fromEntries([
        [UIStates.ConnectToTor, this.showConnectToTor.bind(this)],
        [UIStates.Offline, this.showOffline.bind(this)],
        [UIStates.ConnectionAssist, this.showConnectionAssistant.bind(this)],
        [UIStates.CouldNotLocate, this.showCouldNotLocate.bind(this)],
        [UIStates.LocationConfirm, this.showLocationConfirmation.bind(this)],
        [UIStates.FinalError, this.showFinalError.bind(this)],
      ])
    );
  }

  beginBootstrap() {
    RPMSendAsyncMessage("torconnect:begin-bootstrap");
  }

  beginAutoBootstrap(countryCode) {
    if (countryCode === "automatic") {
      countryCode = "";
    }
    RPMSendAsyncMessage("torconnect:begin-autobootstrap", countryCode);
  }

  cancelBootstrap() {
    RPMSendAsyncMessage("torconnect:cancel-bootstrap");
  }

  transitionUIState(nextState, connState) {
    if (nextState !== this.uiState.currentState) {
      this.uiState.currentState = nextState;
      this.saveUIState();
    }
    this.uiStates[nextState](connState);
  }

  saveUIState() {
    RPMSendAsyncMessage("torconnect:set-ui-state", this.uiState);
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
    this.hide(this.elements.quickstartContainer);
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
    this.showConnectToTor(state);
  }

  update_Configuring(state) {
    if (
      state.StateChanged &&
      (state.PreviousState === TorConnectState.Bootstrapping ||
        state.PreviousState === TorConnectState.AutoBootstrapping)
    ) {
      // The bootstrap has been cancelled
      this.transitionUIState(this.uiState.bootstrapCause, state);
    }
  }

  update_AutoBootstrapping(state) {
    this.showBootstrapping(state);
  }

  update_Bootstrapping(state) {
    this.showBootstrapping(state);
  }

  update_Error(state) {
    if (!this.uiState.connectIsTryAgain) {
      // TorConnect.hasBootstrapEverFailed remains false in case of Internet
      // offline
      this.uiState.connectIsTryAgain = true;
      this.saveUIState();
    }
    if (!state.StateChanged) {
      return;
    }
    if (state.InternetStatus === InternetStatus.Offline) {
      this.transitionUIState(UIStates.Offline, state);
    } else if (state.PreviousState === TorConnectState.Bootstrapping) {
      this.transitionUIState(UIStates.ConnectionAssist, state);
    } else if (state.PreviousState === TorConnectState.AutoBootstrapping) {
      if (this.uiState.bootstrapCause === UIStates.ConnectionAssist) {
        this.transitionUIState(
          this.getLocation() === "automatic"
            ? UIStates.CouldNotLocate
            : UIStates.LocationConfirm,
          state
        );
      } else {
        this.transitionUIState(UIStates.FinalError, state);
      }
    } else {
      console.error(
        "We received an error starting from an unexpected state",
        state
      );
    }
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

  showConnectToTor(state) {
    this.setTitle(TorStrings.torConnect.torConnect, "");
    this.setLongText(TorStrings.settings.torPreferencesDescription);
    this.setProgress("", false);
    this.hide(this.elements.viewLogContainer);
    this.hideButtons();
    this.show(this.elements.quickstartContainer);
    this.show(this.elements.configureButton);
    this.show(this.elements.connectButton, true);
    if (state?.StateChanged) {
      this.elements.connectButton.focus();
    }
    if (this.uiState.connectIsTryAgain) {
      this.setBreadcrumbsStatus(
        BreadcrumbStatus.Active,
        BreadcrumbStatus.Default,
        BreadcrumbStatus.Disabled
      );
      this.elements.connectButton.textContent = TorStrings.torConnect.tryAgain;
    }
    this.uiState.bootstrapCause = UIStates.ConnectToTor;
    this.saveUIState();
  }

  showBootstrapping(state) {
    const showProgressbar = true;
    let title = "";
    let description = "";
    const breadcrumbs = [
      BreadcrumbStatus.Disabled,
      BreadcrumbStatus.Disabled,
      BreadcrumbStatus.Disabled,
    ];
    switch (this.uiState.bootstrapCause) {
      case UIStates.ConnectToTor:
        breadcrumbs[0] = BreadcrumbStatus.Active;
        title = this.uiState.connectIsTryAgain
          ? TorStrings.torConnect.tryAgain
          : TorStrings.torConnect.torConnecting;
        description = TorStrings.settings.torPreferencesDescription;
        break;
      case UIStates.ConnectionAssist:
        breadcrumbs[2] = BreadcrumbStatus.Active;
        title = TorStrings.torConnect.tryingBridge;
        description = TorStrings.torConnect.assistDescription;
        break;
      case UIStates.CouldNotLocate:
        breadcrumbs[2] = BreadcrumbStatus.Active;
        title = TorStrings.torConnect.tryingBridgeAgain;
        description = TorStrings.torConnect.errorLocationDescription;
        break;
      case UIStates.LocationConfirm:
        breadcrumbs[2] = BreadcrumbStatus.Active;
        title = TorStrings.torConnect.tryingBridgeAgain;
        description = TorStrings.torConnect.isLocationCorrectDescription;
        break;
    }
    this.setTitle(title, "");
    this.showConfigureConnectionLink(description);
    this.setProgress("", showProgressbar, state.BootstrapProgress);
    this.setBreadcrumbsStatus(...breadcrumbs);
    this.hideButtons();
    if (state.ShowViewLog) {
      this.show(this.elements.viewLogContainer);
    } else {
      this.hide(this.elements.viewLogContainer);
    }
    this.show(this.elements.cancelButton, true);
    if (state.StateChanged) {
      this.elements.cancelButton.focus();
    }
  }

  showOffline(error) {
    this.setTitle(TorStrings.torConnect.noInternet, "offline");
    this.setLongText("Some long text from 🍩️");
    this.setProgress(error, false);
    this.setBreadcrumbsStatus(
      BreadcrumbStatus.Default,
      BreadcrumbStatus.Active,
      BreadcrumbStatus.Hidden
    );
    this.show(this.elements.viewLogContainer);
    this.hideButtons();
    this.show(this.elements.configureButton);
    this.show(this.elements.connectButton, true);
    this.elements.connectButton.textContent = TorStrings.torConnect.tryAgain;
  }

  showConnectionAssistant(state) {
    this.setTitle(TorStrings.torConnect.couldNotConnect, "assit");
    this.showConfigureConnectionLink(TorStrings.torConnect.assistDescription);
    this.setProgress(state?.ErrorDetails, false);
    this.setBreadcrumbsStatus(
      BreadcrumbStatus.Default,
      BreadcrumbStatus.Active,
      BreadcrumbStatus.Disabled
    );
    this.showLocationForm(false, TorStrings.torConnect.tryBridge);
    if (state?.StateChanged) {
      this.elements.tryBridgeButton.focus();
    }
    this.uiState.bootstrapCause = UIStates.ConnectionAssist;
    this.saveUIState();
  }

  showCouldNotLocate(state) {
    this.uiState.allowAutomaticLocation = false;
    this.setTitle(TorStrings.torConnect.errorLocation, "location");
    this.showConfigureConnectionLink(
      TorStrings.torConnect.errorLocationDescription
    );
    this.setProgress(state.ErrorMessage, false);
    this.setBreadcrumbsStatus(
      BreadcrumbStatus.Default,
      BreadcrumbStatus.Active,
      BreadcrumbStatus.Disabled
    );
    this.show(this.elements.viewLogContainer);
    this.showLocationForm(true, TorStrings.torConnect.tryBridge);
    if (state.StateChanged) {
      this.elements.tryBridgeButton.focus();
    }
    this.uiState.bootstrapCause = UIStates.CouldNotLocate;
    this.saveUIState();
  }

  showLocationConfirmation(state) {
    this.setTitle(TorStrings.torConnect.isLocationCorrect, "location");
    this.showConfigureConnectionLink(
      TorStrings.torConnect.isLocationCorrectDescription
    );
    this.setProgress(state.ErrorMessage, false);
    this.setBreadcrumbsStatus(
      BreadcrumbStatus.Default,
      BreadcrumbStatus.Default,
      BreadcrumbStatus.Active
    );
    this.show(this.elements.viewLogContainer);
    this.showLocationForm(true, TorStrings.torConnect.tryAgain);
    if (state.StateChanged) {
      this.elements.tryBridgeButton.focus();
    }
    this.uiState.bootstrapCause = UIStates.LocationConfirm;
    this.saveUIState();
  }

  showFinalError(state) {
    this.setTitle(TorStrings.torConnect.finalError, "final");
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
        this.setLocationFromState();
      }
    });
    let firstOpt = this.elements.locationDropdownSelect.options[0];
    if (this.uiState.allowAutomaticLocation) {
      firstOpt.value = "automatic";
      firstOpt.textContent = TorStrings.torConnect.automatic;
    } else {
      firstOpt.value = "";
      firstOpt.textContent = TorStrings.torConnect.selectCountryRegion;
    }
    this.setLocationFromState();
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

  setLocationFromState() {
    if (this.getLocation() === this.uiState.selectedLocation) {
      return;
    }
    const options = this.elements.locationDropdownSelect.options;
    // We need to do this way, because we have repeated values that break
    // the .value way to select (which would however require the label,
    // rather than the code)...
    for (let i = 0; i < options.length; i++) {
      if (options[i].value === this.uiState.selectedLocation) {
        this.elements.locationDropdownSelect.selectedIndex = i;
        break;
      }
    }
    this.validateLocation();
  }

  initElements(direction) {
    document.documentElement.setAttribute("dir", direction);

    this.elements.connectToTorLink.addEventListener("click", event => {
      if (this.uiState.currentState === UIStates.ConnectToTor) {
        return;
      }
      this.transitionUIState(UIStates.ConnectToTor, null);
      RPMSendAsyncMessage("torconnect:broadcast-user-action", {
        uiState: UIStates.ConnectToTor,
      });
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
      this.transitionUIState(UIStates.ConnectionAssist, null);
      RPMSendAsyncMessage("torconnect:broadcast-user-action", {
        uiState: UIStates.ConnectionAssist,
      });
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
      this.beginBootstrap();
    });

    this.populateLocations();
    this.elements.locationDropdownSelect.addEventListener("change", () => {
      this.uiState.selectedLocation = this.getLocation();
      this.saveUIState();
      this.validateLocation();
      RPMSendAsyncMessage("torconnect:broadcast-user-action", {
        location: this.uiState.selectedLocation,
      });
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
    RPMAddMessageListener("torconnect:user-action", ({ data }) => {
      if (data.location) {
        this.uiState.selectedLocation = data.location;
        this.setLocationFromState();
      }
      if (data.uiState !== undefined) {
        this.transitionUIState(data.uiState, data.connState);
      }
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

    if (Object.keys(args.State.UIState).length) {
      this.uiState = args.State.UIState;
    } else {
      args.State.UIState = this.uiState;
      this.saveUIState();
    }
    this.uiStates[this.uiState.currentState](args.State);
    // populate UI based on current state
    this.updateUI(args.State);
  }
}

const aboutTorConnect = new AboutTorConnect();
aboutTorConnect.init();
