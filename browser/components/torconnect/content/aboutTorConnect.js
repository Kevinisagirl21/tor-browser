// Copyright (c) 2021, The Tor Project, Inc.

/* eslint-env mozilla/frame-script */

// populated in AboutTorConnect.init()
let TorStrings = {};
let TorConnectState = {};
let TorCensorshipLevel = {};

const BreadcrumbStatus = Object.freeze({
  Disabled: -1,
  Default: 0,
  Active: 1,
  Error: 2,
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
      connectionAssist: {
        link: "#connection-assist",
        label: "#connection-assist .breadcrumb-label",
      },
      locationSettings: {
        link: "#location-settings",
        label: "#location-settings .breadcrumb-label",
      },
      tryBridge: {
        link: "#try-bridge",
        label: "#try-bridge .breadcrumb-label",
      },
    },
    viewLog: {
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
      locationDropdownLabel: "div#locationDropdownLabel",
      locationDropdown: "form#locationDropdown",
      locationDropdownSelect: "form#locationDropdown select",
      tryAgain: "button#tryAgainButton",
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
    connectionAssistLink: document.querySelector(
      this.selectors.breadcrumbs.connectionAssist.link
    ),
    connectionAssistLabel: document.querySelector(
      this.selectors.breadcrumbs.connectionAssist.label
    ),
    locationSettingsLink: document.querySelector(
      this.selectors.breadcrumbs.locationSettings.link
    ),
    locationSettingsLabel: document.querySelector(
      this.selectors.breadcrumbs.locationSettings.label
    ),
    tryBridgeLink: document.querySelector(
      this.selectors.breadcrumbs.tryBridge.link
    ),
    tryBridgeLabel: document.querySelector(
      this.selectors.breadcrumbs.tryBridge.label
    ),
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
    tryBridgeButton: document.querySelector(this.selectors.buttons.tryBridge),
    locationDropdownLabel: document.querySelector(
      this.selectors.buttons.locationDropdownLabel
    ),
    locationDropdown: document.querySelector(
      this.selectors.buttons.locationDropdown
    ),
    locationDropdownSelect: document.querySelector(
      this.selectors.buttons.locationDropdownSelect
    ),
    tryAgainButton: document.querySelector(this.selectors.buttons.tryAgain),
  });

  // a redirect url can be passed as a query parameter for the page to
  // forward us to once bootstrap completes (otherwise the window will just close)
  redirect = null;

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
    RPMSendAsyncMessage("torconnect:begin-autobootstrap", countryCode);
  }

  cancelBootstrap() {
    RPMSendAsyncMessage("torconnect:cancel-bootstrap");
  }

  /*
  Element helper methods
  */

  show(element, primary) {
    if (primary) {
      element.classList.add("primary");
    } else {
      element.classList.remove("primary");
    }
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
    this.hide(this.elements.tryBridgeButton);
    this.hide(this.elements.locationDropdownLabel);
    this.hide(this.elements.locationDropdown);
    this.hide(this.elements.tryAgainButton);
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

  populateSpecialLocations(specialLocations) {
    this.removeSpecialLocations();
    if (!specialLocations || !specialLocations.length) {
      return;
    }

    const locationNodes = [];
    for (const code of specialLocations) {
      const option = document.createElement("option");
      option.value = code;

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

    const disabledDividerNode = document.createElement("option");
    disabledDividerNode.setAttribute("disabled", true);
    disabledDividerNode.className = "divider";
    this.elements.locationDropdownSelect.options[0].after(
      ...locationNodes,
      disabledDividerNode
    );
  }

  removeSpecialLocations() {
    const select = this.elements.locationDropdownSelect;
    if (select.querySelector(".divider") === null) {
      return;
    }

    while (select.options.length > 1) {
      // Skip the "select country/region" option
      const opt = select.options[1];
      opt.remove();
      if (opt.className === "divider") {
        break;
      }
    }
  }

  validateLocation() {
    const selectedIndex = this.elements.locationDropdownSelect.selectedIndex;
    const selectedOption = this.elements.locationDropdownSelect.options[
      selectedIndex
    ];
    if (!selectedOption.value) {
      this.elements.tryAgainButton.setAttribute("disabled", "disabled");
    } else {
      this.elements.tryAgainButton.removeAttribute("disabled");
    }
  }

  setTitle(title, className) {
    this.elements.titleText.textContent = title;
    if (className !== "error") {
      this.elements.title.classList.remove("error");
    }
    if (className !== "location") {
      this.elements.title.classList.remove("location");
    }
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

  setBreadcrumbsStatus(connectionAssist, locationSettings, tryBridge) {
    this.elements.breadcrumbContainer.classList.remove("hidden");
    let elems = [
      [this.elements.connectionAssistLink, connectionAssist],
      [this.elements.locationSettingsLink, locationSettings],
      [this.elements.tryBridgeLink, tryBridge],
    ];
    elems.forEach(([elem, status]) => {
      elem.classList.remove("disabled");
      elem.classList.remove("active");
      elem.classList.remove("error");
      switch (status) {
        case BreadcrumbStatus.Disabled:
          elem.classList.add("disabled");
          break;
        case BreadcrumbStatus.Active:
          elem.classList.add("active");
          break;
        case BreadcrumbStatus.Error:
          elem.classList.add("error");
          break;
      }
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
    const hasError = false;
    const showProgressbar = false;

    this.setTitle(TorStrings.torConnect.torConnect, hasError ? "error" : "");
    this.setProgress(
      TorStrings.settings.torPreferencesDescription,
      showProgressbar
    );
    this.hide(this.elements.quickstartContainer);
    this.hide(this.elements.viewLogLink);
    this.hideButtons();
  }

  update_Configuring(state) {
    const hasError = state.ErrorMessage != null;
    const showProgressbar = false;

    this.hide(this.elements.quickstartContainer);
    this.hide(this.elements.viewLogLink);
    this.hideButtons();

    if (hasError) {
      switch (state.DetectedCensorshiplevel) {
        case TorCensorshipLevel.None:
          // we shouldn't be able to get here
          break;
        case TorCensorshipLevel.Moderate:
          // bootstrap failed once, offer auto bootstrap
          this.showConnectionAssistant(state.ErrorDetails);
          if (state.StateChanged) {
            this.elements.tryBridgeButton.focus();
          }
          break;
        case TorCensorshipLevel.Severe:
          // autobootstrap failed, verify correct location
          this.showLocationSettings(state.CountryCodes, state.ErrorMessage);
          if (state.StateChanged) {
            this.elements.tryAgainButton.focus();
          }
          break;
        case TorCensorshipLevel.Extreme:
          // finally offer to restart tor-browser or go to configure options
          this.showFinalError(state);
          break;
      }
    } else {
      this.setTitle(TorStrings.torConnect.torConnect, "");
      this.setLongText(TorStrings.settings.torPreferencesDescription);
      this.setProgress("", showProgressbar);
      this.show(this.elements.quickstartContainer);
      this.show(this.elements.configureButton);
      this.show(this.elements.connectButton, true);
      if (state.StateChanged) {
        this.elements.connectButton.focus();
      }
      this.elements.connectButton.textContent =
        TorStrings.torConnect.torConnectButton;
    }
  }

  update_AutoBootstrapping(state) {
    const showProgressbar = true;

    if (state.DetectedCensorshiplevel >= TorCensorshipLevel.Severe) {
      this.setTitle(TorStrings.torConnect.tryingBridgeAgain, "");
    } else {
      this.setTitle(TorStrings.torConnect.tryingBridge, "");
    }
    this.showConfigureConnectionLink(TorStrings.torConnect.assistDescription);
    this.setProgress(
      state.BootstrapStatus,
      showProgressbar,
      state.BootstrapProgress
    );
    this.setBreadcrumbsStatus(
      BreadcrumbStatus.Disabled,
      BreadcrumbStatus.Disabled,
      BreadcrumbStatus.Active
    );
    if (state.ShowViewLog) {
      this.show(this.elements.viewLogLink);
    } else {
      this.hide(this.elements.viewLogLink);
    }
    this.hideButtons();
    this.show(this.elements.cancelButton, true);
    if (state.StateChanged) {
      this.elements.cancelButton.focus();
    }
  }

  update_Bootstrapping(state) {
    const showProgressbar = true;

    this.setTitle(TorStrings.torConnect.torConnecting, "");
    this.setLongText(TorStrings.settings.torPreferencesDescription);
    this.setProgress("", showProgressbar, state.BootstrapProgress);
    this.hideBreadcrumbs();
    if (state.ShowViewLog) {
      this.show(this.elements.viewLogLink);
    } else {
      this.hide(this.elements.viewLogLink);
    }
    this.hideButtons();
    this.show(this.elements.cancelButton, true);
    if (state.StateChanged) {
      this.elements.cancelButton.focus();
    }
  }

  update_Error(state) {
    const showProgressbar = false;

    this.setTitle(state.ErrorMessage, "error");
    this.setLongText("");
    this.setProgress(state.ErrorDetails, showProgressbar);
    this.hideButtons();
    this.show(this.elements.viewLogLink);
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

  showConnectionAssistant(error) {
    const hasError = !!error;
    this.setTitle(
      TorStrings.torConnect.couldNotConnect,
      hasError ? "error" : ""
    );
    this.showConfigureConnectionLink(TorStrings.torConnect.assistDescription);
    this.setProgress(error, false);
    this.setBreadcrumbsStatus(
      BreadcrumbStatus.Active,
      BreadcrumbStatus.Default,
      BreadcrumbStatus.Disabled
    );
    this.hideButtons();
    this.show(this.elements.configureButton);
    this.show(this.elements.connectButton);
    this.show(this.elements.tryBridgeButton, true);
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
    this.setLongText(pieces[0], link, pieces[1]);
  }

  showLocationSettings(locations, error) {
    const hasError = !!error;
    if (hasError) {
      this.setTitle(TorStrings.torConnect.errorLocation, "location");
      this.setLongText(TorStrings.torConnect.errorLocationDescription);
      this.setBreadcrumbsStatus(
        BreadcrumbStatus.Disabled,
        BreadcrumbStatus.Error,
        BreadcrumbStatus.Disabled
      );
      this.elements.tryAgainButton.textContent = TorStrings.torConnect.tryAgain;
    } else {
      this.setTitle(TorStrings.torConnect.addLocation, "location");
      this.showConfigureConnectionLink(
        TorStrings.torConnect.addLocationDescription
      );
      this.setBreadcrumbsStatus(
        BreadcrumbStatus.Default,
        BreadcrumbStatus.Active,
        BreadcrumbStatus.Disabled
      );
      this.elements.tryAgainButton.textContent =
        TorStrings.torConnect.tryBridge;
    }
    this.setProgress(error, false);
    this.hideButtons();
    if (!locations || !locations.length) {
      RPMSendQuery("torconnect:get-country-codes").then(codes => {
        if (codes && codes.length) {
          this.populateSpecialLocations(codes);
        }
      });
    } else {
      this.populateSpecialLocations(locations);
    }
    this.validateLocation();
    this.show(this.elements.locationDropdownLabel);
    this.show(this.elements.locationDropdown);
    this.show(this.elements.tryAgainButton, true);
  }

  showFinalError(state) {
    this.setTitle(TorStrings.torConnect.finalError, "error");
    this.setLongText(TorStrings.torConnect.finalErrorDescription);
    this.setProgress(state ? state.ErrorDetails : "", false);
    this.hideButtons();
    this.show(this.elements.restartButton);
    this.show(this.elements.configureButton);
    this.show(this.elements.connectButton, true);
  }

  initElements(direction) {
    document.documentElement.setAttribute("dir", direction);

    this.elements.connectionAssistLink.addEventListener("click", event => {
      if (!this.elements.connectionAssistLink.classList.contains("disabled")) {
        this.showConnectionAssistant();
      }
    });
    this.elements.connectionAssistLabel.textContent =
      TorStrings.torConnect.breadcrumbAssist;
    this.elements.locationSettingsLink.addEventListener("click", event => {
      if (!this.elements.connectionAssistLink.classList.contains("disabled")) {
        this.showLocationSettings();
      }
    });
    this.elements.locationSettingsLabel.textContent =
      TorStrings.torConnect.breadcrumbLocation;
    this.elements.tryBridgeLabel.textContent =
      TorStrings.torConnect.breadcrumbTryBridge;

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
      this.validateLocation();
    });

    this.elements.tryBridgeButton.textContent = TorStrings.torConnect.tryBridge;
    this.elements.tryBridgeButton.addEventListener("click", () => {
      this.beginAutoBootstrap();
    });

    this.elements.locationDropdownLabel.textContent =
      TorStrings.torConnect.yourLocation;

    this.elements.tryAgainButton.textContent = TorStrings.torConnect.tryAgain;
    this.elements.tryAgainButton.setAttribute("disabled", "disabled");
    this.elements.tryAgainButton.addEventListener("click", () => {
      let selectedIndex = this.elements.locationDropdownSelect.selectedIndex;
      let selectedOption = this.elements.locationDropdownSelect.options[
        selectedIndex
      ];

      this.beginAutoBootstrap(selectedOption.value);
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
    TorCensorshipLevel = Object.freeze(args.TorCensorshipLevel);
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
