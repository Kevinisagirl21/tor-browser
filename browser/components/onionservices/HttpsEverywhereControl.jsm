// Copyright (c) 2020, The Tor Project, Inc.

"use strict";

const EXPORTED_SYMBOLS = ["HttpsEverywhereControl"];

const { ExtensionMessaging } = ChromeUtils.import(
  "resource:///modules/ExtensionMessaging.jsm"
);
const { setTimeout } = ChromeUtils.import("resource://gre/modules/Timer.jsm");

const EXTENSION_ID = "https-everywhere-eff@eff.org";
const SECUREDROP_TOR_ONION_CHANNEL_2020 = {
  name: "SecureDropTorOnion",
  jwk: {
    kty: "RSA",
    e: "AQAB",
    n:
      "p10BbUVc5Xj2S_-MH3bACNBaISo_r9e3PVPyTTjsGsdg2qSXvqUO42fBtpFAy0zUzIGS83v4JjiRdvKJaZTIvbC8AcpymzdsTqujMm8RPTSy3hO_8mXzGa4DEsIB1uNLnUWRBKXvSGCmT9kFyxhTpkYqokNBzafVihTU34tN2Md1xFHnmZGqfYtPtbJLWAa5Z1M11EyR4lIyUxIiPTV9t1XstDbWr3iS83REJrGEFmjG1-BAgx8_lDUTa41799N2yYEhgZud7bL0M3ei8s5OERjiion5uANkUV3-s2QqUZjiVA-XR_HizXjciaUWNd683KqekpNOZ_0STh_UGwpcwU-KwG07QyiCrLrRpz8S_vH8CqGrrcWY3GSzYe9dp34jJdO65oA-G8tK6fMXtvTCFDZI6oNNaXJH71F5J0YbqO2ZqwKYc2WSi0gKVl2wd9roOVjaBmkJqvocntYuNM7t38fDEWHn5KUkmrTbiG68Cy56tDUfpKl3D9Uj4LaMvxJ1tKGvzQ4k_60odT7gIxu6DqYjXUHZpwPsSGBq3njaD7boe4CUXF2K7ViOc87BsKxRNCzDD8OklRjjXzOTOBH3PqFJ93CJ-4ECE5t9STU20aZ8E-2zKB8vjKyCySE4-kcIvBBsnkwVaJTPy9Ft1qYybo-soXEWVEZATANNWklBt8k",
  },
  update_path_prefix: "https://securedrop.org/https-everywhere/",
  scope:
    "^https?:\\/\\/[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.securedrop\\.tor\\.onion\\/",
  replaces_default_rulesets: false,
};

const SECUREDROP_TOR_ONION_CHANNEL = {
  name: "SecureDropTorOnion2021",
  jwk: {
    kty: "RSA",
    e: "AQAB",
    n:
      "vsC7BNafkRe8Uh1DUgCkv6RbPQMdJgAKKnWdSqQd7tQzU1mXfmo_k1Py_2MYMZXOWmqSZ9iwIYkykZYywJ2VyMGve4byj1sLn6YQoOkG8g5Z3V4y0S2RpEfmYumNjTzfq8nxtLnwjaYd4sCUd5wa0SzeLrpRQuXo2bF3QuUF2xcbLJloxX1MmlsMMCdBc-qGNonLJ7bpn_JuyXlDWy1Fkeyw1qgjiOdiRIbMC1x302zgzX6dSrBrNB8Cpsh-vCE0ZjUo8M9caEv06F6QbYmdGJHM0ZZY34OHMSNdf-_qUKIV_SuxuSuFE99tkAeWnbWpyI1V-xhVo1sc7NzChP8ci2TdPvI3_0JyAuCvL6zIFqJUJkZibEUghhg6F09-oNJKpy7rhUJq7zZyLXJsvuXnn0gnIxfjRvMcDfZAKUVMZKRdw7fwWzwQril4Ib0MQOVda9vb_4JMk7Gup-TUI4sfuS4NKwsnKoODIO-2U5QpJWdtp1F4AQ1pBv8ajFl1WTrVGvkRGK0woPWaO6pWyJ4kRnhnxrV2FyNNt3JSR-0JEjhFWws47kjBvpr0VRiVRFppKA-plKs4LPlaaCff39TleYmY3mETe3w1GIGc2Lliad32Jpbx496IgDe1K3FMBEoKFZfhmtlRSXft8NKgSzPt2zkatM9bFKfaCYRaSy7akbk",
  },
  update_path_prefix: "https://securedrop.org/https-everywhere-2021/",
  scope:
    "^https?:\\/\\/[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.securedrop\\.tor\\.onion\\/",
  replaces_default_rulesets: false,
};

