"use strict";

/* global AppConstants, Services, openPreferences, XPCOMUtils */

ChromeUtils.import("resource://gre/modules/XPCOMUtils.jsm");
ChromeUtils.import("resource://gre/modules/Services.jsm");

XPCOMUtils.defineLazyModuleGetters(this, {
  CustomizableUI: "resource:///modules/CustomizableUI.jsm",
  PanelMultiView: "resource:///modules/PanelMultiView.jsm",
});

const SecurityLevels = Object.freeze(["", "safest", "safer", "", "standard"]);

/*
  Security Level Prefs

  Getters and Setters for relevant torbutton prefs
*/
const SecurityLevelPrefs = {
  security_slider_pref: "extensions.torbutton.security_slider",
  security_custom_pref: "extensions.torbutton.security_custom",

  get securitySlider() {
    try {
      return Services.prefs.getIntPref(this.security_slider_pref);
    } catch (e) {
      // init pref to 4 (standard)
      const val = 4;
      Services.prefs.setIntPref(this.security_slider_pref, val);
      return val;
    }
  },

  set securitySlider(val) {
    Services.prefs.setIntPref(this.security_slider_pref, val);
  },

  get securitySliderLevel() {
    const slider = this.securitySlider;
    if (slider >= 1 && slider <= 4 && SecurityLevels[slider]) {
      return SecurityLevels[slider];
    }
    return null;
  },

  get securityCustom() {
    try {
      return Services.prefs.getBoolPref(this.security_custom_pref);
    } catch (e) {
      // init custom to false
      const val = false;
      Services.prefs.setBoolPref(this.security_custom_pref, val);
      return val;
    }
  },

  set securityCustom(val) {
    Services.prefs.setBoolPref(this.security_custom_pref, val);
  },
}; /* Security Level Prefs */

/*
  Security Level Button Code

  Controls init and update of the security level toolbar button
*/

const SecurityLevelButton = {
  _securityPrefsBranch: null,

  _configUIFromPrefs(securityLevelButton) {
    if (securityLevelButton != null) {
      const level = SecurityLevelPrefs.securitySliderLevel;
      if (!level) {
        return;
      }
      const customStr = SecurityLevelPrefs.securityCustom ? "_custom" : "";
      securityLevelButton.setAttribute("level", `${level}${customStr}`);
      document.l10n.setAttributes(
        securityLevelButton,
        `security-level-button-${level}`
      );
    }
  },

  get button() {
    let button = document.getElementById("security-level-button");
    if (!button) {
      return null;
    }
    return button;
  },

  get anchor() {
    let anchor = this.button.icon;
    if (!anchor) {
      return null;
    }

    anchor.setAttribute("consumeanchor", SecurityLevelButton.button.id);
    return anchor;
  },

  init() {
    // set the initial class based off of the current pref
    let button = this.button;
    this._configUIFromPrefs(button);

    this._securityPrefsBranch = Services.prefs.getBranch(
      "extensions.torbutton."
    );
    this._securityPrefsBranch.addObserver("", this);

    CustomizableUI.addListener(this);

    SecurityLevelPanel.init();
  },

  uninit() {
    CustomizableUI.removeListener(this);

    this._securityPrefsBranch.removeObserver("", this);
    this._securityPrefsBranch = null;

    SecurityLevelPanel.uninit();
  },

  observe(subject, topic, data) {
    switch (topic) {
      case "nsPref:changed":
        if (data === "security_slider" || data === "security_custom") {
          this._configUIFromPrefs(this.button);
        }
        break;
    }
  },

  // callback for entering the 'Customize Firefox' screen to set icon
  onCustomizeStart(window) {
    let navigatorToolbox = document.getElementById("navigator-toolbox");
    let button = navigatorToolbox.palette.querySelector(
      "#security-level-button"
    );
    this._configUIFromPrefs(button);
  },

  // callback when CustomizableUI modifies DOM
  onWidgetAfterDOMChange(aNode, aNextNode, aContainer, aWasRemoval) {
    if (aNode.id == "security-level-button" && !aWasRemoval) {
      this._configUIFromPrefs(aNode);
    }
  },

  // for when the toolbar button needs to be activated and displays the Security Level panel
  //
  // In the toolbarbutton xul you'll notice we register this callback for both onkeypress and
  // onmousedown. We do this to match the behavior of other panel spawning buttons such as Downloads,
  // Library, and the Hamburger menus. Using oncommand alone would result in only getting fired
  // after onclick, which is mousedown followed by mouseup.
  onCommand(aEvent) {
    // snippet borrowed from /browser/components/downloads/content/indicator.js DownloadsIndicatorView.onCommand(evt)
    if (
      // On Mac, ctrl-click will send a context menu event from the widget, so
      // we don't want to bring up the panel when ctrl key is pressed.
      (aEvent.type == "mousedown" &&
        (aEvent.button != 0 ||
          (AppConstants.platform == "macosx" && aEvent.ctrlKey))) ||
      (aEvent.type == "keypress" && aEvent.key != " " && aEvent.key != "Enter")
    ) {
      return;
    }

    // we need to set this attribute for the button to be shaded correctly to look like it is pressed
    // while the security level panel is open
    this.button.setAttribute("open", "true");
    SecurityLevelPanel.show();
    aEvent.stopPropagation();
  },
}; /* Security Level Button */

