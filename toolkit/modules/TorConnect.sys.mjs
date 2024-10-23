/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  MoatRPC: "resource://gre/modules/Moat.sys.mjs",
  TorBootstrapRequest: "resource://gre/modules/TorBootstrapRequest.sys.mjs",
  TorProviderBuilder: "resource://gre/modules/TorProviderBuilder.sys.mjs",
  TorProviderTopics: "resource://gre/modules/TorProviderBuilder.sys.mjs",
  TorLauncherUtil: "resource://gre/modules/TorLauncherUtil.sys.mjs",
  TorSettings: "resource://gre/modules/TorSettings.sys.mjs",
});

/* Relevant prefs used by tor-launcher */
const TorLauncherPrefs = Object.freeze({
  prompt_at_startup: "extensions.torlauncher.prompt_at_startup",
});

const TorConnectPrefs = Object.freeze({
  censorship_level: "torbrowser.debug.censorship_level",
  allow_internet_test: "torbrowser.bootstrap.allow_internet_test",
  log_level: "torbrowser.bootstrap.log_level",
});

export const TorConnectState = Object.freeze({
  /* Our initial state */
  Initial: "Initial",
  /* In-between initial boot and bootstrapping, users can change tor network settings during this state */
  Configuring: "Configuring",
  /* Tor is attempting to bootstrap with settings from censorship-circumvention db */
  AutoBootstrapping: "AutoBootstrapping",
  /* Tor is bootstrapping */
  Bootstrapping: "Bootstrapping",
  /* Passthrough state back to Configuring */
  Error: "Error",
  /* Final state, after successful bootstrap */
  Bootstrapped: "Bootstrapped",
  /* If we are using System tor or the legacy Tor-Launcher */
  Disabled: "Disabled",
});

export class TorConnectError extends Error {
  static get Offline() {
    return "Offline";
  }
  static get BootstrapError() {
    return "BootstrapError";
  }
  static get CannotDetermineCountry() {
    return "CannotDetermineCountry";
  }
  static get NoSettingsForCountry() {
    return "NoSettingsForCountry";
  }
  static get AllSettingsFailed() {
    return "AllSettingsFailed";
  }
  static get ExternalError() {
    return "ExternalError";
  }

  constructor(code, cause) {
    super(cause?.message ?? `TorConnectError: ${code}`, cause ? { cause } : {});
    this.name = "TorConnectError";
    this.code = code;
  }
}

ChromeUtils.defineLazyGetter(lazy, "logger", () =>
  console.createInstance({
    maxLogLevelPref: TorConnectPrefs.log_level,
    prefix: "TorConnect",
  })
);

/*
                             TorConnect State Transitions

    ┌─────────┐                                                       ┌────────┐
    │         ▼                                                       ▼        │
    │       ┌──────────────────────────────────────────────────────────┐       │
  ┌─┼────── │                           Error                          │ ◀───┐ │
  │ │       └──────────────────────────────────────────────────────────┘     │ │
  │ │         ▲                                                              │ │
  │ │         │                                                              │ │
  │ │         │                                                              │ │
  │ │       ┌───────────────────────┐                       ┌──────────┐     │ │
  │ │ ┌──── │        Initial        │ ────────────────────▶ │ Disabled │     │ │
  │ │ │     └───────────────────────┘                       └──────────┘     │ │
  │ │ │       │                                                              │ │
  │ │ │       │ beginBootstrap()                                             │ │
  │ │ │       ▼                                                              │ │
  │ │ │     ┌──────────────────────────────────────────────────────────┐     │ │
  │ │ │     │                      Bootstrapping                       │ ────┘ │
  │ │ │     └──────────────────────────────────────────────────────────┘       │
  │ │ │       │                        ▲                             │         │
  │ │ │       │ cancelBootstrap()      │ beginBootstrap()            └────┐    │
  │ │ │       ▼                        │                                  │    │
  │ │ │     ┌──────────────────────────────────────────────────────────┐  │    │
  │ │ └───▶ │                                                          │ ─┼────┘
  │ │       │                                                          │  │
  │ │       │                                                          │  │
  │ │       │                       Configuring                        │  │
  │ │       │                                                          │  │
  │ │       │                                                          │  │
  └─┼─────▶ │                                                          │  │
    │       └──────────────────────────────────────────────────────────┘  │
    │         │                        ▲                       ▲          │
    │         │ beginAutoBootstrap()   │ cancelBootstrap()     │          │
    │         ▼                        │                       │          │
    │       ┌───────────────────────┐  │                       │          │
    └────── │   AutoBootstrapping   │ ─┘                       │          │
            └───────────────────────┘                          │          │
              │                                                │          │
              │               ┌────────────────────────────────┘          │
              ▼               │                                           │
            ┌───────────────────────┐                                     │
            │     Bootstrapped      │ ◀───────────────────────────────────┘
            └───────────────────────┘
*/

