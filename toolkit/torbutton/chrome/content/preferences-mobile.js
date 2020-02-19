// # Security Settings User Interface for Mobile

// Utilities
const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");
const {
  getBoolPref,
  getIntPref,
  setBoolPref,
  setIntPref,
  getCharPref,
} = Services.prefs;

// Description elements have the follow names.
const descNames = ["", "desc_standard", "desc_safer", "desc_safest"];
// "Learn-more"-elements have the follow names.
const linkNames = ["", "link_standard", "link_safer", "link_safest"];
// A single `state` object that reflects the user settings in this UI.

let state = { slider: 0, custom: false };

// Utility functions to convert between the legacy 4-value pref index
// and the 3-valued security slider.
let sliderPositionToPrefSetting = pos => [0, 4, 2, 1][pos];
let prefSettingToSliderPosition = pref => [0, 3, 2, 2, 1][pref];

// Set the desired slider value and update UI.
function torbutton_set_slider(sliderValue) {
  state.slider = sliderValue;
  let slider = document.getElementById("torbutton_sec_slider");
  slider.value = sliderValue.toString();
  let descs = descNames.map(name => document.getElementById(name));
  descs.forEach((desc, i) => {
    if (state.slider !== i) {
      desc.style.display = "none";
    } else {
      desc.style.display = "block";
    }
  });
  torbutton_save_security_settings();
}

// Read prefs 'browser.security_level.security_slider' and
// 'browser.security_level.security_custom', and initialize the UI.
function torbutton_init_security_ui() {
  torbutton_set_slider(
    prefSettingToSliderPosition(
      getIntPref("browser.security_level.security_slider")
    )
  );
}

// Write the two prefs from the current settings.
function torbutton_save_security_settings() {
  setIntPref(
    "browser.security_level.security_slider",
    sliderPositionToPrefSetting(state.slider)
  );
  setBoolPref("browser.security_level.security_custom", state.custom);
}
