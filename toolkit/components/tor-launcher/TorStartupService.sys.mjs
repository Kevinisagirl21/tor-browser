const lazy = {};

// We will use the modules only when the profile is loaded, so prefer lazy
// loading
ChromeUtils.defineESModuleGetters(lazy, {
  TorDomainIsolator: "resource://gre/modules/TorDomainIsolator.sys.mjs",
  TorLauncherUtil: "resource://gre/modules/TorLauncherUtil.sys.mjs",
  TorMonitorService: "resource://gre/modules/TorMonitorService.sys.mjs",
  TorProtocolService: "resource://gre/modules/TorProtocolService.sys.mjs",
});

ChromeUtils.defineModuleGetter(
  lazy,
  "TorConnect",
  "resource:///modules/TorConnect.jsm"
);
ChromeUtils.defineModuleGetter(
  lazy,
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
export class TorStartupService {
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
    await lazy.TorProtocolService.init();
    lazy.TorMonitorService.init();

    lazy.TorSettings.init();
    lazy.TorConnect.init();

    lazy.TorDomainIsolator.init();

    gInited = true;
  }

  _uninit() {
    Services.obs.removeObserver(this, BrowserTopics.QuitApplicationGranted);

    lazy.TorDomainIsolator.uninit();

    // Close any helper connection first...
    lazy.TorProtocolService.uninit();
    // ... and only then closes the event monitor connection, which will cause
    // Tor to stop.
    lazy.TorMonitorService.uninit();

    lazy.TorLauncherUtil.cleanupTempDirectories();
  }
}