/* Topics Notified by the TorConnect module */
export const TorConnectTopics = Object.freeze({
  StateChange: "torconnect:state-change",
  BootstrapProgress: "torconnect:bootstrap-progress",
  BootstrapComplete: "torconnect:bootstrap-complete",
  Error: "torconnect:error",
});

/**
 * @callback ProgressCallback
 *
 * @param {integer} progress - The progress percent.
 */
/**
 * @typedef {object} BootstrapOptions
 *
 * Options for a bootstrap attempt.
 *
 * @property {boolean} [options.simulateCensorship] - Whether to simulate a
 *   failing bootstrap.
 * @property {integer} [options.simulateDelay] - The delay in microseconds to
 *   apply to simulated bootstraps.
 * @property {object} [options.simulateMoatResponse] - Simulate a Moat response
 *   for circumvention settings. Should include a "settings" property, and
 *   optionally a "country" property. You may add a "simulateCensorship"
 *   property to some of the settings to make only their bootstrap attempts
 *   fail.
 * @property {boolean} [options.testInternet] - Whether to also test the
 *   internet connection.
 * @property {boolean} [options.simulateOffline] - Whether to simulate an
 *   offline test result. This will not cause the bootstrap to fail.
 * @property {string} [options.regionCode] - The region code to use to fetch
 *   auto-bootstrap settings, or "automatic" to automatically choose the region.
 */
/**
 * @typedef {object} BootstrapResult
 *
 * The result of a bootstrap attempt.
 *
 * @property {string} [result] - The bootstrap result.
 * @property {Error} [error] - An error from the attempt.
 */
/**
 * @callback ResolveBootstrap
 *
 * Resolve a bootstrap attempt.
 *
 * @param {BootstrapResult} - The result, or error.
 */

/**
 * Each instance can be used to attempt one bootstrapping.
 */
class BootstrapAttempt {
  /**
   * The ongoing bootstrap request.
   *
   * @type {?TorBootstrapRequest}
   */
  #bootstrap = null;
  /**
   * The error returned by the bootstrap request, if any.
   *
   * @type {?Error}
   */
  #bootstrapError = null;
  /**
   * The ongoing internet test, if any.
   *
   * @type {?InternetTest}
   */
  #internetTest = null;
  /**
   * The method to call to complete the `run` promise.
   *
   * @type {?ResolveBootstrap}
   */
  #resolveRun = null;
  /**
   * Whether the `run` promise has been, or is about to be, resolved.
   *
   * @type {boolean}
   */
  #resolved = false;
  /**
   * Whether a cancel request has been started.
   *
   * @type {boolean}
   */
  #cancelled = false;

  /**
   * Run a bootstrap attempt.
   *
   * @param {ProgressCallback} progressCallback - The callback to invoke with
   *   the bootstrap progress.
   * @param {BootstrapOptions} options - Options to apply to the bootstrap.
   *
   * @return {Promise<string, Error>} - The result of the bootstrap.
   */
  run(progressCallback, options) {
    const { promise, resolve, reject } = Promise.withResolvers();
    this.#resolveRun = arg => {
      if (this.#resolved) {
        // Already been called once.
        if (arg.error) {
          lazy.logger.error("Delayed bootstrap error", arg.error);
        }
        return;
      }
      this.#resolved = true;
      try {
        // Should be ok to call this twice in the case where we "cancel" the
        // bootstrap.
        this.#internetTest?.cancel();
      } catch (error) {
        lazy.logger.error("Unexpected error in bootstrap cleanup", error);
      }
      if (arg.error) {
        reject(arg.error);
      } else {
        resolve(arg.result);
      }
    };
    try {
      this.#runInternal(progressCallback, options);
    } catch (error) {
      this.#resolveRun({ error });
    }

