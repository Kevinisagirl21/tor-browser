"use strict";

ChromeUtils.import("resource://gre/modules/XPCOMUtils.jsm");
ChromeUtils.import("resource://gre/modules/Services.jsm");

XPCOMUtils.defineLazyModuleGetters(this, {
  CustomizableUI: "resource:///modules/CustomizableUI.jsm",
  PanelMultiView: "resource:///modules/PanelMultiView.jsm",
});

ChromeUtils.defineModuleGetter(
  this,
  "TorStrings",
  "resource:///modules/TorStrings.jsm"
);

/*
  Security Level Prefs

  Getters and Setters for relevant torbutton prefs
*/
const SecurityLevelPrefs = {
  security_slider_pref : "extensions.torbutton.security_slider",
  security_custom_pref : "extensions.torbutton.security_custom",

  get securitySlider() {
    try {
      return Services.prefs.getIntPref(this.security_slider_pref);
    } catch(e) {
      // init pref to 4 (standard)
      const val = 4;
      Services.prefs.setIntPref(this.security_slider_pref, val);
      return val;
    }
  },

  set securitySlider(val) {
    Services.prefs.setIntPref(this.security_slider_pref, val);
  },

  get securityCustom() {
    try {
      return Services.prefs.getBoolPref(this.security_custom_pref);
    } catch(e) {
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
  _securityPrefsBranch : null,

  _populateXUL : function(securityLevelButton) {
    if (securityLevelButton != null) {
      securityLevelButton.setAttribute("tooltiptext", TorStrings.securityLevel.securityLevel);
      securityLevelButton.setAttribute("label", TorStrings.securityLevel.securityLevel);
    }
  },

  _configUIFromPrefs : function(securityLevelButton) {
    if (securityLevelButton != null) {
      let securitySlider = SecurityLevelPrefs.securitySlider;
      securityLevelButton.removeAttribute("level");
      const securityCustom = SecurityLevelPrefs.securityCustom;
      switch(securitySlider) {
        case 4:
          securityLevelButton.setAttribute("level", `standard${securityCustom ? "_custom" : ""}`);
          securityLevelButton.setAttribute("tooltiptext", TorStrings.securityLevel.standard.tooltip);
          break;
        case 2:
          securityLevelButton.setAttribute("level", `safer${securityCustom ? "_custom" : ""}`);
          securityLevelButton.setAttribute("tooltiptext", TorStrings.securityLevel.safer.tooltip);
          break;
        case 1:
          securityLevelButton.setAttribute("level", `safest${securityCustom ? "_custom" : ""}`);
          securityLevelButton.setAttribute("tooltiptext", TorStrings.securityLevel.safest.tooltip);
          break;
      }
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

  init : function() {
    // set the initial class based off of the current pref
    let button = this.button;
    this._populateXUL(button);
    this._configUIFromPrefs(button);

    this._securityPrefsBranch = Services.prefs.getBranch("extensions.torbutton.");
    this._securityPrefsBranch.addObserver("", this, false);

    CustomizableUI.addListener(this);

    SecurityLevelPanel.init();
  },

  uninit : function() {
    CustomizableUI.removeListener(this);

    this._securityPrefsBranch.removeObserver("", this);
    this._securityPrefsBranch = null;

    SecurityLevelPanel.uninit();
  },

  observe : function(subject, topic, data) {
    switch(topic) {
      case "nsPref:changed":
        if (data === "security_slider" || data === "security_custom") {
          this._configUIFromPrefs(this.button);
        }
        break;
    }
  },

  // callback for entering the 'Customize Firefox' screen to set icon
  onCustomizeStart : function(window) {
    let navigatorToolbox = document.getElementById("navigator-toolbox");
    let button = navigatorToolbox.palette.querySelector("#security-level-button");
    this._populateXUL(button);
    this._configUIFromPrefs(button);
  },

  // callback when CustomizableUI modifies DOM
  onWidgetAfterDOMChange : function(aNode, aNextNode, aContainer, aWasRemoval) {
    if (aNode.id == "security-level-button" && !aWasRemoval) {
      this._populateXUL(aNode);
      this._configUIFromPrefs(aNode);
    }
  },

  // for when the toolbar button needs to be activated and displays the Security Level panel
  //
  // In the toolbarbutton xul you'll notice we register this callback for both onkeypress and
  // onmousedown. We do this to match the behavior of other panel spawning buttons such as Downloads,
  // Library, and the Hamburger menus. Using oncommand alone would result in only getting fired
  // after onclick, which is mousedown followed by mouseup.
  onCommand : function(aEvent) {
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
  _securityPrefsBranch : null,
  _panel : null,
  _anchor : null,
  _populated : false,

  _selectors: Object.freeze({
    panel: "panel#securityLevel-panel",
    icon: "vbox#securityLevel-vbox>vbox",
    header: "h1#securityLevel-header",
    level: "label#securityLevel-level",
    custom: "label#securityLevel-custom",
    summary: "description#securityLevel-summary",
    learnMore: "label#securityLevel-learnMore",
    restoreDefaults: "button#securityLevel-restoreDefaults",
    advancedSecuritySettings: "button#securityLevel-advancedSecuritySettings",
  }),

  _populateXUL : function() {
    let selectors = this._selectors;

    this._elements = {
      panel: document.querySelector(selectors.panel),
      icon: document.querySelector(selectors.icon),
      header: document.querySelector(selectors.header),
      levelLabel: document.querySelector(selectors.level),
      customLabel: document.querySelector(selectors.custom),
      summaryDescription: document.querySelector(selectors.summary),
      learnMoreLabel: document.querySelector(selectors.learnMore),
      restoreDefaultsButton: document.querySelector(selectors.restoreDefaults),
      changeButton: document.querySelector(selectors.advancedSecuritySettings),
    };
    let elements = this._elements;

    elements.header.textContent = TorStrings.securityLevel.securityLevel;
    elements.customLabel.setAttribute("value", TorStrings.securityLevel.customWarning);
    elements.learnMoreLabel.setAttribute("value", TorStrings.securityLevel.learnMore);
    elements.learnMoreLabel.setAttribute("href", TorStrings.securityLevel.learnMoreURL);
    elements.restoreDefaultsButton.setAttribute("label", TorStrings.securityLevel.restoreDefaults);
    elements.changeButton.setAttribute("label", TorStrings.securityLevel.change);

    this._configUIFromPrefs();
    this._populated = true;
  },

  _configUIFromPrefs : function() {
    // get security prefs
    let securitySlider = SecurityLevelPrefs.securitySlider;
    let securityCustom = SecurityLevelPrefs.securityCustom;

    // get the panel elements we need to populate
    let elements = this._elements;
    let icon = elements.icon;
    let labelLevel = elements.levelLabel;
    let labelCustomWarning = elements.customLabel;
    let summary = elements.summaryDescription;
    let buttonRestoreDefaults = elements.restoreDefaultsButton;
    let buttonAdvancedSecuritySettings = elements.changeButton;

    // only visible when user is using custom settings
    labelCustomWarning.hidden = !securityCustom;
    buttonRestoreDefaults.hidden = !securityCustom;

    // Descriptions change based on security level
    switch(securitySlider) {
      // standard
      case 4:
        icon.setAttribute("level", "standard");
        labelLevel.setAttribute("value", TorStrings.securityLevel.standard.level);
        summary.textContent = TorStrings.securityLevel.standard.summary;
        break;
      // safer
      case 2:
        icon.setAttribute("level", "safer");
        labelLevel.setAttribute("value", TorStrings.securityLevel.safer.level);
        summary.textContent = TorStrings.securityLevel.safer.summary;
        break;
      // safest
      case 1:
        icon.setAttribute("level", "safest");
        labelLevel.setAttribute("value", TorStrings.securityLevel.safest.level);
        summary.textContent = TorStrings.securityLevel.safest.summary;
        break;
    }

    // override the summary text with custom warning
    if (securityCustom) {
      summary.textContent = TorStrings.securityLevel.custom.summary;
    }
  },

  init : function() {
    this._securityPrefsBranch = Services.prefs.getBranch("extensions.torbutton.");
    this._securityPrefsBranch.addObserver("", this, false);
  },

  uninit : function() {
    this._securityPrefsBranch.removeObserver("", this);
    this._securityPrefsBranch = null;
  },

  show : function() {
    // we have to defer this until after the browser has finished init'ing before
    // we can populate the panel
    if (!this._populated) {
      this._populateXUL();
    }

    let panel = document.getElementById("securityLevel-panel");
    panel.hidden = false;
    PanelMultiView.openPopup(panel, SecurityLevelButton.anchor, "bottomcenter topright",
                             0, 0, false, null).catch(Cu.reportError);
  },

  hide : function() {
    let panel = document.getElementById("securityLevel-panel");
    PanelMultiView.hidePopup(panel);
  },

  restoreDefaults : function() {
    SecurityLevelPrefs.securityCustom = false;
    // hide and reshow so that layout re-renders properly
    this.hide();
    this.show(this._anchor);
  },

  openAdvancedSecuritySettings : function() {
    openPreferences("privacy-securitylevel");
    this.hide();
  },

  // callback when prefs change
  observe : function(subject, topic, data) {
    switch(topic) {
      case "nsPref:changed":
        if (data == "security_slider" || data == "security_custom") {
          this._configUIFromPrefs();
        }
        break;
    }
  },

  // callback when the panel is displayed
  onPopupShown : function(event) {
    SecurityLevelButton.button.setAttribute("open", "true");
  },

  // callback when the panel is hidden
  onPopupHidden : function(event) {
    SecurityLevelButton.button.removeAttribute("open");
  }
}; /* Security Level Panel */

/*
  Security Level Preferences Code

  Code to handle init and update of security level section in about:preferences#privacy
*/

const SecurityLevelPreferences =
{
  _securityPrefsBranch : null,

  _populateXUL : function() {
    let groupbox = document.getElementById("securityLevel-groupbox");

    let labelHeader = groupbox.querySelector("#securityLevel-header");
    labelHeader.textContent = TorStrings.securityLevel.securityLevel;

    let spanOverview = groupbox.querySelector("#securityLevel-overview");
    spanOverview.textContent = TorStrings.securityLevel.overview;

    let labelLearnMore = groupbox.querySelector("#securityLevel-learnMore");
    labelLearnMore.setAttribute("value", TorStrings.securityLevel.learnMore);
    labelLearnMore.setAttribute("href", TorStrings.securityLevel.learnMoreURL);

    let radiogroup =  document.getElementById("securityLevel-radiogroup");
    radiogroup.addEventListener("command", SecurityLevelPreferences.selectSecurityLevel);

    let populateRadioElements = function(vboxQuery, stringStruct) {
      let vbox = groupbox.querySelector(vboxQuery);

      let radio = vbox.querySelector("radio");
      radio.setAttribute("label", stringStruct.level);

      let customWarning = vbox.querySelector("#securityLevel-customWarning");
      customWarning.setAttribute("value", TorStrings.securityLevel.customWarning);

      let labelSummary = vbox.querySelector("#securityLevel-summary");
      labelSummary.textContent = stringStruct.summary;

      let labelRestoreDefaults = vbox.querySelector("#securityLevel-restoreDefaults");
      labelRestoreDefaults.setAttribute("value", TorStrings.securityLevel.restoreDefaults);
      labelRestoreDefaults.addEventListener("click",  SecurityLevelPreferences.restoreDefaults);

      let description1 = vbox.querySelector("#securityLevel-description1");
      if (description1) {
        description1.textContent = stringStruct.description1;
      }
      let description2 = vbox.querySelector("#securityLevel-description2");
      if (description2) {
        description2.textContent = stringStruct.description2;
      }
      let description3 = vbox.querySelector("#securityLevel-description3");
      if (description3) {
        description3.textContent = stringStruct.description3;
      }
    };

    populateRadioElements("#securityLevel-vbox-standard", TorStrings.securityLevel.standard);
    populateRadioElements("#securityLevel-vbox-safer", TorStrings.securityLevel.safer);
    populateRadioElements("#securityLevel-vbox-safest", TorStrings.securityLevel.safest);
  },

  _configUIFromPrefs : function() {
    // read our prefs
    let securitySlider = SecurityLevelPrefs.securitySlider;
    let securityCustom = SecurityLevelPrefs.securityCustom;

    // get our elements
    let groupbox = document.getElementById("securityLevel-groupbox");

    let radiogroup =  groupbox.querySelector("#securityLevel-radiogroup");
    let labelStandardCustom = groupbox.querySelector("#securityLevel-vbox-standard label#securityLevel-customWarning");
    let labelSaferCustom = groupbox.querySelector("#securityLevel-vbox-safer label#securityLevel-customWarning");
    let labelSafestCustom = groupbox.querySelector("#securityLevel-vbox-safest label#securityLevel-customWarning");
    let labelStandardRestoreDefaults = groupbox.querySelector("#securityLevel-vbox-standard label#securityLevel-restoreDefaults");
    let labelSaferRestoreDefaults = groupbox.querySelector("#securityLevel-vbox-safer label#securityLevel-restoreDefaults");
    let labelSafestRestoreDefaults = groupbox.querySelector("#securityLevel-vbox-safest label#securityLevel-restoreDefaults");

    // hide custom label by default until we know which level we're at
    labelStandardCustom.hidden = true;
    labelSaferCustom.hidden = true;
    labelSafestCustom.hidden = true;

    labelStandardRestoreDefaults.hidden = true;
    labelSaferRestoreDefaults.hidden = true;
    labelSafestRestoreDefaults.hidden = true;

    switch(securitySlider) {
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

  init : function() {
    // populate XUL with localized strings
    this._populateXUL();

    // read prefs and populate UI
    this._configUIFromPrefs();

    // register for pref chagnes
    this._securityPrefsBranch = Services.prefs.getBranch("extensions.torbutton.");
    this._securityPrefsBranch.addObserver("", this, false);
  },

  uninit : function() {
    // unregister for pref change events
    this._securityPrefsBranch.removeObserver("", this);
    this._securityPrefsBranch = null;
  },

  // callback for when prefs change
  observe : function(subject, topic, data) {
    switch(topic) {
      case "nsPref:changed":
        if (data == "security_slider" ||
            data == "security_custom") {
          this._configUIFromPrefs();
        }
        break;
    }
  },

  selectSecurityLevel : function() {
    // radio group elements
    let radiogroup =  document.getElementById("securityLevel-radiogroup");

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

  restoreDefaults : function() {
    SecurityLevelPrefs.securityCustom = false;
  },
}; /* Security Level Prefereces */

Object.defineProperty(this, "SecurityLevelButton", {
  value: SecurityLevelButton,
  enumerable: true,
  writable: false
});

Object.defineProperty(this, "SecurityLevelPanel", {
  value: SecurityLevelPanel,
  enumerable: true,
  writable: false
});

Object.defineProperty(this, "SecurityLevelPreferences", {
  value: SecurityLevelPreferences,
  enumerable: true,
  writable: false
});
