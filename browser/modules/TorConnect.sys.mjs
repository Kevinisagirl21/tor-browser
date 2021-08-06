/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  MoatRPC: "resource:///modules/Moat.sys.mjs",
  TorBootstrapRequest: "resource://gre/modules/TorBootstrapRequest.sys.mjs",
});

// TODO: Should we move this to the about:torconnect actor?
ChromeUtils.defineModuleGetter(
  lazy,
  "BrowserWindowTracker",
  "resource:///modules/BrowserWindowTracker.jsm"
);

import { TorLauncherUtil } from "resource://gre/modules/TorLauncherUtil.sys.mjs";
import {
  TorSettings,
  TorSettingsTopics,
  TorBuiltinBridgeTypes,
} from "resource:///modules/TorSettings.sys.mjs";

const { TorStrings } = ChromeUtils.import("resource:///modules/TorStrings.jsm");

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

/* Maps allowed state transitions
   TorConnectStateTransitions[state] maps to an array of allowed states to transition to
   This is just an encoding of the above transition diagram that we verify at runtime
*/
const TorConnectStateTransitions = Object.freeze(
  new Map([
    [
      TorConnectState.Initial,
      [
        TorConnectState.Disabled,
        TorConnectState.Bootstrapping,
        TorConnectState.Configuring,
        TorConnectState.Error,
      ],
    ],
    [
      TorConnectState.Configuring,
      [
        TorConnectState.AutoBootstrapping,
        TorConnectState.Bootstrapping,
        TorConnectState.Error,
      ],
    ],
    [
      TorConnectState.AutoBootstrapping,
      [
        TorConnectState.Configuring,
        TorConnectState.Bootstrapped,
        TorConnectState.Error,
      ],
    ],
    [
      TorConnectState.Bootstrapping,
      [
        TorConnectState.Configuring,
        TorConnectState.Bootstrapped,
        TorConnectState.Error,
      ],
    ],
    [TorConnectState.Error, [TorConnectState.Configuring]],
    [TorConnectState.Bootstrapped, [TorConnectState.Configuring]],
    // terminal states
    [TorConnectState.Disabled, []],
  ])
);

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
  constructor(state, callback) {
    this._state = state;
    this._callback = callback;
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
    console.log(`TorConnect: Entering ${this._state} state`);
    this._init();
    try {
      // this Promise will block until this StateCallback has completed its work
      await Promise.resolve(this._callback.call(this._context, ...args));
      console.log(`TorConnect: Exited ${this._state} state`);

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

export const InternetStatus = Object.freeze({
  Unknown: -1,
  Offline: 0,
  Online: 1,
});

class InternetTest {
  constructor() {
    this._enabled = Services.prefs.getBoolPref(
      TorConnectPrefs.allow_internet_test,
      true
    );

    this._status = InternetStatus.Unknown;
    this._error = null;
    this._pending = false;
    if (this._enabled) {
      this._timeout = setTimeout(() => {
        this._timeout = null;
        this.test();
      }, this.timeoutRand());
    }
    this.onResult = (online, date) => {};
    this.onError = err => {};
  }

  test() {
    if (this._pending || !this._enabled) {
      return;
    }
    this.cancel();
    this._pending = true;

    console.log("TorConnect: starting the Internet test");
    this._testAsync()
      .then(status => {
        this._pending = false;
        this._status = status.successful
          ? InternetStatus.Online
          : InternetStatus.Offline;
        console.log(
          `TorConnect: performed Internet test, outcome ${this._status}`
        );
        this.onResult(this.status, status.date);
      })
      .catch(error => {
        this._error = error;
        this._pending = false;
        this.onError(error);
      });
  }

  cancel() {
    if (this._timeout !== null) {
      clearTimeout(this._timeout);
      this._timeout = null;
    }
  }

  async _testAsync() {
    // Callbacks for the Internet test are desirable, because we will be
    // waiting both for the bootstrap, and for the Internet test.
    // However, managing Moat with async/await is much easier as it avoids a
    // callback hell, and it makes extra explicit that we are uniniting it.
    const mrpc = new lazy.MoatRPC();
    let status = null;
    let error = null;
    try {
      await mrpc.init();
      status = await mrpc.testInternetConnection();
    } catch (err) {
      console.error("Error while checking the Internet connection", err);
      error = err;
    } finally {
      mrpc.uninit();
    }
    if (error !== null) {
      throw error;
    }
    return status;
  }

  get status() {
    return this._status;
  }

  get error() {
    return this._error;
  }

  get enabled() {
    return this._enabled;
  }

  // We randomize the Internet test timeout to make fingerprinting it harder, at least a little bit...
  timeoutRand() {
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
        /* Initial is never transitioned to */
        [
          TorConnectState.Initial,
          new StateCallback(TorConnectState.Initial, async function () {
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
          }),
        ],
        /* Configuring */
        [
          TorConnectState.Configuring,
          new StateCallback(TorConnectState.Configuring, async function () {
            await new Promise(async (resolve, reject) => {
              this.on_transition = nextState => {
                resolve();
              };
            });
          }),
        ],
        /* Bootstrapping */
        [
          TorConnectState.Bootstrapping,
          new StateCallback(TorConnectState.Bootstrapping, async function () {
            // wait until bootstrap completes or we get an error
            await new Promise(async (resolve, reject) => {
              // debug hook to simulate censorship preventing bootstrapping
              if (
                Services.prefs.getIntPref(TorConnectPrefs.censorship_level, 0) >
                0
              ) {
                this.on_transition = nextState => {
                  resolve();
                };
                await debug_sleep(1500);
                TorConnect._hasBootstrapEverFailed = true;
                if (
                  Services.prefs.getIntPref(
                    TorConnectPrefs.censorship_level,
                    0
                  ) === 2
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
                  console.log(
                    `TorConnect: Post-cancel error => ${message}; ${details}`
                  );
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
          }),
        ],
        /* AutoBootstrapping */
        [
          TorConnectState.AutoBootstrapping,
          new StateCallback(TorConnectState.AutoBootstrapping, async function (
            countryCode
          ) {
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
                  [...TorBuiltinBridgeTypes, "vanilla"],
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
                      ...TorBuiltinBridgeTypes,
                      "vanilla",
                    ]);
                  } catch (err) {
                    console.error(
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

                // apply each of our settings and try to bootstrap with each
                try {
                  this.originalSettings = TorSettings.getSettings();

                  for (const [
                    index,
                    currentSetting,
                  ] of this.settings.entries()) {
                    // we want to break here so we can fall through and restore original settings
                    if (this.transitioning) {
                      break;
                    }

                    console.log(
                      `TorConnect: Attempting Bootstrap with configuration ${
                        index + 1
                      }/${this.settings.length}`
                    );

                    TorSettings.setSettings(currentSetting);
                    await TorSettings.applySettings();

                    // build out our bootstrap request
                    const tbr = new lazy.TorBootstrapRequest();
                    tbr.onbootstrapstatus = (progress, status) => {
                      TorConnect._updateBootstrapStatus(progress, status);
                    };
                    tbr.onbootstraperror = (message, details) => {
                      console.log(
                        `TorConnect: Auto-Bootstrap error => ${message}; ${details}`
                      );
                    };

                    // update transition callback for user cancel
                    this.on_transition = async nextState => {
                      if (nextState === TorConnectState.Configuring) {
                        await tbr.cancel();
                      }
                      resolve();
                    };

                    // begin bootstrap
                    if (await tbr.bootstrap()) {
                      // persist the current settings to preferences
                      TorSettings.saveToPrefs();
                      TorConnect._changeState(TorConnectState.Bootstrapped);
                      return;
                    }
                  }

                  // bootstrapped failed for all potential settings, so reset daemon to use original
                  TorSettings.setSettings(this.originalSettings);
                  // The original settings should be good, so we save them to
                  // preferences before trying to apply them, as it might fail
                  // if the actual problem is with the connection to the control
                  // port.
                  // FIXME: We should handle this case in a better way.
                  TorSettings.saveToPrefs();
                  await TorSettings.applySettings();

                  // only explicitly change state here if something else has not transitioned us
                  if (!this.transitioning) {
                    throw_error(
                      TorStrings.torConnect.autoBootstrappingFailed,
                      TorStrings.torConnect.autoBootstrappingAllFailed
                    );
                  }
                  return;
                } catch (err) {
                  // restore original settings in case of error
                  try {
                    TorSettings.setSettings(this.originalSettings);
                    // As above
                    TorSettings.saveToPrefs();
                    await TorSettings.applySettings();
                  } catch (errRestore) {
                    console.log(
                      `TorConnect: Failed to restore original settings => ${errRestore}`
                    );
                  }
                  // throw to outer catch to transition us
                  throw err;
                }
              } catch (err) {
                if (this.mrpc?.inited) {
                  // lookup countries which have settings available
                  TorConnect._countryCodes =
                    await this.mrpc.circumvention_countries();
                }
                if (!this.transitioning) {
                  TorConnect._changeState(
                    TorConnectState.Error,
                    err?.message,
                    err?.details,
                    true
                  );
                } else {
                  console.error(
                    "TorConnect: Received AutoBootstrapping error after transitioning",
                    err
                  );
                }
              } finally {
                // important to uninit MoatRPC object or else the pt process will live as long as tor-browser
                this.mrpc?.uninit();
              }
            });
          }),
        ],
        /* Bootstrapped */
        [
          TorConnectState.Bootstrapped,
          new StateCallback(TorConnectState.Bootstrapped, async function () {
            await new Promise((resolve, reject) => {
              // We may need to leave the bootstrapped state if the tor daemon
              // exits (if it is restarted, we will have to bootstrap again).
              this.on_transition = nextState => {
                resolve();
              };
              // notify observers of bootstrap completion
              Services.obs.notifyObservers(
                null,
                TorConnectTopics.BootstrapComplete
              );
            });
          }),
        ],
        /* Error */
        [
          TorConnectState.Error,
          new StateCallback(TorConnectState.Error, async function (
            errorMessage,
            errorDetails,
            bootstrappingFailure
          ) {
            await new Promise((resolve, reject) => {
              this.on_transition = async nextState => {
                resolve();
              };

              TorConnect._errorMessage = errorMessage;
              TorConnect._errorDetails = errorDetails;

              Services.obs.notifyObservers(
                { message: errorMessage, details: errorDetails },
                TorConnectTopics.BootstrapError
              );

              TorConnect._changeState(TorConnectState.Configuring);
            });
          }),
        ],
        /* Disabled */
        [
          TorConnectState.Disabled,
          new StateCallback(TorConnectState.Disabled, async function () {
            await new Promise((resolve, reject) => {
              // no-op, on_transition not defined because no way to leave Disabled state
            });
          }),
        ],
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

      // ensure this is a valid state transition
      if (!TorConnectStateTransitions.get(prevState)?.includes(newState)) {
        throw Error(
          `TorConnect: Attempted invalid state transition from ${prevState} to ${newState}`
        );
      }

      console.log(
        `TorConnect: Try transitioning from ${prevState} to ${newState}`
      );

      // set our new state first so that state transitions can themselves trigger
      // a state transition
      this._state = newState;

      // call our state function and forward any args
      this._callback(prevState).transition(newState, ...args);
    },

    _updateBootstrapStatus(progress, status) {
      this._bootstrapProgress = progress;
      this._bootstrapStatus = status;

      console.log(
        `TorConnect: Bootstrapping ${this._bootstrapProgress}% complete (${this._bootstrapStatus})`
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
      console.log("TorConnect: init()");
      this._callback(TorConnectState.Initial).begin();

      if (!this.enabled) {
        // Disabled
        this._changeState(TorConnectState.Disabled);
      } else {
        let observeTopic = addTopic => {
          Services.obs.addObserver(this, addTopic);
          console.log(`TorConnect: Observing topic '${addTopic}'`);
        };

        // register the Tor topics we always care about
        observeTopic(TorTopics.ProcessExited);
        observeTopic(TorTopics.LogHasWarnOrErr);
        observeTopic(TorSettingsTopics.Ready);
      }
    },

    async observe(subject, topic, data) {
      console.log(`TorConnect: Observed ${topic}`);

      switch (topic) {
        /* We need to wait until TorSettings have been loaded and applied before we can Quickstart */
        case TorSettingsTopics.Ready: {
          // tor-browser#41907: This is only a workaround to avoid users being
          // bounced back to the initial panel without any explanation.
          // Longer term we should disable the clickable elements, or find a UX
          // to prevent this from happening (e.g., allow buttons to be clicked,
          // but show an intermediate starting state, or a message that tor is
          // starting while the butons are disabled, etc...).
          if (this.state !== TorConnectState.Initial) {
            console.warn(
              "TorConnect: Seen the torsettings:ready after the state has already changed, ignoring the notification."
            );
            break;
          }
          if (this.shouldQuickStart) {
            // Quickstart
            this._changeState(TorConnectState.Bootstrapping);
          } else {
            // Configuring
            this._changeState(TorConnectState.Configuring);
          }
          break;
        }
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
      return TorConnectStateTransitions.get(this.state).includes(
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
      return TorConnectStateTransitions.get(this.state).includes(
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
      console.log("TorConnect: beginBootstrap()");
      this._changeState(TorConnectState.Bootstrapping);
    },

    cancelBootstrap() {
      console.log("TorConnect: cancelBootstrap()");
      this._changeState(TorConnectState.Configuring);
    },

    beginAutoBootstrap(countryCode) {
      console.log("TorConnect: beginAutoBootstrap()");
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
        console.log("An error occurred while fetching country codes", err);
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
        console.error(
          `TorConnect: received unknown variant '${JSON.stringify(uriVariant)}'`
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
      console.log(
        `TorConnect: Will load after bootstrap => [${uris.join(", ")}]`
      );
      return uris.map(uri => this.getRedirectURL(uri));
    },
  };
  return retval;
})(); /* TorConnect */
