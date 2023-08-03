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
  TorProviderBuilder: "resource://gre/modules/TorProviderBuilder.sys.mjs",
});

export const TorCheckService = {
  kCheckNotInitiated: 0, // Possible values for status.
  kCheckSuccessful: 1,
  kCheckFailed: 2,

  kObserverTopic: "TorCheckService:StatusChanged",

  _status: 0, // this.kCheckNotInitiated,
  _loggerObject: null,

  // Public methods
  get status() {
    return this._status;
  },

  set status(aStatus) {
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
        this.status = this.kCheckSuccessful;
      } else {
        this.status = this.kCheckFailed;
      }
    } else if (await this._remoteCheck()) {
      this.status = this.kCheckSuccessful;
    } else {
      this.status = this.kCheckFailed;
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
      listeners = await lazy.TorProviderBuilder.build().getSocksListeners();
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
        const addrTokens = addr.match(
          /^([\d.]{7,15}|\[?[\da-fA-F:]+\]?):(\d{1,5})$/
        );
        if (!addrTokens) {
          this._logger.warn(
            `Ignoring address ${addr} because it is not valid.`
          );
          continue;
        }

        const torSocksAddr = removeBrackets(addrTokens[1]);
        const torSocksPort = parseInt(addrTokens[2], 10);
        if (!torSocksAddr) {
          this._logger.warn(`Ignoring address ${addr} its host is empty.`);
          continue;
        }
        if (torSocksPort === 0 || torSocksPort > 65535) {
          this._logger.warn(
            `Ignoring address ${addr} as its port is not valid.`
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

  async _remoteCheck() {
    try {
      const url = Services.prefs.getCharPref("extensions.torbutton.test_url");
      const request = await fetch(url, { cache: "no-store" });
      const parser = new DOMParser();
      const document = parser.parseFromString(
        await request.text(),
        "text/html"
      );
      const elem = document.getElementById("TorCheckResult");
      if (!elem) {
        this._logger.error(
          "Could not find the HTML element with the check result."
        );
      }
      // #TorCheckResult is an <a>, and has the outcome in the target attribute.
      const target = elem.getAttribute("target");
      this._logger.debug(`Remote test: target=${target}`);
      if (target === "success") {
        this._logger.info("Remote test succeeded.");
        return true;
      }
      this._logger.error(`Remote test: unexpected target value '${target}'.`);
      return false;
    } catch (e) {
      this._logger.error("Failed to perform the remote check", e);
      return false;
    }
  },

  _openAboutTor() {
    // If the user does not have an about:tor tab open in the front most
    // window, open one.
    const win = Services.wm.getMostRecentWindow("navigator:browser");
    const browser = win.gBrowser;
    for (const tab of win.gBrowser.visibleTabs) {
      if (tab.linkedBrowser.currentURI.spec.toLowerCase() === "about:tor") {
        browser.selectedTab = tab;
        return;
      }
    }
    browser.selectedTab = browser.addTrustedTab("about:tor");
  },
};
