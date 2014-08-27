// # Test for TB4: Tor Browser's Firefox preference overrides
// This is a minimal test to check whether the 000-tor-browser.js
// pref overrides are being used at all or not. More comprehensive
// pref tests are maintained in the tor-browser-bundle-testsuite project.

function test() {

let expectedPrefs = [
   // Homepage
   ["browser.startup.homepage", "about:tor"],

   // Disable the "Refresh" prompt that is displayed for stale profiles.
   ["browser.disableResetPrompt", true],
  ];

let getPref = function (prefName) {
  let type = Services.prefs.getPrefType(prefName);
  if (type === Services.prefs.PREF_INT) return Services.prefs.getIntPref(prefName);
  if (type === Services.prefs.PREF_BOOL) return Services.prefs.getBoolPref(prefName);
  if (type === Services.prefs.PREF_STRING) return Services.prefs.getCharPref(prefName);
  // Something went wrong.
  throw new Error("Can't access pref " + prefName);
};

let testPref = function([key, expectedValue]) {
  let foundValue = getPref(key);
  is(foundValue, expectedValue, "Pref '" + key + "' should be '" + expectedValue +"'.");
};  

expectedPrefs.map(testPref);

} // end function test()
