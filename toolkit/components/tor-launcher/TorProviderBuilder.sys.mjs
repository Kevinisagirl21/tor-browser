/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  TorProvider: "resource://gre/modules/TorProvider.sys.mjs",
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
  static #provider = null;

  static async init() {
    const provider = new lazy.TorProvider();
    await provider.init();
    // Assign it only when initialization succeeds.
    TorProviderBuilder.#provider = provider;
  }

  static uninit() {
    TorProviderBuilder.#provider.uninit();
    TorProviderBuilder.#provider = null;
  }

  // TODO: Switch to an async build?
  static build() {
    if (!TorProviderBuilder.#provider) {
      throw new Error("TorProviderBuilder has not been initialized yet.");
    }
    return TorProviderBuilder.#provider;
  }
}
