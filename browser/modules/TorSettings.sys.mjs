/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  TorLauncherUtil: "resource://gre/modules/TorLauncherUtil.sys.mjs",
  TorProviderBuilder: "resource://gre/modules/TorProviderBuilder.sys.mjs",
  TorProviderTopics: "resource://gre/modules/TorProviderBuilder.sys.mjs",
});

/* TorSettings observer topics */
export const TorSettingsTopics = Object.freeze({
  Ready: "torsettings:ready",
  SettingChanged: "torsettings:setting-changed",
});

/* TorSettings observer data (for SettingChanged topic) */
export const TorSettingsData = Object.freeze({
  QuickStartEnabled: "torsettings:quickstart_enabled",
});

/* Prefs used to store settings in TorBrowser prefs */
const TorSettingsPrefs = Object.freeze({
  /* bool: are we pulling tor settings from the preferences */
  enabled: "torbrowser.settings.enabled",
  quickstart: {
    /* bool: does tor connect automatically on launch */
    enabled: "torbrowser.settings.quickstart.enabled",
  },
  bridges: {
    /* bool:  does tor use bridges */
    enabled: "torbrowser.settings.bridges.enabled",
    /* int: -1=invalid|0=builtin|1=bridge_db|2=user_provided */
    source: "torbrowser.settings.bridges.source",
    /* string: obfs4|meek_azure|snowflake|etc */
    builtin_type: "torbrowser.settings.bridges.builtin_type",
    /* preference branch: each child branch should be a bridge string */
    bridge_strings: "torbrowser.settings.bridges.bridge_strings",
  },
  proxy: {
    /* bool: does tor use a proxy */
    enabled: "torbrowser.settings.proxy.enabled",
    /* -1=invalid|0=socks4,1=socks5,2=https */
    type: "torbrowser.settings.proxy.type",
    /* string: proxy server address */
    address: "torbrowser.settings.proxy.address",
    /* int: [1,65535], proxy port */
    port: "torbrowser.settings.proxy.port",
    /* string: username */
    username: "torbrowser.settings.proxy.username",
    /* string: password */
    password: "torbrowser.settings.proxy.password",
  },
  firewall: {
    /* bool: does tor have a port allow list */
    enabled: "torbrowser.settings.firewall.enabled",
    /* string: comma-delimitted list of port numbers */
    allowed_ports: "torbrowser.settings.firewall.allowed_ports",
  },
});

