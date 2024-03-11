/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";
import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  ConsoleAPI: "resource://gre/modules/Console.sys.mjs",
  MoatRPC: "resource://gre/modules/Moat.sys.mjs",
  TorBootstrapRequest: "resource://gre/modules/TorBootstrapRequest.sys.mjs",
  TorProviderBuilder: "resource://gre/modules/TorProviderBuilder.sys.mjs",
});

// TODO: Should we move this to the about:torconnect actor?
ChromeUtils.defineModuleGetter(
  lazy,
  "BrowserWindowTracker",
  "resource:///modules/BrowserWindowTracker.jsm"
);

import { TorLauncherUtil } from "resource://gre/modules/TorLauncherUtil.sys.mjs";
import { TorSettings } from "resource://gre/modules/TorSettings.sys.mjs";

import { TorStrings } from "resource://gre/modules/TorStrings.sys.mjs";

const TorTopics = Object.freeze({
  LogHasWarnOrErr: "TorLogHasWarnOrErr",
  ProcessExited: "TorProcessExited",
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

XPCOMUtils.defineLazyGetter(
  lazy,
  "logger",
  () =>
    new lazy.ConsoleAPI({
      maxLogLevel: "info",
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
  BootstrapError: "torconnect:bootstrap-error",
});

// The StateCallback is the base class to implement the various states.
// All states should extend it and implement a `run` function, which can
// optionally be async, and define an array of valid transitions.
// The parent class will handle everything else, including the transition to
// other states when the run function is complete etc...
// A system is also provided to allow this function to early-out. The runner
// should check the transitioning getter when appropriate and return.
// This allows to handle, for example, users' requests to cancel a bootstrap
// attempt.
// A state can optionally define a cleanup function, that will be run in all
// cases before transitioning to the next state.
class StateCallback {
  #state;
  #promise;
  #transitioning = false;

  constructor(stateName) {
    this.#state = stateName;
  }

  async begin(...args) {
    lazy.logger.trace(`Entering ${this.#state} state`);
    // Make sure we always have an actual promise.
    try {
      this.#promise = Promise.resolve(this.run(...args));
    } catch (err) {
      this.#promise = Promise.reject(err);
    }
    try {
      // If the callback throws, transition to error as soon as possible.
      await this.#promise;
      lazy.logger.info(`${this.#state}'s run is done`);
    } catch (err) {
      lazy.logger.error(
        `${this.#state}'s run threw, transitioning to the Error state.`,
        err
      );
      this.changeState(TorConnectState.Error, err?.message, err?.details);
    }
  }

  async transition(nextState, ...args) {
    lazy.logger.trace(
      `Transition requested from ${this.#state} to ${nextState.state}`,
      args
    );

    if (this.#transitioning) {
      // Should we check turn this into an error?
      // It will make dealing with the error state harder.
      lazy.logger.warn("this.#transitioning is already true.");
    }

    // Signal we should bail out ASAP.
    this.#transitioning = true;

    lazy.logger.debug(
      `Waiting for the ${
        this.#state
      }'s callback to return before the transition.`
    );
    try {
      await this.#promise;
    } catch (e) {
      // begin should already transform exceptions into the error state.
      if (nextState.state !== TorConnectState.Error) {
        lazy.logger.error(
          `Refusing the transition to ${nextState.state} because the callback threw.`,
          e
        );
        return;
      }
    }
    lazy.logger.debug(`Ready to run ${this.#state} cleanup, if implemented.`);

    if (this.cleanup) {
      try {
        await this.cleanup(nextState.state);
        lazy.logger.debug(`${this.#state}'s cleanup function done.`);
      } catch (e) {
        lazy.logger.warn(`${this.#state}'s cleanup function threw.`, e);
      }
    }

    lazy.logger.debug(
      `Transitioning from ${this.#state} to ${nextState.state}`
    );
    Services.obs.notifyObservers(
      { state: nextState.state },
      TorConnectTopics.StateChange
    );
    nextState.begin(...args);
  }

  changeState(stateName, ...args) {
    // TODO: We could reverse the role, and have TorConnect go through this
    // function insatead.
    TorConnect._changeState(stateName, ...args);
  }

  get transitioning() {
    return this.#transitioning;
  }

  get state() {
    return this.#state;
  }
}

// async method to sleep for a given amount of time
const debugSleep = async ms => {
  return new Promise((resolve, reject) => {
    setTimeout(resolve, ms);
  });
};

// The initial state doesn't actually do anything, so here is a
// skeleton for other states which do perform work
class InitialState extends StateCallback {
  allowedTransitions = Object.freeze([
    TorConnectState.Disabled,
    TorConnectState.Bootstrapping,
    TorConnectState.Configuring,
    TorConnectState.Error,
  ]);

  constructor() {
    super(TorConnectState.Initial);
  }

  async run() {
    // Each state may have a sequence of async work to do.
    let asyncWork = async () => {
      // throw new Error("An error occurred");
    };
    // Any error of thrown will make the state machine move to the error state.
    await asyncWork();

    // After each block we may check for an opportunity to early-out.
    if (this.transitioning) {
      return;
    }

    await asyncWork();

    // Whenever needed, a state can request a transition.
    // this.changeState(TorConnectState.StateName, args, forThe, newState);
  }

  async cleanup(nextState) {
    // Optionally, a state can define a cleanup function, which can also be
    // async. nextState contains the name of the state we are transitioning to.
  }
}

class ConfiguringState extends StateCallback {
  allowedTransitions = Object.freeze([
    TorConnectState.AutoBootstrapping,
    TorConnectState.Bootstrapping,
    TorConnectState.Error,
  ]);

  constructor() {
    super(TorConnectState.Configuring);
  }

  run() {
    // The configuring state does not do anything.
  }
}

class BootstrappingState extends StateCallback {
  #bootstrap = null;
  #bootstrapError = "";
  #bootstrapErrorDetails = "";
  #internetTest = null;
  #cancelled = false;

  allowedTransitions = Object.freeze([
    TorConnectState.Configuring,
    TorConnectState.Bootstrapped,
    TorConnectState.Error,
  ]);

  constructor() {
    super(TorConnectState.Bootstrapping);
  }

  async run() {
    if (await this.#simulateCensorship()) {
      return;
    }

    this.#bootstrap = new lazy.TorBootstrapRequest();
    this.#bootstrap.onbootstrapstatus = (progress, status) => {
      TorConnect._updateBootstrapStatus(progress, status);
    };
    this.#bootstrap.onbootstrapcomplete = () => {
      this.#internetTest.cancel();
      this.changeState(TorConnectState.Bootstrapped);
    };
    this.#bootstrap.onbootstraperror = (message, details) => {
      if (this.#cancelled) {
        // We ignore this error since it occurred after cancelling (by the
        // user). We assume the error is just a side effect of the cancelling.
        // E.g. If the cancelling is triggered late in the process, we get
        // "Building circuits: Establishing a Tor circuit failed".
        // TODO: Maybe move this logic deeper in the process to know when to
        // filter out such errors triggered by cancelling.
        lazy.logger.warn(`Post-cancel error => ${message}; ${details}`);
        return;
      }
      // We have to wait for the Internet test to finish before sending the
      // bootstrap error
      this.#bootstrapError = message;
      this.#bootstrapErrorDetails = details;
      this.#maybeTransitionToError();
    };

    this.#internetTest = new InternetTest();
    this.#internetTest.onResult = (status, date) => {
      // TODO: Use the date to save the clock skew?
      TorConnect._internetStatus = status;
      this.#maybeTransitionToError();
    };
    this.#internetTest.onError = () => {
      this.#maybeTransitionToError();
    };

    this.#bootstrap.bootstrap();
  }

  async cleanup(nextState) {
    if (nextState === TorConnectState.Configuring) {
      // stop bootstrap process if user cancelled
      this.#cancelled = true;
      this.#internetTest?.cancel();
      await this.#bootstrap?.cancel();
    }
  }

  #maybeTransitionToError() {
    if (
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
    // Do not transition to the offline error until we are sure that also the
    // bootstrap failed, in case Moat is down but the bootstrap can proceed
    // anyway.
    if (this.#bootstrapError === "") {
      return;
    }
    if (this.#internetTest.status === InternetStatus.Offline) {
      this.changeState(
        TorConnectState.Error,
        TorStrings.torConnect.offline,
        "",
        true
      );
    } else {
      // Give priority to the bootstrap error, in case the Internet test fails
      TorConnect._hasBootstrapEverFailed = true;
      this.changeState(
        TorConnectState.Error,
        this.#bootstrapError,
        this.#bootstrapErrorDetails,
        true
      );
    }
  }

  async #simulateCensorship() {
    // debug hook to simulate censorship preventing bootstrapping
    const censorshipLevel = Services.prefs.getIntPref(
      TorConnectPrefs.censorship_level,
      0
    );
    if (censorshipLevel <= 0) {
      return false;
    }

    await debugSleep(1500);
    TorConnect._hasBootstrapEverFailed = true;
    if (censorshipLevel === 2) {
      const codes = Object.keys(TorConnect._countryNames);
      TorConnect._detectedLocation =
        codes[Math.floor(Math.random() * codes.length)];
    }
    this.changeState(
      TorConnectState.Error,
      "Bootstrap failed (for debugging purposes)",
      "Error: Censorship simulation",
      true
    );
    return true;
  }
}

