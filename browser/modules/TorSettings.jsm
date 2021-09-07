"use strict";

var EXPORTED_SYMBOLS = ["TorSettings", "TorSettingsTopics", "TorSettingsData", "TorBridgeSource", "TorBuiltinBridgeTypes", "TorProxyType"];

const { Services } = ChromeUtils.import(
    "resource://gre/modules/Services.jsm"
);

const { TorProtocolService, TorProcessStatus } = ChromeUtils.import(
    "resource:///modules/TorProtocolService.jsm"
);

/* Browser observer topics */
const BrowserTopics = Object.freeze({
    ProfileAfterChange: "profile-after-change",
});

/* tor-launcher observer topics */
const TorTopics = Object.freeze({
    ProcessIsReady: "TorProcessIsReady",
});

/* TorSettings observer topics */
const TorSettingsTopics = Object.freeze({
    Ready: "torsettings:ready",
    SettingChanged: "torsettings:setting-changed",
});

/* TorSettings observer data (for SettingChanged topic) */
const TorSettingsData = Object.freeze({
    QuickStartEnabled : "torsettings:quickstart_enabled",
});

/* Prefs used to store settings in TorBrowser prefs */
const TorSettingsPrefs = Object.freeze({
    /* bool: are we pulling tor settings from the preferences */
    enabled: 'torbrowser.settings.enabled',
    quickstart : {
        /* bool: does tor connect automatically on launch */
        enabled: 'torbrowser.settings.quickstart.enabled',
    },
    bridges : {
        /* bool:  does tor use bridges */
        enabled : 'torbrowser.settings.bridges.enabled',
        /* int: -1=invalid|0=builtin|1=bridge_db|2=user_provided */
        source : 'torbrowser.settings.bridges.source',
        /* string: obfs4|meek_azure|snowflake|etc */
        builtin_type : 'torbrowser.settings.bridges.builtin_type',
        /* preference branch: each child branch should be a bridge string */
        bridge_strings : 'torbrowser.settings.bridges.bridge_strings',
    },
    proxy : {
        /* bool: does tor use a proxy */
        enabled : 'torbrowser.settings.proxy.enabled',
        /* -1=invalid|0=socks4,1=socks5,2=https */
        type: 'torbrowser.settings.proxy.type',
        /* string: proxy server address */
        address: 'torbrowser.settings.proxy.address',
        /* int: [1,65535], proxy port */
        port: 'torbrowser.settings.proxy.port',
        /* string: username */
        username: 'torbrowser.settings.proxy.username',
        /* string: password */
        password: 'torbrowser.settings.proxy.password',
    },
    firewall : {
        /* bool: does tor have a port allow list */
        enabled: 'torbrowser.settings.firewall.enabled',
        /* string: comma-delimitted list of port numbers */
        allowed_ports: 'torbrowser.settings.firewall.allowed_ports',
    },
});

/* Legacy tor-launcher prefs and pref branches*/
const TorLauncherPrefs = Object.freeze({
    quickstart: "extensions.torlauncher.quickstart",
    default_bridge_type: "extensions.torlauncher.default_bridge_type",
    default_bridge: "extensions.torlauncher.default_bridge.",
    default_bridge_recommended_type: "extensions.torlauncher.default_bridge_recommended_type",
    bridgedb_bridge: "extensions.torlauncher.bridgedb_bridge.",
});

/* Config Keys used to configure tor daemon */
const TorConfigKeys = Object.freeze({
    useBridges: "UseBridges",
    bridgeList: "Bridge",
    socks4Proxy: "Socks4Proxy",
    socks5Proxy: "Socks5Proxy",
    socks5ProxyUsername: "Socks5ProxyUsername",
    socks5ProxyPassword: "Socks5ProxyPassword",
    httpsProxy: "HTTPSProxy",
    httpsProxyAuthenticator: "HTTPSProxyAuthenticator",
    reachableAddresses: "ReachableAddresses",
    clientTransportPlugin: "ClientTransportPlugin",
});

