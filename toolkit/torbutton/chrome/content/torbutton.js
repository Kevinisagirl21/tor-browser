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

  var m_tb_control_ipc_file = null; // Set if using IPC (UNIX domain socket).
  var m_tb_control_port = null; // Set if using TCP.
  var m_tb_control_host = null; // Set if using TCP.
  var m_tb_control_pass = null;

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

  // ---------------------- Event handlers -----------------

  // Bug 1506 P3: This is needed pretty much only for the window resizing.
  // See comments for individual functions for details
  function torbutton_new_window(event) {
    torbutton_log(3, "New window");
    if (!m_tb_wasinited) {
      torbutton_init();
    }
  }
  window.addEventListener("load", torbutton_new_window);
})();
