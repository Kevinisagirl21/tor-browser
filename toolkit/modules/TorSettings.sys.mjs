/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  TorLauncherUtil: "resource://gre/modules/TorLauncherUtil.sys.mjs",
  TorProviderBuilder: "resource://gre/modules/TorProviderBuilder.sys.mjs",
  TorProviderTopics: "resource://gre/modules/TorProviderBuilder.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "logger", () => {
  let { ConsoleAPI } = ChromeUtils.importESModule(
    "resource://gre/modules/Console.sys.mjs"
  );
  return new ConsoleAPI({
    maxLogLevel: "warn",
    maxLogLevelPref: "browser.torsettings.log_level",
    prefix: "TorSettings",
  });
});

/* TorSettings observer topics */
export const TorSettingsTopics = Object.freeze({
  Ready: "torsettings:ready",
  SettingsChanged: "torsettings:settings-changed",
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
    /* int: See TorBridgeSource */
    source: "torbrowser.settings.bridges.source",
    /* string: obfs4|meek_azure|snowflake|etc */
    builtin_type: "torbrowser.settings.bridges.builtin_type",
    /* preference branch: each child branch should be a bridge string */
    bridge_strings: "torbrowser.settings.bridges.bridge_strings",
  },
  proxy: {
    /* bool: does tor use a proxy */
    enabled: "torbrowser.settings.proxy.enabled",
    /* See TorProxyType */
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

/* TorSettings module */

export const TorSettings = (() => {
  const self = {
    /**
     * The underlying settings values.
     *
     * @type {object}
     */
    _settings: {
      quickstart: {
        enabled: false,
      },
      bridges: {
        enabled: false,
        source: TorBridgeSource.Invalid,
        builtin_type: "",
        bridge_strings: [],
      },
      proxy: {
        enabled: false,
        type: TorProxyType.Invalid,
        address: "",
        port: 0,
        username: "",
        password: "",
      },
      firewall: {
        enabled: false,
        allowed_ports: [],
      },
    },

    /**
     * The current number of freezes applied to the notifications.
     *
     * @type {integer}
     */
    _freezeNotificationsCount: 0,
    /**
     * The queue for settings that have changed. To be broadcast in the
     * notification when not frozen.
     *
     * @type {Set<string>}
     */
    _notificationQueue: new Set(),
    /**
     * Send a notification if we have any queued and we are not frozen.
     */
    _tryNotification() {
      if (this._freezeNotificationsCount || !this._notificationQueue.size) {
        return;
      }
      Services.obs.notifyObservers(
        { changes: [...this._notificationQueue] },
        TorSettingsTopics.SettingsChanged
      );
      this._notificationQueue.clear();
    },
    /**
     * Pause notifications for changes in setting values. This is useful if you
     * need to make batch changes to settings.
     *
     * This should always be paired with a call to thawNotifications once
     * notifications should be released. Usually you should wrap whatever
     * changes you make with a `try` block and call thawNotifications in the
     * `finally` block.
     */
    freezeNotifications() {
      this._freezeNotificationsCount++;
    },
    /**
     * Release the hold on notifications so they may be sent out.
     *
     * Note, if some other method has also frozen the notifications, this will
     * only release them once it has also called this method.
     */
    thawNotifications() {
      this._freezeNotificationsCount--;
      this._tryNotification();
    },
    /**
     * @typedef {object} TorSettingProperty
     *
     * @property {function} [getter] - A getter for the property. If this is
     *   given, the property cannot be set.
     * @property {function} [transform] - Called in the setter for the property,
     *   with the new value given. Should transform the given value into the
     *   right type.
     * @property {function} [equal] - Test whether two values for the property
     *   are considered equal. Otherwise uses `===`.
     * @property {function} [callback] - Called whenever the property value
     *   changes, with the new value given. Should be used to trigger any other
     *   required changes for the new value.
     * @property {function} [copy] - Called whenever the property is read, with
     *   the stored value given. Should return a copy of the value. Otherwise
     *   returns the stored value.
     */
    /**
     * Add properties to the TorSettings instance, to be read or set.
     *
     * @param {string} groupname - The name of the setting group. The given
     *   settings will be accessible from the TorSettings property of the same
     *   name.
     * @param {object<string, TorSettingProperty>} propParams - An object that
     *   defines the settings to add to this group. The object property names
     *   will be mapped to properties of TorSettings under the given groupname
     *   property. Details about the setting should be described in the
     *   TorSettingProperty property value.
     */
    _addProperties(groupname, propParams) {
      // Create a new object to hold all these settings.
      const group = {};
      for (const name in propParams) {
        const { getter, transform, callback, copy, equal } = propParams[name];
        Object.defineProperty(group, name, {
          get: getter
            ? getter
            : () => {
                let val = this._settings[groupname][name];
                if (copy) {
                  val = copy(val);
                }
                // Assume string or number value.
                return val;
              },
          set: getter
            ? undefined
            : val => {
                const prevVal = this._settings[groupname][name];
                this.freezeNotifications();
                try {
                  if (transform) {
                    val = transform(val);
                  }
                  const isEqual = equal ? equal(val, prevVal) : val === prevVal;
                  if (!isEqual) {
                    if (callback) {
                      callback(val);
                    }
                    this._settings[groupname][name] = val;
                    this._notificationQueue.add(`${groupname}.${name}`);
                  }
                } finally {
                  this.thawNotifications();
                }
              },
        });
      }
      // The group object itself should not be writable.
      Object.preventExtensions(group);
      Object.defineProperty(this, groupname, {
        writable: false,
        value: group,
      });
    },

    /**
     * Regular expression for a decimal non-negative integer.
     *
     * @type {RegExp}
     */
    _portRegex: /^[0-9]+$/,
    /**
     * Parse a string as a port number.
     *
     * @param {string|integer} val - The value to parse.
     * @param {boolean} trim - Whether a string value can be stripped of
     *   whitespace before parsing.
     *
     * @return {integer?} - The port number, or null if the given value was not
     *   valid.
     */
    _parsePort(val, trim) {
      if (typeof val === "string") {
        if (trim) {
          val = val.trim();
        }
        // ensure port string is a valid positive integer
        if (this._portRegex.test(val)) {
          val = Number.parseInt(val, 10);
        } else {
          lazy.logger.error(`Invalid port string "${val}"`);
          return null;
        }
      }
      if (!Number.isInteger(val) || val < 1 || val > 65535) {
        lazy.logger.error(`Port out of range: ${val}`);
        return null;
      }
      return val;
    },
    /**
     * Test whether two arrays have equal members and order.
     *
     * @param {Array} val1 - The first array to test.
     * @param {Array} val2 - The second array to compare against.
     *
     * @return {boolean} - Whether the two arrays are equal.
     */
    _arrayEqual(val1, val2) {
      if (val1.length !== val2.length) {
        return false;
      }
      return val1.every((v, i) => v === val2[i]);
    },

    /* load or init our settings, and register observers */
    async init() {
      this._addProperties("quickstart", {
        enabled: {},
      });
      this._addProperties("bridges", {
        enabled: {},
        source: {
          transform: val => {
            if (Object.values(TorBridgeSource).includes(val)) {
              return val;
            }
            lazy.logger.error(`Not a valid bridge source: "${val}"`);
            return TorBridgeSource.Invalid;
          },
        },
        bridge_strings: {
          transform: val => {
            if (Array.isArray(val)) {
              return [...val];
            }
            return parseBridgeStrings(val);
          },
          copy: val => [...val],
          equal: (val1, val2) => this._arrayEqual(val1, val2),
        },
        builtin_type: {
          callback: val => {
            if (!val) {
              // Make sure that the source is not BuiltIn
              if (this.bridges.source === TorBridgeSource.BuiltIn) {
                this.bridges.source = TorBridgeSource.Invalid;
              }
              return;
            }
            const bridgeStrings = getBuiltinBridgeStrings(val);
            if (bridgeStrings.length) {
              this.bridges.bridge_strings = bridgeStrings;
              return;
            }
            lazy.logger.error(`No built-in ${val} bridges found`);
            // Change to be empty, this will trigger this callback again,
            // but with val as "".
            this.bridges.builtin_type == "";
          },
        },
      });
      this._addProperties("proxy", {
        enabled: {
          callback: val => {
            if (val) {
              return;
            }
            // Reset proxy settings.
            this.proxy.type = TorProxyType.Invalid;
            this.proxy.address = "";
            this.proxy.port = 0;
            this.proxy.username = "";
            this.proxy.password = "";
          },
        },
        type: {
          transform: val => {
            if (Object.values(TorProxyType).includes(val)) {
              return val;
            }
            lazy.logger.error(`Not a valid proxy type: "${val}"`);
            return TorProxyType.Invalid;
          },
        },
        address: {},
        port: {
          transform: val => {
            if (val === 0) {
              // This is a valid value that "unsets" the port.
              // Keep this value without giving a warning.
              // NOTE: In contrast, "0" is not valid.
              return 0;
            }
            // Unset to 0 if invalid null is returned.
            return this._parsePort(val, false) ?? 0;
          },
        },
        username: {},
        password: {},
        uri: {
          getter: () => {
            const { type, address, port, username, password } = this.proxy;
            switch (type) {
              case TorProxyType.Socks4:
                return `socks4a://${address}:${port}`;
              case TorProxyType.Socks5:
                if (username) {
                  return `socks5://${username}:${password}@${address}:${port}`;
                }
                return `socks5://${address}:${port}`;
              case TorProxyType.HTTPS:
                if (username) {
                  return `http://${username}:${password}@${address}:${port}`;
                }
                return `http://${address}:${port}`;
            }
            return null;
          },
        },
      });
      this._addProperties("firewall", {
        enabled: {
          callback: val => {
            if (!val) {
              this.firewall.allowed_ports = "";
            }
          },
        },
        allowed_ports: {
          transform: val => {
            if (!Array.isArray(val)) {
              val = val === "" ? [] : val.split(",");
            }
            // parse and remove duplicates
            const portSet = new Set(val.map(p => this._parsePort(p, true)));
            // parsePort returns null for failed parses, so remove it.
            portSet.delete(null);
            return [...portSet];
          },
          copy: val => [...val],
          equal: (val1, val2) => this._arrayEqual(val1, val2),
        },
      });

      // TODO: We could use a shared promise, and wait for it to be fullfilled
      // instead of Service.obs.
      if (lazy.TorLauncherUtil.shouldStartAndOwnTor) {
        // if the settings branch exists, load settings from prefs
        if (Services.prefs.getBoolPref(TorSettingsPrefs.enabled, false)) {
          // Do not want notifications for initially loaded prefs.
          this.freezeNotifications();
          try {
            this.loadFromPrefs();
          } finally {
            this._notificationQueue.clear();
            this.thawNotifications();
          }
        }
        try {
          const provider = await lazy.TorProviderBuilder.build();
          if (provider.isRunning) {
            this.handleProcessReady();
            // No need to add an observer to call this again.
            return;
          }
        } catch {}

        Services.obs.addObserver(this, lazy.TorProviderTopics.ProcessIsReady);
      }
    },

    /* wait for relevant life-cycle events to apply saved settings */
    async observe(subject, topic, data) {
      lazy.logger.debug(`Observed ${topic}`);

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
      lazy.logger.info("Ready");
      Services.obs.notifyObservers(null, TorSettingsTopics.Ready);
    },

    // load our settings from prefs
    loadFromPrefs() {
      lazy.logger.debug("loadFromPrefs()");

      /* Quickstart */
      this.quickstart.enabled = Services.prefs.getBoolPref(
        TorSettingsPrefs.quickstart.enabled,
        false
      );
      /* Bridges */
      this.bridges.enabled = Services.prefs.getBoolPref(
        TorSettingsPrefs.bridges.enabled,
        false
      );
      this.bridges.source = Services.prefs.getIntPref(
        TorSettingsPrefs.bridges.source,
        TorBridgeSource.Invalid
      );
      if (this.bridges.source == TorBridgeSource.BuiltIn) {
        this.bridges.builtin_type = Services.prefs.getStringPref(
          TorSettingsPrefs.bridges.builtin_type,
          ""
        );
      } else {
        const bridgeBranchPrefs = Services.prefs
          .getBranch(TorSettingsPrefs.bridges.bridge_strings)
          .getChildList("");
        this.bridges.bridge_strings = Array.from(bridgeBranchPrefs, pref =>
          Services.prefs.getStringPref(
            `${TorSettingsPrefs.bridges.bridge_strings}${pref}`
          )
        );
      }
      /* Proxy */
      this.proxy.enabled = Services.prefs.getBoolPref(
        TorSettingsPrefs.proxy.enabled,
        false
      );
      if (this.proxy.enabled) {
        this.proxy.type = Services.prefs.getIntPref(
          TorSettingsPrefs.proxy.type,
          TorProxyType.Invalid
        );
        this.proxy.address = Services.prefs.getStringPref(
          TorSettingsPrefs.proxy.address,
          ""
        );
        this.proxy.port = Services.prefs.getIntPref(
          TorSettingsPrefs.proxy.port,
          0
        );
        this.proxy.username = Services.prefs.getStringPref(
          TorSettingsPrefs.proxy.username,
          ""
        );
        this.proxy.password = Services.prefs.getStringPref(
          TorSettingsPrefs.proxy.password,
          ""
        );
      }

      /* Firewall */
      this.firewall.enabled = Services.prefs.getBoolPref(
        TorSettingsPrefs.firewall.enabled,
        false
      );
      if (this.firewall.enabled) {
        this.firewall.allowed_ports = Services.prefs.getStringPref(
          TorSettingsPrefs.firewall.allowed_ports,
          ""
        );
      }
    },

    // save our settings to prefs
    saveToPrefs() {
      lazy.logger.debug("saveToPrefs()");

      /* Quickstart */
      Services.prefs.setBoolPref(
        TorSettingsPrefs.quickstart.enabled,
        this.quickstart.enabled
      );
      /* Bridges */
      Services.prefs.setBoolPref(
        TorSettingsPrefs.bridges.enabled,
        this.bridges.enabled
      );
      Services.prefs.setIntPref(
        TorSettingsPrefs.bridges.source,
        this.bridges.source
      );
      Services.prefs.setStringPref(
        TorSettingsPrefs.bridges.builtin_type,
        this.bridges.builtin_type
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
      if (this.bridges.source !== TorBridgeSource.BuiltIn) {
        this.bridges.bridge_strings.forEach((string, index) => {
          Services.prefs.setStringPref(
            `${TorSettingsPrefs.bridges.bridge_strings}.${index}`,
            string
          );
        });
      }
      /* Proxy */
      Services.prefs.setBoolPref(
        TorSettingsPrefs.proxy.enabled,
        this.proxy.enabled
      );
      if (this.proxy.enabled) {
        Services.prefs.setIntPref(TorSettingsPrefs.proxy.type, this.proxy.type);
        Services.prefs.setStringPref(
          TorSettingsPrefs.proxy.address,
          this.proxy.address
        );
        Services.prefs.setIntPref(TorSettingsPrefs.proxy.port, this.proxy.port);
        Services.prefs.setStringPref(
          TorSettingsPrefs.proxy.username,
          this.proxy.username
        );
        Services.prefs.setStringPref(
          TorSettingsPrefs.proxy.password,
          this.proxy.password
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
        this.firewall.enabled
      );
      if (this.firewall.enabled) {
        Services.prefs.setStringPref(
          TorSettingsPrefs.firewall.allowed_ports,
          this.firewall.allowed_ports.join(",")
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
      lazy.logger.debug("applySettings()");
      const settingsMap = new Map();

      /* Bridges */
      const haveBridges =
        this.bridges.enabled && !!this.bridges.bridge_strings.length;
      settingsMap.set(TorConfigKeys.useBridges, haveBridges);
      if (haveBridges) {
        settingsMap.set(TorConfigKeys.bridgeList, this.bridges.bridge_strings);
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
      if (this.proxy.enabled) {
        const address = this.proxy.address;
        const port = this.proxy.port;
        const username = this.proxy.username;
        const password = this.proxy.password;

        switch (this.proxy.type) {
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
      if (this.firewall.enabled) {
        const reachableAddresses = this.firewall.allowed_ports
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
      lazy.logger.debug("setSettings()");
      const backup = this.getSettings();
      const backup_notifications = [...this._notificationQueue];

      // Hold off on lots of notifications until all settings are changed.
      this.freezeNotifications();
      try {
        this.bridges.enabled = !!settings.bridges.enabled;
        this.bridges.source = settings.bridges.source;
        switch (settings.bridges.source) {
          case TorBridgeSource.BridgeDB:
          case TorBridgeSource.UserProvided:
            this.bridges.bridge_strings = settings.bridges.bridge_strings;
            break;
          case TorBridgeSource.BuiltIn: {
            this.bridges.builtin_type = settings.bridges.builtin_type;
            if (!this.bridges.bridge_strings.length) {
              // No bridges were found when setting the builtin_type.
              throw new Error(
                `No available builtin bridges of type ${settings.bridges.builtin_type}`
              );
            }
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
        // Restore the old settings without any new notifications generated from
        // the above code.
        // NOTE: Since this code is not async, it should not be possible for
        // some other call to TorSettings to change anything whilst we are
        // in this context (other than lower down in this call stack), so it is
        // safe to discard all changes to settings and notifications.
        this._settings = backup;
        this._notificationQueue.clear();
        for (const notification of backup_notifications) {
          this._notificationQueue.add(notification);
        }

        lazy.logger.error("setSettings failed", ex);
      } finally {
        this.thawNotifications();
      }

      lazy.logger.debug("setSettings result", this._settings);
    },

    // get a copy of all our settings
    getSettings() {
      lazy.logger.debug("getSettings()");
      return structuredClone(this._settings);
    },
  };
  return self;
})();
