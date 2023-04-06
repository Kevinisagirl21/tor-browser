// A component for Tor Browser that puts requests from different
// first party domains on separate Tor circuits.

var EXPORTED_SYMBOLS = ["TorDomainIsolator"];

const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");
const { XPCOMUtils } = ChromeUtils.import(
  "resource://gre/modules/XPCOMUtils.jsm"
);
const { ConsoleAPI } = ChromeUtils.import("resource://gre/modules/Console.jsm");

const lazy = {};

XPCOMUtils.defineLazyServiceGetters(lazy, {
  ProtocolProxyService: [
    "@mozilla.org/network/protocol-proxy-service;1",
    "nsIProtocolProxyService",
  ],
});

ChromeUtils.defineModuleGetter(
  lazy,
  "TorProtocolService",
  "resource://gre/modules/TorProtocolService.jsm"
);

const logger = new ConsoleAPI({
  prefix: "TorDomainIsolator",
  maxLogLevel: "warn",
  maxLogLevelPref: "browser.tordomainisolator.loglevel",
});

// The string to use instead of the domain when it is not known.
const CATCHALL_DOMAIN = "--unknown--";

// The preference to observe, to know whether isolation should be enabled or
// disabled.
const NON_TOR_PROXY_PREF = "extensions.torbutton.use_nontor_proxy";

// The topic of new identity, to observe to cleanup all the nonces.
const NEW_IDENTITY_TOPIC = "new-identity-requested";

class TorDomainIsolatorImpl {
  // A mutable map that records what nonce we are using for each domain.
  #noncesForDomains = new Map();

  // A mutable map that records what nonce we are using for each tab container.
  #noncesForUserContextId = new Map();

  // A bool that controls if we use SOCKS auth for isolation or not.
  #isolationEnabled = true;

  // Specifies when the current catch-all circuit was first used
  #catchallDirtySince = Date.now();

  /**
   * Initialize the domain isolator.
   * This function will setup the proxy filter that injects the credentials and
   * register some observers.
   */
  init() {
    logger.info("Setup circuit isolation by domain and user context");

    if (Services.prefs.getBoolPref(NON_TOR_PROXY_PREF)) {
      this.#isolationEnabled = false;
    }
    this.#setupProxyFilter();

    Services.prefs.addObserver(NON_TOR_PROXY_PREF, this);
    Services.obs.addObserver(this, NEW_IDENTITY_TOPIC);
  }

  /**
   * Removes the observers added in the initialization.
   */
  uninit() {
    Services.prefs.removeObserver(NON_TOR_PROXY_PREF, this);
    Services.obs.removeObserver(this, NEW_IDENTITY_TOPIC);
  }

  enable() {
    logger.trace("Domain isolation enabled");
    this.#isolationEnabled = true;
  }

  disable() {
    logger.trace("Domain isolation disabled");
    this.#isolationEnabled = false;
  }

  /**
   * Return the credentials to use as username and password for the SOCKS proxy,
   * given a certain domain and userContextId. Optionally, create them.
   *
   * @param {string} firstPartyDomain The first party domain associated to the requests
   * @param {string} userContextId The context ID associated to the request
   * @param {bool} create Whether to create the nonce, if it is not available
   * @returns {object|null} Either the credential, or null if we do not have them and create is
   * false.
   */
  getSocksProxyCredentials(firstPartyDomain, userContextId, create = false) {
    if (!this.#noncesForDomains.has(firstPartyDomain)) {
      if (!create) {
        return null;
      }
      const nonce = this.#nonce();
      logger.info(`New nonce for first party ${firstPartyDomain}: ${nonce}`);
      this.#noncesForDomains.set(firstPartyDomain, nonce);
    }
    if (!this.#noncesForUserContextId.has(userContextId)) {
      if (!create) {
        return null;
      }
      const nonce = this.#nonce();
      logger.info(`New nonce for userContextId ${userContextId}: ${nonce}`);
      this.#noncesForUserContextId.set(userContextId, nonce);
    }
    return {
      username: this.#makeUsername(firstPartyDomain, userContextId),
      password:
        this.#noncesForDomains.get(firstPartyDomain) +
        this.#noncesForUserContextId.get(userContextId),
    };
  }