/*
  Security Level Panel Code

  Controls init and update of the panel in the security level hanger
*/

const SecurityLevelPanel = {
  _securityPrefsBranch: null,
  _panel: null,
  _anchor: null,
  _populated: false,

  _selectors: Object.freeze({
    panel: "panel#securityLevel-panel",
    icon: "vbox#securityLevel-vbox>vbox",
    labelLevel: "label#securityLevel-level",
    labelCustom: "label#securityLevel-custom",
    summary: "description#securityLevel-summary",
    restoreDefaults: "button#securityLevel-restoreDefaults",
    advancedSecuritySettings: "button#securityLevel-advancedSecuritySettings",
  }),

  _populateXUL() {
    let selectors = this._selectors;

    this._elements = {
      panel: document.querySelector(selectors.panel),
      icon: document.querySelector(selectors.icon),
      labelLevel: document.querySelector(selectors.labelLevel),
      labelCustom: document.querySelector(selectors.labelCustom),
      summaryDescription: document.querySelector(selectors.summary),
      restoreDefaultsButton: document.querySelector(selectors.restoreDefaults),
      advancedSecuritySettings: document.querySelector(
        selectors.advancedSecuritySettings
      ),
    };
    this._elements.panel.addEventListener("onpopupshown", e => {
      this.onPopupShown(e);
    });
    this._elements.panel.addEventListener("onpopuphidden", e => {
      this.onPopupHidden(e);
    });
    this._elements.restoreDefaultsButton.addEventListener("command", () => {
      this.restoreDefaults();
    });
    this._elements.advancedSecuritySettings.addEventListener("command", () => {
      this.openAdvancedSecuritySettings();
    });
    this._configUIFromPrefs();
    this._populated = true;
  },

  _configUIFromPrefs() {
    // get security prefs
    const level = SecurityLevelPrefs.securitySliderLevel;
    const custom = SecurityLevelPrefs.securityCustom;

    // only visible when user is using custom settings
    let labelCustomWarning = this._elements.labelCustom;
    labelCustomWarning.hidden = !custom;
    let buttonRestoreDefaults = this._elements.restoreDefaultsButton;
    buttonRestoreDefaults.hidden = !custom;

    const summary = this._elements.summaryDescription;
    // Descriptions change based on security level
    if (level) {
      this._elements.icon.setAttribute("level", level);
      document.l10n.setAttributes(
        this._elements.labelLevel,
        `security-level-${level}-label`
      );
      document.l10n.setAttributes(summary, `security-level-${level}-summary`);
    }
    // override the summary text with custom warning
    if (custom) {
      document.l10n.setAttributes(summary, "security-level-custom-summary");
    }
  },

  init() {
    this._securityPrefsBranch = Services.prefs.getBranch(
      "extensions.torbutton."
    );
    this._securityPrefsBranch.addObserver("", this);
  },

  uninit() {
    this._securityPrefsBranch.removeObserver("", this);
    this._securityPrefsBranch = null;
  },

  show() {
    // we have to defer this until after the browser has finished init'ing
    // before we can populate the panel
    if (!this._populated) {
      this._populateXUL();
    }

    this._elements.panel.hidden = false;
    PanelMultiView.openPopup(
      this._elements.panel,
      SecurityLevelButton.anchor,
      "bottomcenter topright",
      0,
      0,
      false,
      null
    ).catch(Cu.reportError);
  },

  hide() {
    PanelMultiView.hidePopup(this._elements.panel);
  },

  restoreDefaults() {
    SecurityLevelPrefs.securityCustom = false;
    // hide and reshow so that layout re-renders properly
    this.hide();
    this.show(this._anchor);
  },

  openAdvancedSecuritySettings() {
    openPreferences("privacy-securitylevel");
    this.hide();
  },

  // callback when prefs change
  observe(subject, topic, data) {
    switch (topic) {
      case "nsPref:changed":
        if (data == "security_slider" || data == "security_custom") {
          this._configUIFromPrefs();
        }
        break;
    }
  },

  // callback when the panel is displayed
  onPopupShown(event) {
    SecurityLevelButton.button.setAttribute("open", "true");
  },

  // callback when the panel is hidden
  onPopupHidden(event) {
    SecurityLevelButton.button.removeAttribute("open");
  },
}; /* Security Level Panel */

/*
  Security Level Preferences Code

  Code to handle init and update of security level section in about:preferences#privacy
*/