    return promise;
  }

  /**
   * Run the attempt.
   *
   * @param {ProgressCallback} progressCallback - The callback to invoke with
   *   the bootstrap progress.
   * @param {BootstrapOptions} options - Options to apply to the bootstrap.
   */
  #runInternal(progressCallback, options) {
    if (options.simulateCensorship) {
      // Create a fake request.
      this.#bootstrap = {
        _timeout: 0,
        bootstrap() {
          this._timeout = setTimeout(() => {
            const err = new Error("Censorship simulation");
            err.phase = "conn";
            err.reason = "noroute";
            this.onbootstraperror(err);
          }, options.simulateDelay || 0);
        },
        cancel() {
          clearTimeout(this._timeout);
        },
      };
    } else {
      this.#bootstrap = new lazy.TorBootstrapRequest();
    }

    this.#bootstrap.onbootstrapstatus = (progress, _status) => {
      if (!this.#resolved) {
        progressCallback(progress);
      }
    };
    this.#bootstrap.onbootstrapcomplete = () => {
      this.#resolveRun({ result: "complete" });
    };
    this.#bootstrap.onbootstraperror = error => {
      if (this.#bootstrapError) {
        lazy.logger.warn("Another bootstrap error", error);
        return;
      }
      // We have to wait for the Internet test to finish before sending the
      // bootstrap error
      this.#bootstrapError = error;
      this.#maybeTransitionToError();
    };
    if (options.testInternet) {
      this.#internetTest = new InternetTest(options.simulateOffline);
      this.#internetTest.onResult = () => {
        this.#maybeTransitionToError();
      };
      this.#internetTest.onError = () => {
        this.#maybeTransitionToError();
      };
    }

    this.#bootstrap.bootstrap();
  }

  /**
   * Callback for when we get a new bootstrap error or a change in the internet
   * status.
   */
  #maybeTransitionToError() {
    if (this.#resolved || this.#cancelled) {
      if (this.#bootstrapError) {
        // We ignore this error since it occurred after cancelling (by the
        // user), or we have already resolved. We assume the error is just a
        // side effect of the cancelling.
        // E.g. If the cancelling is triggered late in the process, we get
        // "Building circuits: Establishing a Tor circuit failed".
        // TODO: Maybe move this logic deeper in the process to know when to
        // filter out such errors triggered by cancelling.
        lazy.logger.warn("Post-complete error.", this.#bootstrapError);
      }
      return;
    }

    if (
      this.#internetTest &&
      this.#internetTest.status === InternetStatus.Unknown &&
      this.#internetTest.error === null &&
      this.#internetTest.enabled
    ) {
      // We have been called by a failed bootstrap, but the internet test has
      // not run yet - force it to run immediately!
      this.#internetTest.test();
      // Return from this call, because the Internet test's callback will call
      // us again.
      return;
    }
    // Do not transition to "offline" until we are sure that also the bootstrap
    // failed, in case Moat is down but the bootstrap can proceed anyway.
    if (!this.#bootstrapError) {
      return;
    }
    if (this.#internetTest?.status === InternetStatus.Offline) {
      if (this.#bootstrapError) {
        lazy.logger.info(
          "Ignoring bootstrap error since offline.",
          this.#bootstrapError
        );
      }
      this.#resolveRun({ result: "offline" });
      return;
    }
    this.#resolveRun({
      error: new TorConnectError(
        TorConnectError.BootstrapError,
        this.#bootstrapError
      ),
    });
  }

  /**
   * Cancel the bootstrap attempt.
   */
  async cancel() {
    if (this.#cancelled) {
      lazy.logger.warn(
        "Cancelled bootstrap after it has already been cancelled"
      );
      return;
    }
    this.#cancelled = true;
    if (this.#resolved) {
      lazy.logger.warn("Cancelled bootstrap after it has already resolved");
      return;
    }
    // Wait until after bootstrap.cancel returns before we resolve with
    // cancelled. In particular, there is a small chance that the bootstrap
    // completes, in which case we want to be able to resolve with a success
    // instead.
    this.#internetTest?.cancel();
    await this.#bootstrap?.cancel();
    this.#resolveRun({ result: "cancelled" });
  }
}

/**
 * Each instance can be used to attempt one auto-bootstrapping sequence.
 */
class AutoBootstrapAttempt {
  /**
   * The current bootstrap attempt, if any.
   *
   * @type {?BootstrapAttempt}
   */
  #bootstrapAttempt = null;
  /**
   * The method to call to complete the `run` promise.
   *
   * @type {?ResolveBootstrap}
   */
  #resolveRun = null;
  /**
   * Whether the `run` promise has been, or is about to be, resolved.
   *
   * @type {boolean}
   */
  #resolved = false;
  /**
   * Whether a cancel request has been started.
   *
   * @type {boolean}
   */
  #cancelled = false;
  /**
   * The method to call when the cancelled value is set to true.
   *
   * @type {?Function}
   */
  #resolveCancelled = null;
  /**
   * A promise that resolves when the cancelled value is set to true. We can use
   * this with Promise.race to end early when the user cancels.
   *
   * @type {?Promise}
   */
  #cancelledPromise = null;
  /**
   * The found settings from Moat.
   *
   * @type {?object[]}
   */
  #settings = null;
  /**
   * The last settings that have been applied to the TorProvider, if any.
   *
   * @type {?object}
   */
  #changedSetting = null;
  /**
   * The detected region code returned by Moat, if any.
   *
   * @type {?string}
   */
  detectedRegion = null;

