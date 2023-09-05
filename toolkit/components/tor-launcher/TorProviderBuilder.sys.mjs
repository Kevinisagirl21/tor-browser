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
   * The observer that checks when the tor process exits, and reinitializes the
   * provider.
   *
   * @type {nsIObserver?}
   */
  static #observer = null;

  /**
   * Tell whether the browser UI is ready.
   * We ignore any errors until it is because we cannot show them.
   *
   * @type {boolean}
   */
  static #uiReady = false;

  /**
   * Initialize the provider of choice.
   * Even though initialization is asynchronous, we do not expect the caller to
   * await this method. The reason is that any call to build() will wait the
   * initialization anyway (and re-throw any initialization error).
   */
  static async init() {
    this.#observer = {
      observe(subject, topic, data) {
        if (topic !== TorProviderTopics.ProcessExited) {
          return;
        }
        if (!TorProviderBuilder.#uiReady) {
          console.warn(
            `Seen ${TorProviderTopics.ProcessExited}, but not doing anything because the UI is not ready yet.`
          );
          return;
        }
        TorProviderBuilder.#torExited();
      },
    };
    Services.obs.addObserver(this.#observer, TorProviderTopics.ProcessExited);
    await this.#initProvider();
  }

  static async #initProvider() {
    this.#provider = new Promise((resolve, reject) => {
      const provider = new lazy.TorProvider();
      provider
        .init()
        .then(() => resolve(provider))
        .catch(reject);
    });
    await this.#provider;
  }

  static uninit() {
    this.#provider?.then(provider => {
      provider.uninit();
      this.#provider = null;
    });
    if (this.#observer) {
      Services.obs.removeObserver(
        this.#observer,
        TorProviderTopics.ProcessExited
      );
      this.#observer = null;
    }
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
      const provider = await this.#provider;
      if (provider.isRunning) {
        this.#uiReady = true;
        return;
      }
      provider.uninit();
    } catch {}
    while (lazy.TorLauncherUtil.showRestartPrompt(true)) {
      try {
        await this.#initProvider();
        break;
      } catch {}
    }
    this.#uiReady = true;
  }

  static async #torExited() {
    while (lazy.TorLauncherUtil.showRestartPrompt(false)) {
      try {
        const old = await this.#provider;
        old?.uninit();
        this.#provider = null;
      } catch {}
      try {
        await this.#initProvider();
        break;
      } catch {}
    }
  }
}
