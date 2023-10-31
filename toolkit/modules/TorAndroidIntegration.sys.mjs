/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ConsoleAPI } from "resource://gre/modules/Console.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  EventDispatcher: "resource://gre/modules/Messaging.sys.mjs",
  TorConnect: "resource://gre/modules/TorConnect.sys.mjs",
  TorProviderBuilder: "resource://gre/modules/TorProviderBuilder.sys.mjs",
  TorSettings: "resource://gre/modules/TorSettings.sys.mjs",
});

const Prefs = Object.freeze({
  useNewBootstrap: "browser.tor_android.use_new_bootstrap",
  logLevel: "browser.tor_android.log_level",
});

const logger = new ConsoleAPI({
  maxLogLevel: "info",
  maxLogLevelPref: Prefs.logLevel,
  prefix: "TorAndroidIntegration",
});

const ListenedEvents = Object.freeze({
  settingsGet: "GeckoView:Tor:SettingsGet",
  settingsSet: "GeckoView:Tor:SettingsSet",
  settingsApply: "GeckoView:Tor:SettingsApply",
  settingsSave: "GeckoView:Tor:SettingsSave",
});

class TorAndroidIntegrationImpl {
  #initialized = false;

  init() {
    lazy.EventDispatcher.instance.registerListener(
      this,
      Object.values(ListenedEvents)
    );

    this.#bootstrapMethodReset();
    Services.prefs.addObserver(Prefs.useNewBootstrap, this);
  }

  async #initNewBootstrap() {
    if (this.#initialized) {
      return;
    }
    this.#initialized = true;

    lazy.TorProviderBuilder.init().finally(() => {
      lazy.TorProviderBuilder.firstWindowLoaded();
    });
    try {
      await lazy.TorSettings.init();
      await lazy.TorConnect.init();
    } catch (e) {
      logger.error("Cannot initialize TorSettings or TorConnect", e);
    }
  }

  observe(subj, topic, data) {
    switch (topic) {
      case "nsPref:changed":
        if (data === Prefs.useNewBootstrap) {
          this.#bootstrapMethodReset();
        }
        break;
    }
  }

  async onEvent(event, data, callback) {
    logger.debug(`Received event ${event}`, data);
    try {
      switch (event) {
        case settingsGet:
          callback?.onSuccess(lazy.TorSettings.getSettings());
          return;
        case settingsSet:
          // This does not throw, so we do not have any way to report the error!
          lazy.TorSettings.setSettings(data);
          break;
        case settingsApply:
          await lazy.TorSettings.applySettings();
          break;
        case settingsSave:
          await lazy.TorSettings.saveSettings();
          break;
      }
      callback?.onSuccess();
    } catch (e) {
      logger.error();
      callback?.sendError(e);
    }
  }

  #bootstrapMethodReset() {
    if (Services.prefs.getBoolPref(Prefs.useNewBootstrap, false)) {
      this.#initNewBootstrap();
    } else {
      Services.prefs.clearUserPref("network.proxy.socks");
      Services.prefs.clearUserPref("network.proxy.socks_port");
    }
  }
}

export const TorAndroidIntegration = new TorAndroidIntegrationImpl();