  /**
   * Run an auto-bootstrap attempt.
   *
   * @param {ProgressCallback} progressCallback - The callback to invoke with
   *   the bootstrap progress.
   * @param {BootstrapOptions} options - Options to apply to the bootstrap.
   *
   * @return {Promise<string, Error>} - The result of the bootstrap.
   */
  run(progressCallback, options) {
    const { promise, resolve, reject } = Promise.withResolvers();

    this.#resolveRun = async arg => {
      if (this.#resolved) {
        // Already been called once.
        if (arg.error) {
          lazy.logger.error("Delayed auto-bootstrap error", arg.error);
        }
        return;
      }
      this.#resolved = true;
      try {
        // Run cleanup before we resolve the promise to ensure two instances
        // of AutoBootstrapAttempt are not trying to change the settings at
        // the same time.
        if (this.#changedSetting) {
          if (arg.result === "complete") {
            // Persist the current settings to preferences.
            lazy.TorSettings.setSettings(this.#changedSetting);
            lazy.TorSettings.saveToPrefs();
          } // else, applySettings will restore the current settings.
          await lazy.TorSettings.applySettings();
        }
      } catch (error) {
        lazy.logger.error("Unexpected error in auto-bootstrap cleanup", error);
      }
      if (arg.error) {
        reject(arg.error);
      } else {
        resolve(arg.result);
      }
    };

    ({ promise: this.#cancelledPromise, resolve: this.#resolveCancelled } =
      Promise.withResolvers());

    this.#runInternal(progressCallback, options).catch(error => {
      this.#resolveRun({ error });
    });

