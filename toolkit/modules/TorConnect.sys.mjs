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

// The StateCallback is a wrapper around an async function which executes during
// the lifetime of a TorConnect State. A system is also provided to allow this
// ongoing function to early-out via a per StateCallback on_transition callback
// which may be called externally when we need to early-out and move on to another
// state (for example, from Bootstrapping to Configuring in the event the user
// cancels a bootstrap attempt)
class StateCallback {
  constructor(state) {
    this._state = state;
    this._init();
  }

  _init() {
    // this context object is bound to the callback each time transition is
    // attempted via begin()
    this._context = {
      // This callback may be overwritten in the _callback for each state
      // States may have various pieces of work which need to occur
      // before they can be exited (eg resource cleanup)
      // See the _stateCallbacks map for examples
      on_transition: nextState => {},

      // flag used to determine if a StateCallback should early-out
      // its work
      _transitioning: false,

      // may be called within the StateCallback to determine if exit is possible
      get transitioning() {
        return this._transitioning;
      },
    };
  }

  async begin(...args) {
    lazy.logger.trace(`Entering ${this._state} state`);
    this._init();
    try {
      // this Promise will block until this StateCallback has completed its work
      await Promise.resolve(this._callback.call(this._context, ...args));
      lazy.logger.info(`Exited ${this._state} state`);

      // handled state transition
      Services.obs.notifyObservers(
        { state: this._nextState },
        TorConnectTopics.StateChange
      );
      TorConnect._callback(this._nextState).begin(...this._nextStateArgs);
    } catch (obj) {
      TorConnect._changeState(
        TorConnectState.Error,
        obj?.message,
        obj?.details
      );
    }
  }

  transition(nextState, ...args) {
    this._nextState = nextState;
    this._nextStateArgs = [...args];

    // calls the on_transition callback to resolve any async work or do per-state cleanup
    // this call to on_transition should resolve the async work currentlying going on in this.begin()
    this._context.on_transition(nextState);
    this._context._transitioning = true;
  }
}

// async method to sleep for a given amount of time
const debug_sleep = async ms => {
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

  _callback = initialCallback;

  constructor() {
    super(TorConnectState.Initial);
  }
}

async function initialCallback() {
  // The initial state doesn't actually do anything, so here is a skeleton for other
  // states which do perform work
  await new Promise(async (resolve, reject) => {
    // This function is provided to signal to the callback that it is complete.
    // It is called as a result of _changeState and at the very least must
    // resolve the root Promise object within the StateCallback function
    // The on_transition callback may also perform necessary cleanup work
    this.on_transition = nextState => {
      resolve();
    };

    try {
      // each state may have a sequence of async work to do
      let asyncWork = async () => {};
      await asyncWork();

      // after each block we may check for an opportunity to early-out
      if (this.transitioning) {
        return;
      }

      // repeat the above pattern as necessary
    } catch (err) {
      // any thrown exceptions here will trigger a transition to the Error state
      TorConnect._changeState(
        TorConnectState.Error,
        err?.message,
        err?.details
      );
    }
  });
}

class ConfiguringState extends StateCallback {
  allowedTransitions = Object.freeze([
    TorConnectState.AutoBootstrapping,
    TorConnectState.Bootstrapping,
    TorConnectState.Error,
  ]);

  _callback = configuringCallback;

  constructor() {
    super(TorConnectState.Configuring);
  }
}

async function configuringCallback() {
  await new Promise(async (resolve, reject) => {
    this.on_transition = nextState => {
      resolve();
    };
  });
}

class BootstrappingState extends StateCallback {
  allowedTransitions = Object.freeze([
    TorConnectState.Configuring,
    TorConnectState.Bootstrapped,
    TorConnectState.Error,
  ]);

  _callback = bootstrappingCallback;

  constructor() {
    super(TorConnectState.Bootstrapping);
  }
}

