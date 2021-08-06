"use strict";

var EXPORTED_SYMBOLS = ["TorStartupService"];

const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");

// We will use the modules only when the profile is loaded, so prefer lazy
// loading
ChromeUtils.defineModuleGetter(
  this,
  "TorLauncherUtil",
  "resource://gre/modules/TorLauncherUtil.jsm"
);
ChromeUtils.defineModuleGetter(
  this,
  "TorMonitorService",
  "resource://gre/modules/TorMonitorService.jsm"
);
ChromeUtils.defineModuleGetter(
  this,
  "TorProtocolService",
  "resource://gre/modules/TorProtocolService.jsm"
);

ChromeUtils.defineModuleGetter(
  this,
  "TorConnect",
  "resource:///modules/TorConnect.jsm"
);
ChromeUtils.defineModuleGetter(
  this,
  "TorSettings",
  "resource:///modules/TorSettings.jsm"
);

/* Browser observer topis */
const BrowserTopics = Object.freeze({
  ProfileAfterChange: "profile-after-change",
  QuitApplicationGranted: "quit-application-granted",
});

let gInited = false;

// This class is registered as an observer, and will be instanced automatically
// by Firefox.
// When it observes profile-after-change, it initializes whatever is needed to
// launch Tor.
class TorStartupService {
  _defaultPreferencesAreLoaded = false;

  observe(aSubject, aTopic, aData) {
    if (aTopic === BrowserTopics.ProfileAfterChange && !gInited) {
      this._init();
    } else if (aTopic === BrowserTopics.QuitApplicationGranted) {
      this._uninit();
    }
  }

  async _init() {
    Services.obs.addObserver(this, BrowserTopics.QuitApplicationGranted);

    // Starts TorProtocolService first, because it configures the controller
    // factory, too.
    await TorProtocolService.init();
    TorMonitorService.init();

    TorSettings.init();
    TorConnect.init();

    gInited = true;
  }

  _uninit() {
    Services.obs.removeObserver(this, BrowserTopics.QuitApplicationGranted);

    // Close any helper connection first...
    TorProtocolService.uninit();
    // ... and only then closes the event monitor connection, which will cause
    // Tor to stop.
    TorMonitorService.uninit();

    TorLauncherUtil.cleanupTempDirectories();
  }
}
