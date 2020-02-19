// # domain-isolator.js
// A component for TorBrowser that puts requests from different
// first party domains on separate tor circuits.

// This file is written in call stack order (later functions
// call earlier functions). The code file can be processed
// with docco.js to provide clear documentation.

// ### Abbreviations

const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");
const { XPCOMUtils } = ChromeUtils.import(
  "resource://gre/modules/XPCOMUtils.jsm"
);

XPCOMUtils.defineLazyModuleGetters(this, {
  ComponentUtils: "resource://gre/modules/ComponentUtils.jsm",
});

// Make the logger available.
let logger = Cc["@torproject.org/torbutton-logger;1"].getService(Ci.nsISupports)
  .wrappedJSObject;

// Import crypto object (FF 37+).
Cu.importGlobalProperties(["crypto"]);

// ## mozilla namespace.
// Useful functionality for interacting with Mozilla services.
let mozilla = {};

// __mozilla.protocolProxyService__.
// Mozilla's protocol proxy service, useful for managing proxy connections made
// by the browser.
mozilla.protocolProxyService = Cc[
  "@mozilla.org/network/protocol-proxy-service;1"
].getService(Ci.nsIProtocolProxyService);

// __mozilla.registerProxyChannelFilter(filterFunction, positionIndex)__.
// Registers a proxy channel filter with the Mozilla Protocol Proxy Service,
// which will help to decide the proxy to be used for a given channel.
// The filterFunction should expect two arguments, (aChannel, aProxy),
// where aProxy is the proxy or list of proxies that would be used by default
// for the given channel, and should return a new Proxy or list of Proxies.
mozilla.registerProxyChannelFilter = function(filterFunction, positionIndex) {
  let proxyFilter = {
    applyFilter(aChannel, aProxy, aCallback) {
      aCallback.onProxyFilterResult(filterFunction(aChannel, aProxy));
    },
  };
  mozilla.protocolProxyService.registerChannelFilter(
    proxyFilter,
    positionIndex
  );
};

// ## tor functionality.
let tor = {};

// __tor.noncesForDomains__.
// A mutable map that records what nonce we are using for each domain.
tor.noncesForDomains = new Map();

// __tor.noncesForUserContextId__.
// A mutable map that records what nonce we are using for each tab container.
tor.noncesForUserContextId = new Map();

// __tor.isolationEabled__.
// A bool that controls if we use SOCKS auth for isolation or not.
tor.isolationEnabled = true;

// __tor.unknownDirtySince__.
// Specifies when the current catch-all circuit was first used
tor.unknownDirtySince = Date.now();

tor.passwordForDomainAndUserContextId = function(
  domain,
  userContextId,
  create
) {
  // Check if we already have a nonce. If not, possibly create one for this
  // domain and userContextId.
  if (!tor.noncesForDomains.has(domain)) {
    if (!create) {
      return null;
    }
    tor.noncesForDomains.set(domain, tor.nonce());
  }
  if (!tor.noncesForUserContextId.has(userContextId)) {
    if (!create) {
      return null;
    }
    tor.noncesForUserContextId.set(userContextId, tor.nonce());
  }
  return (
    tor.noncesForDomains.get(domain) +
    tor.noncesForUserContextId.get(userContextId)
  );
};

tor.usernameForDomainAndUserContextId = function(domain, userContextId) {
  return `${domain}:${userContextId}`;
};

// __tor.socksProxyCredentials(originalProxy, domain, userContextId)__.
// Takes a proxyInfo object (originalProxy) and returns a new proxyInfo
// object with the same properties, except the username is set to the
// the domain and userContextId, and the password is a nonce.
tor.socksProxyCredentials = function(originalProxy, domain, userContextId) {
  let proxy = originalProxy.QueryInterface(Ci.nsIProxyInfo);
  let proxyUsername = tor.usernameForDomainAndUserContextId(
    domain,
    userContextId
  );
  let proxyPassword = tor.passwordForDomainAndUserContextId(
    domain,
    userContextId,
    true
  );
  return mozilla.protocolProxyService.newProxyInfoWithAuth(
    "socks",
    proxy.host,
    proxy.port,
    proxyUsername,
    proxyPassword,
    "", // aProxyAuthorizationHeader
    "", // aConnectionIsolationKey
    proxy.flags,
    proxy.failoverTimeout,
    proxy.failoverProxy
  );
};

tor.nonce = function() {
  // Generate a new 128 bit random tag.  Strictly speaking both using a
  // cryptographic entropy source and using 128 bits of entropy for the
  // tag are likely overkill, as correct behavior only depends on how
  // unlikely it is for there to be a collision.
  let tag = new Uint8Array(16);
  crypto.getRandomValues(tag);

  // Convert the tag to a hex string.
  let tagStr = "";
  for (let i = 0; i < tag.length; i++) {
    tagStr += (tag[i] >>> 4).toString(16);
    tagStr += (tag[i] & 0x0f).toString(16);
  }

  return tagStr;
};

