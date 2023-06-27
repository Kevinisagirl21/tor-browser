// Bug 1506 P1-3: This code is mostly hackish remnants of session store
// support. There are a couple of observer events that *might* be worth
// listening to. Search for 1506 in the code.

/*************************************************************************
 * Startup observer (JavaScript XPCOM component)
 *
 * Cases tested (each during Tor and Non-Tor, FF4 and FF3.6)
 *    1. Crash
 *    2. Upgrade
 *    3. Fresh install
 *
 *************************************************************************/

var EXPORTED_SYMBOLS = ["StartupObserver"];

const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");
const { XPCOMUtils } = ChromeUtils.import(
  "resource://gre/modules/XPCOMUtils.jsm"
);

const { TorProtocolService } = ChromeUtils.import(
  "resource://gre/modules/TorProtocolService.jsm"
);

const lazy = {};

XPCOMUtils.defineLazyModuleGetters(lazy, {
  FileUtils: "resource://gre/modules/FileUtils.jsm",
});

function cleanupCookies() {
  const migratedPref = "extensions.torbutton.cookiejar_migrated";
  if (!Services.prefs.getBoolPref(migratedPref, false)) {
    // Cleanup stored cookie-jar-selector json files
    const profileFolder = Services.dirsvc.get("ProfD", Ci.nsIFile).clone();
    for (const file of profileFolder.directoryEntries) {
      if (file.leafName.match(/^(cookies|protected)-.*[.]json$/)) {
        try {
          file.remove(false);
        } catch (e) {}
      }
    }
    Services.prefs.setBoolPref(migratedPref, true);
  }
}

function StartupObserver() {
  this.logger = Cc["@torproject.org/torbutton-logger;1"].getService(
    Ci.nsISupports
  ).wrappedJSObject;
  this._prefs = Services.prefs;
  this.logger.log(3, "Startup Observer created");

  try {
    // XXX: We're in a race with HTTPS-Everywhere to update our proxy settings
    // before the initial SSL-Observatory test... If we lose the race, Firefox
    // caches the old proxy settings for check.tp.o somehwere, and it never loads :(
    this.setProxySettings();
  } catch (e) {
    this.logger.log(
      4,
      "Early proxy change failed. Will try again at profile load. Error: " + e
    );
  }

  cleanupCookies();
}

StartupObserver.prototype = {
  // Bug 6803: We need to get the env vars early due to
  // some weird proxy caching code that showed up in FF15.
  // Otherwise, homepage domain loads fail forever.
  setProxySettings() {
    // Bug 1506: Still want to get these env vars
    if (Services.env.exists("TOR_TRANSPROXY")) {
      this.logger.log(3, "Resetting Tor settings to transproxy");
      this._prefs.setBoolPref("network.proxy.socks_remote_dns", false);
      this._prefs.setIntPref("network.proxy.type", 0);
      this._prefs.setIntPref("network.proxy.socks_port", 0);
      this._prefs.setCharPref("network.proxy.socks", "");
    } else {
      // Try to retrieve SOCKS proxy settings from Tor Launcher.
      let socksPortInfo;
      try {
        socksPortInfo = TorProtocolService.torGetSOCKSPortInfo();
      } catch (e) {
        this.logger.log(3, "tor launcher failed " + e);
      }

      // If Tor Launcher is not available, check environment variables.
      if (!socksPortInfo) {
        socksPortInfo = { ipcFile: undefined, host: undefined, port: 0 };

        let isWindows = Services.appinfo.OS === "WINNT";
        if (!isWindows && Services.env.exists("TOR_SOCKS_IPC_PATH")) {
          socksPortInfo.ipcFile = new lazy.FileUtils.File(
            Services.env.get("TOR_SOCKS_IPC_PATH")
          );
        } else {
          if (Services.env.exists("TOR_SOCKS_HOST")) {
            socksPortInfo.host = Services.env.get("TOR_SOCKS_HOST");
          }
          if (Services.env.exists("TOR_SOCKS_PORT")) {
            socksPortInfo.port = parseInt(Services.env.get("TOR_SOCKS_PORT"));
          }
        }
      }

      // Adjust network.proxy prefs.
      if (socksPortInfo.ipcFile) {
        let fph = Services.io
          .getProtocolHandler("file")
          .QueryInterface(Ci.nsIFileProtocolHandler);
        let fileURI = fph.newFileURI(socksPortInfo.ipcFile);
        this.logger.log(3, "Reset socks to " + fileURI.spec);
        this._prefs.setCharPref("network.proxy.socks", fileURI.spec);
        this._prefs.setIntPref("network.proxy.socks_port", 0);
      } else {
        if (socksPortInfo.host) {
          this._prefs.setCharPref("network.proxy.socks", socksPortInfo.host);
          this.logger.log(3, "Reset socks host to " + socksPortInfo.host);
        }
        if (socksPortInfo.port) {
          this._prefs.setIntPref(
            "network.proxy.socks_port",
            socksPortInfo.port
          );
          this.logger.log(3, "Reset socks port to " + socksPortInfo.port);
        }
      }

      if (socksPortInfo.ipcFile || socksPortInfo.host || socksPortInfo.port) {
        this._prefs.setBoolPref("network.proxy.socks_remote_dns", true);
        this._prefs.setIntPref("network.proxy.type", 1);
      }
    }

    // Force prefs to be synced to disk
    Services.prefs.savePrefFile(null);

    this.logger.log(3, "Synced network settings to environment.");
  },

  observe(subject, topic, data) {
    if (topic == "profile-after-change") {
      this.setProxySettings();
    }

    // In all cases, force prefs to be synced to disk
    Services.prefs.savePrefFile(null);
  },

  // Hack to get us registered early to observe recovery
  _xpcom_categories: [{ category: "profile-after-change" }],
};
