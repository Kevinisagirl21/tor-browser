// window globals
var torbutton_init;
var torbutton_new_circuit;

(() => {
  // Bug 1506 P1-P5: This is the main Torbutton overlay file. Much needs to be
  // preserved here, but in an ideal world, most of this code should perhaps be
  // moved into an XPCOM service, and much can also be tossed. See also
  // individual 1506 comments for details.

  // TODO: check for leaks: http://www.mozilla.org/scriptable/avoiding-leaks.html
  // TODO: Double-check there are no strange exploits to defeat:
  //       http://kb.mozillazine.org/Links_to_local_pages_don%27t_work

  /* global gBrowser, Services, AppConstants */

  let {
    unescapeTorString,
    getDomainForBrowser,
    torbutton_log,
    torbutton_get_property_string,
  } = ChromeUtils.import("resource://torbutton/modules/utils.js");
  let { configureControlPortModule, wait_for_controller } = ChromeUtils.import(
    "resource://torbutton/modules/tor-control-port.js"
  );

  const { TorProtocolService } = ChromeUtils.import(
    "resource://gre/modules/TorProtocolService.jsm"
  );

  const k_tb_tor_check_failed_topic = "Torbutton:TorCheckFailed";

  var m_tb_prefs = Services.prefs;

  // status
  var m_tb_wasinited = false;
  var m_tb_is_main_window = false;

  var m_tb_control_ipc_file = null; // Set if using IPC (UNIX domain socket).
  var m_tb_control_port = null; // Set if using TCP.
  var m_tb_control_host = null; // Set if using TCP.
  var m_tb_control_pass = null;

  // Bug 1506 P2: This object keeps Firefox prefs in sync with Torbutton prefs.
  // It probably could stand some simplification (See #3100). It also belongs
  // in a component, not the XUL overlay.
  var torbutton_unique_pref_observer = {
    register() {
      this.forced_ua = false;
      m_tb_prefs.addObserver("extensions.torbutton", this);
      m_tb_prefs.addObserver("browser.privatebrowsing.autostart", this);
      m_tb_prefs.addObserver("javascript", this);
    },

    unregister() {
      m_tb_prefs.removeObserver("extensions.torbutton", this);
      m_tb_prefs.removeObserver("browser.privatebrowsing.autostart", this);
      m_tb_prefs.removeObserver("javascript", this);
    },

    // topic:   what event occurred
    // subject: what nsIPrefBranch we're observing
    // data:    which pref has been changed (relative to subject)
    observe(subject, topic, data) {
      if (topic !== "nsPref:changed") {
        return;
      }
      switch (data) {
        case "browser.privatebrowsing.autostart":
          torbutton_update_disk_prefs();
          break;
        case "extensions.torbutton.use_nontor_proxy":
          torbutton_use_nontor_proxy();
          break;
      }
    },
  };

  var torbutton_tor_check_observer = {
    register() {
      this._obsSvc = Services.obs;
      this._obsSvc.addObserver(this, k_tb_tor_check_failed_topic);
    },

    unregister() {
      if (this._obsSvc) {
        this._obsSvc.removeObserver(this, k_tb_tor_check_failed_topic);
      }
    },

    observe(subject, topic, data) {
      if (topic === k_tb_tor_check_failed_topic) {
        // Update all open about:tor pages.
        torbutton_abouttor_message_handler.updateAllOpenPages();

        // If the user does not have an about:tor tab open in the front most
        // window, open one.
        var wm = Services.wm;
        var win = wm.getMostRecentWindow("navigator:browser");
        if (win == window) {
          let foundTab = false;
          let tabBrowser = top.gBrowser;
          for (let i = 0; !foundTab && i < tabBrowser.browsers.length; ++i) {
            let b = tabBrowser.getBrowserAtIndex(i);
            foundTab = b.currentURI.spec.toLowerCase() == "about:tor";
          }

          if (!foundTab) {
            gBrowser.selectedTab = gBrowser.addTrustedTab("about:tor");
          }
        }
      }
    },
  };

  var torbutton_new_identity_observers = {
    register() {
      Services.obs.addObserver(this, "new-identity-requested");
    },

    observe(aSubject, aTopic, aData) {
      if (aTopic !== "new-identity-requested") {
        return;
      }

      // Clear the domain isolation state.
      torbutton_log(3, "Clearing domain isolator");
      const domainIsolator = Cc["@torproject.org/domain-isolator;1"].getService(
        Ci.nsISupports
      ).wrappedJSObject;
      domainIsolator.clearIsolation();

      torbutton_log(3, "New Identity: Sending NEWNYM");
      // We only support TBB for newnym.
      if (
        !m_tb_control_pass ||
        (!m_tb_control_ipc_file && !m_tb_control_port)
      ) {
        const warning = torbutton_get_property_string(
          "torbutton.popup.no_newnym"
        );
        torbutton_log(
          5,
          "Torbutton cannot safely newnym. It does not have access to the Tor Control Port."
        );
        window.alert(warning);
      } else {
        const warning = torbutton_get_property_string(
          "torbutton.popup.no_newnym"
        );
        torbutton_send_ctrl_cmd("SIGNAL NEWNYM")
          .then(res => {
            if (!res) {
              torbutton_log(
                5,
                "Torbutton was unable to request a new circuit from Tor"
              );
              window.alert(warning);
            }
          })
          .catch(e => {
            torbutton_log(
              5,
              "Torbutton was unable to request a new circuit from Tor " + e
            );
            window.alert(warning);
          });
      }
    },
  };

  // Bug 1506 P2-P4: This code sets some version variables that are irrelevant.
  // It does read out some important environment variables, though. It is
  // called once per browser window.. This might belong in a component.
  torbutton_init = function() {
    torbutton_log(3, "called init()");

    if (m_tb_wasinited) {
      return;
    }
    m_tb_wasinited = true;

    // Bug 1506 P4: These vars are very important for New Identity
    var environ = Cc["@mozilla.org/process/environment;1"].getService(
      Ci.nsIEnvironment
    );

    if (environ.exists("TOR_CONTROL_PASSWD")) {
      m_tb_control_pass = environ.get("TOR_CONTROL_PASSWD");
    } else if (environ.exists("TOR_CONTROL_COOKIE_AUTH_FILE")) {
      var cookie_path = environ.get("TOR_CONTROL_COOKIE_AUTH_FILE");
      try {
        if ("" != cookie_path) {
          m_tb_control_pass = torbutton_read_authentication_cookie(cookie_path);
        }
      } catch (e) {
        torbutton_log(4, "unable to read authentication cookie");
      }
    } else {
      try {
        // Try to get password from Tor Launcher.
        m_tb_control_pass = TorProtocolService.torGetPassword(false);
      } catch (e) {}
    }

    // Try to get the control port IPC file (an nsIFile) from Tor Launcher,
    // since Tor Launcher knows how to handle its own preferences and how to
    // resolve relative paths.
    try {
      m_tb_control_ipc_file = TorProtocolService.torGetControlIPCFile();
    } catch (e) {}

    if (!m_tb_control_ipc_file) {
      if (environ.exists("TOR_CONTROL_PORT")) {
        m_tb_control_port = environ.get("TOR_CONTROL_PORT");
      } else {
        try {
          const kTLControlPortPref = "extensions.torlauncher.control_port";
          m_tb_control_port = m_tb_prefs.getIntPref(kTLControlPortPref);
        } catch (e) {
          // Since we want to disable some features when Tor Launcher is
          // not installed (e.g., New Identity), we do not set a default
          // port value here.
        }
      }

      if (environ.exists("TOR_CONTROL_HOST")) {
        m_tb_control_host = environ.get("TOR_CONTROL_HOST");
      } else {
        try {
          const kTLControlHostPref = "extensions.torlauncher.control_host";
          m_tb_control_host = m_tb_prefs.getCharPref(kTLControlHostPref);
        } catch (e) {
          m_tb_control_host = "127.0.0.1";
        }
      }
    }

    configureControlPortModule(
      m_tb_control_ipc_file,
      m_tb_control_host,
      m_tb_control_port,
      m_tb_control_pass
    );

    // Add about:tor IPC message listener.
    window.messageManager.addMessageListener(
      "AboutTor:Loaded",
      torbutton_abouttor_message_handler
    );

    torbutton_log(1, "registering Tor check observer");
    torbutton_tor_check_observer.register();

    // Arrange for our about:tor content script to be loaded in each frame.
    window.messageManager.loadFrameScript(
      "chrome://torbutton/content/aboutTor/aboutTor-content.js",
      true
    );

    torbutton_new_identity_observers.register();

    torbutton_log(3, "init completed");
  };

  var torbutton_abouttor_message_handler = {
    // Receive IPC messages from the about:tor content script.
    async receiveMessage(aMessage) {
      switch (aMessage.name) {
        case "AboutTor:Loaded":
          aMessage.target.messageManager.sendAsyncMessage(
            "AboutTor:ChromeData",
            await this.getChromeData(true)
          );
          break;
      }
    },

    // Send privileged data to all of the about:tor content scripts.
    async updateAllOpenPages() {
      window.messageManager.broadcastAsyncMessage(
        "AboutTor:ChromeData",
        await this.getChromeData(false)
      );
    },

    // The chrome data contains all of the data needed by the about:tor
    // content process that is only available here (in the chrome process).
    // It is sent to the content process when an about:tor window is opened
    // and in response to events such as the browser noticing that Tor is
    // not working.
    async getChromeData(aIsRespondingToPageLoad) {
      let dataObj = {
        mobile: Services.appinfo.OS === "Android",
        updateChannel: AppConstants.MOZ_UPDATE_CHANNEL,
        torOn: await torbutton_tor_check_ok(),
      };

      if (aIsRespondingToPageLoad) {
        const kShouldNotifyPref = "torbrowser.post_update.shouldNotify";
        if (m_tb_prefs.getBoolPref(kShouldNotifyPref, false)) {
          m_tb_prefs.clearUserPref(kShouldNotifyPref);
          dataObj.hasBeenUpdated = true;
          dataObj.updateMoreInfoURL = this.getUpdateMoreInfoURL();
        }
      }

      return dataObj;
    },

    getUpdateMoreInfoURL() {
      try {
        return Services.prefs.getCharPref("torbrowser.post_update.url");
      } catch (e) {}

      // Use the default URL as a fallback.
      return Services.urlFormatter.formatURLPref(
        "startup.homepage_override_url"
      );
    },
  };

  // Bug 1506 P4: Control port interaction. Needed for New Identity.
  function torbutton_read_authentication_cookie(path) {
    var file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(path);
    var fileStream = Cc[
      "@mozilla.org/network/file-input-stream;1"
    ].createInstance(Ci.nsIFileInputStream);
    fileStream.init(file, 1, 0, false);
    var binaryStream = Cc["@mozilla.org/binaryinputstream;1"].createInstance(
      Ci.nsIBinaryInputStream
    );
    binaryStream.setInputStream(fileStream);
    var array = binaryStream.readByteArray(fileStream.available());
    binaryStream.close();
    fileStream.close();
    return torbutton_array_to_hexdigits(array);
  }

  // Bug 1506 P4: Control port interaction. Needed for New Identity.
  function torbutton_array_to_hexdigits(array) {
    return array
      .map(function(c) {
        return String("0" + c.toString(16)).slice(-2);
      })
      .join("");
  }

  // Bug 1506 P4: Control port interaction. Needed for New Identity.
  //
  // Asynchronously executes a command on the control port.
  // returns the response as a string, or null on error
  async function torbutton_send_ctrl_cmd(command) {
    const getErrorMessage = e => (e && (e.torMessage || e.message)) || "";
    let response = null;
    try {
      const avoidCache = true;
      let torController = await wait_for_controller(avoidCache);

      let bytes = await torController.sendCommand(command);
      if (!bytes.startsWith("250")) {
        throw new Error(
          `Unexpected command response on control port '${bytes}'`
        );
      }
      response = bytes.slice(4);

      torController.close();
    } catch (err) {
      let msg = getErrorMessage(err);
      torbutton_log(4, `Error: ${msg}`);
    }
    return response;
  }

  // Bug 1506 P4: Needed for New IP Address
  torbutton_new_circuit = function() {
    let firstPartyDomain = getDomainForBrowser(gBrowser.selectedBrowser);

    let domainIsolator = Cc["@torproject.org/domain-isolator;1"].getService(
      Ci.nsISupports
    ).wrappedJSObject;

    domainIsolator.newCircuitForDomain(firstPartyDomain);

    gBrowser.reloadWithFlags(Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_CACHE);
  };

  /* Called when we switch the use_nontor_proxy pref in either direction.
   *
   * Enables/disables domain isolation and then does new identity
   */
  function torbutton_use_nontor_proxy() {
    let domainIsolator = Cc["@torproject.org/domain-isolator;1"].getService(
      Ci.nsISupports
    ).wrappedJSObject;

    if (m_tb_prefs.getBoolPref("extensions.torbutton.use_nontor_proxy")) {
      // Disable domain isolation
      domainIsolator.disableIsolation();
    } else {
      domainIsolator.enableIsolation();
    }
  }

  async function torbutton_do_tor_check() {
    let checkSvc = Cc["@torproject.org/torbutton-torCheckService;1"].getService(
      Ci.nsISupports
    ).wrappedJSObject;
    if (
      m_tb_prefs.getBoolPref("extensions.torbutton.use_nontor_proxy") ||
      !m_tb_prefs.getBoolPref("extensions.torbutton.test_enabled")
    ) {
      return;
    } // Only do the check once.

    // If we have a tor control port and transparent torification is off,
    // perform a check via the control port.
    const kEnvSkipControlPortTest = "TOR_SKIP_CONTROLPORTTEST";
    const kEnvUseTransparentProxy = "TOR_TRANSPROXY";
    var env = Cc["@mozilla.org/process/environment;1"].getService(
      Ci.nsIEnvironment
    );
    if (
      (m_tb_control_ipc_file || m_tb_control_port) &&
      !env.exists(kEnvUseTransparentProxy) &&
      !env.exists(kEnvSkipControlPortTest) &&
      m_tb_prefs.getBoolPref("extensions.torbutton.local_tor_check")
    ) {
      if (await torbutton_local_tor_check()) {
        checkSvc.statusOfTorCheck = checkSvc.kCheckSuccessful;
      } else {
        // The check failed.  Update toolbar icon and tooltip.
        checkSvc.statusOfTorCheck = checkSvc.kCheckFailed;
      }
    } else {
      // A local check is not possible, so perform a remote check.
      torbutton_initiate_remote_tor_check();
    }
  }

  async function torbutton_local_tor_check() {
    let didLogError = false;

    let proxyType = m_tb_prefs.getIntPref("network.proxy.type");
    if (0 == proxyType) {
      return false;
    }

    // Ask tor for its SOCKS listener address and port and compare to the
    // browser preferences.
    const kCmdArg = "net/listeners/socks";
    let resp = await torbutton_send_ctrl_cmd("GETINFO " + kCmdArg);
    if (!resp) {
      return false;
    }

    function logUnexpectedResponse() {
      if (!didLogError) {
        didLogError = true;
        torbutton_log(
          5,
          "Local Tor check: unexpected GETINFO response: " + resp
        );
      }
    }

    function removeBrackets(aStr) {
      // Remove enclosing square brackets if present.
      if (aStr.startsWith("[") && aStr.endsWith("]")) {
        return aStr.substr(1, aStr.length - 2);
      }

      return aStr;
    }

    // Sample response: net/listeners/socks="127.0.0.1:9149" "127.0.0.1:9150"
    // First, check for and remove the command argument prefix.
    if (0 != resp.indexOf(kCmdArg + "=")) {
      logUnexpectedResponse();
      return false;
    }
    resp = resp.substr(kCmdArg.length + 1);

    // Retrieve configured proxy settings and check each listener against them.
    // When the SOCKS prefs are set to use IPC (e.g., a Unix domain socket), a
    // file URL should be present in network.proxy.socks.
    // See: https://bugzilla.mozilla.org/show_bug.cgi?id=1211567
    let socksAddr = m_tb_prefs.getCharPref("network.proxy.socks");
    let socksPort = m_tb_prefs.getIntPref("network.proxy.socks_port");
    let socksIPCPath;
    if (socksAddr && socksAddr.startsWith("file:")) {
      // Convert the file URL to a file path.
      try {
        let ioService = Services.io;
        let fph = ioService
          .getProtocolHandler("file")
          .QueryInterface(Ci.nsIFileProtocolHandler);
        socksIPCPath = fph.getFileFromURLSpec(socksAddr).path;
      } catch (e) {
        torbutton_log(5, "Local Tor check: IPC file error: " + e);
        return false;
      }
    } else {
      socksAddr = removeBrackets(socksAddr);
    }

    // Split into quoted strings. This code is adapted from utils.splitAtSpaces()
    // within tor-control-port.js; someday this code should use the entire
    // tor-control-port.js framework.
    let addrArray = [];
    resp.replace(/((\S*?"(.*?)")+\S*|\S+)/g, function(a, captured) {
      addrArray.push(captured);
    });

    let foundSocksListener = false;
    for (let i = 0; !foundSocksListener && i < addrArray.length; ++i) {
      let addr;
      try {
        addr = unescapeTorString(addrArray[i]);
      } catch (e) {}
      if (!addr) {
        continue;
      }

      // Remove double quotes if present.
      let len = addr.length;
      if (len > 2 && '"' == addr.charAt(0) && '"' == addr.charAt(len - 1)) {
        addr = addr.substring(1, len - 1);
      }

      if (addr.startsWith("unix:")) {
        if (!socksIPCPath) {
          continue;
        }

        // Check against the configured UNIX domain socket proxy.
        let path = addr.substring(5);
        torbutton_log(2, "Tor socks listener (Unix domain socket): " + path);
        foundSocksListener = socksIPCPath === path;
      } else if (!socksIPCPath) {
        // Check against the configured TCP proxy. We expect addr:port where addr
        // may be an IPv6 address; that is, it may contain colon characters.
        // Also, we remove enclosing square brackets before comparing addresses
        // because tor requires them but Firefox does not.
        let idx = addr.lastIndexOf(":");
        if (idx < 0) {
          logUnexpectedResponse();
        } else {
          let torSocksAddr = removeBrackets(addr.substring(0, idx));
          let torSocksPort = parseInt(addr.substring(idx + 1), 10);
          if (torSocksAddr.length < 1 || isNaN(torSocksPort)) {
            logUnexpectedResponse();
          } else {
            torbutton_log(
              2,
              "Tor socks listener: " + torSocksAddr + ":" + torSocksPort
            );
            foundSocksListener =
              socksAddr === torSocksAddr && socksPort === torSocksPort;
          }
        }
      }
    }

    return foundSocksListener;
  } // torbutton_local_tor_check

  function torbutton_initiate_remote_tor_check() {
    let obsSvc = Services.obs;
    try {
      let checkSvc = Cc[
        "@torproject.org/torbutton-torCheckService;1"
      ].getService(Ci.nsISupports).wrappedJSObject;
      let req = checkSvc.createCheckRequest(true); // async
      req.onreadystatechange = function(aEvent) {
        if (req.readyState === 4) {
          let ret = checkSvc.parseCheckResponse(req);

          // If we received an error response from check.torproject.org,
          // set the status of the tor check to failure (we don't want
          // to indicate failure if we didn't receive a response).
          if (
            ret == 2 ||
            ret == 3 ||
            ret == 5 ||
            ret == 6 ||
            ret == 7 ||
            ret == 8
          ) {
            checkSvc.statusOfTorCheck = checkSvc.kCheckFailed;
            obsSvc.notifyObservers(null, k_tb_tor_check_failed_topic);
          } else if (ret == 4) {
            checkSvc.statusOfTorCheck = checkSvc.kCheckSuccessful;
          } // Otherwise, redo the check later

          torbutton_log(3, "Tor remote check done. Result: " + ret);
        }
      };

      torbutton_log(3, "Sending async Tor remote check");
      req.send(null);
    } catch (e) {
      if (e.result == 0x80004005) {
        // NS_ERROR_FAILURE
        torbutton_log(5, "Tor check failed! Is tor running?");
      } else {
        torbutton_log(5, "Tor check failed! Tor internal error: " + e);
      }

      obsSvc.notifyObservers(null, k_tb_tor_check_failed_topic);
    }
  } // torbutton_initiate_remote_tor_check()

  async function torbutton_tor_check_ok() {
    await torbutton_do_tor_check();
    let checkSvc = Cc["@torproject.org/torbutton-torCheckService;1"].getService(
      Ci.nsISupports
    ).wrappedJSObject;
    return checkSvc.kCheckFailed != checkSvc.statusOfTorCheck;
  }

  function torbutton_update_disk_prefs() {
    var mode = m_tb_prefs.getBoolPref("browser.privatebrowsing.autostart");

    m_tb_prefs.setBoolPref("browser.cache.disk.enable", !mode);
    m_tb_prefs.setBoolPref("places.history.enabled", !mode);

    m_tb_prefs.setBoolPref("security.nocertdb", mode);

    // No way to clear this beast during New Identity. Leave it off.
    //m_tb_prefs.setBoolPref("dom.indexedDB.enabled", !mode);

    m_tb_prefs.setBoolPref("permissions.memory_only", mode);

    // Third party abuse. Leave it off for now.
    //m_tb_prefs.setBoolPref("browser.cache.offline.enable", !mode);

    // Force prefs to be synced to disk
    Services.prefs.savePrefFile(null);
  }

  // Bug 1506 P1: This function just cleans up prefs that got set badly in previous releases
  function torbutton_fixup_old_prefs() {
    if (m_tb_prefs.getIntPref("extensions.torbutton.pref_fixup_version") < 1) {
      // TBB 5.0a3 had bad Firefox code that silently flipped this pref on us
      if (m_tb_prefs.prefHasUserValue("browser.newtabpage.enhanced")) {
        m_tb_prefs.clearUserPref("browser.newtabpage.enhanced");
        // TBB 5.0a3 users had all the necessary data cached in
        // directoryLinks.json. This meant that resetting the pref above
        // alone was not sufficient as the tiles features uses the cache
        // even if the pref indicates that feature should be disabled.
        // We flip the preference below as this forces a refetching which
        // effectively results in an empty JSON file due to our spoofed
        // URLs.
        let matchOS = m_tb_prefs.getBoolPref("intl.locale.matchOS");
        m_tb_prefs.setBoolPref("intl.locale.matchOS", !matchOS);
        m_tb_prefs.setBoolPref("intl.locale.matchOS", matchOS);
      }

      // For some reason, the Share This Page button also survived the
      // TBB 5.0a4 update's attempt to remove it.
      if (m_tb_prefs.prefHasUserValue("browser.uiCustomization.state")) {
        m_tb_prefs.clearUserPref("browser.uiCustomization.state");
      }

      m_tb_prefs.setIntPref("extensions.torbutton.pref_fixup_version", 1);
    }
  }

  // ---------------------- Event handlers -----------------

  // Bug 1506 P1-P3: Most of these observers aren't very important.
  // See their comments for details
  function torbutton_do_main_window_startup() {
    torbutton_log(3, "Torbutton main window startup");
    m_tb_is_main_window = true;
    torbutton_unique_pref_observer.register();
  }

  // Bug 1506 P4: Most of this function is now useless, save
  // for the very important SOCKS environment vars at the end.
  // Those could probably be rolled into a function with the
  // control port vars, though. See 1506 comments inside.
  function torbutton_do_startup() {
    if (m_tb_prefs.getBoolPref("extensions.torbutton.startup")) {
      // Bug 1506: Should probably be moved to an XPCOM component
      torbutton_do_main_window_startup();

      // Bug 30565: sync browser.privatebrowsing.autostart with security.nocertdb
      torbutton_update_disk_prefs();

      // For general pref fixups to handle pref damage in older versions
      torbutton_fixup_old_prefs();

      m_tb_prefs.setBoolPref("extensions.torbutton.startup", false);
    }
  }

  // Bug 1506 P3: This is needed pretty much only for the window resizing.
  // See comments for individual functions for details
  function torbutton_new_window(event) {
    torbutton_log(3, "New window");
    var browser = window.gBrowser;

    if (!browser) {
      torbutton_log(5, "No browser for new window.");
      return;
    }

    if (!m_tb_wasinited) {
      torbutton_init();
    }

    torbutton_do_startup();
  }

  // Bug 1506 P2: This is only needed because we have observers
  // in XUL that should be in an XPCOM component
  function torbutton_close_window(event) {
    torbutton_tor_check_observer.unregister();

    // TODO: This is a real ghetto hack.. When the original window
    // closes, we need to find another window to handle observing
    // unique events... The right way to do this is to move the
    // majority of torbutton functionality into a XPCOM component..
    // But that is a major overhaul..
    if (m_tb_is_main_window) {
      torbutton_log(3, "Original window closed. Searching for another");
      var wm = Services.wm;
      var enumerator = wm.getEnumerator("navigator:browser");
      while (enumerator.hasMoreElements()) {
        var win = enumerator.getNext();
        // For some reason, when New Identity is called from a pref
        // observer (ex: torbutton_use_nontor_proxy) on an ASAN build,
        // we sometimes don't have this symbol set in the new window yet.
        // However, the new window will run this init later in that case,
        // as it does in the OSX case.
        if (win != window && "torbutton_do_main_window_startup" in win) {
          torbutton_log(3, "Found another window");
          win.torbutton_do_main_window_startup();
          m_tb_is_main_window = false;
          break;
        }
      }

      torbutton_unique_pref_observer.unregister();

      if (m_tb_is_main_window) {
        // main window not reset above
        // This happens on Mac OS because they allow firefox
        // to still persist without a navigator window
        torbutton_log(3, "Last window closed. None remain.");
        m_tb_prefs.setBoolPref("extensions.torbutton.startup", true);
        m_tb_is_main_window = false;
      }
    }
  }

  window.addEventListener("load", torbutton_new_window);
  window.addEventListener("unload", torbutton_close_window);
})();
