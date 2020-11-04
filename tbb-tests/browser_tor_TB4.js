// # Test for TB4: Tor Browser's Firefox preference overrides
// Simple regression tests to check the value of each pref and
// decides if it is set as expected.

// TODO: Write unit tests to check that each pref setting here
// causes the browser to have the desired behavior (a big task).

function test() {

let expectedPrefs = [
   // Homepage
   ["browser.startup.homepage", "about:tor"],

   // Disable the "Refresh" prompt that is displayed for stale profiles.
   ["browser.disableResetPrompt", true],

   // Version placeholder
   ["torbrowser.version", "dev-build"],
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
