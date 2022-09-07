"use strict";

var EXPORTED_SYMBOLS = ["NewIdentityButton"];

/* globals CustomizableUI Services gFindBarInitialized gFindBar
   OpenBrowserWindow PrivateBrowsingUtils XPCOMUtils
 */

XPCOMUtils.defineLazyGetter(this, "NewIdentityStrings", () => {
  const brandBundle = Services.strings.createBundle(
    "chrome://branding/locale/brand.properties"
  );
  const brandShortName = brandBundle.GetStringFromName("brandShortName");

  let strings = {
    new_identity: "New Identity",
    new_identity_sentence_case: "New identity",
    new_identity_prompt: `${brandShortName} will close all windows and tabs. All website sessions will be lost. \nRestart ${brandShortName} now to reset your identity?`,
    new_identity_ask_again: "Never ask me again",
    new_identity_menu_accesskey: "I",
  };
  let bundle = null;
  try {
    bundle = Services.strings.createBundle(
      "chrome://newidentity/locale/newIdentity.properties"
    );
  } catch (e) {
    console.warn("Could not load the New Identity strings");
  }
  if (bundle) {
    for (const key of Object.keys(strings)) {
      try {
        strings[key] = bundle.GetStringFromName(key);
      } catch (e) {}
    }
    strings.new_identity_prompt = strings.new_identity_prompt.replaceAll(
      "%S",
      brandShortName
    );
  }
  return strings;
});

