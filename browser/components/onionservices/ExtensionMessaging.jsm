// Copyright (c) 2020, The Tor Project, Inc.

"use strict";

const EXPORTED_SYMBOLS = ["ExtensionMessaging"];

const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");
const { ExtensionUtils } = ChromeUtils.import(
  "resource://gre/modules/ExtensionUtils.jsm"
);
const { MessageChannel } = ChromeUtils.import(
  "resource://gre/modules/MessageChannel.jsm"
);
const { AddonManager } = ChromeUtils.import(
  "resource://gre/modules/AddonManager.jsm"
);

const { XPCOMUtils } = ChromeUtils.import(
  "resource://gre/modules/XPCOMUtils.jsm"
);

XPCOMUtils.defineLazyModuleGetters(this, {
  ExtensionParent: "resource://gre/modules/ExtensionParent.jsm",
});

class ExtensionMessaging {
  constructor() {
    this._callback = null;
    this._handlers = new Map();
    this._messageManager = Services.cpmm;
  }

  async sendMessage(message, extensionId) {
    const addon = await AddonManager.getAddonByID(extensionId);
    if (!addon) {
      throw new Error(`extension '${extensionId} does not exist`);
    }
    await addon.startupPromise;

    const { torSendExtensionMessage } = ExtensionParent;
    return torSendExtensionMessage(extensionId, message);
  }

  unload() {
    if (this._callback) {
      this._handlers.clear();
      this._messageManager.removeMessageListener(
        "MessageChannel:Response",
        this._callback
      );
      this._callback = null;
    }
  }

  _onMessage({ data }) {
    const channelId = data.messageName;
    if (this._handlers.has(channelId)) {
      const { resolve, reject } = this._handlers.get(channelId);
      this._handlers.delete(channelId);
      if (data.error) {
        reject(new Error(data.error.message));
      } else {
        resolve(data.value);
      }
    }
  }

  _init() {
    if (this._callback === null) {
      this._callback = this._onMessage.bind(this);
      this._messageManager.addMessageListener(
        "MessageChannel:Response",
        this._callback
      );
    }
  }
}