class AutoBootstrappingState extends StateCallback {
  allowedTransitions = Object.freeze([
    TorConnectState.Configuring,
    TorConnectState.Bootstrapped,
    TorConnectState.Error,
  ]);

  constructor() {
    super(TorConnectState.AutoBootstrapping);
  }

  async run(countryCode) {
    // debug hook to simulate censorship preventing bootstrapping
    {
      const censorshipLevel = Services.prefs.getIntPref(
        TorConnectPrefs.censorship_level,
        0
      );
      if (censorshipLevel > 1) {
        // always fail even after manually selecting location specific settings
        if (censorshipLevel == 3) {
          await debugSleep(2500);
          this.changeState(
            TorConnectState.Error,
            "Error: censorship simulation",
            "",
            true
          );
          return;
          // only fail after auto selecting, manually selecting succeeds
        } else if (censorshipLevel == 2 && !countryCode) {
          await debugSleep(2500);
          this.changeState(
            TorConnectState.Error,
            "Error: Severe Censorship simulation",
            "",
            true
          );
          return;
        }
      }
    }

    const throw_error = (message, details) => {
      let err = new Error(message);
      err.details = details;
      throw err;
    };

    // lookup user's potential censorship circumvention settings from Moat service
    try {
      this.mrpc = new lazy.MoatRPC();
      await this.mrpc.init();

      if (this.transitioning) {
        return;
      }

      const settings = await this.mrpc.circumvention_settings(
        [...TorSettings.builtinBridgeTypes, "vanilla"],
        countryCode
      );

      if (this.transitioning) {
        return;
      }

      if (settings?.country) {
        TorConnect._detectedLocation = settings.country;
      }
      if (settings?.settings && settings.settings.length) {
        this.settings = settings.settings;
      } else {
        try {
          this.settings = await this.mrpc.circumvention_defaults([
            ...TorSettings.builtinBridgeTypes,
            "vanilla",
          ]);
        } catch (err) {
          lazy.logger.error(
            "We did not get localized settings, and default settings failed as well",
            err
          );
        }
      }
      if (this.settings === null || this.settings.length === 0) {
        // The fallback has failed as well, so throw the original error
        if (!TorConnect._detectedLocation) {
          // unable to determine country
          throw_error(
            TorStrings.torConnect.autoBootstrappingFailed,
            TorStrings.torConnect.cannotDetermineCountry
          );
        } else {
          // no settings available for country
          throw_error(
            TorStrings.torConnect.autoBootstrappingFailed,
            TorStrings.torConnect.noSettingsForCountry
          );
        }
      }

      const restoreOriginalSettings = async () => {
        try {
          await TorSettings.applySettings();
        } catch (e) {
          // We cannot do much if the original settings were bad or
          // if the connection closed, so just report it in the
          // console.
          lazy.logger.warn("Failed to restore original settings.", e);
        }
      };

      // apply each of our settings and try to bootstrap with each
      try {
        for (const [index, currentSetting] of this.settings.entries()) {
          // we want to break here so we can fall through and restore original settings
          if (this.transitioning) {
            break;
          }

          lazy.logger.info(
            `Attempting Bootstrap with configuration ${index + 1}/${
              this.settings.length
            }`
          );

          // Send the new settings directly to the provider. We will
          // save them only if the bootstrap succeeds.
          // FIXME: We should somehow signal TorSettings users that we
          // have set custom settings, and they should not apply
          // theirs until we are done with trying ours.
          // Otherwise, the new settings provided by the user while we
          // were bootstrapping could be the ones that cause the
          // bootstrap to succeed, but we overwrite them (unless we
          // backup the original settings, and then save our new
          // settings only if they have not changed).
          // Another idea (maybe easier to implement) is to disable
          // the settings UI while *any* bootstrap is going on.
          // This is also documented in tor-browser#41921.
          const provider = await lazy.TorProviderBuilder.build();
          // We need to merge with old settings, in case the user is
          // using a proxy or is behind a firewall.
          await provider.writeSettings({
            ...TorSettings.getSettings(),
            ...currentSetting,
          });

          // build out our bootstrap request
          const tbr = new lazy.TorBootstrapRequest();
          tbr.onbootstrapstatus = (progress, status) => {
            TorConnect._updateBootstrapStatus(progress, status);
          };
          tbr.onbootstraperror = (message, details) => {
            lazy.logger.error(`Auto-Bootstrap error => ${message}; ${details}`);
          };

          // update transition callback for user cancel
          this.cleanup = async nextState => {
            if (nextState === TorConnectState.Configuring) {
              await tbr.cancel();
              await restoreOriginalSettings();
            }
          };

          // begin bootstrap
          if (await tbr.bootstrap()) {
            // persist the current settings to preferences
            TorSettings.setSettings(currentSetting);
            TorSettings.saveToPrefs();
            await TorSettings.applySettings();
            this.changeState(TorConnectState.Bootstrapped);
            return;
          }
        }

        // Bootstrap failed for all potential settings, so restore the
        // original settings the provider.
        await restoreOriginalSettings();

        // Only explicitly change state here if something else has not
        // transitioned us.
        if (!this.transitioning) {
          throw_error(
            TorStrings.torConnect.autoBootstrappingFailed,
            TorStrings.torConnect.autoBootstrappingAllFailed
          );
        }
        return;
      } catch (err) {
        await restoreOriginalSettings();
        // throw to outer catch to transition us.
        throw err;
      }
    } catch (err) {
      if (this.mrpc?.inited) {
        // lookup countries which have settings available
        TorConnect._countryCodes = await this.mrpc.circumvention_countries();
      }
      if (!this.transitioning) {
        this.changeState(
          TorConnectState.Error,
          err?.message,
          err?.details,
          true
        );
      } else {
        lazy.logger.error(
          "Received AutoBootstrapping error after transitioning",
          err
        );
      }
    } finally {
      // important to uninit MoatRPC object or else the pt process will live as long as tor-browser
      this.mrpc?.uninit();
    }
  }
}