tor.newCircuitForDomain = function(domain) {
  // Re-generate the nonce for the domain.
  if (domain === "") {
    domain = "--unknown--";
  }
  tor.noncesForDomains.set(domain, tor.nonce());
  logger.eclog(
    3,
    `New domain isolation for ${domain}: ${tor.noncesForDomains.get(domain)}`
  );
};

tor.newCircuitForUserContextId = function(userContextId) {
  // Re-generate the nonce for the context.
  tor.noncesForUserContextId.set(userContextId, tor.nonce());
  logger.eclog(
    3,
    `New container isolation for ${userContextId}: ${tor.noncesForUserContextId.get(
      userContextId
    )}`
  );
};

// __tor.clearIsolation()_.
// Clear the isolation state cache, forcing new circuits to be used for all
// subsequent requests.
tor.clearIsolation = function() {
  // Per-domain and per contextId nonces are stored in maps, so simply clear them.
  tor.noncesForDomains.clear();
  tor.noncesForUserContextId.clear();

  // Force a rotation on the next catch-all circuit use by setting the creation
  // time to the epoch.
  tor.unknownDirtySince = 0;
};

// __tor.isolateCircuitsByDomain()__.
// For every HTTPChannel, replaces the default SOCKS proxy with one that authenticates
// to the SOCKS server (the tor client process) with a username (the first party domain
// and userContextId) and a nonce password. Tor provides a separate circuit for each
// username+password combination.
tor.isolateCircuitsByDomain = function() {
  mozilla.registerProxyChannelFilter(function(aChannel, aProxy) {
    if (!tor.isolationEnabled) {
      return aProxy;
    }
    try {
      let channel = aChannel.QueryInterface(Ci.nsIChannel),
        firstPartyDomain = channel.loadInfo.originAttributes.firstPartyDomain,
        userContextId = channel.loadInfo.originAttributes.userContextId;
      if (firstPartyDomain === "") {
        firstPartyDomain = "--unknown--";
        if (Date.now() - tor.unknownDirtySince > 1000 * 10 * 60) {
          logger.eclog(
            3,
            "tor catchall circuit has been dirty for over 10 minutes. Rotating."
          );
          tor.newCircuitForDomain("--unknown--");
          tor.unknownDirtySince = Date.now();
        }
      }
      let replacementProxy = tor.socksProxyCredentials(
        aProxy,
        firstPartyDomain,
        userContextId
      );
      logger.eclog(
        3,
        `tor SOCKS: ${channel.URI.spec} via
                       ${replacementProxy.username}:${replacementProxy.password}`
      );
      return replacementProxy;
    } catch (e) {
      logger.eclog(4, `tor domain isolator error: ${e.message}`);
      return null;
    }
  }, 0);
};

// ## XPCOM component construction.
// Module specific constants
const kMODULE_NAME = "TorBrowser Domain Isolator";
const kMODULE_CONTRACTID = "@torproject.org/domain-isolator;1";
const kMODULE_CID = Components.ID("e33fd6d4-270f-475f-a96f-ff3140279f68");

// DomainIsolator object.
function DomainIsolator() {
  this.wrappedJSObject = this;
}

// Firefox component requirements
DomainIsolator.prototype = {
  QueryInterface: ChromeUtils.generateQI([Ci.nsIObserver]),
  classDescription: kMODULE_NAME,
  classID: kMODULE_CID,
  contractID: kMODULE_CONTRACTID,
  observe(subject, topic, data) {
    if (topic === "profile-after-change") {
      logger.eclog(3, "domain isolator: set up isolating circuits by domain");

      if (Services.prefs.getBoolPref("extensions.torbutton.use_nontor_proxy")) {
        tor.isolationEnabled = false;
      }
      tor.isolateCircuitsByDomain();
    }
  },

  newCircuitForDomain(domain) {
    tor.newCircuitForDomain(domain);
  },

  /**
   * Return the stored SOCKS proxy username and password for the given domain
   * and user context ID.
   *
   * @param {string} firstPartyDomain - The domain to lookup credentials for.
   * @param {integer} userContextId - The ID for the user context.
   *
   * @return {{ username: string, password: string }?} - The SOCKS credentials,
   *   or null if none are found.
   */
  getSocksProxyCredentials(firstPartyDomain, userContextId) {
    if (firstPartyDomain == "") {
      firstPartyDomain = "--unknown--";
    }
    let proxyPassword = tor.passwordForDomainAndUserContextId(
      firstPartyDomain,
      userContextId,
      // Do not create a new entry if it does not exist.
      false
    );
    if (!proxyPassword) {
      return null;
    }
    return {
      username: tor.usernameForDomainAndUserContextId(
        firstPartyDomain,
        userContextId
      ),
      password: proxyPassword,
    };
  },

  enableIsolation() {
    tor.isolationEnabled = true;
  },

  disableIsolation() {
    tor.isolationEnabled = false;
  },

  clearIsolation() {
    tor.clearIsolation();
  },

  wrappedJSObject: null,
};

// Assign factory to global object.
const NSGetFactory = XPCOMUtils.generateNSGetFactory
  ? XPCOMUtils.generateNSGetFactory([DomainIsolator])
  : ComponentUtils.generateNSGetFactory([DomainIsolator]);
