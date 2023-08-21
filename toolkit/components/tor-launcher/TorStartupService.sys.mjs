const lazy = {};

// We will use the modules only when the profile is loaded, so prefer lazy
// loading
ChromeUtils.defineESModuleGetters(lazy, {
  TorConnect: "resource:///modules/TorConnect.sys.mjs",
  TorLauncherUtil: "resource://gre/modules/TorLauncherUtil.sys.mjs",
  TorProviderBuilder: "resource://gre/modules/TorProviderBuilder.sys.mjs",
  TorSettings: "resource:///modules/TorSettings.sys.mjs",
});

ChromeUtils.defineModuleGetter(
  lazy,
  "TorDomainIsolator",
  "resource://gre/modules/TorDomainIsolator.jsm"
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
  observe(aSubject, aTopic, aData) {
    if (aTopic === BrowserTopics.ProfileAfterChange && !gInited) {
      this.#init();
    } else if (aTopic === BrowserTopics.QuitApplicationGranted) {
      this.#uninit();
    }
  }

  async #init() {
    Services.obs.addObserver(this, BrowserTopics.QuitApplicationGranted);

    await lazy.TorProviderBuilder.init();

    lazy.TorSettings.init();
    lazy.TorConnect.init();

    lazy.TorDomainIsolator.init();

    gInited = true;
  }

  #uninit() {
    Services.obs.removeObserver(this, BrowserTopics.QuitApplicationGranted);

    lazy.TorDomainIsolator.uninit();

    lazy.TorProviderBuilder.uninit();
    lazy.TorLauncherUtil.cleanupTempDirectories();
  }
}