class BootstrappedState extends StateCallback {
  // We may need to leave the bootstrapped state if the tor daemon
  // exits (if it is restarted, we will have to bootstrap again).
  allowedTransitions = Object.freeze([TorConnectState.Configuring]);

  constructor() {
    super(TorConnectState.Bootstrapped);
  }

  run() {
    // Notify observers of bootstrap completion.
    Services.obs.notifyObservers(null, TorConnectTopics.BootstrapComplete);
  }
}

class ErrorState extends StateCallback {
  allowedTransitions = Object.freeze([TorConnectState.Configuring]);

  constructor() {
    super(TorConnectState.Error);
  }

  run(errorMessage, errorDetails, bootstrappingFailure) {
    TorConnect._errorMessage = errorMessage;
    TorConnect._errorDetails = errorDetails;
    lazy.logger.error(
      `Entering error state (${errorMessage}, ${errorDetails})`
    );

    Services.obs.notifyObservers(
      { message: errorMessage, details: errorDetails },
      TorConnectTopics.BootstrapError
    );

    this.changeState(TorConnectState.Configuring);
  }
}

class DisabledState extends StateCallback {
  allowedTransitions = Object.freeze([]);

  constructor() {
    super(TorConnectState.DisabledState);
  }

  async run() {
    await new Promise(() => {
      // Trap state: no way to leave the Disabled state.
      lazy.logger.debug("Entered the disabled state.");
    });
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
  #timeout = 0;

  constructor() {
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
    this.onResult = (online, date) => {};
    this.onError = err => {};
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

    lazy.logger.info("Starting the Internet test");
    const mrpc = new lazy.MoatRPC();
    try {
      await mrpc.init();
      const status = await mrpc.testInternetConnection();
      this.#status = status.successful
        ? InternetStatus.Online
        : InternetStatus.Offline;
      lazy.logger.info(`Performed Internet test, outcome ${this.#status}`);
      setTimeout(() => {
        this.onResult(this.#status, status.date);
      });
    } catch (err) {
      lazy.logger.error("Error while checking the Internet connection", err);
      this.#error = err;
      this.#pending = false;
      setTimeout(() => {
        this.onError(err);
      });
    } finally {
      mrpc.uninit();
    }
  }

  cancel() {
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

export const TorConnect = (() => {
  let retval = {
    _state: new InitialState(),
    _bootstrapProgress: 0,
    _bootstrapStatus: null,
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
    _errorMessage: null,
    _errorDetails: null,
    _logHasWarningOrError: false,
    _hasEverFailed: false,
    _hasBootstrapEverFailed: false,
    _transitionPromise: null,

    // This is used as a helper to make the state of about:torconnect persistent
    // during a session, but TorConnect does not use this data at all.
    _uiState: {},

    _stateCallbacks: Object.freeze(
      new Map([
        // Initial is never transitioned to
        [TorConnectState.Initial, InitialState],
        [TorConnectState.Configuring, ConfiguringState],
        [TorConnectState.Bootstrapping, BootstrappingState],
        [TorConnectState.AutoBootstrapping, AutoBootstrappingState],
        [TorConnectState.Bootstrapped, BootstrappedState],
        [TorConnectState.Error, ErrorState],
        [TorConnectState.Disabled, DisabledState],
      ])
    ),

    _makeState(state) {
      const klass = this._stateCallbacks.get(state);
      if (!klass) {
        throw new Error(`${state} is not a valid state.`);
      }
      return new klass();
    },

    _changeState(newState, ...args) {
      if (newState === TorConnectState.Error) {
        this._hasEverFailed = true;
      }
      const prevState = this._state;

      // ensure this is a valid state transition
      if (!prevState.allowedTransitions.includes(newState)) {
        throw Error(
          `TorConnect: Attempted invalid state transition from ${prevState.state} to ${newState}`
        );
      }

      lazy.logger.trace(
        `Try transitioning from ${prevState.state} to ${newState}`,
        args
      );

      // Set our new state first so that state transitions can themselves
      // trigger a state transition.
      this._state = this._makeState(newState);

      // Call our state run function and forward any args.
      prevState.transition(this._state, ...args);
    },

    _updateBootstrapStatus(progress, status) {
      this._bootstrapProgress = progress;
      this._bootstrapStatus = status;

      lazy.logger.info(
        `Bootstrapping ${this._bootstrapProgress}% complete (${this._bootstrapStatus})`
      );
      Services.obs.notifyObservers(
        {
          progress: TorConnect._bootstrapProgress,
          status: TorConnect._bootstrapStatus,
          hasWarnings: TorConnect._logHasWarningOrError,
        },
        TorConnectTopics.BootstrapProgress
      );
    },

    // init should be called by TorStartupService
    init() {
      lazy.logger.debug("TorConnect.init()");
      this._state.begin();

      if (!this.enabled) {
        // Disabled
        this._changeState(TorConnectState.Disabled);
      } else {
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
        TorSettings.initializedPromise.then(() => this._settingsInitialized());

        // register the Tor topics we always care about
        observeTopic(TorTopics.ProcessExited);
        observeTopic(TorTopics.LogHasWarnOrErr);
      }
    },

    async observe(subject, topic, data) {
      lazy.logger.debug(`Observed ${topic}`);

      switch (topic) {
        case TorTopics.LogHasWarnOrErr: {
          this._logHasWarningOrError = true;
          break;
        }
        case TorTopics.ProcessExited: {
          // Treat a failure as a possibly broken configuration.
          // So, prevent quickstart at the next start.
          Services.prefs.setBoolPref(TorLauncherPrefs.prompt_at_startup, true);
          switch (this._state) {
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
      return TorLauncherUtil.shouldStartAndOwnTor;
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
      return this._state.allowedTransitions.includes(
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
      return this._state.allowedTransitions.includes(
        TorConnectState.AutoBootstrapping
      );
    },

    get shouldQuickStart() {
      // quickstart must be enabled
      return (
        TorSettings.quickstart.enabled &&
        // and the previous bootstrap attempt must have succeeded
        !Services.prefs.getBoolPref(TorLauncherPrefs.prompt_at_startup, true)
      );
    },

    get state() {
      return this._state.state;
    },

    get bootstrapProgress() {
      return this._bootstrapProgress;
    },

    get bootstrapStatus() {
      return this._bootstrapStatus;
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

    get errorMessage() {
      return this._errorMessage;
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
      return this._hasEverFailed;
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
      // Difference with the getter: this is to be called by TorConnectParent, and downloads
      // the country codes if they are not already in cache.
      if (this._countryCodes.length) {
        return this._countryCodes;
      }
      const mrpc = new lazy.MoatRPC();
      try {
        await mrpc.init();
        this._countryCodes = await mrpc.circumvention_countries();
      } catch (err) {
        lazy.logger.error(
          "An error occurred while fetching country codes",
          err
        );
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
      lazy.logger.debug(`Will load after bootstrap => [${uris.join(", ")}]`);
      return uris.map(uri => this.getRedirectURL(uri));
    },
  };
  return retval;
})(); /* TorConnect */