const TorBridgeSource = Object.freeze({
    Invalid: -1,
    BuiltIn: 0,
    BridgeDB: 1,
    UserProvided: 2,
});

const TorProxyType = Object.freeze({
    Invalid: -1,
    Socks4: 0,
    Socks5: 1,
    HTTPS: 2,
});


const TorBuiltinBridgeTypes = Object.freeze(
    (() => {
      let bridgeListBranch = Services.prefs.getBranch(TorLauncherPrefs.default_bridge);
      let bridgePrefs = bridgeListBranch.getChildList("");

      // an unordered set for shoving bridge types into
      let bridgeTypes = new Set();
      // look for keys ending in ".N" and treat string before that as the bridge type
      const pattern = /\.[0-9]+$/;
      for (const key of bridgePrefs) {
        const offset = key.search(pattern);
        if (offset != -1) {
          const bt = key.substring(0, offset);
          bridgeTypes.add(bt);
        }
      }

      // recommended bridge type goes first in the list
      let recommendedBridgeType = Services.prefs.getCharPref(TorLauncherPrefs.default_bridge_recommended_type, null);

      let retval = [];
      if (recommendedBridgeType && bridgeTypes.has(recommendedBridgeType)) {
        retval.push(recommendedBridgeType);
      }

      for (const bridgeType of bridgeTypes.values()) {
        if (bridgeType != recommendedBridgeType) {
          retval.push(bridgeType);
        }
      }
      return retval;
  })()
);

/* Parsing Methods */

// expects a string representation of an integer from 1 to 65535
let parsePort = function(aPort) {
  // ensure port string is a valid positive integer
  const validIntRegex = /^[0-9]+$/;
  if (!validIntRegex.test(aPort)) {
    return 0;
  }

  // ensure port value is on valid range
  let port = Number.parseInt(aPort);
  if (port < 1 || port > 65535) {
    return 0;
  }

  return port;
};
// expects a string in the format: "ADDRESS:PORT"
let parseAddrPort = function(aAddrColonPort) {
  let tokens = aAddrColonPort.split(":");
  if (tokens.length != 2) {
    return ["", 0];
  }
  let address = tokens[0];
  let port = parsePort(tokens[1]);
  return [address, port];
};

// expects a string in the format: "USERNAME:PASSWORD"
// split on the first colon and any subsequent go into password
let parseUsernamePassword = function(aUsernameColonPassword) {
  let colonIndex = aUsernameColonPassword.indexOf(":");
  if (colonIndex < 0) {
    return ["", ""];
  }

  let username = aUsernameColonPassword.substring(0, colonIndex);
  let password = aUsernameColonPassword.substring(colonIndex + 1);

  return [username, password];
};

// expects a string in the format: ADDRESS:PORT,ADDRESS:PORT,...
// returns array of ports (as ints)
let parseAddrPortList = function(aAddrPortList) {
  let addrPorts = aAddrPortList.split(",");
  // parse ADDRESS:PORT string and only keep the port (second element in returned array)
  let retval = addrPorts.map(addrPort => parseAddrPort(addrPort)[1]);
  return retval;
};

// expects a '/n' or '/r/n' delimited bridge string, which we split and trim
// each bridge string can also optionally have 'bridge' at the beginning ie:
// bridge $(type) $(address):$(port) $(certificate)
// we strip out the 'bridge' prefix here
let parseBridgeStrings = function(aBridgeStrings) {

  // replace carriage returns ('\r') with new lines ('\n')
  aBridgeStrings = aBridgeStrings.replace(/\r/g, "\n");
  // then replace contiguous new lines ('\n') with a single one
  aBridgeStrings = aBridgeStrings.replace(/[\n]+/g, "\n");

  // split on the newline and for each bridge string: trim, remove starting 'bridge' string
  // finally discard entries that are empty strings; empty strings could occur if we receive
  // a new line containing only whitespace
  let splitStrings = aBridgeStrings.split("\n");
  return splitStrings.map(val => val.trim().replace(/^bridge\s+/i, ""))
                     .filter(bridgeString => bridgeString != "");
};