async function bootstrappingCallback() {
  // wait until bootstrap completes or we get an error
  await new Promise(async (resolve, reject) => {
    // debug hook to simulate censorship preventing bootstrapping
    if (Services.prefs.getIntPref(TorConnectPrefs.censorship_level, 0) > 0) {
      this.on_transition = nextState => {
        resolve();
      };
      await debug_sleep(1500);
      TorConnect._hasBootstrapEverFailed = true;
      if (
        Services.prefs.getIntPref(TorConnectPrefs.censorship_level, 0) === 2
      ) {
        const codes = Object.keys(TorConnect._countryNames);
        TorConnect._detectedLocation =
          codes[Math.floor(Math.random() * codes.length)];
      }
      TorConnect._changeState(
        TorConnectState.Error,
        "Bootstrap failed (for debugging purposes)",
        "Error: Censorship simulation",
        true
      );
      return;
    }

    const tbr = new lazy.TorBootstrapRequest();
    const internetTest = new InternetTest();
    let cancelled = false;

    let bootstrapError = "";
    let bootstrapErrorDetails = "";
    const maybeTransitionToError = () => {
      if (
        internetTest.status === InternetStatus.Unknown &&
        internetTest.error === null &&
        internetTest.enabled
      ) {
        // We have been called by a failed bootstrap, but the internet test has not run yet - force
        // it to run immediately!
        internetTest.test();
        // Return from this call, because the Internet test's callback will call us again
        return;
      }
      // Do not transition to the offline error until we are sure that also the bootstrap failed, in
      // case Moat is down but the bootstrap can proceed anyway.
      if (bootstrapError === "") {
        return;
      }
      if (internetTest.status === InternetStatus.Offline) {
        TorConnect._changeState(
          TorConnectState.Error,
          TorStrings.torConnect.offline,
          "",
          true
        );
      } else {
        // Give priority to the bootstrap error, in case the Internet test fails
        TorConnect._hasBootstrapEverFailed = true;
        TorConnect._changeState(
          TorConnectState.Error,
          bootstrapError,
          bootstrapErrorDetails,
          true
        );
      }
    };

    this.on_transition = async nextState => {
      if (nextState === TorConnectState.Configuring) {
        // stop bootstrap process if user cancelled
        cancelled = true;
        internetTest.cancel();
        await tbr.cancel();
      }
      resolve();
    };

    tbr.onbootstrapstatus = (progress, status) => {
      TorConnect._updateBootstrapStatus(progress, status);
    };
    tbr.onbootstrapcomplete = () => {
      internetTest.cancel();
      TorConnect._changeState(TorConnectState.Bootstrapped);
    };
    tbr.onbootstraperror = (message, details) => {
      if (cancelled) {
        // We ignore this error since it occurred after cancelling (by
        // the user). We assume the error is just a side effect of the
        // cancelling.
        // E.g. If the cancelling is triggered late in the process, we
        // get "Building circuits: Establishing a Tor circuit failed".
        // TODO: Maybe move this logic deeper in the process to know
        // when to filter out such errors triggered by cancelling.
        lazy.logger.warn(`Post-cancel error => ${message}; ${details}`);
        return;
      }
      // We have to wait for the Internet test to finish before sending the bootstrap error
      bootstrapError = message;
      bootstrapErrorDetails = details;
      maybeTransitionToError();
    };

    internetTest.onResult = (status, date) => {
      // TODO: Use the date to save the clock skew?
      TorConnect._internetStatus = status;
      maybeTransitionToError();
    };
    internetTest.onError = () => {
      maybeTransitionToError();
    };

    tbr.bootstrap();
  });
}

class AutoBootstrappingState extends StateCallback {
  allowedTransitions = Object.freeze([
    TorConnectState.Configuring,
    TorConnectState.Bootstrapped,
    TorConnectState.Error,
  ]);

  _callback = autoBootstrappingCallback;

  constructor() {
    super(TorConnectState.AutoBootstrapping);
  }
}