class HttpsEverywhereControl {
  constructor() {
    this._extensionMessaging = null;
  }

  async _sendMessage(type, object) {
    return this._extensionMessaging.sendMessage(
      {
        type,
        object,
      },
      EXTENSION_ID
    );
  }

  static async wait(seconds = 1) {
    return new Promise(resolve => setTimeout(resolve, seconds * 1000));
  }

  /**
   * Installs the .tor.onion update channel in https-everywhere
   */
  async installTorOnionUpdateChannel(retries = 5) {
    this._init();

    // TODO: https-everywhere store is initialized asynchronously, so sending a message
    // immediately results in a `store.get is undefined` error.
    // For now, let's wait a bit and retry a few times if there is an error, but perhaps
    // we could suggest https-everywhere to send a message when that happens and listen
    // for that here.
    await HttpsEverywhereControl.wait();

    try {
      // Delete the previous channel signing key, and add the new one below.
      await this._sendMessage(
        "delete_update_channel",
        SECUREDROP_TOR_ONION_CHANNEL_2020.name
      );
    } catch (e) {
      if (retries <= 0) {
        throw new Error("Could not uninstall SecureDropTorOnion update channel");
      }
      await this.installTorOnionUpdateChannel(retries - 1);
      return;
    }

    try {
      // TODO: we may want a way to "lock" this update channel, so that it cannot be modified
      // by the user via UI, but I think this is not possible at the time of writing via
      // the existing messages in https-everywhere.
      await this._sendMessage(
        "create_update_channel",
        SECUREDROP_TOR_ONION_CHANNEL.name
      );
    } catch (e) {
      if (retries <= 0) {
        throw new Error("Could not install SecureDropTorOnion update channel");
      }
      await this.installTorOnionUpdateChannel(retries - 1);
      return;
    }

    await this._sendMessage(
      "update_update_channel",
      SECUREDROP_TOR_ONION_CHANNEL
    );
  }

  /**
   * Returns the .tor.onion rulesets available in https-everywhere
   */
  async getTorOnionRules() {
    return this._sendMessage("get_simple_rules_ending_with", ".tor.onion");
  }

  /**
   * Returns the timestamp of the last .tor.onion update channel update.
   */
  async getRulesetTimestamp() {
    const rulesets = await this._sendMessage("get_update_channel_timestamps");
    const securedrop =
      rulesets &&
      rulesets.find(([{ name }]) => name === SECUREDROP_TOR_ONION_CHANNEL.name);
    if (securedrop) {
      const [
        updateChannel, // This has the same structure as SECUREDROP_TOR_ONION_CHANNEL
        lastUpdatedTimestamp, // An integer, 0 if the update channel was never updated
      ] = securedrop;
      void updateChannel; // Ignore eslint unused warning for ruleset
      return lastUpdatedTimestamp;
    }
    return null;
  }

  unload() {
    if (this._extensionMessaging) {
      this._extensionMessaging.unload();
      this._extensionMessaging = null;
    }
  }

  _init() {
    if (!this._extensionMessaging) {
      this._extensionMessaging = new ExtensionMessaging();
    }
  }
}