// Use a lazy getter because NewIdentityButton is declared more than once
// otherwise.
XPCOMUtils.defineLazyGetter(this, "NewIdentityButton", () => {
  // Logger adapted from CustomizableUI.jsm
  const logger = (() => {
    const { ConsoleAPI } = ChromeUtils.import(
      "resource://gre/modules/Console.jsm"
    );
    const consoleOptions = {
      maxLogLevel: "info",
      prefix: "NewIdentity",
    };
    return new ConsoleAPI(consoleOptions);
  })();

  const topics = Object.freeze({
    newIdentityRequested: "new-identity-requested",
  });

  class NewIdentityImpl {
    async run() {
      logger.debug("Disabling JS");
      this.disableAllJS();
      await this.clearState();
      this.broadcast();
      this.openNewWindow();
      this.closeOldWindow();
    }

    // Disable JS (as a defense-in-depth measure)

    disableAllJS() {
      logger.info("Disabling JavaScript");
      const enumerator = Services.wm.getEnumerator("navigator:browser");
      while (enumerator.hasMoreElements()) {
        const win = enumerator.getNext();
        this.disableWindowJS(win);
      }
    }

    disableWindowJS(win) {
      const browsers = win.gBrowser?.browsers || [];
      for (const browser of browsers) {
        if (!browser) {
          continue;
        }
        this.disableBrowserJS(browser);
        try {
          browser.webNavigation?.stop(browser.webNavigation.STOP_ALL);
        } catch (e) {
          logger.warn("Could not stop navigation", e, browser.currentURI);
        }
      }
    }

    disableBrowserJS(browser) {
      if (!browser) {
        return;
      }
      // Does the following still apply?
      // Solution from: https://bugzilla.mozilla.org/show_bug.cgi?id=409737
      // XXX: This kills the entire window. We need to redirect
      // focus and inform the user via a lightbox.
      const eventSuppressor = browser.contentWindow?.windowUtils;
      if (browser.browsingContext) {
        browser.browsingContext.allowJavascript = false;
      }
      try {
        // My estimation is that this does not get the inner iframe windows,
        // but that does not matter, because iframes should be destroyed
        // on the next load.
        // Should we log when browser.contentWindow is null?
        if (browser.contentWindow) {
          browser.contentWindow.name = null;
          browser.contentWindow.window.name = null;
        }
      } catch (e) {
        logger.warn("Failed to reset window.name", e);
      }
      eventSuppressor?.suppressEventHandling(true);
    }

    // Clear state

    async clearState() {
      logger.info("Clearing the state");
      this.closeTabs();
      this.clearSearchBar();
      this.clearPrivateSessionHistory();
      this.clearHTTPAuths();
      this.clearCryptoTokens();
      this.clearOCSPCache();
      this.clearSecuritySettings();
      this.clearImageCaches();
      this.clearStorage();
      this.clearPreferencesAndPermissions();
      await this.clearData();
      this.clearConnections();
      this.clearPrivateSession();
    }

    clearSiteSpecificZoom() {
      Services.prefs.setBoolPref(
        "browser.zoom.siteSpecific",
        !Services.prefs.getBoolPref("browser.zoom.siteSpecific")
      );
      Services.prefs.setBoolPref(
        "browser.zoom.siteSpecific",
        !Services.prefs.getBoolPref("browser.zoom.siteSpecific")
      );
    }

    closeTabs() {
      logger.info("Closing tabs");
      if (
        !Services.prefs.getBoolPref("extensions.torbutton.close_newnym", true)
      ) {
        logger.info("Not closing tabs");
        return;
      }
      // TODO: muck around with browser.tabs.warnOnClose.. maybe..
      logger.info("Closing tabs...");
      const enumerator = Services.wm.getEnumerator("navigator:browser");
      const windowsToClose = [];
      while (enumerator.hasMoreElements()) {
        const win = enumerator.getNext();
        const browser = win.gBrowser;
        if (!browser) {
          logger.warn("No browser for possible window to close");
          continue;
        }
        const tabsToRemove = [];
        for (const b of browser.browsers) {
          const tab = browser.getTabForBrowser(b);
          if (tab) {
            tabsToRemove.push(tab);
          } else {
            logger.warn("Browser has a null tab", b);
          }
        }
        if (win == window) {
          browser.addWebTab("about:blank");
        } else {
          // It is a bad idea to alter the window list while iterating
          // over it, so add this window to an array and close it later.
          windowsToClose.push(win);
        }
        // Close each tab except the new blank one that we created.
        tabsToRemove.forEach(aTab => browser.removeTab(aTab));
      }
      // Close all XUL windows except this one.
      logger.info("Closing windows...");
      windowsToClose.forEach(aWin => aWin.close());
      logger.info("Closed all tabs");

      // This clears the undo tab history.
      const tabs = Services.prefs.getIntPref(
        "browser.sessionstore.max_tabs_undo"
      );
      Services.prefs.setIntPref("browser.sessionstore.max_tabs_undo", 0);
      Services.prefs.setIntPref("browser.sessionstore.max_tabs_undo", tabs);
    }

    clearSearchBar() {
      logger.info("Clearing searchbox");
      // Bug #10800: Trying to clear search/find can cause exceptions
      // in unknown cases. Just log for now.
      try {
        const searchBar = window.document.getElementById("searchbar");
        if (searchBar) {
          searchBar.textbox.reset();
        }
      } catch (e) {
        logger.error("Exception on clearing search box", e);
      }
      try {
        if (gFindBarInitialized) {
          const findbox = gFindBar.getElement("findbar-textbox");
          findbox.reset();
          gFindBar.close();
        }
      } catch (e) {
        logger.error("Exception on clearing find bar", e);
      }
    }

    clearPrivateSessionHistory() {
      logger.info("Emitting Private Browsing Session clear event");
      Services.obs.notifyObservers(null, "browser:purge-session-history");
    }

    clearHTTPAuths() {
      if (
        !Services.prefs.getBoolPref(
          "extensions.torbutton.clear_http_auth",
          true
        )
      ) {
        logger.info("Skipping HTTP Auths, because disabled");
        return;
      }
      logger.info("Clearing HTTP Auths");
      const auth = Cc["@mozilla.org/network/http-auth-manager;1"].getService(
        Ci.nsIHttpAuthManager
      );
      auth.clearAll();
    }

    clearCryptoTokens() {
      logger.info("Clearing Crypto Tokens");
      // Clear all crypto auth tokens. This includes calls to PK11_LogoutAll(),
      // nsNSSComponent::LogoutAuthenticatedPK11() and clearing the SSL session
      // cache.
      const sdr = Cc["@mozilla.org/security/sdr;1"].getService(
        Ci.nsISecretDecoderRing
      );
      sdr.logoutAndTeardown();
    }

    clearOCSPCache() {
      // nsNSSComponent::Observe() watches security.OCSP.enabled, which calls
      // setValidationOptions(), which in turn calls setNonPkixOcspEnabled() which,
      // if security.OCSP.enabled is set to 0, calls CERT_DisableOCSPChecking(),
      // which calls CERT_ClearOCSPCache().
      // See: https://mxr.mozilla.org/comm-esr24/source/mozilla/security/manager/ssl/src/nsNSSComponent.cpp
      const ocsp = Services.prefs.getIntPref("security.OCSP.enabled");
      Services.prefs.setIntPref("security.OCSP.enabled", 0);
      Services.prefs.setIntPref("security.OCSP.enabled", ocsp);
    }

    clearSecuritySettings() {
      // Clear site security settings
      const sss = Cc["@mozilla.org/ssservice;1"].getService(
        Ci.nsISiteSecurityService
      );
      sss.clearAll();
    }

    clearImageCaches() {
      logger.info("Clearing Image Cache");
      // In Firefox 18 and newer, there are two image caches: one that is used
      // for regular browsing, and one that is used for private browsing.
      this.clearImageCacheRB();
      this.clearImageCachePB();
    }

    clearImageCacheRB() {
      try {
        const imgTools = Cc["@mozilla.org/image/tools;1"].getService(
          Ci.imgITools
        );
        const imgCache = imgTools.getImgCacheForDocument(null);
        // Evict all but chrome cache
        imgCache.clearCache(false);
      } catch (e) {
        // FIXME: This can happen in some rare cases involving XULish image data
        // in combination with our image cache isolation patch. Sure isn't
        // a good thing, but it's not really a super-cookie vector either.
        // We should fix it eventually.
        logger.error("Exception on image cache clearing", e);
      }
    }

    clearImageCachePB() {
      const imgTools = Cc["@mozilla.org/image/tools;1"].getService(
        Ci.imgITools
      );
      try {
        // Try to clear the private browsing cache. To do so, we must locate a
        // content document that is contained within a private browsing window.
        let didClearPBCache = false;
        const enumerator = Services.wm.getEnumerator("navigator:browser");
        while (!didClearPBCache && enumerator.hasMoreElements()) {
          const win = enumerator.getNext();
          let browserDoc = win.document.documentElement;
          if (!browserDoc.hasAttribute("privatebrowsingmode")) {
            continue;
          }
          const tabbrowser = win.gBrowser;
          if (!tabbrowser) {
            continue;
          }
          for (const browser of tabbrowser.browsers) {
            const doc = browser.contentDocument;
            if (doc) {
              const imgCache = imgTools.getImgCacheForDocument(doc);
              // Evict all but chrome cache
              imgCache.clearCache(false);
              didClearPBCache = true;
              break;
            }
          }
        }
      } catch (e) {
        logger.error("Exception on private browsing image cache clearing", e);
      }
    }

    clearStorage() {
      logger.info("Clearing Disk and Memory Caches");
      try {
        Services.cache2.clear();
      } catch (e) {
        logger.error("Exception on cache clearing", e);
      }

      logger.info("Clearing Cookies and DOM Storage");
      Services.cookies.removeAll();
    }

    clearPreferencesAndPermissions() {
      logger.info("Clearing Content Preferences");
      ChromeUtils.defineModuleGetter(
        this,
        "PrivateBrowsingUtils",
        "resource://gre/modules/PrivateBrowsingUtils.jsm"
      );
      const pbCtxt = PrivateBrowsingUtils.privacyContextFromWindow(window);
      const cps = Cc["@mozilla.org/content-pref/service;1"].getService(
        Ci.nsIContentPrefService2
      );
      cps.removeAllDomains(pbCtxt);
      this.clearSiteSpecificZoom();

      logger.info("Clearing permissions");
      try {
        Services.perms.removeAll();
      } catch (e) {
        // Actually, this catch does not appear to be needed. Leaving it in for
        // safety though.
        logger.error("Cannot clear permissions", e);
      }

      logger.info("Syncing prefs");
      // Force prefs to be synced to disk
      Services.prefs.savePrefFile(null);
    }

    async clearData() {
      logger.info("Calling the clearDataService");
      const flags =
        Services.clearData.CLEAR_ALL ^ Services.clearData.CLEAR_PASSWORDS;
      return new Promise((resolve, reject) => {
        Services.clearData.deleteData(flags, {
          onDataDeleted(code) {
            if (code !== Cr.NS_OK) {
              logger.error(`Error while calling the clearDataService: ${code}`);
            }
            // We always resolve, because we do not want to interrupt the new
            // identity procedure.
            resolve();
          },
        });
      });
    }

    clearConnections() {
      logger.info("Closing open connections");
      // Clear keep-alive
      Services.obs.notifyObservers(this, "net:prune-all-connections");
    }

    clearPrivateSession() {
      logger.info("Ending any remaining private browsing sessions.");
      Services.obs.notifyObservers(null, "last-pb-context-exited");
    }

    // Broadcast as a hook to clear other data

    broadcast() {
      logger.info("Broadcasting the new identity");
      Services.obs.notifyObservers({}, topics.newIdentityRequested);
    }

    // Window management

    openNewWindow() {
      logger.info("Opening a new window");
      // Open a new window with the default homepage
      // We could pass {private: true} but we do not because we enforce
      // browser.privatebrowsing.autostart = true.
      // What about users that change settings?
      OpenBrowserWindow();
    }

    closeOldWindow() {
      logger.info("Closing the old window");

      // Run garbage collection and cycle collection after window is gone.
      // This ensures that blob URIs are forgotten.
      window.addEventListener("unload", function(event) {
        logger.debug("Initiating New Identity GC pass");
        // Clear out potential pending sInterSliceGCTimer:
        window.windowUtils.runNextCollectorTimer();
        // Clear out potential pending sICCTimer:
        window.windowUtils.runNextCollectorTimer();
        // Schedule a garbage collection in 4000-1000ms...
        window.windowUtils.garbageCollect();
        // To ensure the GC runs immediately instead of 4-10s from now, we need
        // to poke it at least 11 times.
        // We need 5 pokes for GC, 1 poke for the interSliceGC, and 5 pokes for
        // CC.
        // See nsJSContext::RunNextCollectorTimer() in
        // https://mxr.mozilla.org/mozilla-central/source/dom/base/nsJSEnvironment.cpp#1970.
        // XXX: We might want to make our own method for immediate full GC...
        for (let poke = 0; poke < 11; poke++) {
          window.windowUtils.runNextCollectorTimer();
        }
        // And now, since the GC probably actually ran *after* the CC last time,
        // run the whole thing again.
        window.windowUtils.garbageCollect();
        for (let poke = 0; poke < 11; poke++) {
          window.windowUtils.runNextCollectorTimer();
        }
        logger.debug("Completed New Identity GC pass");
      });

      // Close the current window for added safety
      window.close();
    }
  }

  let newIdentityInProgress = false;
  return {
    topics,

    init() {
      CustomizableUI.addListener(this);

      const button = document.querySelector("#new-identity-button");
      if (button) {
        button.setAttribute("tooltiptext", NewIdentityStrings.new_identity);
        button.addEventListener("command", () => {
          this.onCommand();
        });
      }
      const viewCache = document.getElementById("appMenu-viewCache").content;
      const appButton = viewCache.querySelector("#appMenu-new-identity");
      if (appButton) {
        appButton.setAttribute(
          "label",
          NewIdentityStrings.new_identity_sentence_case
        );
        appButton.addEventListener("command", () => {
          this.onCommand();
        });
      }
      const menu = document.querySelector("#menu_newIdentity");
      if (menu) {
        menu.setAttribute("label", NewIdentityStrings.new_identity);
        menu.setAttribute(
          "accesskey",
          NewIdentityStrings.new_identity_menu_accesskey
        );
        menu.addEventListener("command", () => {
          this.onCommand();
        });
      }
    },

    uninit() {
      CustomizableUI.removeListener(this);
    },

    onCustomizeStart(window) {
      const button = document.querySelector("#new-identity-button");
      button.setAttribute("label", NewIdentityStrings.new_identity);
    },

    onWidgetAfterDOMChange(aNode, aNextNode, aContainer, aWasRemoval) {},

    async onCommand() {
      try {
        // Ignore if there's a New Identity in progress to avoid race
        // conditions leading to failures (see bug 11783 for an example).
        if (newIdentityInProgress) {
          return;
        }
        newIdentityInProgress = true;

        const prefConfirm = "extensions.torbutton.confirm_newnym";
        const shouldConfirm = Services.prefs.getBoolPref(prefConfirm, true);
        if (shouldConfirm) {
          // Display two buttons, both with string titles.
          const flags = Services.prompt.STD_YES_NO_BUTTONS;
          const askAgain = { value: false };
          const confirmed =
            Services.prompt.confirmEx(
              null,
              "",
              NewIdentityStrings.new_identity_prompt,
              flags,
              null,
              null,
              null,
              NewIdentityStrings.new_identity_ask_again,
              askAgain
            ) == 0;
          Services.prefs.setBoolPref(prefConfirm, !askAgain.value);
          if (!confirmed) {
            return;
          }
        }

        const impl = new NewIdentityImpl();
        await impl.run();
      } catch (e) {
        // If something went wrong make sure we have the New Identity button
        // enabled (again).
        logger.error("Unexpected error", e);
        window.alert("New Identity unexpected error: " + e);
      } finally {
        newIdentityInProgress = false;
      }
    },
  };
});
