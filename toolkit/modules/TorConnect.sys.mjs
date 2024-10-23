/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  EventDispatcher: "resource://gre/modules/Messaging.sys.mjs",
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

/* Topics Notified by the TorConnect module */
export const TorConnectTopics = Object.freeze({
  StageChange: "torconnect:stage-change",
  // TODO: Remove torconnect:state-change when pages have switched to stage.
  StateChange: "torconnect:state-change",
  BootstrapProgress: "torconnect:bootstrap-progress",
  BootstrapComplete: "torconnect:bootstrap-complete",
  // TODO: Remove torconnect:error when pages have switched to stage.
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

export const TorConnectStage = Object.freeze({
  Disabled: "Disabled",
  Loading: "Loading",
  Start: "Start",
  Bootstrapping: "Bootstrapping",
  Offline: "Offline",
  ChooseRegion: "ChooseRegion",
  RegionNotFound: "RegionNotFound",
  ConfirmRegion: "ConfirmRegion",
  FinalError: "FinalError",
  Bootstrapped: "Bootstrapped",
});

/**
 * @typedef {object} ConnectStage
 *
 * A summary of the user stage.
 *
 * @property {string} name - The name of the stage.
 * @property {string} defaultRegion - The default region to show in the UI.
 * @property {?string} bootstrapTrigger - The TorConnectStage prior to this
 *   bootstrap attempt. Only set during the "Bootstrapping" stage.
 * @property {?BootstrapError} error - The last bootstrapping error.
 * @property {boolean} tryAgain - Whether a bootstrap attempt has failed, so
 *   that a normal bootstrap should be shown as "Try Again" instead of
 *   "Connect". NOTE: to be removed when about:torconnect no longer uses
 *   breadcrumbs.
 * @property {boolean} potentiallyBlocked - Whether bootstrapping has ever
 *   failed, not including being cancelled or being offline. I.e. whether we
 *   have reached an error stage at some point before being bootstrapped.
 * @property {BootstrappingStatus} bootstrappingStatus - The current
 *   bootstrapping status.
 */

/**
 * @typedef {object} BootstrappingStatus
 *
 * The status of a bootstrap.
 *
 * @property {number} progress - The percent progress.
 * @property {boolean} hasWarning - Whether this bootstrap has a warning in the
 *   Tor log.
 */

/**
 * @typedef {object} BootstrapError
 *
 * Details about the error that caused bootstrapping to fail.
 *
 * @property {string} code - The error code type.
 * @property {string} message - The error message.
 * @property {?string} phase - The bootstrapping phase that failed.
 * @property {?string} reason - The bootstrapping failure reason.
 */

export const TorConnect = {
  /**
   * Default bootstrap options for simulation.
   *
   * @type {BootstrapOptions}
   */
  simulateBootstrapOptions: {},

  /**
   * The name of the current stage the user is in.
   *
   * @type {string}
   */
  _stageName: TorConnectStage.Loading,

  get stageName() {
    return this._stageName;
  },

  /**
   * The stage that triggered bootstrapping.
   *
   * @type {?string}
   */
  _bootstrapTrigger: null,

  /**
   * The alternative stage that we should move to after bootstrapping completes.
   *
   * @type {?string}
   */
  _requestedStage: null,

  /**
   * The default region to show in the UI for auto-bootstrapping.
   *
   * @type {string}
   */
  _defaultRegion: "automatic",

  /**
   * The current bootstrap attempt, if any.
   *
   * @type {?(BootstrapAttempt|AutoBootstrapAttempt)}
   */
  _bootstrapAttempt: null,

  /**
   * The bootstrap error that was last generated.
   *
   * @type {?TorConnectError}
   */
  _errorDetails: null,

  /**
   * Whether a bootstrap attempt has failed, so that a normal bootstrap should
   * be shown as "Try Again" instead of "Connect".
   *
   * @type {boolean}
   */
  // TODO: Drop tryAgain when we remove breadcrumbs and use "Start again"
  // instead.
  _tryAgain: false,

  /**
   * Whether bootstrapping has ever returned an error.
   *
   * @type {boolean}
   */
  _potentiallyBlocked: false,

  /**
   * Get a summary of the current user stage.
   *
   * @type {ConnectStage}
   */
  get stage() {
    return {
      name: this._stageName,
      defaultRegion: this._defaultRegion,
      bootstrapTrigger: this._bootstrapTrigger,
      error: this._errorDetails
        ? {
            code: this._errorDetails.code,
            message: String(this._errorDetails.message ?? ""),
            phase: this._errorDetails.cause?.phase ?? null,
            reason: this._errorDetails.cause?.reason ?? null,
          }
        : null,
      tryAgain: this._tryAgain,
      potentiallyBlocked: this._potentiallyBlocked,
      bootstrappingStatus: structuredClone(this._bootstrappingStatus),
    };
  },

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

  // This is used as a helper to make the state of about:torconnect persistent
  // during a session, but TorConnect does not use this data at all.
  _uiState: {},

  /**
   * The status of the most recent bootstrap attempt.
   *
   * @type {BootstrappingStatus}
   */
  _bootstrappingStatus: {
    progress: 0,
    hasWarning: false,
  },

  /**
   * Notify the bootstrap progress.
   */
  _notifyBootstrapProgress() {
    lazy.logger.debug("BootstrappingStatus", this._bootstrappingStatus);
    Services.obs.notifyObservers(
      this._bootstrappingStatus,
      TorConnectTopics.BootstrapProgress
    );
  },

  // init should be called by TorStartupService
  init() {
    lazy.logger.debug("TorConnect.init()");

    if (!this.enabled) {
      // Disabled
      this._setStage(TorConnectStage.Disabled);
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
      case lazy.TorProviderTopics.HasWarnOrErr:
        if (this._bootstrappingStatus.hasWarning) {
          // No change.
          return;
        }
        if (this._stageName === "Bootstrapping") {
          this._bootstrappingStatus.hasWarning = true;
          this._notifyBootstrapProgress();
        }
        break;
      case lazy.TorProviderTopics.ProcessExited:
        lazy.logger.info("Starting again since the tor process exited");
        // Treat a failure as a possibly broken configuration.
        // So, prevent quickstart at the next start.
        Services.prefs.setBoolPref(TorLauncherPrefs.prompt_at_startup, true);
        this._makeStageRequest(TorConnectStage.Start, true);
        break;
      default:
        // ignore
        break;
    }
  },

  async _settingsInitialized() {
    // TODO: Handle failures here, instead of the prompt to restart the
    // daemon when it exits (tor-browser#21053, tor-browser#41921).
    await lazy.TorProviderBuilder.build();

    lazy.logger.debug("The TorProvider is ready, changing state.");
    // NOTE: If the tor process exits before this point, then
    // shouldQuickStart would be `false`.
    // NOTE: At this point, _requestedStage should still be `null`.
    this._setStage(TorConnectStage.Start);
    if (this.shouldQuickStart) {
      // Quickstart
      this.beginBootstrapping();
    }
  },

  /**
   * Set the user stage.
   *
   * @param {string} name - The name of the stage to move to.
   */
  _setStage(name) {
    if (this._bootstrapAttempt) {
      throw new Error(`Trying to set the stage to ${name} during a bootstrap`);
    }

    lazy.logger.info(`Entering stage ${name}`);
    const prevState = this.state;
    this._stageName = name;
    this._bootstrappingStatus.hasWarning = false;
    this._bootstrappingStatus.progress =
      name === TorConnectStage.Bootstrapped ? 100 : 0;

    Services.obs.notifyObservers(this.stage, TorConnectTopics.StageChange);

    // TODO: Remove when all pages have switched to stage.
    const newState = this.state;
    if (prevState !== newState) {
      Services.obs.notifyObservers(
        { state: newState },
        TorConnectTopics.StateChange
      );
    }

    // Update the progress after the stage has changed.
    this._notifyBootstrapProgress();
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
      this._stageName !== TorConnectStage.Bootstrapped
    );
  },

  /**
   * Whether we are in a stage that can lead into the Bootstrapping stage. I.e.
   * whether we can make a "normal" or "auto" bootstrapping request.
   *
   * The value may change with TorConnectTopics.StageChanged.
   *
   * @param {boolean}
   */
  get canBeginBootstrap() {
    return (
      this._stageName === TorConnectStage.Start ||
      this._stageName === TorConnectStage.Offline ||
      this._stageName === TorConnectStage.ChooseRegion ||
      this._stageName === TorConnectStage.RegionNotFound ||
      this._stageName === TorConnectStage.ConfirmRegion
    );
  },

  /**
   * Whether we are in an error stage that can lead into the Bootstrapping
   * stage. I.e. whether we can make an "auto" bootstrapping request.
   *
   * The value may change with TorConnectTopics.StageChanged.
   *
   * @param {boolean}
   */
  get canBeginAutoBootstrap() {
    return (
      this._stageName === TorConnectStage.ChooseRegion ||
      this._stageName === TorConnectStage.RegionNotFound ||
      this._stageName === TorConnectStage.ConfirmRegion
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

  // TODO: Remove when all pages have switched to "stage".
  get state() {
    // There is no "Error" stage, but about:torconnect relies on receiving the
    // Error state to update its display. So we temporarily set the stage for a
    // StateChange signal.
    if (this._isErrorState) {
      return TorConnectState.Error;
    }
    switch (this._stageName) {
      case TorConnectStage.Disabled:
        return TorConnectState.Disabled;
      case TorConnectStage.Loading:
        return TorConnectState.Initial;
      case TorConnectStage.Start:
      case TorConnectStage.Offline:
      case TorConnectStage.ChooseRegion:
      case TorConnectStage.RegionNotFound:
      case TorConnectStage.ConfirmRegion:
      case TorConnectStage.FinalError:
        return TorConnectState.Configuring;
      case TorConnectStage.Bootstrapping:
        if (
          this._bootstrapTrigger === TorConnectStage.Start ||
          this._bootstrapTrigger === TorConnectStage.Offline
        ) {
          return TorConnectState.Bootstrapping;
        }
        return TorConnectState.AutoBootstrapping;
      case TorConnectStage.Bootstrapped:
        return TorConnectState.Bootstrapped;
    }
    lazy.logger.error(`Unknown state at stage ${this._stageName}`);
    return null;
  },

  // TODO: Remove when all pages have switched to "stage".
  get bootstrapProgress() {
    return this._bootstrappingStatus.progress;
  },

  // TODO: Remove when all pages have switched to "stage".
  get internetStatus() {
    return this._internetStatus;
  },

  get countryCodes() {
    return this._countryCodes;
  },

  get countryNames() {
    return this._countryNames;
  },

  // TODO: Remove when all pages have switched to "stage".
  get detectedLocation() {
    return this._detectedLocation;
  },

  // TODO: Remove when all pages have switched to "stage".
  get errorCode() {
    return this._errorCode;
  },

  // TODO: Remove when all pages have switched to "stage".
  get errorDetails() {
    return this._errorDetails;
  },

  // TODO: Remove public method when all pages have switched to "stage".
  get logHasWarningOrError() {
    return this._bootstrappingStatus.hasWarning;
  },

  /**
   * Whether we have ever entered the Error state.
   *
   * @type {boolean}
   */
  // TODO: Remove public method when all pages have switched to "stage".
  get hasEverFailed() {
    return this._potentiallyBlocked;
  },

  /**
   * Whether the Bootstrapping process has ever failed, not including being
   * cancelled or being offline.
   *
   * The value may change with TorConnectTopics.StageChanged.
   *
   * @type {boolean}
   */
  get potentiallyBlocked() {
    return this._potentiallyBlocked;
  },

  // TODO: Remove when all pages have switched to stage.
  get uiState() {
    return this._uiState;
  },
  set uiState(newState) {
    this._uiState = newState;
    if (
      newState.currentState === "ConnectToTor" &&
      this._stageName !== TorConnectStage.Start
    ) {
      // User pressed first breadcrumb.
      this.startAgain();
    } else if (
      newState.currentState === "ConnectionAssist" &&
      this._stageName !== TorConnectStage.ChooseRegion
    ) {
      // User pressed second breadcrumb.
      this.chooseRegion();
    }
  },

  /*
    These functions allow external consumers to tell TorConnect to transition states
   */

  // TODO: Remove when all pages switch to `beginBootstrapping`.
  beginBootstrap() {
    this.beginBootstrapping();
  },

  // TODO: Remove when all pages switch to `cancelBootstrapping`.
  cancelBootstrap() {
    this.cancelBootstrapping();
  },

  // TODO: Remove when all pages switch to `beginBootstrapping`.
  beginAutoBootstrap(countryCode) {
    this.beginBootstrapping(countryCode || "automatic");
  },

  /**
   * Ensure that we are not disabled.
   */
  _ensureEnabled() {
    if (!this.enabled || this._stageName === TorConnectStage.Disabled) {
      throw new Error("Unexpected Disabled stage for user method");
    }
  },

  /**
   * Signal an error to listeners.
   *
   * @param {Error} error - The error.
   */
  _signalError(error) {
    // TODO: Replace this method with _setError without any signalling when
    // pages have switched to stage.
    // Currently it simulates the old behaviour for about:torconnect.
    lazy.logger.debug("Signalling error", error);

    if (!(error instanceof TorConnectError)) {
      error = new TorConnectError(TorConnectError.ExternalError, error);
    }
    this._errorCode = error.code;
    this._errorDetails = error;

    // Temporarily set an error state for listeners.
    // We send the Error signal before the "StateChange" signal.
    // Expected on android `onBootstrapError` to set lastKnownError.
    // Expected in about:torconnect to set the error codes and internet status
    // *before* the StateChange signal.
    this._isErrorState = true;
    Services.obs.notifyObservers(error, TorConnectTopics.Error);
    Services.obs.notifyObservers(
      { state: this.state },
      TorConnectTopics.StateChange
    );
    this._isErrorState = false;
  },

  /**
   * Add simulation options to the bootstrap request.
   *
   * @param {BootstrapOptions} bootstrapOptions - The options to add to.
   * @param {string} [regionCode] - The region code being used.
   */
  _addSimulateOptions(bootstrapOptions, regionCode) {
    if (this.simulateBootstrapOptions.simulateCensorship) {
      bootstrapOptions.simulateCensorship = true;
    }
    if (this.simulateBootstrapOptions.simulateDelay) {
      bootstrapOptions.simulateDelay =
        this.simulateBootstrapOptions.simulateDelay;
    }
    if (this.simulateBootstrapOptions.simulateOffline) {
      bootstrapOptions.simulateOffline = true;
    }
    if (this.simulateBootstrapOptions.simulateMoatResponse) {
      bootstrapOptions.simulateMoatResponse =
        this.simulateBootstrapOptions.simulateMoatResponse;
    }

    const censorshipLevel = Services.prefs.getIntPref(
      TorConnectPrefs.censorship_level,
      0
    );
    if (censorshipLevel > 0 && !bootstrapOptions.simulateDelay) {
      bootstrapOptions.simulateDelay = 1500;
    }
    if (censorshipLevel === 1) {
      // Bootstrap fails, but auto-bootstrap does not.
      if (!regionCode) {
        bootstrapOptions.simulateCensorship = true;
      }
    } else if (censorshipLevel === 2) {
      // Bootstrap fails. Auto-bootstrap fails with ConfirmRegion when using
      // auto-detect region, but succeeds otherwise.
      if (!regionCode) {
        bootstrapOptions.simulateCensorship = true;
      }
      if (regionCode === "automatic") {
        bootstrapOptions.simulateCensorship = true;
        bootstrapOptions.simulateMoatResponse = {
          country: "fi",
          settings: [{}, {}],
        };
      }
    } else if (censorshipLevel === 3) {
      // Bootstrap and auto-bootstrap fail.
      bootstrapOptions.simulateCensorship = true;
      bootstrapOptions.simulateMoatResponse = {
        country: null,
        settings: [],
      };
    }
  },

  /**
   * Confirm that a bootstrapping can take place, and whether the given values
   * are valid.
   *
   * @param {string} [regionCode] - The region code passed in.
   *
   * @return {boolean} whether bootstrapping can proceed.
   */
  _confirmBootstrapping(regionCode) {
    this._ensureEnabled();

    if (this._bootstrapAttempt) {
      lazy.logger.warn(
        "Already have an ongoing bootstrap attempt." +
          ` Ignoring request with ${regionCode}.`
      );
      return false;
    }

    const currentStage = this._stageName;

    if (regionCode) {
      if (!this.canBeginAutoBootstrap) {
        lazy.logger.warn(
          `Cannot begin auto bootstrap in stage ${currentStage}`
        );
        return false;
      }
      if (
        regionCode === "automatic" &&
        currentStage !== TorConnectStage.ChooseRegion
      ) {
        lazy.logger.warn("Auto bootstrap is missing an explicit regionCode");
        return false;
      }
      return true;
    }

    if (!this.canBeginBootstrap) {
      lazy.logger.warn(`Cannot begin bootstrap in stage ${currentStage}`);
      return false;
    }
    if (this.canBeginAutoBootstrap) {
      // Only expect "auto" bootstraps to be triggered when in an error stage.
      lazy.logger.warn(
        `Expected a regionCode to bootstrap in stage ${currentStage}`
      );
      return false;
    }

    return true;
  },

  /**
   * Begin a bootstrap attempt.
   *
   * @param {string} [regionCode] - An optional region code string to use, or
   *   "automatic" to automatically determine the region. If given, will start
   *   an auto-bootstrap attempt.
   */
  async beginBootstrapping(regionCode) {
    lazy.logger.debug("TorConnect.beginBootstrapping()");

    if (!this._confirmBootstrapping(regionCode)) {
      return;
    }

    const beginStage = this._stageName;
    const bootstrapOptions = { regionCode };
    const bootstrapAttempt = regionCode
      ? new AutoBootstrapAttempt()
      : new BootstrapAttempt();

    if (!regionCode) {
      // Only test internet for the first bootstrap attempt.
      // TODO: Remove this since we do not have user consent. tor-browser#42605.
      bootstrapOptions.testInternet = true;
    }

    this._addSimulateOptions(bootstrapOptions, regionCode);

    // NOTE: The only `await` in this method is for `bootstrapAttempt.run`.
    // Moreover, we returned early if `_bootstrapAttempt` was non-`null`.
    // Therefore, the method is effectively "locked" by `_bootstrapAttempt`, so
    // there should only ever be one caller at a time.

    // TODO: Remove when all pages have switched to stage.
    // Reset the internet status before the bootstrap attempt.
    // Currently this is only read for about:torconnect at the initial page or
    // when getting an error. So we can just reset it just before each
    // bootstrap attempt.
    this._internetStatus = InternetStatus.Unknown;
    if (regionCode) {
      // Set the default to what the user chose.
      this._defaultRegion = regionCode;
    } else {
      // Reset the default region to show in the UI.
      this._defaultRegion = "automatic";
    }
    this._requestedStage = null;
    this._bootstrapTrigger = beginStage;
    this._setStage(TorConnectStage.Bootstrapping);
    this._bootstrapAttempt = bootstrapAttempt;

    let error = null;
    let result = null;
    try {
      result = await bootstrapAttempt.run(progress => {
        this._bootstrappingStatus.progress = progress;
        lazy.logger.info(`Bootstrapping ${progress}% complete`);
        this._notifyBootstrapProgress();
      }, bootstrapOptions);
    } catch (err) {
      error = err;
    }

    const requestedStage = this._requestedStage;
    this._requestedStage = null;
    this._bootstrapTrigger = null;
    this._bootstrapAttempt = null;

    if (bootstrapAttempt.detectedRegion) {
      this._defaultRegion = bootstrapAttempt.detectedRegion;
      this._detectedLocation = bootstrapAttempt.detectedRegion;
    }

    if (result === "complete") {
      // Reset tryAgain, potentiallyBlocked and errorDetails in case the tor
      // process exists later on.
      this._tryAgain = false;
      this._potentiallyBlocked = false;
      this._errorDetails = null;
      this._errorCode = null;

      if (requestedStage) {
        lazy.logger.warn(
          `Ignoring ${requestedStage} request since we are bootstrapped`
        );
      }
      this._setStage(TorConnectStage.Bootstrapped);
      Services.obs.notifyObservers(null, TorConnectTopics.BootstrapComplete);
      return;
    }

    if (requestedStage) {
      lazy.logger.debug("Ignoring bootstrap result", result, error);
      this._setStage(requestedStage);
      return;
    }

    if (
      result === "offline" &&
      (beginStage === TorConnectStage.Start ||
        beginStage === TorConnectStage.Offline)
    ) {
      this._tryAgain = true;
      this._internetStatus = InternetStatus.Offline;
      this._signalError(new TorConnectError(TorConnectError.Offline));

      this._setStage(TorConnectStage.Offline);
      return;
    }

    if (error) {
      lazy.logger.info("Bootstrap attempt error", error);

      this._tryAgain = true;
      this._potentiallyBlocked = true;

      this._signalError(error);

      switch (beginStage) {
        case TorConnectStage.Start:
        case TorConnectStage.Offline:
          this._setStage(TorConnectStage.ChooseRegion);
          return;
        case TorConnectStage.ChooseRegion:
          // TODO: Uncomment for behaviour in tor-browser#42550.
          /*
          if (regionCode !== "automatic") {
            // Not automatic. Go straight to the final error.
            this._setStage(TorConnectStage.FinalError);
            return;
          }
          */
          if (regionCode !== "automatic" || bootstrapAttempt.detectedRegion) {
            this._setStage(TorConnectStage.ConfirmRegion);
            return;
          }
          this._setStage(TorConnectStage.RegionNotFound);
          return;
      }
      this._setStage(TorConnectStage.FinalError);
      return;
    }

    // Bootstrap was cancelled.
    if (result !== "cancelled") {
      lazy.logger.error(`Unexpected bootstrap result`, result);
    }

    // TODO: Remove this Offline hack when pages use "stage".
    if (beginStage === TorConnectStage.Offline) {
      // Re-send the "Offline" error to push the pages back to "Offline".
      this._internetStatus = InternetStatus.Offline;
      this._signalError(new TorConnectError(TorConnectError.Offline));
    }

    // Return to the previous stage.
    this._setStage(beginStage);
  },

  /**
   * Cancel an ongoing bootstrap attempt.
   */
  cancelBootstrapping() {
    lazy.logger.debug("TorConnect.cancelBootstrapping()");

    this._ensureEnabled();

    if (!this._bootstrapAttempt) {
      lazy.logger.warn("No bootstrap attempt to cancel");
      return;
    }

    this._bootstrapAttempt.cancel();
  },

  /**
   * Request the transition to the given stage.
   *
   * If we are bootstrapping, it will be cancelled and the stage will be
   * transitioned to when it resolves. Otherwise, we will switch to the stage
   * immediately.
   *
   * @param {string} stage - The stage to request.
   * @param {boolean} [overideBootstrapped=false] - Whether the request can
   *   override the "Bootstrapped" stage.
   */
  _makeStageRequest(stage, overrideBootstrapped = false) {
    lazy.logger.debug(`Request for stage ${stage}`);

    this._ensureEnabled();

    if (stage === this._stageName) {
      lazy.logger.info(`Ignoring request for current stage ${stage}`);
      return;
    }
    if (
      !overrideBootstrapped &&
      this._stageName === TorConnectStage.Bootstrapped
    ) {
      lazy.logger.warn(`Cannot move to ${stage} when bootstrapped`);
      return;
    }
    if (this._stageName === TorConnectStage.Loading) {
      if (stage === TorConnectStage.Start) {
        // Will transition to "Start" stage when loading completes.
        lazy.logger.info("Still in the Loading stage");
      } else {
        lazy.logger.warn(`Cannot move to ${stage} when Loading`);
      }
      return;
    }

    if (!this._bootstrapAttempt) {
      // Transition immediately.
      this._setStage(stage);
      return;
    }

    if (this._requestedStage === stage) {
      lazy.logger.info(`Already requesting stage ${stage}`);
      return;
    }
    if (this._requestedStage) {
      lazy.logger.warn(
        `Overriding request for ${this._requestedStage} with ${stage}`
      );
    }
    // Move to stage *after* bootstrap completes.
    this._requestedStage = stage;
    this._bootstrapAttempt?.cancel();
  },

  /**
   * Restart the TorConnect stage to the start.
   */
  startAgain() {
    this._makeStageRequest(TorConnectStage.Start);
  },

  /**
   * Set the stage to be "ChooseRegion".
   */
  chooseRegion() {
    if (!this._potentiallyBlocked) {
      lazy.logger.error("chooseRegion request before getting an error");
      return;
    }
    // NOTE: The ChooseRegion stage needs _errorDetails to be displayed in
    // about:torconnect. The _potentiallyBlocked condition should be
    // sufficient to ensure this.
    this._makeStageRequest(TorConnectStage.ChooseRegion);
  },

  /*
    Further external commands and helper methods
   */
  // TODO: Move to TorConnectParent.
  openTorPreferences() {
    if (lazy.TorLauncherUtil.isAndroid) {
      lazy.EventDispatcher.instance.sendRequest({
        type: "GeckoView:Tor:OpenSettings",
      });
      return;
    }
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
   * @property {"soft"|"hard"} [options.beginBootstrapping] - Whether to try and
   *   begin bootstrapping. "soft" will only trigger the bootstrap if we are not
   *   `potentiallyBlocked`. "hard" will try begin the bootstrap regardless.
   * @property {string} [options.regionCode] - A region to pass in for
   *   auto-bootstrapping.
   */
  openTorConnect(options) {
    // FIXME: Should we move this to the about:torconnect actor?
    const win = lazy.BrowserWindowTracker.getTopWindow();
    win.switchToTabHavingURI("about:torconnect", true, {
      ignoreQueryString: true,
    });

    if (!options?.beginBootstrapping || !this.canBeginBootstrap) {
      return;
    }

    if (options.beginBootstrapping === "hard") {
      if (this.canBeginAutoBootstrap && !options.regionCode) {
        // Treat as an addition startAgain request to first move back to the
        // "Start" stage before bootstrapping.
        this.startAgain();
      }
    } else if (this.potentiallyBlocked) {
      // Do not trigger the bootstrap if we have ever had an error.
      return;
    }

    this.beginBootstrapping(options.regionCode);
  },

  // TODO: Move to TorConnectParent.
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