// expecting a ',' delimited list of ints with possible white space between
// returns an array of ints
let parsePortList = function(aPortListString) {
  let splitStrings = aPortListString.split(",");
  // parse and remove duplicates
  let portSet = new Set(splitStrings.map(val => parsePort(val.trim())));
  // parsePort returns 0 for failed parses, so remove 0 from list
  portSet.delete(0);
  return Array.from(portSet);
};

let getBuiltinBridgeStrings = function(builtinType) {
    let bridgeBranch = Services.prefs.getBranch(TorLauncherPrefs.default_bridge);
    let bridgeBranchPrefs = bridgeBranch.getChildList("");
    let retval = [];

    // regex matches against strings ending in ".N" where N is a positive integer
    let pattern = /\.[0-9]+$/;
    for (const key of bridgeBranchPrefs) {
      // verify the location of the match is the correct offset required for aBridgeType
      // to fit, and that the string begins with aBridgeType
      if (key.search(pattern) == builtinType.length &&
          key.startsWith(builtinType)) {
        let bridgeStr = bridgeBranch.getCharPref(key);
        retval.push(bridgeStr);
      }
    }

    // shuffle so that Tor Browser users don't all try the built-in bridges in the same order
    arrayShuffle(retval);

    return retval;
};

/* Array methods */

let arrayShuffle = function(array) {
    // fisher-yates shuffle
    for (let i = array.length - 1; i > 0; --i) {
      // number n such that 0.0 <= n < 1.0
      const n = Math.random();
      // integer j such that 0 <= j <= i
      const j = Math.floor(n * (i + 1));

      // swap values at indices i and j
      const tmp = array[i];
      array[i] = array[j];
      array[j] = tmp;
    }
}

let arrayCopy = function(array) {
    return [].concat(array);
}

/* TorSettings module */