  /**
   * Create a new nonce for the FP domain of the selected browser and reload the
   * tab with a new circuit.
   *
   * @param {object} browser Should be the gBrowser from the context of the
   * caller
   */
  newCircuitForBrowser(browser) {
    const firstPartyDomain = getDomainForBrowser(browser.selectedBrowser);
    this.#newCircuitForDomain(firstPartyDomain);
    // TODO: How to properly handle the user context? Should we use
    // (domain, userContextId) pairs, instead of concatenating nonces?
    browser.reloadWithFlags(Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_CACHE);
  }

  /**
   * Clear the isolation state cache, forcing new circuits to be used for all
   * subsequent requests.
   */
  clearIsolation() {
    logger.trace("Clearing isolation nonces.");

    // Per-domain and per contextId nonces are stored in maps, so simply clear
    // them.
    this.#noncesForDomains.clear();
    this.#noncesForUserContextId.clear();

    // Force a rotation on the next catch-all circuit use by setting the
    // creation time to the epoch.
    this.#catchallDirtySince = 0;
  }

  async observe(subject, topic, data) {
    if (topic === "nsPref:changed" && data === NON_TOR_PROXY_PREF) {
      if (Services.prefs.getBoolPref(NON_TOR_PROXY_PREF)) {
        this.disable();
      } else {
        this.enable();
      }
    } else if (topic === NEW_IDENTITY_TOPIC) {
      logger.info(
        "New identity has been requested, clearing isolation tokens."
      );
      this.clearIsolation();
      try {
        await lazy.TorProtocolService.newnym();
      } catch (e) {
        logger.error("Could not send the newnym command", e);
        // TODO: What UX to use here? See tor-browser#41708
      }
    }
  }

