"use strict";

var EXPORTED_SYMBOLS = ["TorBootstrapRequest", "TorTopics"];

const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");
const { setTimeout, clearTimeout } = ChromeUtils.import(
  "resource://gre/modules/Timer.jsm"
);

const { TorProtocolService } = ChromeUtils.import(
  "resource://gre/modules/TorProtocolService.jsm"
);
const { TorLauncherUtil } = ChromeUtils.import(
  "resource://gre/modules/TorLauncherUtil.jsm"
);

/* tor-launcher observer topics */
const TorTopics = Object.freeze({
  BootstrapStatus: "TorBootstrapStatus",
  BootstrapError: "TorBootstrapError",
  LogHasWarnOrErr: "TorLogHasWarnOrErr",
});

// modeled after XMLHttpRequest
// nicely encapsulates the observer register/unregister logic
class TorBootstrapRequest {
  constructor() {
    // number of ms to wait before we abandon the bootstrap attempt
    // a value of 0 implies we never wait
    this.timeout = 0;
    // callbacks for bootstrap process status updates
    this.onbootstrapstatus = (progress, status) => {};
    this.onbootstrapcomplete = () => {};
    this.onbootstraperror = (message, details) => {};

    // internal resolve() method for bootstrap
    this._bootstrapPromiseResolve = null;
    this._bootstrapPromise = null;
    this._timeoutID = null;
  }

  async observe(subject, topic, data) {
    const obj = subject?.wrappedJSObject;
    switch (topic) {
      case TorTopics.BootstrapStatus: {
        const progress = obj.PROGRESS;
        const status = TorLauncherUtil.getLocalizedBootstrapStatus(obj, "TAG");
        if (this.onbootstrapstatus) {
          this.onbootstrapstatus(progress, status);
        }
        if (progress === 100) {
          if (this.onbootstrapcomplete) {
            this.onbootstrapcomplete();
          }
          this._bootstrapPromiseResolve(true);
          clearTimeout(this._timeoutID);
        }

        break;
      }
      case TorTopics.BootstrapError: {
        // first stop our bootstrap timeout before handling the error
        clearTimeout(this._timeoutID);

        await TorProtocolService.stopBootstrap();

        const message = obj.message;
        const details = obj.details;
        if (this.onbootstraperror) {
          this.onbootstraperror(message, details);
        }
        this._bootstrapPromiseResolve(false);
        break;
      }
    }
  }

  // resolves 'true' if bootstrap succeeds, false otherwise
  bootstrap() {
    if (this._bootstrapPromise) {
      return this._bootstrapPromise;
    }

    this._bootstrapPromise = new Promise((resolve, reject) => {
      this._bootstrapPromiseResolve = resolve;

      // register ourselves to listen for bootstrap events
      Services.obs.addObserver(this, TorTopics.BootstrapStatus);
      Services.obs.addObserver(this, TorTopics.BootstrapError);

      // optionally cancel bootstrap after a given timeout
      if (this.timeout > 0) {
        this._timeoutID = setTimeout(async () => {
          await TorProtocolService.stopBootstrap();
          if (this.onbootstraperror) {
            this.onbootstraperror(
              "Tor Bootstrap process timed out",
              `Bootstrap attempt abandoned after waiting ${this.timeout} ms`
            );
          }
          this._bootstrapPromiseResolve(false);
        }, this.timeout);
      }

      // wait for bootstrapping to begin and maybe handle error
      TorProtocolService.connect().catch(async err => {
        clearTimeout(this._timeoutID);
        // stopBootstrap never throws, at the moment
        await TorProtocolService.stopBootstrap();
        if (this.onbootstraperror) {
          this.onbootstraperror(err.message, "");
        }
        this._bootstrapPromiseResolve(false);
      });
    }).finally(() => {
      // and remove ourselves once bootstrap is resolved
      Services.obs.removeObserver(this, TorTopics.BootstrapStatus);
      Services.obs.removeObserver(this, TorTopics.BootstrapError);
    });

    return this._bootstrapPromise;
  }

  async cancel() {
    clearTimeout(this._timeoutID);

    await TorProtocolService.stopBootstrap();

    this._bootstrapPromiseResolve(false);
  }
}