    return promise;
  }

  /**
   * Run the attempt.
   *
   * Note, this is an async method, but should *not* be awaited by the `run`
   * method.
   *
   * @param {ProgressCallback} progressCallback - The callback to invoke with
   *   the bootstrap progress.
   * @param {BootstrapOptions} options - Options to apply to the bootstrap.
   */
  async #runInternal(progressCallback, options) {
    await this.#fetchSettings(options);
    if (this.#cancelled || this.#resolved) {
      return;
    }

    if (!this.#settings?.length) {
      this.#resolveRun({
        error: new TorConnectError(
          options.regionCode === "automatic" && !this.detectedRegion
            ? TorConnectError.CannotDetermineCountry
            : TorConnectError.NoSettingsForCountry
        ),
      });
    }

    // Apply each of our settings and try to bootstrap with each.
    for (const [index, currentSetting] of this.#settings.entries()) {
      lazy.logger.info(
        `Attempting Bootstrap with configuration ${index + 1}/${
          this.#settings.length
        }`
      );

      await this.#trySetting(currentSetting, progressCallback, options);

      if (this.#cancelled || this.#resolved) {
        return;
      }
    }

    this.#resolveRun({
      error: new TorConnectError(TorConnectError.AllSettingsFailed),
    });
  }

  /**
   * Lookup user's potential censorship circumvention settings from Moat
   * service.
   *
   * @param {BootstrapOptions} options - Options to apply to the bootstrap.
   */
  async #fetchSettings(options) {
    if (options.simulateMoatResponse) {
      await Promise.race([
        new Promise(res => setTimeout(res, options.simulateDelay || 0)),
        this.#cancelledPromise,
      ]);

      if (this.#cancelled || this.#resolved) {
        return;
      }

      this.detectedRegion = options.simulateMoatResponse.country || null;
      this.#settings = options.simulateMoatResponse.settings ?? null;

      return;
    }

    const moat = new lazy.MoatRPC();
    try {
      // We need to wait Moat's initialization even when we are requested to
      // transition to another state to be sure its uninit will have its
      // intended effect. So, do not use Promise.race here.
      await moat.init();

      if (this.#cancelled || this.#resolved) {
        return;
      }

      // For now, throw any errors we receive from the backend, except when it
      // was unable to detect user's country/region.
      // If we use specialized error objects, we could pass the original errors
      // to them.
      const maybeSettings = await Promise.race([
        moat.circumvention_settings(
          [...lazy.TorSettings.builtinBridgeTypes, "vanilla"],
          options.regionCode === "automatic" ? null : options.regionCode
        ),
        // This might set maybeSettings to undefined.
        this.#cancelledPromise,
      ]);
      if (this.#cancelled || this.#resolved) {
        return;
      }

      this.detectedRegion = maybeSettings?.country || null;

      if (maybeSettings?.settings?.length) {
        this.#settings = maybeSettings.settings;
      } else {
        // Keep consistency with the other call.
        this.#settings = await Promise.race([
          moat.circumvention_defaults([
            ...lazy.TorSettings.builtinBridgeTypes,
            "vanilla",
          ]),
          // This might set this.#settings to undefined.
          this.#cancelledPromise,
        ]);
      }
    } finally {
      // Do not await the uninit.
      moat.uninit();
    }
  }

  /**
   * Try to apply the settings we fetched.
   *
   * @param {object} setting - The setting to try.
   * @param {ProgressCallback} progressCallback - The callback to invoke with
   *   the bootstrap progress.
   * @param {BootstrapOptions} options - Options to apply to the bootstrap.
   */
  async #trySetting(setting, progressCallback, options) {
    if (this.#cancelled || this.#resolved) {
      return;
    }

    if (options.simulateMoatResponse && setting.simulateCensorship) {
      // Move the simulateCensorship option to the options for the next
      // BootstrapAttempt.
      setting = structuredClone(setting);
      delete setting.simulateCensorship;
      options = { ...options, simulateCensorship: true };
    }

    // Send the new settings directly to the provider. We will save them only
    // if the bootstrap succeeds.
    // FIXME: We should somehow signal TorSettings users that we have set
    // custom settings, and they should not apply theirs until we are done
    // with trying ours.
    // Otherwise, the new settings provided by the user while we were
    // bootstrapping could be the ones that cause the bootstrap to succeed,
    // but we overwrite them (unless we backup the original settings, and then
    // save our new settings only if they have not changed).
    // Another idea (maybe easier to implement) is to disable the settings
    // UI while *any* bootstrap is going on.
    // This is also documented in tor-browser#41921.
    const provider = await lazy.TorProviderBuilder.build();
    this.#changedSetting = setting;
    // We need to merge with old settings, in case the user is using a proxy
    // or is behind a firewall.
    await provider.writeSettings({
      ...lazy.TorSettings.getSettings(),
      ...setting,
    });

    if (this.#cancelled || this.#resolved) {
      return;
    }

    let result;
    try {
      this.#bootstrapAttempt = new BootstrapAttempt();
      // At this stage, cancelling AutoBootstrap will also cancel this
      // bootstrapAttempt.
      result = await this.#bootstrapAttempt.run(progressCallback, options);
    } catch (error) {
      // Only re-try with the next settings *if* we have a BootstrapError.
      // Other errors will end this auto-bootstrap attempt entirely.
      if (
        error instanceof TorConnectError &&
        error.code === TorConnectError.BootstrapError
      ) {
        lazy.logger.info("TorConnect setting failed", setting, error);
        // Try with the next settings.
        // NOTE: We do not restore the user settings in between these runs.
        // Instead we wait for #resolveRun callback to do so.
        // This means there is a window of time where the setting is applied, but
        // no bootstrap is running.
        return;
      }
      // Pass error up.
      throw error;
    } finally {
      this.#bootstrapAttempt = null;
    }

    if (this.#cancelled || this.#resolved) {
      return;
    }

    // Pass the BootstrapAttempt result up.
    this.#resolveRun({ result });
  }

  /**
   * Cancel the bootstrap attempt.
   */
  async cancel() {
    if (this.#cancelled) {
      lazy.logger.warn(
        "Cancelled auto-bootstrap after it has already been cancelled"
      );
      return;
    }
    this.#cancelled = true;
    this.#resolveCancelled();
    if (this.#resolved) {
      lazy.logger.warn(
        "Cancelled auto-bootstrap after it has already resolved"
      );
      return;
    }

    // Wait until after bootstrap.cancel returns before we resolve with
    // cancelled. In particular, there is a small chance that the bootstrap
    // completes, in which case we want to be able to resolve with a success
    // instead.
    if (this.#bootstrapAttempt) {
      this.#bootstrapAttempt.cancel();
      await this.#bootstrapAttempt;
    }
    // In case no bootstrap is running, we resolve with "cancelled".
    this.#resolveRun({ result: "cancelled" });
  }
}

export const InternetStatus = Object.freeze({
  Unknown: -1,
  Offline: 0,
  Online: 1,
});

class InternetTest {
  #enabled;
  #status = InternetStatus.Unknown;
  #error = null;
  #pending = false;
  #canceled = false;
  #timeout = 0;
  #simulateOffline = false;

