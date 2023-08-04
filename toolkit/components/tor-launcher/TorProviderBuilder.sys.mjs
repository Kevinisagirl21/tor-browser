/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  TorProtocolService: "resource://gre/modules/TorProtocolService.sys.mjs",
});

export const TorProviderTopics = Object.freeze({
  ProcessIsReady: "TorProcessIsReady",
  ProcessExited: "TorProcessExited",
  ProcessRestarted: "TorProcessRestarted",
  BootstrapStatus: "TorBootstrapStatus",
  BootstrapError: "TorBootstrapError",
  HasWarnOrErr: "TorLogHasWarnOrErr",
  BridgeChanged: "TorBridgeChanged",
  StreamSucceeded: "TorStreamSucceeded",
});

export class TorProviderBuilder {
  static async init() {
    await lazy.TorProtocolService.init();
  }

  static uninit() {
    lazy.TorProtocolService.uninit();
  }

  // TODO: Switch to an async build?
  static build() {
    return lazy.TorProtocolService;
  }
}