const SecurityLevelPreferences = {
  _securityPrefsBranch: null,

  _populateXUL() {
    const groupbox = document.querySelector("#securityLevel-groupbox");
    const radiogroup = groupbox.querySelector("#securityLevel-radiogroup");
    radiogroup.addEventListener(
      "command",
      SecurityLevelPreferences.selectSecurityLevel
    );

    const populateRadioElements = vboxQuery => {
      const vbox = groupbox.querySelector(vboxQuery);
      const labelRestoreDefaults = vbox.querySelector(
        ".securityLevel-restoreDefaults"
      );
      labelRestoreDefaults.addEventListener(
        "click",
        SecurityLevelPreferences.restoreDefaults
      );
    };
    populateRadioElements("#securityLevel-vbox-standard");
    populateRadioElements("#securityLevel-vbox-safer");
    populateRadioElements("#securityLevel-vbox-safest");
  },

  _configUIFromPrefs() {
    // read our prefs
    const securitySlider = SecurityLevelPrefs.securitySlider;
    const securityCustom = SecurityLevelPrefs.securityCustom;

    // get our elements
    const groupbox = document.querySelector("#securityLevel-groupbox");
    let radiogroup = groupbox.querySelector("#securityLevel-radiogroup");
    let labelStandardCustom = groupbox.querySelector(
      "#securityLevel-vbox-standard label.securityLevel-customWarning"
    );
    let labelSaferCustom = groupbox.querySelector(
      "#securityLevel-vbox-safer label.securityLevel-customWarning"
    );
    let labelSafestCustom = groupbox.querySelector(
      "#securityLevel-vbox-safest label.securityLevel-customWarning"
    );
    let labelStandardRestoreDefaults = groupbox.querySelector(
      "#securityLevel-vbox-standard label.securityLevel-restoreDefaults"
    );
    let labelSaferRestoreDefaults = groupbox.querySelector(
      "#securityLevel-vbox-safer label.securityLevel-restoreDefaults"
    );
    let labelSafestRestoreDefaults = groupbox.querySelector(
      "#securityLevel-vbox-safest label.securityLevel-restoreDefaults"
    );

    // hide custom label by default until we know which level we're at
    labelStandardCustom.hidden = true;
    labelSaferCustom.hidden = true;
    labelSafestCustom.hidden = true;

    labelStandardRestoreDefaults.hidden = true;
    labelSaferRestoreDefaults.hidden = true;
    labelSafestRestoreDefaults.hidden = true;

    switch (securitySlider) {
      // standard
      case 4:
        radiogroup.value = "standard";
        labelStandardCustom.hidden = !securityCustom;
        labelStandardRestoreDefaults.hidden = !securityCustom;
        break;
      // safer
      case 2:
        radiogroup.value = "safer";
        labelSaferCustom.hidden = !securityCustom;
        labelSaferRestoreDefaults.hidden = !securityCustom;
        break;
      // safest
      case 1:
        radiogroup.value = "safest";
        labelSafestCustom.hidden = !securityCustom;
        labelSafestRestoreDefaults.hidden = !securityCustom;
        break;
    }
  },

  init() {
    // populate XUL with localized strings
    this._populateXUL();

    // read prefs and populate UI
    this._configUIFromPrefs();

    // register for pref chagnes
    this._securityPrefsBranch = Services.prefs.getBranch(
      "extensions.torbutton."
    );
    this._securityPrefsBranch.addObserver("", this);
  },

  uninit() {
    // unregister for pref change events
    this._securityPrefsBranch.removeObserver("", this);
    this._securityPrefsBranch = null;
  },

  // callback for when prefs change
  observe(subject, topic, data) {
    switch (topic) {
      case "nsPref:changed":
        if (data == "security_slider" || data == "security_custom") {
          this._configUIFromPrefs();
        }
        break;
    }
  },

  selectSecurityLevel() {
    // radio group elements
    let radiogroup = document.getElementById("securityLevel-radiogroup");

    // update pref based on selected radio option
    switch (radiogroup.value) {
      case "standard":
        SecurityLevelPrefs.securitySlider = 4;
        break;
      case "safer":
        SecurityLevelPrefs.securitySlider = 2;
        break;
      case "safest":
        SecurityLevelPrefs.securitySlider = 1;
        break;
    }

    SecurityLevelPreferences.restoreDefaults();
  },

  restoreDefaults() {
    SecurityLevelPrefs.securityCustom = false;
  },
}; /* Security Level Prefereces */

Object.defineProperty(this, "SecurityLevelButton", {
  value: SecurityLevelButton,
  enumerable: true,
  writable: false,
});

Object.defineProperty(this, "SecurityLevelPanel", {
  value: SecurityLevelPanel,
  enumerable: true,
  writable: false,
});

Object.defineProperty(this, "SecurityLevelPreferences", {
  value: SecurityLevelPreferences,
  enumerable: true,
  writable: false,
});
