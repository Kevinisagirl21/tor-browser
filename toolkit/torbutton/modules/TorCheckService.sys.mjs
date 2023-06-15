/*************************************************************************
 * Copyright (c) 2013, The Tor Project, Inc.
 * See LICENSE for licensing information.
 *
 * vim: set sw=2 sts=2 ts=8 et syntax=javascript:
 *
 * Tor check service
 *************************************************************************/

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  ConsoleAPI: "resource://gre/modules/Console.sys.mjs",
});

ChromeUtils.defineModuleGetter(
  lazy,
  "TorProtocolService",
  "resource://gre/modules/TorProtocolService.jsm"
);

export const TorCheckService = {
  kCheckNotInitiated: 0, // Possible values for statusOfTorCheck.
  kCheckSuccessful: 1,
  kCheckFailed: 2,

  kObserverTopic: "TorCheckService:StatusChanged",

  _status: 0, // this.kCheckNotInitiated,
  _loggerObject: null,

  // Public methods
  get statusOfTorCheck() {
    return this._status;
  },

  set statusOfTorCheck(aStatus) {
    if (aStatus === this._status) {
      return;
    }
    this._status = aStatus;
    Services.obs.notifyObservers(null, this.kObserverTopic);
    if (aStatus === this.kCheckFailed) {
      this._openAboutTor();
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

  get hasFailed() {
    return this._status === this.kCheckFailed;
  },

  get _logger() {
    if (!this._loggerObject) {
      this._loggerObject = new lazy.ConsoleAPI({
        maxLogLevel: "warn",
        maxLogLevelPref: "extensions.torbutton.test_log_level",
        prefix: "TorCheckService",
      });
    }
    return this._loggerObject;
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

  // In the local check, we ask tor for its SOCKS listener address and port and
  // compare them with the browser settings.
  async _localCheck() {
    let proxyType = Services.prefs.getIntPref("network.proxy.type");
    if (proxyType === 0) {
      this._logger.error("Local Tor check failed: no proxy set!");
      return false;
    }

    let listeners;
    try {
      listeners = await lazy.TorProtocolService.getSocksListeners();
    } catch (e) {
      this._logger.error("Failed to get the SOCKS listerner addresses.", e);
      return false;
    }

    // Remove enclosing square brackets if present.
    const removeBrackets = aStr =>
      aStr.startsWith("[") && aStr.endsWith("]")
        ? aStr.substr(1, aStr.length - 2)
        : aStr;

    // Retrieve configured proxy settings and check each listener against them.
    // When the SOCKS prefs are set to use IPC (e.g., a Unix domain socket), a
    // file URL should be present in network.proxy.socks.
    // See: https://bugzilla.mozilla.org/show_bug.cgi?id=1211567
    let socksAddr = Services.prefs.getCharPref("network.proxy.socks");
    let socksIPCPath;
    if (socksAddr && socksAddr.startsWith("file:")) {
      // Convert the file URL to a file path.
      try {
        let fph = Services.io
          .getProtocolHandler("file")
          .QueryInterface(Ci.nsIFileProtocolHandler);
        socksIPCPath = fph.getFileFromURLSpec(socksAddr).path;
      } catch (e) {
        this._logger.error("Local Tor check: IPC file error", e);
        return false;
      }
    } else {
      socksAddr = removeBrackets(socksAddr);
    }
    const socksPort = Services.prefs.getIntPref("network.proxy.socks_port");

    for (let addr of listeners) {
      let len = addr.length;
      // We need to have at least 2 characters to check for quotes.
      // But no address can be shorter than 3 characters anyway, since it must
      // either start by unix: or have host:port.
      if (len < 2) {
        continue;
      }
      // Remove double quotes if present.
      if (addr[0] === '"' && addr[len - 1] === '"') {
        addr = addr.substring(1, len - 1);
      }
      if (addr.startsWith("unix:")) {
        const path = addr.substring(5);
        this._logger.debug(
          `Found Tor SOCKS IPC listener (Unix domain socket): ${path}.`
        );
        if (socksIPCPath && socksIPCPath === path) {
          return true;
        }
      } else if (!socksIPCPath) {
        // Check against the configured TCP proxy. We expect addr:port where addr
        // may be an IPv6 address; that is, it may contain colon characters.
        // Also, we remove enclosing square brackets before comparing addresses
        // because tor requires them but Firefox does not.
        const portIdx = addr.lastIndexOf(":");
        if (portIdx < 0) {
          this._logger.warn(
            `Ignoring address ${addr} because does not contain a port number.`
          );
          continue;
        }

        const torSocksAddr = removeBrackets(addr.substring(0, portIdx));
        const torSocksPort = parseInt(addr.substring(portIdx + 1), 10);
        if (!torSocksAddr) {
          this._logger.warn(`Ignoring address ${addr} its host is empty.`);
          continue;
        }
        if (isNaN(torSocksPort) || torSocksPort <= 0) {
          this._logger.warn(
            `Ignoring address ${addr} its port is not a number.`
          );
          continue;
        }
        this._logger.debug(
          `Found Tor SOCKS listener: ${torSocksAddr}:${torSocksPort}.`
        );
        if (socksAddr === torSocksAddr && socksPort === torSocksPort) {
          return true;
        }
      }
    }
    this._logger.error(
      "Local Tor check: no SOCKS listener match the browser settings."
    );
    return false;
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

          this._logger.info(`Tor remote check done. Result: ${ret}`);
        }
      };
      req.send(null);
    } catch (e) {
      if (e.result == 0x80004005) {
        // NS_ERROR_FAILURE
        this._logger.error("Tor check failed! Is tor running?");
      } else {
        this._logger.error("Tor check failed!", e);
      }
      this.statusOfTorCheck = this.kCheckFailed;
    }
  },

  _openAboutTor() {
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
        this._logger.error("Check failed! Not text/xml!");
        ret = 1;
      } else {
        let result = aReq.responseXML.getElementById("TorCheckResult");

        if (result === null) {
          this._logger.error("Test failed! No TorCheckResult element");
          ret = 2;
        } else if (
          typeof result.target == "undefined" ||
          result.target === null
        ) {
          this._logger.error("Test failed! No target");
          ret = 3;
        } else if (result.target === "success") {
          this._logger.info("Remote test Successful");
          ret = 4;
        } else if (result.target === "failure") {
          this._logger.error("Tor test failed!");
          ret = 5;
        } else if (result.target === "unknown") {
          this._logger.error("Tor test failed. TorDNSEL Failure?");
          ret = 6;
        } else {
          this._logger.error("Tor test failed. Strange target.");
          ret = 7;
        }
      }
    } else {
      if (0 == aReq.status) {
        try {
          var req = aReq.channel.QueryInterface(Ci.nsIRequest);
          if (req.status == Cr.NS_ERROR_PROXY_CONNECTION_REFUSED) {
            this._logger.error("Tor test failed. Proxy connection refused");
            ret = 8;
          }
        } catch (e) {}
      }

      if (ret == 0) {
        this._logger.error(`Tor test failed. HTTP Error: ${aReq.status}`);
        ret = -aReq.status;
      }
    }

    return ret;
  },
};