const TorSettings = (() => {
    let self = {
        _settings: null,

        // tor daemon related settings
        defaultSettings: function() {
            let settings = {
                quickstart: {
                    enabled: false
                },
                bridges : {
                    enabled: false,
                    source: TorBridgeSource.Invalid,
                    builtin_type: null,
                    bridge_strings: [],
                },
                proxy: {
                    enabled: false,
                    type: TorProxyType.Invalid,
                    address: null,
                    port: 0,
                    username: null,
                    password: null,
                },
                firewall: {
                    enabled: false,
                    allowed_ports: [],
                },
            };
            return settings;
        },

        /* try and load our settings, and register observers */
        init: function() {
            if (TorProtocolService.ownsTorDaemon) {
                // if the settings branch exists, load settings from prefs
                if (Services.prefs.getBoolPref(TorSettingsPrefs.enabled, false)) {
                    this.loadFromPrefs();
                    Services.obs.notifyObservers(null, TorSettingsTopics.Ready);
                }
                Services.obs.addObserver(this, BrowserTopics.ProfileAfterChange);
                Services.obs.addObserver(this, TorTopics.ProcessIsReady);
            }
        },

        /* wait for relevant life-cycle events to load and/or apply saved settings */
        observe: function(subject, topic, data) {
            console.log(`TorSettings: observed ${topic}`);

            // once the process is ready, we need to apply our settings
            let handleProcessReady = () => {
                Services.obs.removeObserver(this, TorTopics.ProcessIsReady);
                if (this._settings == null) {
                    // load settings from tor if our load in init() failed and save them to prefs
                    this.loadLegacy();
                    this.saveToPrefs();
                } else {
                    // push down settings to tor
                    this.applySettings();
                }
                Services.obs.notifyObservers(null, TorSettingsTopics.Ready);
            };

            switch (topic) {
                case BrowserTopics.ProfileAfterChange: {
                    if (TorProtocolService.torProcessStatus == TorProcessStatus.Running) {
                        handleProcessReady();
                    }
                }
                break;
                case TorTopics.ProcessIsReady: {
                    handleProcessReady();
                }
                break;
            }
        },

        // load our settings from old locations (misc prefs and from tor daemon)
        // TODO: remove this after some time has elapsed to ensure users have migrated to pref settings
        loadLegacy: function() {
            console.log("TorSettings: loadLegacy()");

            let settings = this.defaultSettings();

            /* Quickstart */
            settings.quickstart.enabled = Services.prefs.getBoolPref(TorLauncherPrefs.quickstart, false);

            /* Bridges

            So the way tor-launcher determines the origin of the configured bridges is a bit
            weird and depends on inferring our scenario based on some firefox prefs and the
            relationship between the saved list of bridges in about:config vs the list saved in torrc

            first off, if "extensions.torlauncher.default_bridge_type" is set to one of our
            builtin default types (obfs4, meek-azure, snowflake, etc) then we provide the
            bridges in "extensions.torlauncher.default_bridge.*" (filtered by our default_bridge_type)

            next, we compare the list of bridges saved in torrc to the bridges stored in the
            "extensions.torlauncher.bridgedb_bridge."" branch. If they match *exactly* then we assume
            the bridges were retrieved from BridgeDB and use those. If the torrc list is empty then we know
            we have no bridge settings

            finally, if none of the previous conditions are not met, it is assumed the bridges stored in
            torrc are user-provided
            */

            let builtinType = Services.prefs.getCharPref(TorLauncherPrefs.default_bridge_type, null);

            // check if source is built-in
            if (builtinType) {
                let builtinBridgeStrings = getBuiltinBridgeStrings(builtinType);
                if (builtinBridgeStrings.length > 0) {
                    settings.bridges.enabled = true;
                    settings.bridges.source = TorBridgeSource.BuiltIn;
                    settings.bridges.builtin_type = builtinType;
                    settings.bridges.bridge_strings = builtinBridgeStrings;
                }
            } else  {
                // get our currently configured bridges from tor
                let torrcBridgeStrings = (() => {
                    let bridgeList = TorProtocolService.readStringArraySetting(TorConfigKeys.bridgeList);
                    let retval = [];
                    for (const line of bridgeList) {
                      let trimmedLine = line.trim();
                      if (trimmedLine) {
                        retval.push(trimmedLine);
                      }
                    }
                    return retval;
                })();

                // torrc has bridges configured
                if (torrcBridgeStrings.length > 0) {
                    // compare tor's bridges to our saved bridgedb bridges
                    let bridgedbBBridgeStrings = (() => {
                        let bridgeBranch = Services.prefs.getBranch(TorLauncherPrefs.bridgedb_bridge);
                        let bridgeBranchPrefs = bridgeBranch.getChildList("");
                        // the child prefs do not come in any particular order so sort the keys
                        // so the values can be compared to what we get out off torrc
                        bridgeBranchPrefs.sort();

                        // just assume all of the prefs under the parent point to valid bridge string
                        let retval = bridgeBranchPrefs.map(key =>
                          bridgeBranch.getCharPref(key).trim()
                        );
                        return retval;
                    })();

                    let arraysEqual = (left, right) => {
                        if (left.length != right.length) {
                            return false;
                        }
                        const length = left.length;
                        for (let i = 0; i < length; ++i) {
                            if (left[i] != right[i]) {
                                return false;
                            }
                        }
                        return true;
                    };

                    if (arraysEqual(torrcBridgeStrings, bridgedbBBridgeStrings)) {
                        settings.bridges.enabled = true;
                        settings.bridges.source = TorBridgeSource.BridgeDB;
                        settings.bridges.builtin_type = null;
                        settings.bridges.bridge_strings = torrcBridgeStrings;
                    } else {
                        settings.bridges.enabled = true;
                        settings.bridges.source = TorBridgeSource.UserProvided;
                        settings.bridges.builtin_type = null;
                        settings.bridges.bridge_strings = torrcBridgeStrings;
                    }
                } else {
                    // tor has no bridge strings saved, so bridges not in use
                    settings.bridges.enabled = false;
                    settings.bridges.source = TorBridgeSource.Invalid;
                    settings.bridges.builtin_type = null;
                    settings.bridges.bridge_strings = [];
                }
            }

            /* Proxy */

            let proxyString = null;
            if (proxyString = TorProtocolService.readStringSetting(TorConfigKeys.socks4Proxy)) {
                let [address, port] = parseAddrPort(proxyString);

                settings.proxy.enabled = true;
                settings.proxy.type = TorProxyType.Socks4;
                settings.proxy.address = address;
                settings.proxy.port = port;
                settings.proxy.username = null;
                settings.proxy.password = null;
            } else if (proxyString = TorProtocolService.readStringSetting(TorConfigKeys.socks5Proxy)) {
                let [address, port] = parseAddrPort(proxyString);
                let username = TorProtocolService.readStringSetting(TorConfigKeys.socks5ProxyUsername);
                let password = TorProtocolService.readStringSetting(TorConfigKeys.socks5ProxyPassword);

                settings.proxy.enabled = true;
                settings.proxy.type = TorProxyType.Socks5;
                settings.proxy.address = address;
                settings.proxy.port = port;
                settings.proxy.username = username;
                settings.proxy.password = password;
            } else if (proxyString = TorProtocolService.readStringSetting(TorConfigKeys.httpsProxy)) {
                let [address, port] = parseAddrPort(proxyString);
                let authenticator = TorProtocolService.readStringSetting(TorConfigKeys.httpsProxyAuthenticator);
                let [username, password] = parseUsernamePassword(authenticator);

                settings.proxy.enabled = true;
                settings.proxy.type = TorProxyType.HTTPS;
                settings.proxy.address = address;
                settings.proxy.port = port;
                settings.proxy.username = username;
                settings.proxy.password = password;
            } else {
                settings.proxy.enabled = false;
                settings.proxy.type = TorProxyType.Invalid;
                settings.proxy.address = null;
                settings.proxy.port = 0;
                settings.proxy.username = null;
                settings.proxy.password = null;
            }

            /* Firewall */
            let firewallString = TorProtocolService.readStringSetting(TorConfigKeys.reachableAddresses);
            if (firewallString) {
                let allowedPorts = parseAddrPortList(firewallString);
                settings.firewall.enabled = allowedPorts.length > 0;
                settings.firewall.allowed_ports = allowedPorts;
            } else {
                settings.firewall.enabled = false;
                settings.firewall.allowed_ports = [];
            }

            this._settings = settings;

            return this;
        },

        // load our settings from prefs
        loadFromPrefs: function() {
            console.log("TorSettings: loadFromPrefs()");

            let settings = this.defaultSettings();

            /* Quickstart */
            settings.quickstart.enabled = Services.prefs.getBoolPref(TorSettingsPrefs.quickstart.enabled);
            /* Bridges */
            settings.bridges.enabled = Services.prefs.getBoolPref(TorSettingsPrefs.bridges.enabled);
            if (settings.bridges.enabled) {
                settings.bridges.source = Services.prefs.getIntPref(TorSettingsPrefs.bridges.source);
                // builtin bridge (obfs4, meek, snowlfake, etc)
                if (settings.bridges.source == TorBridgeSource.BuiltIn) {
                    let builtinType = Services.prefs.getStringPref(TorSettingsPrefs.bridges.builtin_type);
                    settings.bridges.builtin_type = builtinType;
                    // always dynamically load builtin bridges rather than loading the cached versions
                    // if the user upgrades and the builtin bridges have changed, we want to ensure the user
                    // can still bootstrap using the provided bridges
                    let bridgeStrings = getBuiltinBridgeStrings(builtinType);
                    if (bridgeStrings.length > 0) {
                        settings.bridges.bridge_strings = bridgeStrings;
                    } else {
                        // in this case the user is using a builtin bridge that is no longer supported,
                        // reset to settings to default values
                        settings.bridges.enabled = false;
                        settings.bridges.source = TorBridgeSource.Invalid;
                        settings.bridges.builtin_type = null;
                    }
                } else {
                    settings.bridges.bridge_strings = [];
                    let bridgeBranchPrefs = Services.prefs.getBranch(TorSettingsPrefs.bridges.bridge_strings).getChildList("");
                    bridgeBranchPrefs.forEach(pref => {
                        let bridgeString = Services.prefs.getStringPref(`${TorSettingsPrefs.bridges.bridge_strings}${pref}`);
                        settings.bridges.bridge_strings.push(bridgeString);
                    });
                }
            } else {
                settings.bridges.source = TorBridgeSource.Invalid;
                settings.bridges.builtin_type = null;
                settings.bridges.bridge_strings = [];
            }
            /* Proxy */
            settings.proxy.enabled = Services.prefs.getBoolPref(TorSettingsPrefs.proxy.enabled);
            if (settings.proxy.enabled) {
                settings.proxy.type = Services.prefs.getIntPref(TorSettingsPrefs.proxy.type);
                settings.proxy.address = Services.prefs.getStringPref(TorSettingsPrefs.proxy.address);
                settings.proxy.port = Services.prefs.getIntPref(TorSettingsPrefs.proxy.port);
                settings.proxy.username = Services.prefs.getStringPref(TorSettingsPrefs.proxy.username);
                settings.proxy.password = Services.prefs.getStringPref(TorSettingsPrefs.proxy.password);
            } else {
                settings.proxy.type = TorProxyType.Invalid;
                settings.proxy.address = null;
                settings.proxy.port = 0;
                settings.proxy.username = null;
                settings.proxy.password = null;
            }

            /* Firewall */
            settings.firewall.enabled = Services.prefs.getBoolPref(TorSettingsPrefs.firewall.enabled);
            if(settings.firewall.enabled) {
                let portList = Services.prefs.getStringPref(TorSettingsPrefs.firewall.allowed_ports);
                settings.firewall.allowed_ports = parsePortList(portList);
            } else {
                settings.firewall.allowed_ports = 0;
            }

            this._settings = settings;

            return this;
        },

        // save our settings to prefs
        saveToPrefs: function() {
            console.log("TorSettings: saveToPrefs()");

            let settings = this._settings;

            /* Quickstart */
            Services.prefs.setBoolPref(TorSettingsPrefs.quickstart.enabled, settings.quickstart.enabled);
            /* Bridges */
            Services.prefs.setBoolPref(TorSettingsPrefs.bridges.enabled, settings.bridges.enabled);
            if (settings.bridges.enabled) {
                Services.prefs.setIntPref(TorSettingsPrefs.bridges.source, settings.bridges.source);
                if (settings.bridges.source === TorBridgeSource.BuiltIn) {
                    Services.prefs.setStringPref(TorSettingsPrefs.bridges.builtin_type, settings.bridges.builtin_type);
                } else {
                    Services.prefs.clearUserPref(TorSettingsPrefs.bridges.builtin_type);
                }
                // erase existing bridge strings
                let bridgeBranchPrefs = Services.prefs.getBranch(TorSettingsPrefs.bridges.bridge_strings).getChildList("");
                bridgeBranchPrefs.forEach(pref => {
                    Services.prefs.clearUserPref(`${TorSettingsPrefs.bridges.bridge_strings}${pref}`);
                });
                // write new ones
                settings.bridges.bridge_strings.forEach((string, index) => {
                    Services.prefs.setStringPref(`${TorSettingsPrefs.bridges.bridge_strings}.${index}`, string);
                });
            } else {
                Services.prefs.clearUserPref(TorSettingsPrefs.bridges.source);
                Services.prefs.clearUserPref(TorSettingsPrefs.bridges.builtin_type);
                let bridgeBranchPrefs = Services.prefs.getBranch(TorSettingsPrefs.bridges.bridge_strings).getChildList("");
                bridgeBranchPrefs.forEach(pref => {
                    Services.prefs.clearUserPref(`${TorSettingsPrefs.bridges.bridge_strings}${pref}`);
                });
            }
            /* Proxy */
            Services.prefs.setBoolPref(TorSettingsPrefs.proxy.enabled, settings.proxy.enabled);
            if (settings.proxy.enabled) {
                Services.prefs.setIntPref(TorSettingsPrefs.proxy.type, settings.proxy.type);
                Services.prefs.setStringPref(TorSettingsPrefs.proxy.address, settings.proxy.address);
                Services.prefs.setIntPref(TorSettingsPrefs.proxy.port, settings.proxy.port);
                Services.prefs.setStringPref(TorSettingsPrefs.proxy.username, settings.proxy.username);
                Services.prefs.setStringPref(TorSettingsPrefs.proxy.password, settings.proxy.password);
            } else {
                Services.prefs.clearUserPref(TorSettingsPrefs.proxy.type);
                Services.prefs.clearUserPref(TorSettingsPrefs.proxy.address);
                Services.prefs.clearUserPref(TorSettingsPrefs.proxy.port);
                Services.prefs.clearUserPref(TorSettingsPrefs.proxy.username);
                Services.prefs.clearUserPref(TorSettingsPrefs.proxy.password);
            }
            /* Firewall */
            Services.prefs.setBoolPref(TorSettingsPrefs.firewall.enabled, settings.firewall.enabled);
            if (settings.firewall.enabled) {
                Services.prefs.setStringPref(TorSettingsPrefs.firewall.allowed_ports, settings.firewall.allowed_ports.join(","));
            } else {
                Services.prefs.clearUserPref(TorSettingsPrefs.firewall.allowed_ports);
            }

            // all tor settings now stored in prefs :)
            Services.prefs.setBoolPref(TorSettingsPrefs.enabled, true);

            return this;
        },

        // push our settings down to the tor daemon
        applySettings: function() {
            console.log("TorSettings: applySettings()");
            let settings = this._settings;
            let settingsMap = new Map();

            /* Bridges */
            settingsMap.set(TorConfigKeys.useBridges, settings.bridges.enabled);
            if (settings.bridges.enabled) {
                settingsMap.set(TorConfigKeys.bridgeList, settings.bridges.bridge_strings);
            } else {
                // shuffle bridge list
                settingsMap.set(TorConfigKeys.bridgeList, null);
            }

            /* Proxy */
            settingsMap.set(TorConfigKeys.socks4Proxy, null);
            settingsMap.set(TorConfigKeys.socks5Proxy, null);
            settingsMap.set(TorConfigKeys.socks5ProxyUsername, null);
            settingsMap.set(TorConfigKeys.socks5ProxyPassword, null);
            settingsMap.set(TorConfigKeys.httpsProxy, null);
            settingsMap.set(TorConfigKeys.httpsProxyAuthenticator, null);
            if (settings.proxy.enabled) {
                let address = settings.proxy.address;
                let port = settings.proxy.port;
                let username = settings.proxy.username;
                let password = settings.proxy.password;

                switch (settings.proxy.type) {
                  case TorProxyType.Socks4:
                    settingsMap.set(TorConfigKeys.socks4Proxy, `${address}:${port}`);
                    break;
                  case TorProxyType.Socks5:
                    settingsMap.set(TorConfigKeys.socks5Proxy, `${address}:${port}`);
                    settingsMap.set(TorConfigKeys.socks5ProxyUsername, username);
                    settingsMap.set(TorConfigKeys.socks5ProxyPassword, password);
                    break;
                  case TorProxyType.HTTPS:
                    settingsMap.set(TorConfigKeys.httpsProxy, `${address}:${port}`);
                    settingsMap.set(TorConfigKeys.httpsProxyAuthenticator, `${username}:${password}`);
                    break;
                }
            }

            /* Firewall */
            if (settings.firewall.enabled) {
                let reachableAddresses = settings.firewall.allowed_ports.map(port => `*:${port}`).join(",");
                settingsMap.set(TorConfigKeys.reachableAddresses, reachableAddresses);
            } else {
                settingsMap.set(TorConfigKeys.reachableAddresses, null);
            }

            /* Push to Tor */
            TorProtocolService.writeSettings(settingsMap);

            return this;
        },

        /* Getters and Setters */


        // Quickstart
        get quickstart() {
            return {
                get enabled() { return self._settings.quickstart.enabled; },
                set enabled(val) {
                    if (val != self._settings.quickstart.enabled)
                    {
                        self._settings.quickstart.enabled = val;
                        Services.obs.notifyObservers({value: val}, TorSettingsTopics.SettingChanged, TorSettingsData.QuickStartEnabled);
                    }
                },
            };
        },

        // Bridges
        get bridges() {
            return {
                get enabled() { return self._settings.bridges.enabled; },
                set enabled(val) {
                    self._settings.bridges.enabled = val;
                    // reset bridge settings
                    self._settings.bridges.source = TorBridgeSource.Invalid;
                    self._settings.bridges.builtin_type = null;
                    self._settings.bridges.bridge_strings = [];
                },
                get source() { return self._settings.bridges.source; },
                set source(val) { self._settings.bridges.source = val; },
                get builtin_type() { return self._settings.bridges.builtin_type; },
                set builtin_type(val) {
                    let bridgeStrings = getBuiltinBridgeStrings(val);
                    if (bridgeStrings.length > 0) {
                        self._settings.bridges.builtin_type = val;
                        self._settings.bridges.bridge_strings = bridgeStrings;
                    }
                },
                get bridge_strings() { return arrayCopy(self._settings.bridges.bridge_strings); },
                set bridge_strings(val) {
                    self._settings.bridges.bridge_strings = parseBridgeStrings(val);
                },
            };
        },

        // Proxy
        get proxy() {
            return {
                get enabled() { return self._settings.proxy.enabled; },
                set enabled(val) {
                    self._settings.proxy.enabled = val;
                    // reset proxy settings
                    self._settings.proxy.type = TorProxyType.Invalid;
                    self._settings.proxy.address = null;
                    self._settings.proxy.port = 0;
                    self._settings.proxy.username = null;
                    self._settings.proxy.password = null;
                },
                get type() { return self._settings.proxy.type; },
                set type(val) { self._settings.proxy.type = val; },
                get address() { return self._settings.proxy.address; },
                set address(val) { self._settings.proxy.address = val; },
                get port() { return arrayCopy(self._settings.proxy.port); },
                set port(val) { self._settings.proxy.port = parsePort(val); },
                get username() { return self._settings.proxy.username; },
                set username(val) { self._settings.proxy.username = val; },
                get password() { return self._settings.proxy.password; },
                set password(val) { self._settings.proxy.password = val; },
                get uri() {
                    switch (this.type) {
                      case TorProxyType.Socks4:
                        return `socks4a://${this.address}:${this.port}`;
                      case TorProxyType.Socks5:
                        if (this.username) {
                          return `socks5://${this.username}:${this.password}@${this.address}:${this.port}`;
                        }
                        return `socks5://${this.address}:${this.port}`;
                      case TorProxyType.HTTPS:
                        if (this._proxyUsername) {
                          return `http://${this.username}:${this.password}@${this.address}:${this.port}`;
                        }
                        return `http://${this.address}:${this.port}`;
                    }
                    return null;
                },
            };
        },

        // Firewall
        get firewall() {
            return {
                get enabled() { return self._settings.firewall.enabled; },
                set enabled(val) {
                    self._settings.firewall.enabled = val;
                    // reset firewall settings
                    self._settings.firewall.allowed_ports = [];
                },
                get allowed_ports() { return self._settings.firewall.allowed_ports; },
                set allowed_ports(val) { self._settings.firewall.allowed_ports = parsePortList(val); },
            };
        },
    };
    self.init();
    return self;
})();
