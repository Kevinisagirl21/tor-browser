// window globals
var torbutton_init;

(() => {
  // Bug 1506 P1-P5: This is the main Torbutton overlay file. Much needs to be
  // preserved here, but in an ideal world, most of this code should perhaps be
  // moved into an XPCOM service, and much can also be tossed. See also
  // individual 1506 comments for details.

  // TODO: check for leaks: http://www.mozilla.org/scriptable/avoiding-leaks.html
  // TODO: Double-check there are no strange exploits to defeat:
  //       http://kb.mozillazine.org/Links_to_local_pages_don%27t_work

  /* global gBrowser, Services, AppConstants */

  let { torbutton_log } = ChromeUtils.import(
    "resource://torbutton/modules/utils.js"
  );
  let { configureControlPortModule } = ChromeUtils.import(
    "resource://torbutton/modules/tor-control-port.js"
  );

  const { TorProtocolService } = ChromeUtils.import(
    "resource://gre/modules/TorProtocolService.jsm"
  );

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
      Services.prefs.addObserver("browser.privatebrowsing.autostart", this);
    },

    unregister() {
      Services.prefs.removeObserver("browser.privatebrowsing.autostart", this);
    },

    // topic:   what event occurred
    // subject: what nsIPrefBranch we're observing
    // data:    which pref has been changed (relative to subject)
    observe(subject, topic, data) {
      if (
        topic === "nsPref:changed" &&
        data === "browser.privatebrowsing.autostart"
      ) {
        torbutton_update_disk_prefs();
      }
    },
  };

  // Bug 1506 P2-P4: This code sets some version variables that are irrelevant.
  // It does read out some important environment variables, though. It is
  // called once per browser window.. This might belong in a component.
  torbutton_init = function () {
    torbutton_log(3, "called init()");

    if (m_tb_wasinited) {
      return;
    }
    m_tb_wasinited = true;

    // Bug 1506 P4: These vars are very important for New Identity
    if (Services.env.exists("TOR_CONTROL_PASSWD")) {
      m_tb_control_pass = Services.env.get("TOR_CONTROL_PASSWD");
    } else if (Services.env.exists("TOR_CONTROL_COOKIE_AUTH_FILE")) {
      var cookie_path = Services.env.get("TOR_CONTROL_COOKIE_AUTH_FILE");
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
      if (Services.env.exists("TOR_CONTROL_PORT")) {
        m_tb_control_port = Services.env.get("TOR_CONTROL_PORT");
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

      if (Services.env.exists("TOR_CONTROL_HOST")) {
        m_tb_control_host = Services.env.get("TOR_CONTROL_HOST");
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

    torbutton_log(3, "init completed");
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
      .map(function (c) {
        return String("0" + c.toString(16)).slice(-2);
      })
      .join("");
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

  // ---------------------- Event handlers -----------------

  // Bug 1506 P1-P3: Most of these observers aren't very important.
  // See their comments for details
  function torbutton_do_main_window_startup() {
    torbutton_log(3, "Torbutton main window startup");
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
