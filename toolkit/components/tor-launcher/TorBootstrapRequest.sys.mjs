import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";

import { TorProviderBuilder } from "resource://gre/modules/TorProviderBuilder.sys.mjs";

/* tor-launcher observer topics */
export const TorTopics = Object.freeze({
  BootstrapStatus: "TorBootstrapStatus",
  BootstrapError: "TorBootstrapError",
});

// modeled after XMLHttpRequest
// nicely encapsulates the observer register/unregister logic
// TODO: Remove this class, and move its logic inside the TorProvider.
export class TorBootstrapRequest {
  // number of ms to wait before we abandon the bootstrap attempt
  // a value of 0 implies we never wait
  timeout = 0;

  // callbacks for bootstrap process status updates
  onbootstrapstatus = (progress, status) => {};
  onbootstrapcomplete = () => {};
  onbootstraperror = error => {};

  // internal resolve() method for bootstrap
  #bootstrapPromiseResolve = null;
  #bootstrapPromise = null;
  #timeoutID = null;

  observe(subject, topic, data) {
    const obj = subject?.wrappedJSObject;
    switch (topic) {
      case TorTopics.BootstrapStatus: {
        const progress = obj.PROGRESS;
        if (this.onbootstrapstatus) {
          const status = obj.TAG;
          this.onbootstrapstatus(progress, status);
        }
        if (progress === 100) {
          if (this.onbootstrapcomplete) {
            this.onbootstrapcomplete();
          }
          this.#bootstrapPromiseResolve(true);
          clearTimeout(this.#timeoutID);
          this.#timeoutID = null;
        }

        break;
      }
      case TorTopics.BootstrapError: {
        console.info("TorBootstrapRequest: observerd TorBootstrapError", obj);
        const error = new Error(obj.summary);
        error.details = obj;
        this.#stop(error);
        break;
      }
    }
  }

  // resolves 'true' if bootstrap succeeds, false otherwise
  bootstrap() {
    if (this.#bootstrapPromise) {
      return this.#bootstrapPromise;
    }

    this.#bootstrapPromise = new Promise((resolve, reject) => {
      this.#bootstrapPromiseResolve = resolve;

      // register ourselves to listen for bootstrap events
      Services.obs.addObserver(this, TorTopics.BootstrapStatus);
      Services.obs.addObserver(this, TorTopics.BootstrapError);

      // optionally cancel bootstrap after a given timeout
      if (this.timeout > 0) {
        this.#timeoutID = setTimeout(async () => {
          this.#timeoutID = null;
          // TODO: Translate, if really used
          await this.#stop(
            "Tor Bootstrap process timed out",
            `Bootstrap attempt abandoned after waiting ${this.timeout} ms`
          );
        }, this.timeout);
      }

      // Wait for bootstrapping to begin and maybe handle error.
      // Notice that we do not resolve the promise here in case of success, but
      // we do it from the BootstrapStatus observer.
      TorProviderBuilder.build()
        .then(provider => provider.connect())
        .catch(err => {
          this.#stop(err.message, err.torMessage);
        });
    }).finally(() => {
      // and remove ourselves once bootstrap is resolved
      Services.obs.removeObserver(this, TorTopics.BootstrapStatus);
      Services.obs.removeObserver(this, TorTopics.BootstrapError);
      this.#bootstrapPromise = null;
    });

    return this.#bootstrapPromise;
  }

  async cancel() {
    await this.#stop();
  }

  // Internal implementation. Do not use directly, but call cancel, instead.
  async #stop(error) {
    // first stop our bootstrap timeout before handling the error
    if (this.#timeoutID !== null) {
      clearTimeout(this.#timeoutID);
      this.#timeoutID = null;
    }

    let provider;
    try {
      provider = await TorProviderBuilder.build();
    } catch {
      // This was probably the error that lead to stop in the first place.
      // No need to continue propagating it.
    }
    try {
      await provider?.stopBootstrap();
    } catch (e) {
      console.error("Failed to stop the bootstrap.", e);
      if (!error) {
        error = e;
      }
    }

    if (this.onbootstraperror && error) {
      this.onbootstraperror(error);
    }

    this.#bootstrapPromiseResolve(false);
  }
}
