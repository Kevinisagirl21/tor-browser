/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  TorLauncherUtil: "resource://gre/modules/TorLauncherUtil.sys.mjs",
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

/**
 * The factory to get a Tor provider.
 * Currently we support only TorProvider, i.e., the one that interacts with
 * C-tor through the control port protocol.
 */
export class TorProviderBuilder {
  /**
   * A promise with the instance of the provider that we are using.
   *
   * @type {Promise<TorProvider>?}
   */
  static #provider = null;

  /**
   * Initialize the provider of choice.
   * Even though initialization is asynchronous, we do not expect the caller to
   * await this method. The reason is that any call to build() will wait the
   * initialization anyway (and re-throw any initialization error).
   */
  static init() {
    this.#provider = new Promise((resolve, reject) => {
      const provider = new lazy.TorProvider();
      provider
        .init()
        .then(() => resolve(provider))
        .catch(reject);
    });
  }

  static uninit() {
    this.#provider?.then(provider => {
      provider.uninit();
      this.#provider = null;
    });
  }

  /**
   * Build a provider.
   * This method will wait for the system to be initialized, and allows you to
   * catch also any initialization errors.
   */
  static async build() {
    if (!this.#provider) {
      throw new Error(
        "The provider has not been initialized or already uninitialized."
      );
    }
    return this.#provider;
  }

  /**
   * Check if the provider has been succesfully initialized when the first
   * browser window is shown.
   * This is a workaround we need because ideally we would like the tor process
   * to start as soon as possible, to avoid delays in the about:torconnect page,
   * but we should modify TorConnect and about:torconnect to handle this case
   * there with a better UX.
   */
  static async firstWindowLoaded() {
    // FIXME: Just integrate this with the about:torconnect or about:tor UI.
    try {
      await this.#provider;
    } catch {
      while (lazy.TorLauncherUtil.showRestartPrompt(true)) {
        try {
          this.init();
          await this.#provider;
          break;
        } catch {}
      }
    }
  }
}
