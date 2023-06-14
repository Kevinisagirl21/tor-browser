/*************************************************************************
 * Copyright (c) 2013, The Tor Project, Inc.
 * See LICENSE for licensing information.
 *
 * vim: set sw=2 sts=2 ts=8 et syntax=javascript:
 *
 * Tor check service
 *************************************************************************/

const lazy = {};

ChromeUtils.defineModuleGetter(
  lazy,
  "unescapeTorString",
  "resource://torbutton/modules/utils.js"
);
ChromeUtils.defineModuleGetter(
  lazy,
  "wait_for_controller",
  "resource://torbutton/modules/tor-control-port.js"
);

export const TorCheckService = {
  kCheckNotInitiated: 0, // Possible values for statusOfTorCheck.
  kCheckSuccessful: 1,
  kCheckFailed: 2,

  kCheckFailedTopic: "Torbutton:TorCheckFailed",

  _logger: null,
  _status: 0, // this.kCheckNotInitiated,

  // Public methods.
  get statusOfTorCheck() {
    return this._status;
  },

  set statusOfTorCheck(aStatus) {
    if (aStatus === this._status) {
      return;
    }
    this._status = aStatus;
    if (aStatus === this.kCheckFailed) {
      this._broadcastFailure();
    }
  },

  get enabled() {
    return (
      Services.prefs.getBoolPref("extensions.torbutton.test_enabled", true) &&
      !Services.prefs.getBoolPref(
        "extensions.torbutton.use_nontor_proxy",
        false
      )
    );
  },

  async runTorCheck() {
    if (!this.enabled) {
      return;
    }

    // If we have a tor control port and transparent torification is off,
    // perform a check via the control port.
    // FIXME: Centralize this!
    const kEnvSkipControlPortTest = "TOR_SKIP_CONTROLPORTTEST";
    const kEnvUseTransparentProxy = "TOR_TRANSPROXY";
    if (
      // (m_tb_control_ipc_file || m_tb_control_port) &&
      !Services.env.exists(kEnvUseTransparentProxy) &&
      !Services.env.exists(kEnvSkipControlPortTest) &&
      Services.prefs.getBoolPref("extensions.torbutton.local_tor_check")
    ) {
      if (await this._localCheck()) {
        this.statusOfTorCheck = this.kCheckSuccessful;
      } else {
        this.statusOfTorCheck = this.kCheckFailed;
      }
    } else {
      // A local check is not possible, so perform a remote check.
      this._remoteCheck();
    }
  },

  _init() {
    // TODO: Get rid of this logger
    this._logger = Cc["@torproject.org/torbutton-logger;1"].getService(
      Ci.nsISupports
    ).wrappedJSObject;
    this._logger.log(3, "Torbutton Tor Check Service initialized");
  },

  async _localCheck() {
    let didLogError = false;

    let proxyType = Services.prefs.getIntPref("network.proxy.type");
    if (0 == proxyType) {
      return false;
    }

    // Ask tor for its SOCKS listener address and port and compare to the
    // browser preferences.
    const kCmdArg = "net/listeners/socks";
    let resp = await this.torbutton_send_ctrl_cmd("GETINFO " + kCmdArg);
    if (!resp) {
      return false;
    }

    function logUnexpectedResponse() {
      if (!didLogError) {
        didLogError = true;
        this._logger.log(
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
    let socksAddr = Services.prefs.getCharPref("network.proxy.socks");
    let socksPort = Services.prefs.getIntPref("network.proxy.socks_port");
    let socksIPCPath;
    if (socksAddr && socksAddr.startsWith("file:")) {
      // Convert the file URL to a file path.
      try {
        let fph = Services.io
          .getProtocolHandler("file")
          .QueryInterface(Ci.nsIFileProtocolHandler);
        socksIPCPath = fph.getFileFromURLSpec(socksAddr).path;
      } catch (e) {
        this._logger.log(5, "Local Tor check: IPC file error: " + e);
        return false;
      }
    } else {
      socksAddr = removeBrackets(socksAddr);
    }

    // Split into quoted strings. This code is adapted from utils.splitAtSpaces()
    // within tor-control-port.js; someday this code should use the entire
    // tor-control-port.js framework.
    let addrArray = [];
    resp.replace(/((\S*?"(.*?)")+\S*|\S+)/g, function (a, captured) {
      addrArray.push(captured);
    });

    let foundSocksListener = false;
    for (let i = 0; !foundSocksListener && i < addrArray.length; ++i) {
      let addr;
      try {
        addr = lazy.unescapeTorString(addrArray[i]);
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
        this._logger.log(2, "Tor socks listener (Unix domain socket): " + path);
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
            this._logger.log(
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
  },

  _remoteCheck() {
    try {
      let req = this.createCheckRequest(true); // async
      req.onreadystatechange = function (aEvent) {
        if (req.readyState === 4) {
          let ret = this.parseCheckResponse(req);

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
            this.statusOfTorCheck = this.kCheckFailed;
          } else if (ret == 4) {
            this.statusOfTorCheck = this.kCheckSuccessful;
          } // Otherwise, redo the check later

          this._logger.log(3, "Tor remote check done. Result: " + ret);
        }
      };

      this._logger.log(3, "Sending async Tor remote check");
      req.send(null);
    } catch (e) {
      if (e.result == 0x80004005) {
        // NS_ERROR_FAILURE
        this._logger.log(5, "Tor check failed! Is tor running?");
      } else {
        this._logger.log(5, "Tor check failed! Tor internal error: " + e);
      }
      this.statusOfTorCheck = this.kCheckFailed;
    }
  },

  _broadcastFailure() {
    Services.obs.notifyObservers(null, this.kCheckFailedTopic);

    // If the user does not have an about:tor tab open in the front most
    // window, open one.
    const win = Services.wm.getMostRecentWindow("navigator:browser");
    const browser = win.gBrowser;
    for (const tab of win.gBrowser.visibleTabs) {
      if (tab.linkedBrowser.currentURI.spec.toLowerCase() == "about:tor") {
        browser.selectedTab = tab;
        return;
      }
    }
    browser.selectedTab = browser.addTrustedTab("about:tor");
  },

  createCheckRequest(aAsync) {
    let req = new XMLHttpRequest();
    let url = Services.prefs.getCharPref("extensions.torbutton.test_url");
    req.open("GET", url, aAsync);
    req.channel.loadFlags |= Ci.nsIRequest.LOAD_BYPASS_CACHE;
    req.overrideMimeType("text/xml");
    req.timeout = 120000; // Wait at most two minutes for a response.
    return req;
  },

  parseCheckResponse(aReq) {
    let ret = 0;
    if (aReq.status == 200) {
      if (!aReq.responseXML) {
        this._logger.log(5, "Check failed! Not text/xml!");
        ret = 1;
      } else {
        let result = aReq.responseXML.getElementById("TorCheckResult");

        if (result === null) {
          this._logger.log(5, "Test failed! No TorCheckResult element");
          ret = 2;
        } else if (
          typeof result.target == "undefined" ||
          result.target === null
        ) {
          this._logger.log(5, "Test failed! No target");
          ret = 3;
        } else if (result.target === "success") {
          this._logger.log(3, "Test Successful");
          ret = 4;
        } else if (result.target === "failure") {
          this._logger.log(5, "Tor test failed!");
          ret = 5;
        } else if (result.target === "unknown") {
          this._logger.log(5, "Tor test failed. TorDNSEL Failure?");
          ret = 6;
        } else {
          this._logger.log(5, "Tor test failed. Strange target.");
          ret = 7;
        }
      }
    } else {
      if (0 == aReq.status) {
        try {
          var req = aReq.channel.QueryInterface(Ci.nsIRequest);
          if (req.status == Cr.NS_ERROR_PROXY_CONNECTION_REFUSED) {
            this._logger.log(5, "Tor test failed. Proxy connection refused");
            ret = 8;
          }
        } catch (e) {}
      }

      if (ret == 0) {
        this._logger.log(5, "Tor test failed. HTTP Error: " + aReq.status);
        ret = -aReq.status;
      }
    }

    return ret;
  },

  async torbutton_send_ctrl_cmd(command) {
    const getErrorMessage = e => (e && (e.torMessage || e.message)) || "";
    let response = null;
    try {
      const avoidCache = true;
      let torController = await lazy.wait_for_controller(avoidCache);

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
      this._logger.log(4, `Error: ${msg}`);
    }
    return response;
  },
};

TorCheckService._init();