/* Legacy tor-launcher prefs and pref branches*/
const TorLauncherPrefs = Object.freeze({
  quickstart: "extensions.torlauncher.quickstart",
  default_bridge_type: "extensions.torlauncher.default_bridge_type",
  default_bridge: "extensions.torlauncher.default_bridge.",
  default_bridge_recommended_type:
    "extensions.torlauncher.default_bridge_recommended_type",
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

export const TorBridgeSource = Object.freeze({
  Invalid: -1,
  BuiltIn: 0,
  BridgeDB: 1,
  UserProvided: 2,
});

export const TorProxyType = Object.freeze({
  Invalid: -1,
  Socks4: 0,
  Socks5: 1,
  HTTPS: 2,
});

export const TorBuiltinBridgeTypes = Object.freeze(
  (() => {
    const bridgeListBranch = Services.prefs.getBranch(
      TorLauncherPrefs.default_bridge
    );
    const bridgePrefs = bridgeListBranch.getChildList("");

    // an unordered set for shoving bridge types into
    const bridgeTypes = new Set();
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
    const recommendedBridgeType = Services.prefs.getCharPref(
      TorLauncherPrefs.default_bridge_recommended_type,
      null
    );

    const retval = [];
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
const parsePort = function (aPort) {
  // ensure port string is a valid positive integer
  const validIntRegex = /^[0-9]+$/;
  if (!validIntRegex.test(aPort)) {
    return 0;
  }

  // ensure port value is on valid range
  const port = Number.parseInt(aPort);
  if (port < 1 || port > 65535) {
    return 0;
  }

  return port;
};

// expects a '\n' or '\r\n' delimited bridge string, which we split and trim
// each bridge string can also optionally have 'bridge' at the beginning ie:
// bridge $(type) $(address):$(port) $(certificate)
// we strip out the 'bridge' prefix here
const parseBridgeStrings = function (aBridgeStrings) {
  // replace carriage returns ('\r') with new lines ('\n')
  aBridgeStrings = aBridgeStrings.replace(/\r/g, "\n");
  // then replace contiguous new lines ('\n') with a single one
  aBridgeStrings = aBridgeStrings.replace(/[\n]+/g, "\n");

  // split on the newline and for each bridge string: trim, remove starting 'bridge' string
  // finally discard entries that are empty strings; empty strings could occur if we receive
  // a new line containing only whitespace
  const splitStrings = aBridgeStrings.split("\n");
  return splitStrings
    .map(val => val.trim().replace(/^bridge\s+/i, ""))
    .filter(bridgeString => bridgeString != "");
};

// expecting a ',' delimited list of ints with possible white space between
// returns an array of ints
const parsePortList = function (aPortListString) {
  const splitStrings = aPortListString.split(",");
  // parse and remove duplicates
  const portSet = new Set(splitStrings.map(val => parsePort(val.trim())));
  // parsePort returns 0 for failed parses, so remove 0 from list
  portSet.delete(0);
  return Array.from(portSet);
};

const getBuiltinBridgeStrings = function (builtinType) {
  if (!builtinType) {
    return [];
  }

  const bridgeBranch = Services.prefs.getBranch(
    TorLauncherPrefs.default_bridge
  );
  const bridgeBranchPrefs = bridgeBranch.getChildList("");
  const retval = [];

  // regex matches against strings ending in ".N" where N is a positive integer
  const pattern = /\.[0-9]+$/;
  for (const key of bridgeBranchPrefs) {
    // verify the location of the match is the correct offset required for aBridgeType
    // to fit, and that the string begins with aBridgeType
    if (
      key.search(pattern) == builtinType.length &&
      key.startsWith(builtinType)
    ) {
      const bridgeStr = bridgeBranch.getCharPref(key);
      retval.push(bridgeStr);
    }
  }

  // shuffle so that Tor Browser users don't all try the built-in bridges in the same order
  arrayShuffle(retval);

  return retval;
};

/* Helper methods */

const arrayShuffle = function (array) {
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
};

const arrayCopy = function (array) {
  return [].concat(array);
};

/* TorSettings module */

export const TorSettings = (() => {
  const self = {
    _settings: null,

    // tor daemon related settings
    defaultSettings() {
      const settings = {
        quickstart: {
          enabled: false,
        },
        bridges: {
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

    /* load or init our settings, and register observers */
    async init() {
      // TODO: We could use a shared promise, and wait for it to be fullfilled
      // instead of Service.obs.
      if (lazy.TorLauncherUtil.shouldStartAndOwnTor) {
        // if the settings branch exists, load settings from prefs
        if (Services.prefs.getBoolPref(TorSettingsPrefs.enabled, false)) {
          this.loadFromPrefs();
        } else {
          // otherwise load defaults
          this._settings = this.defaultSettings();
        }
        Services.obs.addObserver(this, lazy.TorProviderTopics.ProcessIsReady);

        try {
          const provider = await lazy.TorProviderBuilder.build();
          if (provider.isRunning) {
            this.handleProcessReady();
          }
        } catch {}
      }
    },

    /* wait for relevant life-cycle events to apply saved settings */
    async observe(subject, topic, data) {
      console.log(`TorSettings: Observed ${topic}`);

      switch (topic) {
        case lazy.TorProviderTopics.ProcessIsReady:
          Services.obs.removeObserver(
            this,
            lazy.TorProviderTopics.ProcessIsReady
          );
          await this.handleProcessReady();
          break;
      }
    },

    // once the tor daemon is ready, we need to apply our settings
    async handleProcessReady() {
      // push down settings to tor
      await this.applySettings();
      console.log("TorSettings: Ready");
      Services.obs.notifyObservers(null, TorSettingsTopics.Ready);
    },

    // load our settings from prefs
    loadFromPrefs() {
      console.log("TorSettings: loadFromPrefs()");

      const settings = this.defaultSettings();

      /* Quickstart */
      settings.quickstart.enabled = Services.prefs.getBoolPref(
        TorSettingsPrefs.quickstart.enabled
      );
      /* Bridges */
      settings.bridges.enabled = Services.prefs.getBoolPref(
        TorSettingsPrefs.bridges.enabled
      );
      settings.bridges.source = Services.prefs.getIntPref(
        TorSettingsPrefs.bridges.source,
        TorBridgeSource.Invalid
      );
      if (settings.bridges.source == TorBridgeSource.BuiltIn) {
        const builtinType = Services.prefs.getStringPref(
          TorSettingsPrefs.bridges.builtin_type
        );
        settings.bridges.builtin_type = builtinType;
        settings.bridges.bridge_strings = getBuiltinBridgeStrings(builtinType);
        if (!settings.bridges.bridge_strings.length) {
          // in this case the user is using a builtin bridge that is no longer supported,
          // reset to settings to default values
          settings.bridges.source = TorBridgeSource.Invalid;
          settings.bridges.builtin_type = null;
        }
      } else {
        settings.bridges.bridge_strings = [];
        const bridgeBranchPrefs = Services.prefs
          .getBranch(TorSettingsPrefs.bridges.bridge_strings)
          .getChildList("");
        bridgeBranchPrefs.forEach(pref => {
          const bridgeString = Services.prefs.getStringPref(
            `${TorSettingsPrefs.bridges.bridge_strings}${pref}`
          );
          settings.bridges.bridge_strings.push(bridgeString);
        });
      }
      /* Proxy */
      settings.proxy.enabled = Services.prefs.getBoolPref(
        TorSettingsPrefs.proxy.enabled
      );
      if (settings.proxy.enabled) {
        settings.proxy.type = Services.prefs.getIntPref(
          TorSettingsPrefs.proxy.type
        );
        settings.proxy.address = Services.prefs.getStringPref(
          TorSettingsPrefs.proxy.address
        );
        settings.proxy.port = Services.prefs.getIntPref(
          TorSettingsPrefs.proxy.port
        );
        settings.proxy.username = Services.prefs.getStringPref(
          TorSettingsPrefs.proxy.username
        );
        settings.proxy.password = Services.prefs.getStringPref(
          TorSettingsPrefs.proxy.password
        );
      } else {
        settings.proxy.type = TorProxyType.Invalid;
        settings.proxy.address = null;
        settings.proxy.port = 0;
        settings.proxy.username = null;
        settings.proxy.password = null;
      }

      /* Firewall */
      settings.firewall.enabled = Services.prefs.getBoolPref(
        TorSettingsPrefs.firewall.enabled
      );
      if (settings.firewall.enabled) {
        const portList = Services.prefs.getStringPref(
          TorSettingsPrefs.firewall.allowed_ports
        );
        settings.firewall.allowed_ports = parsePortList(portList);
      } else {
        settings.firewall.allowed_ports = 0;
      }

      this._settings = settings;

      return this;
    },

    // save our settings to prefs
    saveToPrefs() {
      console.log("TorSettings: saveToPrefs()");

      const settings = this._settings;

      /* Quickstart */
      Services.prefs.setBoolPref(
        TorSettingsPrefs.quickstart.enabled,
        settings.quickstart.enabled
      );
      /* Bridges */
      Services.prefs.setBoolPref(
        TorSettingsPrefs.bridges.enabled,
        settings.bridges.enabled
      );
      Services.prefs.setIntPref(
        TorSettingsPrefs.bridges.source,
        settings.bridges.source
      );
      Services.prefs.setStringPref(
        TorSettingsPrefs.bridges.builtin_type,
        settings.bridges.builtin_type
      );
      // erase existing bridge strings
      const bridgeBranchPrefs = Services.prefs
        .getBranch(TorSettingsPrefs.bridges.bridge_strings)
        .getChildList("");
      bridgeBranchPrefs.forEach(pref => {
        Services.prefs.clearUserPref(
          `${TorSettingsPrefs.bridges.bridge_strings}${pref}`
        );
      });
      // write new ones
      if (settings.bridges.source !== TorBridgeSource.BuiltIn) {
        settings.bridges.bridge_strings.forEach((string, index) => {
          Services.prefs.setStringPref(
            `${TorSettingsPrefs.bridges.bridge_strings}.${index}`,
            string
          );
        });
      }
      /* Proxy */
      Services.prefs.setBoolPref(
        TorSettingsPrefs.proxy.enabled,
        settings.proxy.enabled
      );
      if (settings.proxy.enabled) {
        Services.prefs.setIntPref(
          TorSettingsPrefs.proxy.type,
          settings.proxy.type
        );
        Services.prefs.setStringPref(
          TorSettingsPrefs.proxy.address,
          settings.proxy.address
        );
        Services.prefs.setIntPref(
          TorSettingsPrefs.proxy.port,
          settings.proxy.port
        );
        Services.prefs.setStringPref(
          TorSettingsPrefs.proxy.username,
          settings.proxy.username
        );
        Services.prefs.setStringPref(
          TorSettingsPrefs.proxy.password,
          settings.proxy.password
        );
      } else {
        Services.prefs.clearUserPref(TorSettingsPrefs.proxy.type);
        Services.prefs.clearUserPref(TorSettingsPrefs.proxy.address);
        Services.prefs.clearUserPref(TorSettingsPrefs.proxy.port);
        Services.prefs.clearUserPref(TorSettingsPrefs.proxy.username);
        Services.prefs.clearUserPref(TorSettingsPrefs.proxy.password);
      }
      /* Firewall */
      Services.prefs.setBoolPref(
        TorSettingsPrefs.firewall.enabled,
        settings.firewall.enabled
      );
      if (settings.firewall.enabled) {
        Services.prefs.setStringPref(
          TorSettingsPrefs.firewall.allowed_ports,
          settings.firewall.allowed_ports.join(",")
        );
      } else {
        Services.prefs.clearUserPref(TorSettingsPrefs.firewall.allowed_ports);
      }

      // all tor settings now stored in prefs :)
      Services.prefs.setBoolPref(TorSettingsPrefs.enabled, true);

      return this;
    },

    // push our settings down to the tor daemon
    async applySettings() {
      console.log("TorSettings: applySettings()");
      const settings = this._settings;
      const settingsMap = new Map();

      /* Bridges */
      const haveBridges =
        settings.bridges.enabled && !!settings.bridges.bridge_strings.length;
      settingsMap.set(TorConfigKeys.useBridges, haveBridges);
      if (haveBridges) {
        settingsMap.set(
          TorConfigKeys.bridgeList,
          settings.bridges.bridge_strings
        );
      } else {
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
        const address = settings.proxy.address;
        const port = settings.proxy.port;
        const username = settings.proxy.username;
        const password = settings.proxy.password;

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
            settingsMap.set(
              TorConfigKeys.httpsProxyAuthenticator,
              `${username}:${password}`
            );
            break;
        }
      }

      /* Firewall */
      if (settings.firewall.enabled) {
        const reachableAddresses = settings.firewall.allowed_ports
          .map(port => `*:${port}`)
          .join(",");
        settingsMap.set(TorConfigKeys.reachableAddresses, reachableAddresses);
      } else {
        settingsMap.set(TorConfigKeys.reachableAddresses, null);
      }

      /* Push to Tor */
      const provider = await lazy.TorProviderBuilder.build();
      await provider.writeSettings(settingsMap);

      return this;
    },

    // set all of our settings at once from a settings object
    setSettings(settings) {
      console.log("TorSettings: setSettings()");
      const backup = this.getSettings();

      try {
        this._settings.bridges.enabled = !!settings.bridges.enabled;
        this._settings.bridges.source = settings.bridges.source;
        switch (settings.bridges.source) {
          case TorBridgeSource.BridgeDB:
          case TorBridgeSource.UserProvided:
            this._settings.bridges.bridge_strings =
              settings.bridges.bridge_strings;
            break;
          case TorBridgeSource.BuiltIn: {
            this._settings.bridges.builtin_type = settings.bridges.builtin_type;
            settings.bridges.bridge_strings = getBuiltinBridgeStrings(
              settings.bridges.builtin_type
            );
            if (
              !settings.bridges.bridge_strings.length &&
              settings.bridges.enabled
            ) {
              throw new Error(
                `No available builtin bridges of type ${settings.bridges.builtin_type}`
              );
            }
            this._settings.bridges.bridge_strings =
              settings.bridges.bridge_strings;
            break;
          }
          case TorBridgeSource.Invalid:
            break;
          default:
            if (settings.bridges.enabled) {
              throw new Error(
                `Bridge source '${settings.source}' is not a valid source`
              );
            }
            break;
        }

        // TODO: proxy and firewall
      } catch (ex) {
        this._settings = backup;
        console.log(`TorSettings: setSettings failed => ${ex.message}`);
      }

      console.log("TorSettings: setSettings result");
      console.log(this._settings);
    },

    // get a copy of all our settings
    getSettings() {
      console.log("TorSettings: getSettings()");
      // TODO: replace with structuredClone someday (post esr94): https://developer.mozilla.org/en-US/docs/Web/API/structuredClone
      return JSON.parse(JSON.stringify(this._settings));
    },

    /* Getters and Setters */

    // Quickstart
    get quickstart() {
      return {
        get enabled() {
          return self._settings.quickstart.enabled;
        },
        set enabled(val) {
          if (val != self._settings.quickstart.enabled) {
            self._settings.quickstart.enabled = val;
            Services.obs.notifyObservers(
              { value: val },
              TorSettingsTopics.SettingChanged,
              TorSettingsData.QuickStartEnabled
            );
          }
        },
      };
    },

    // Bridges
    get bridges() {
      return {
        get enabled() {
          return self._settings.bridges.enabled;
        },
        set enabled(val) {
          self._settings.bridges.enabled = val;
        },
        get source() {
          return self._settings.bridges.source;
        },
        set source(val) {
          self._settings.bridges.source = val;
        },
        get builtin_type() {
          return self._settings.bridges.builtin_type;
        },
        set builtin_type(val) {
          const bridgeStrings = getBuiltinBridgeStrings(val);
          if (bridgeStrings.length) {
            self._settings.bridges.builtin_type = val;
            self._settings.bridges.bridge_strings = bridgeStrings;
          } else {
            self._settings.bridges.builtin_type = "";
            if (self._settings.bridges.source === TorBridgeSource.BuiltIn) {
              self._settings.bridges.source = TorBridgeSource.Invalid;
            }
          }
        },
        get bridge_strings() {
          return arrayCopy(self._settings.bridges.bridge_strings);
        },
        set bridge_strings(val) {
          self._settings.bridges.bridge_strings = parseBridgeStrings(val);
        },
      };
    },

    // Proxy
    get proxy() {
      return {
        get enabled() {
          return self._settings.proxy.enabled;
        },
        set enabled(val) {
          self._settings.proxy.enabled = val;
          // reset proxy settings
          self._settings.proxy.type = TorProxyType.Invalid;
          self._settings.proxy.address = null;
          self._settings.proxy.port = 0;
          self._settings.proxy.username = null;
          self._settings.proxy.password = null;
        },
        get type() {
          return self._settings.proxy.type;
        },
        set type(val) {
          self._settings.proxy.type = val;
        },
        get address() {
          return self._settings.proxy.address;
        },
        set address(val) {
          self._settings.proxy.address = val;
        },
        get port() {
          return arrayCopy(self._settings.proxy.port);
        },
        set port(val) {
          self._settings.proxy.port = parsePort(val);
        },
        get username() {
          return self._settings.proxy.username;
        },
        set username(val) {
          self._settings.proxy.username = val;
        },
        get password() {
          return self._settings.proxy.password;
        },
        set password(val) {
          self._settings.proxy.password = val;
        },
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
        get enabled() {
          return self._settings.firewall.enabled;
        },
        set enabled(val) {
          self._settings.firewall.enabled = val;
          // reset firewall settings
          self._settings.firewall.allowed_ports = [];
        },
        get allowed_ports() {
          return self._settings.firewall.allowed_ports;
        },
        set allowed_ports(val) {
          self._settings.firewall.allowed_ports = parsePortList(val);
        },
      };
    },
  };
  return self;
})();