async function autoBootstrappingCallback(countryCode) {
  await new Promise(async (resolve, reject) => {
    this.on_transition = nextState => {
      resolve();
    };

    // debug hook to simulate censorship preventing bootstrapping
    {
      const censorshipLevel = Services.prefs.getIntPref(
        TorConnectPrefs.censorship_level,
        0
      );
      if (censorshipLevel > 1) {
        this.on_transition = nextState => {
          resolve();
        };
        // always fail even after manually selecting location specific settings
        if (censorshipLevel == 3) {
          await debug_sleep(2500);
          TorConnect._changeState(
            TorConnectState.Error,
            "Error: censorship simulation",
            "",
            true
          );
          return;
          // only fail after auto selecting, manually selecting succeeds
        } else if (censorshipLevel == 2 && !countryCode) {
          await debug_sleep(2500);
          TorConnect._changeState(
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
          this.on_transition = async nextState => {
            if (nextState === TorConnectState.Configuring) {
              await tbr.cancel();
              await restoreOriginalSettings();
            }
            resolve();
          };

          // begin bootstrap
          if (await tbr.bootstrap()) {
            // persist the current settings to preferences
            TorSettings.setSettings(currentSetting);
            TorSettings.saveToPrefs();
            await TorSettings.applySettings();
            TorConnect._changeState(TorConnectState.Bootstrapped);
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
        TorConnect._changeState(
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
  });
}

class BootstrappedState extends StateCallback {
  allowedTransitions = Object.freeze([TorConnectState.Configuring]);

  _callback = bootstrappedCallback;

  constructor() {
    super(TorConnectState.Bootstrapped);
  }
}

async function bootstrappedCallback() {
  await new Promise((resolve, reject) => {
    // We may need to leave the bootstrapped state if the tor daemon
    // exits (if it is restarted, we will have to bootstrap again).
    this.on_transition = nextState => {
      resolve();
    };
    // notify observers of bootstrap completion
    Services.obs.notifyObservers(null, TorConnectTopics.BootstrapComplete);
  });
}

class ErrorState extends StateCallback {
  allowedTransitions = Object.freeze([TorConnectState.Configuring]);

  _callback = errorCallback;

  constructor() {
    super(TorConnectState.Error);
  }
}

async function errorCallback(errorMessage, errorDetails, bootstrappingFailure) {
  await new Promise((resolve, reject) => {
    this.on_transition = async nextState => {
      resolve();
    };

    TorConnect._errorMessage = errorMessage;
    TorConnect._errorDetails = errorDetails;
    lazy.logger.error(
      `Entering error state (${errorMessage}, ${errorDetails})`
    );

    Services.obs.notifyObservers(
      { message: errorMessage, details: errorDetails },
      TorConnectTopics.BootstrapError
    );

    TorConnect._changeState(TorConnectState.Configuring);
  });
}

class DisabledState extends StateCallback {
  allowedTransitions = Object.freeze([]);

  _callback = disabledCallback;

  constructor() {
    super(TorConnectState.DisabledState);
  }
}

async function disabledCallback() {
  await new Promise((resolve, reject) => {
    // no-op, on_transition not defined because no way to leave Disabled state
  });
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
    _state: TorConnectState.Initial,
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

    /* These functions represent ongoing work associated with one of our states
           Some of these functions are mostly empty, apart from defining an
           on_transition function used to resolve their Promise */
    _stateCallbacks: Object.freeze(
      new Map([
        // Initial is never transitioned to
        [TorConnectState.Initial, new InitialState()],
        [TorConnectState.Configuring, new ConfiguringState()],
        [TorConnectState.Bootstrapping, new BootstrappingState()],
        [TorConnectState.AutoBootstrapping, new AutoBootstrappingState()],
        [TorConnectState.Bootstrapped, new BootstrappedState()],
        [TorConnectState.Error, new ErrorState()],
        [TorConnectState.Disabled, new DisabledState()],
      ])
    ),

    _callback(state) {
      return this._stateCallbacks.get(state);
    },

    _changeState(newState, ...args) {
      if (newState === TorConnectState.Error) {
        this._hasEverFailed = true;
      }
      const prevState = this._state;
      const prevCallback = this._callback(prevState);

      // ensure this is a valid state transition
      if (!prevCallback?.allowedTransitions.includes(newState)) {
        throw Error(
          `TorConnect: Attempted invalid state transition from ${prevState} to ${newState}`
        );
      }

      lazy.logger.trace(`Try transitioning from ${prevState} to ${newState}`);

      // set our new state first so that state transitions can themselves trigger
      // a state transition
      this._state = newState;

      // call our state function and forward any args
      prevCallback.transition(newState, ...args);
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
      this._callback(TorConnectState.Initial).begin();

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
      return this._callback(this.state)?.allowedTransitions.includes(
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
      return this._callback(this.state)?.allowedTransitions.includes(
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
      return this._state;
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