  /**
   * Setup a filter that for every HTTPChannel, replaces the default SOCKS proxy
   * with one that authenticates to the SOCKS server (the tor client process)
   * with a username (the first party domain and userContextId) and a nonce
   * password.
   * Tor provides a separate circuit for each username+password combination.
   */
  #setupProxyFilter() {
    const filterFunction = (aChannel, aProxy) => {
      if (!this.#isolationEnabled) {
        return aProxy;
      }
      try {
        const channel = aChannel.QueryInterface(Ci.nsIChannel);
        let firstPartyDomain =
          channel.loadInfo.originAttributes.firstPartyDomain;
        const userContextId = channel.loadInfo.originAttributes.userContextId;
        if (firstPartyDomain === "") {
          firstPartyDomain = CATCHALL_DOMAIN;
          if (Date.now() - this.#catchallDirtySince > 1000 * 10 * 60) {
            logger.info(
              "tor catchall circuit has been dirty for over 10 minutes. Rotating."
            );
            this.#newCircuitForDomain(CATCHALL_DOMAIN);
            this.#catchallDirtySince = Date.now();
          }
        }
        const replacementProxy = this.#applySocksProxyCredentials(
          aProxy,
          firstPartyDomain,
          userContextId
        );
        logger.debug(
          `Requested ${channel.URI.spec} via ${replacementProxy.username}:${replacementProxy.password}`
        );
        return replacementProxy;
      } catch (e) {
        logger.error("Error while setting a new proxy", e);
        return null;
      }
    };

    lazy.ProtocolProxyService.registerChannelFilter(
      {
        applyFilter(aChannel, aProxy, aCallback) {
          aCallback.onProxyFilterResult(filterFunction(aChannel, aProxy));
        },
      },
      0
    );
  }

  /**
   * Takes a proxyInfo object (originalProxy) and returns a new proxyInfo
   * object with the same properties, except the username is set to the
   * the domain and userContextId, and the password is a nonce.
   */
  #applySocksProxyCredentials(originalProxy, domain, userContextId) {
    const proxy = originalProxy.QueryInterface(Ci.nsIProxyInfo);
    const { username, password } = this.getSocksProxyCredentials(
      domain,
      userContextId,
      true
    );
    return lazy.ProtocolProxyService.newProxyInfoWithAuth(
      "socks",
      proxy.host,
      proxy.port,
      username,
      password,
      "", // aProxyAuthorizationHeader
      "", // aConnectionIsolationKey
      proxy.flags,
      proxy.failoverTimeout,
      proxy.failoverProxy
    );
  }

  /**
   * Combine the needed data into a username for the proxy.
   */
  #makeUsername(domain, userContextId) {
    if (!domain) {
      domain = CATCHALL_DOMAIN;
    }
    return `${domain}:${userContextId}`;
  }

  /**
   * Generate a new 128 bit random tag.
   *
   * Strictly speaking both using a cryptographic entropy source and using 128
   * bits of entropy for the tag are likely overkill, as correct behavior only
   * depends on how unlikely it is for there to be a collision.
   */
  #nonce() {
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte =>
      byte.toString(16).padStart(2, "0")
    ).join("");
  }

  /**
   * Re-generate the nonce for a certain domain.
   */
  #newCircuitForDomain(domain) {
    if (!domain) {
      domain = CATCHALL_DOMAIN;
    }
    this.#noncesForDomains.set(domain, this.#nonce());
    logger.info(
      `New domain isolation for ${domain}: ${this.#noncesForDomains.get(
        domain
      )}`
    );
  }

  /**
   * Re-generate the nonce for a userContextId.
   *
   * Currently, this function is not hooked to anything.
   */
  #newCircuitForUserContextId(userContextId) {
    this.#noncesForUserContextId.set(userContextId, this.#nonce());
    logger.info(
      `New container isolation for ${userContextId}: ${this.#noncesForUserContextId.get(
        userContextId
      )}`
    );
  }
}

/**
 * Get the first party domain for a certain browser.
 *
 * @param browser The browser to get the FP-domain for.
 *
 * Please notice that it should be gBrowser.selectedBrowser, because
 * browser.documentURI is the actual shown page, and might be an error page.
 * In this case, we rely on currentURI, which for gBrowser is an alias of
 * gBrowser.selectedBrowser.currentURI.
 * See browser/base/content/tabbrowser.js and tor-browser#31562.
 */
function getDomainForBrowser(browser) {
  let fpd = browser.contentPrincipal.originAttributes.firstPartyDomain;

  // Bug 31562: For neterror or certerror, get the original URL from
  // browser.currentURI and use it to calculate the firstPartyDomain.
  const knownErrors = [
    "about:neterror",
    "about:certerror",
    "about:httpsonlyerror",
  ];
  const { documentURI } = browser;
  if (
    documentURI &&
    documentURI.schemeIs("about") &&
    knownErrors.some(x => documentURI.spec.startsWith(x))
  ) {
    const knownSchemes = ["http", "https"];
    const currentURI = browser.currentURI;
    if (currentURI && knownSchemes.some(x => currentURI.schemeIs(x))) {
      try {
        fpd = Services.eTLD.getBaseDomainFromHost(currentURI.host);
      } catch (e) {
        if (
          e.result === Cr.NS_ERROR_HOST_IS_IP_ADDRESS ||
          e.result === Cr.NS_ERROR_INSUFFICIENT_DOMAIN_LEVELS
        ) {
          fpd = currentURI.host;
        } else {
          logger.error(
            `Failed to get first party domain for host ${currentURI.host}`,
            e
          );
        }
      }
    }
  }

  return fpd;
}

const TorDomainIsolator = new TorDomainIsolatorImpl();
// Reduce global vars pollution
TorDomainIsolator.getDomainForBrowser = getDomainForBrowser;