  constructor(simulateOffline) {
    this.#simulateOffline = simulateOffline;

    this.#enabled = Services.prefs.getBoolPref(
      TorConnectPrefs.allow_internet_test,
      true
    );
    if (this.#enabled) {
      this.#timeout = setTimeout(() => {
        this.#timeout = 0;
        this.test();
      }, this.#timeoutRand());
    }
    this.onResult = _online => {};
    this.onError = _error => {};
  }

  /**
   * Perform the internet test.
   *
   * While this is an async method, the callers are not expected to await it,
   * as we are also using callbacks.
   */
  async test() {
    if (this.#pending || !this.#enabled) {
      return;
    }
    this.cancel();
    this.#pending = true;
    this.#canceled = false;

    lazy.logger.info("Starting the Internet test");

    if (this.#simulateOffline) {
      await new Promise(res => setTimeout(res, 500));

      this.#status = InternetStatus.Offline;

      if (this.#canceled) {
        return;
      }
      this.onResult(this.#status);
      return;
    }

    const mrpc = new lazy.MoatRPC();
    try {
      await mrpc.init();
      const status = await mrpc.testInternetConnection();
      this.#status = status.successful
        ? InternetStatus.Online
        : InternetStatus.Offline;
      // TODO: We could consume the date we got from the HTTP request to detect
      // big clock skews that might prevent a successfull bootstrap.
      lazy.logger.info(`Performed Internet test, outcome ${this.#status}`);
    } catch (err) {
      lazy.logger.error("Error while checking the Internet connection", err);
      this.#error = err;
      this.#pending = false;
    } finally {
      mrpc.uninit();
    }

    if (this.#canceled) {
      return;
    }
    if (this.#error) {
      this.onError(this.#error);
    } else {
      this.onResult(this.#status);
    }
  }

  cancel() {
    this.#canceled = true;
    if (this.#timeout) {
      clearTimeout(this.#timeout);
      this.#timeout = 0;
    }
  }

  get status() {
    return this.#status;
  }

  get error() {
    return this.#error;
  }

  get enabled() {
    return this.#enabled;
  }

  // We randomize the Internet test timeout to make fingerprinting it harder, at
  // least a little bit...
  #timeoutRand() {
    const offset = 30000;
    const randRange = 5000;
    return offset + randRange * (Math.random() * 2 - 1);
  }
}

export const TorConnect = {
  _bootstrapProgress: 0,
  _internetStatus: InternetStatus.Unknown,
  // list of country codes Moat has settings for
  _countryCodes: [],
  _countryNames: Object.freeze(
    (() => {
      const codes = Services.intl.getAvailableLocaleDisplayNames("region");
      const names = Services.intl.getRegionDisplayNames(undefined, codes);
      let codesNames = {};
      for (let i = 0; i < codes.length; i++) {
        codesNames[codes[i]] = names[i];
      }
      return codesNames;
    })()
  ),
  _detectedLocation: "",
  _errorCode: null,
  _errorDetails: null,
  _logHasWarningOrError: false,
  _hasBootstrapEverFailed: false,

  // This is used as a helper to make the state of about:torconnect persistent
  // during a session, but TorConnect does not use this data at all.
  _uiState: {},

  async _changeState(newState, ...args) {
    // TODO: Remove.
  },

  _updateBootstrapProgress(progress, status) {
    this._bootstrapProgress = progress;

    lazy.logger.info(
      `Bootstrapping ${this._bootstrapProgress}% complete (${status})`
    );
    Services.obs.notifyObservers(
      {
        progress: TorConnect._bootstrapProgress,
        hasWarnings: TorConnect._logHasWarningOrError,
      },
      TorConnectTopics.BootstrapProgress
    );
  },

  // init should be called by TorStartupService
  init() {
    lazy.logger.debug("TorConnect.init()");

    if (!this.enabled) {
      // Disabled
      this._changeState(TorConnectState.Disabled);
      return;
    }

    let observeTopic = addTopic => {
      Services.obs.addObserver(this, addTopic);
      lazy.logger.debug(`Observing topic '${addTopic}'`);
    };

    // Wait for TorSettings, as we will need it.
    // We will wait for a TorProvider only after TorSettings is ready,
    // because the TorProviderBuilder initialization might not have finished
    // at this point, and TorSettings initialization is a prerequisite for
    // having a provider.
    // So, we prefer initializing TorConnect as soon as possible, so that
    // the UI will be able to detect it is in the Initializing state and act
    // consequently.
    lazy.TorSettings.initializedPromise.then(() => this._settingsInitialized());

    // register the Tor topics we always care about
    observeTopic(lazy.TorProviderTopics.ProcessExited);
    observeTopic(lazy.TorProviderTopics.HasWarnOrErr);
  },

  async observe(subject, topic) {
    lazy.logger.debug(`Observed ${topic}`);

    switch (topic) {
      case lazy.TorProviderTopics.HasWarnOrErr: {
        this._logHasWarningOrError = true;
        break;
      }
      case lazy.TorProviderTopics.ProcessExited: {
        // Treat a failure as a possibly broken configuration.
        // So, prevent quickstart at the next start.
        Services.prefs.setBoolPref(TorLauncherPrefs.prompt_at_startup, true);
        switch (this.state) {
          case TorConnectState.Bootstrapping:
          case TorConnectState.AutoBootstrapping:
          case TorConnectState.Bootstrapped:
            // If we are in the bootstrap or auto bootstrap, we could go
            // through the error phase (and eventually we might do it, if some
            // transition calls fail). However, this would start the
            // connection assist, so we go directly to configuring.
            // FIXME: Find a better way to handle this.
            this._changeState(TorConnectState.Configuring);
            break;
          // Other states naturally resolve in configuration.
        }
        break;
      }
      default:
        // ignore
        break;
    }
  },

  async _settingsInitialized() {
    // TODO: Handle failures here, instead of the prompt to restart the
    // daemon when it exits (tor-browser#21053, tor-browser#41921).
    await lazy.TorProviderBuilder.build();

    // tor-browser#41907: This is only a workaround to avoid users being
    // bounced back to the initial panel without any explanation.
    // Longer term we should disable the clickable elements, or find a UX
    // to prevent this from happening (e.g., allow buttons to be clicked,
    // but show an intermediate starting state, or a message that tor is
    // starting while the butons are disabled, etc...).
    // Notice that currently the initial state does not do anything.
    // Instead of just waiting, we could move this code in its callback.
    // See also tor-browser#41921.
    if (this.state !== TorConnectState.Initial) {
      lazy.logger.warn(
        "The TorProvider was built after the state had already changed."
      );
      return;
    }
    lazy.logger.debug("The TorProvider is ready, changing state.");
    if (this.shouldQuickStart) {
      // Quickstart
      this._changeState(TorConnectState.Bootstrapping);
    } else {
      // Configuring
      this._changeState(TorConnectState.Configuring);
    }
  },

  /*
    Various getters
   */

  /**
   * Whether TorConnect is enabled.
   *
   * @type {boolean}
   */
  get enabled() {
    // FIXME: This is called before the TorProvider is ready.
    // As a matter of fact, at the moment it is equivalent to the following
    // line, but this might become a problem in the future.
    return lazy.TorLauncherUtil.shouldStartAndOwnTor;
  },

  get shouldShowTorConnect() {
    // TorBrowser must control the daemon
    return (
      this.enabled &&
      // if we have succesfully bootstraped, then no need to show TorConnect
      this.state !== TorConnectState.Bootstrapped
    );
  },

  /**
   * Whether bootstrapping can currently begin.
   *
   * The value may change with TorConnectTopics.StateChanged.
   *
   * @param {boolean}
   */
  get canBeginBootstrap() {
    return this._stateHandler.allowedTransitions.includes(
      TorConnectState.Bootstrapping
    );
  },

  /**
   * Whether auto-bootstrapping can currently begin.
   *
   * The value may change with TorConnectTopics.StateChanged.
   *
   * @param {boolean}
   */
  get canBeginAutoBootstrap() {
    return this._stateHandler.allowedTransitions.includes(
      TorConnectState.AutoBootstrapping
    );
  },

  get shouldQuickStart() {
    // quickstart must be enabled
    return (
      lazy.TorSettings.quickstart.enabled &&
      // and the previous bootstrap attempt must have succeeded
      !Services.prefs.getBoolPref(TorLauncherPrefs.prompt_at_startup, true)
    );
  },

  get state() {
    return this._stateHandler.state;
  },

  get bootstrapProgress() {
    return this._bootstrapProgress;
  },

  get internetStatus() {
    return this._internetStatus;
  },

  get countryCodes() {
    return this._countryCodes;
  },

  get countryNames() {
    return this._countryNames;
  },

  get detectedLocation() {
    return this._detectedLocation;
  },

  get errorCode() {
    return this._errorCode;
  },

  get errorDetails() {
    return this._errorDetails;
  },

  get logHasWarningOrError() {
    return this._logHasWarningOrError;
  },

  /**
   * Whether we have ever entered the Error state.
   *
   * @type {boolean}
   */
  get hasEverFailed() {
    return ErrorState.hasEverHappened;
  },

  /**
   * Whether the Bootstrapping process has ever failed, not including when it
   * failed due to not being connected to the internet.
   *
   * This does not include a failure in AutoBootstrapping.
   *
   * @type {boolean}
   */
  get potentiallyBlocked() {
    return this._hasBootstrapEverFailed;
  },

  get uiState() {
    return this._uiState;
  },
  set uiState(newState) {
    this._uiState = newState;
  },

  /*
    These functions allow external consumers to tell TorConnect to transition states
   */

  beginBootstrap() {
    lazy.logger.debug("TorConnect.beginBootstrap()");
    this._changeState(TorConnectState.Bootstrapping);
  },

  cancelBootstrap() {
    lazy.logger.debug("TorConnect.cancelBootstrap()");
    if (
      this.state !== TorConnectState.AutoBootstrapping &&
      this.state !== TorConnectState.Bootstrapping
    ) {
      lazy.logger.warn(
        `Cannot cancel bootstrapping in the ${this.state} state`
      );
      return;
    }
    this._changeState(TorConnectState.Configuring);
  },

  beginAutoBootstrap(countryCode) {
    lazy.logger.debug("TorConnect.beginAutoBootstrap()");
    this._changeState(TorConnectState.AutoBootstrapping, countryCode);
  },

  /*
    Further external commands and helper methods
   */
  openTorPreferences() {
    const win = lazy.BrowserWindowTracker.getTopWindow();
    win.switchToTabHavingURI("about:preferences#connection", true);
  },

  /**
   * Open the "about:torconnect" tab.
   *
   * Bootstrapping or AutoBootstrapping can also be automatically triggered at
   * the same time, if the current state allows for it.
   *
   * Bootstrapping will not be triggered if the connection is
   * potentially blocked.
   *
   * @param {object} [options] - extra options.
   * @property {boolean} [options.beginBootstrap=false] - Whether to try and
   *   begin Bootstrapping.
   * @property {string} [options.beginAutoBootstrap] - The location to use to
   *   begin AutoBootstrapping, if possible.
   */
  openTorConnect(options) {
    // FIXME: Should we move this to the about:torconnect actor?
    const win = lazy.BrowserWindowTracker.getTopWindow();
    win.switchToTabHavingURI("about:torconnect", true, {
      ignoreQueryString: true,
    });
    if (
      options?.beginBootstrap &&
      this.canBeginBootstrap &&
      !this.potentiallyBlocked
    ) {
      this.beginBootstrap();
    }
    // options.beginAutoBootstrap can be an empty string.
    if (
      options?.beginAutoBootstrap !== undefined &&
      this.canBeginAutoBootstrap
    ) {
      this.beginAutoBootstrap(options.beginAutoBootstrap);
    }
  },

  viewTorLogs() {
    const win = lazy.BrowserWindowTracker.getTopWindow();
    win.switchToTabHavingURI("about:preferences#connection-viewlogs", true);
  },

  async getCountryCodes() {
    // Difference with the getter: this is to be called by TorConnectParent, and
    // downloads the country codes if they are not already in cache.
    if (this._countryCodes.length) {
      return this._countryCodes;
    }
    const mrpc = new lazy.MoatRPC();
    try {
      await mrpc.init();
      this._countryCodes = await mrpc.circumvention_countries();
    } catch (err) {
      lazy.logger.error("An error occurred while fetching country codes", err);
    } finally {
      mrpc.uninit();
    }
    return this._countryCodes;
  },

  getRedirectURL(url) {
    return `about:torconnect?redirect=${encodeURIComponent(url)}`;
  },

  /**
   * Convert the given object into a list of valid URIs.
   *
   * The object is either from the user's homepage preference (which may
   * contain multiple domains separated by "|") or uris passed to the browser
   * via command-line.
   *
   * @param {string|string[]} uriVariant - The string to extract uris from.
   *
   * @return {string[]} - The array of uris found.
   */
  fixupURIs(uriVariant) {
    let uriArray;
    if (typeof uriVariant === "string") {
      uriArray = uriVariant.split("|");
    } else if (
      Array.isArray(uriVariant) &&
      uriVariant.every(entry => typeof entry === "string")
    ) {
      uriArray = uriVariant;
    } else {
      // about:tor as safe fallback
      lazy.logger.error(
        `Received unknown variant '${JSON.stringify(uriVariant)}'`
      );
      uriArray = ["about:tor"];
    }

    // Attempt to convert user-supplied string to a uri, fallback to
    // about:tor if cannot convert to valid uri object
    return uriArray.map(
      uriString =>
        Services.uriFixup.getFixupURIInfo(
          uriString,
          Ci.nsIURIFixup.FIXUP_FLAG_NONE
        ).preferredURI?.spec ?? "about:tor"
    );
  },

  // called from browser.js on browser startup, passed in either the user's homepage(s)
  // or uris passed via command-line; we want to replace them with about:torconnect uris
  // which redirect after bootstrapping
  getURIsToLoad(uriVariant) {
    const uris = this.fixupURIs(uriVariant);
    const localUriRx = /^(file:\/\/\/|moz-extension:)/;
    lazy.logger.debug(
      `Will load after bootstrap => [${uris
        .filter(uri => !localUriRx.test(uri))
        .join(", ")}]`
    );

    return uris.map(uri =>
      localUriRx.test(uri) ? uri : this.getRedirectURL(uri)
    );
  },
};
