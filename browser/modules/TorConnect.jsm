"use strict";

var EXPORTED_SYMBOLS = ["TorConnect", "TorConnectTopics", "TorConnectState"];

const { Services } = ChromeUtils.import(
    "resource://gre/modules/Services.jsm"
);

const { BrowserWindowTracker } = ChromeUtils.import(
    "resource:///modules/BrowserWindowTracker.jsm"
);

const { TorProtocolService, TorProcessStatus, TorTopics, TorBootstrapRequest } = ChromeUtils.import(
    "resource:///modules/TorProtocolService.jsm"
);

const { TorLauncherUtil } = ChromeUtils.import(
    "resource://torlauncher/modules/tl-util.jsm"
);

const { TorSettings, TorSettingsTopics, TorBridgeSource, TorBuiltinBridgeTypes, TorProxyType } = ChromeUtils.import(
    "resource:///modules/TorSettings.jsm"
);

const { MoatRPC } = ChromeUtils.import("resource:///modules/Moat.jsm");

/* Browser observer topis */
const BrowserTopics = Object.freeze({
    ProfileAfterChange: "profile-after-change",
});

/* Relevant prefs used by tor-launcher */
const TorLauncherPrefs = Object.freeze({
  prompt_at_startup: "extensions.torlauncher.prompt_at_startup",
});

const TorConnectState = Object.freeze({
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
    │         │                        ▲                                  │
    │         │ beginAutoBootstrap()   │ cancelAutoBootstrap()            │
    │         ▼                        │                                  │
    │       ┌───────────────────────┐  │                                  │
    └────── │   AutoBootstrapping   │ ─┘                                  │
            └───────────────────────┘                                     │
              │                                                           │
              │                                                           │
              ▼                                                           │
            ┌───────────────────────┐                                     │
            │     Bootstrapped      │ ◀───────────────────────────────────┘
            └───────────────────────┘
*/

/* Maps allowed state transitions
   TorConnectStateTransitions[state] maps to an array of allowed states to transition to
   This is just an encoding of the above transition diagram that we verify at runtime
*/
const TorConnectStateTransitions =
    Object.freeze(new Map([
        [TorConnectState.Initial,
            [TorConnectState.Disabled,
             TorConnectState.Bootstrapping,
             TorConnectState.Configuring,
             TorConnectState.Error]],
        [TorConnectState.Configuring,
            [TorConnectState.AutoBootstrapping,
             TorConnectState.Bootstrapping,
             TorConnectState.Error]],
        [TorConnectState.AutoBootstrapping,
            [TorConnectState.Configuring,
             TorConnectState.Bootstrapped,
             TorConnectState.Error]],
        [TorConnectState.Bootstrapping,
            [TorConnectState.Configuring,
             TorConnectState.Bootstrapped,
             TorConnectState.Error]],
        [TorConnectState.Error,
            [TorConnectState.Configuring]],
        // terminal states
        [TorConnectState.Bootstrapped, []],
        [TorConnectState.Disabled, []],
    ]));

/* Topics Notified by the TorConnect module */
const TorConnectTopics = Object.freeze({
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
            on_transition: (nextState) => {},

            // flag used to determine if a StateCallback should early-out
            // its work
            _transitioning: false,

            // may be called within the StateCallback to determine if exit is possible
            get transitioning() {
                return this._transitioning;
            }
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
            Services.obs.notifyObservers({state: this._nextState}, TorConnectTopics.StateChange);
            TorConnect._callback(this._nextState).begin(...this._nextStateArgs);
        } catch (obj) {
            TorConnect._changeState(TorConnectState.Error, obj?.message, obj?.details);
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

const TorConnect = (() => {
    let retval = {

        _state: TorConnectState.Initial,
        _bootstrapProgress: 0,
        _bootstrapStatus: null,
        _errorMessage: null,
        _errorDetails: null,
        _logHasWarningOrError: false,
        _transitionPromise: null,

        /* These functions represent ongoing work associated with one of our states
           Some of these functions are mostly empty, apart from defining an
           on_transition function used to resolve their Promise */
        _stateCallbacks: Object.freeze(new Map([
            /* Initial is never transitioned to */
            [TorConnectState.Initial, new StateCallback(TorConnectState.Initial, async function() {
                // The initial state doesn't actually do anything, so here is a skeleton for other
                // states which do perform work
                await new Promise(async (resolve, reject) => {
                    // This function is provided to signal to the callback that it is complete.
                    // It is called as a result of _changeState and at the very least must
                    // resolve the root Promise object within the StateCallback function
                    // The on_transition callback may also perform necessary cleanup work
                    this.on_transition = (nextState) => {
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
                    } catch(err) {
                        // any thrown exceptions here will trigger a transition to the Error state
                        TorConnect._changeState(TorConnectState.Error, err?.message, err?.details);
                    }
                });
            })],
            /* Configuring */
            [TorConnectState.Configuring, new StateCallback(TorConnectState.Configuring, async function() {
                await new Promise(async (resolve, reject) => {
                    this.on_transition = (nextState) => {
                        resolve();
                    };
                });
             })],
            /* Bootstrapping */
            [TorConnectState.Bootstrapping, new StateCallback(TorConnectState.Bootstrapping, async function() {
                // wait until bootstrap completes or we get an error
                await new Promise(async (resolve, reject) => {
                    const tbr = new TorBootstrapRequest();
                    this.on_transition = async (nextState) => {
                        if (nextState === TorConnectState.Configuring) {
                            // stop bootstrap process if user cancelled
                            await tbr.cancel();
                        }
                        resolve();
                    };

                    tbr.onbootstrapstatus = (progress, status) => {
                        TorConnect._updateBootstrapStatus(progress, status);
                    };
                    tbr.onbootstrapcomplete = () => {
                        TorConnect._changeState(TorConnectState.Bootstrapped);
                    };
                    tbr.onbootstraperror = (message, details) => {
                        TorConnect._changeState(TorConnectState.Error, message, details);
                    };

                    tbr.bootstrap();
                });
            })],
            /* AutoBootstrapping */
            [TorConnectState.AutoBootstrapping, new StateCallback(TorConnectState.AutoBootstrapping, async function(countryCode) {
                await new Promise(async (resolve, reject) => {
                    this.on_transition = (nextState) => {
                        resolve();
                    };

                    // lookup user's potential censorship circumvention settings from Moat service
                    try {
                        this.mrpc = new MoatRPC();
                        await this.mrpc.init();

                        this.settings = await this.mrpc.circumvention_settings([...TorBuiltinBridgeTypes, "vanilla"], countryCode);

                        if (this.transitioning) return;

                        if (this.settings === null) {
                            // unable to determine country
                            TorConnect._changeState(TorConnectState.Error, "Unable to determine user country", "DETAILS_STRING");
                            return;
                        } else if (this.settings.length === 0) {
                            // no settings available for country
                            TorConnect._changeState(TorConnectState.Error, "No settings available for your location", "DETAILS_STRING");
                            return;
                        }
                    } catch (err) {
                        TorConnect._changeState(TorConnectState.Error, err?.message, err?.details);
                        return;
                    } finally {
                        // important to uninit MoatRPC object or else the pt process will live as long as tor-browser
                        this.mrpc?.uninit();
                    }

                    // apply each of our settings and try to bootstrap with each
                    try {
                        this.originalSettings = TorSettings.getSettings();

                        let index = 0;
                        for (let currentSetting of this.settings) {
                            // let us early out if user cancels
                            if (this.transitioning) return;

                            console.log(`TorConnect: Attempting Bootstrap with configuration ${++index}/${this.settings.length}`);

                            TorSettings.setSettings(currentSetting);
                            await TorSettings.applySettings();

                            // build out our bootstrap request
                            const tbr = new TorBootstrapRequest();
                            tbr.onbootstrapstatus = (progress, status) => {
                                TorConnect._updateBootstrapStatus(progress, status);
                            };
                            tbr.onbootstraperror = (message, details) => {
                                console.log(`TorConnect: Auto-Bootstrap error => ${message}; ${details}`);
                            };

                            // update transition callback for user cancel
                            this.on_transition = async (nextState) => {
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
                        await TorSettings.applySettings();
                        TorSettings.saveToPrefs();

                        // only explicitly change state here if something else has not transitioned us
                        if (!this.transitioning) {
                            TorConnect._changeState(TorConnectState.Error, "AutoBootstrapping failed", "DETAILS_STRING");
                        }
                        return;
                    } catch (err) {
                        // restore original settings in case of error
                        try {
                            TorSettings.setSettings(this.originalSettings);
                            await TorSettings.applySettings();
                        } catch(err) {
                            console.log(`TorConnect: Failed to restore original settings => ${err}`);
                        }
                        TorConnect._changeState(TorConnectState.Error, err?.message, err?.details);
                        return;
                    }
                });
            })],
            /* Bootstrapped */
            [TorConnectState.Bootstrapped, new StateCallback(TorConnectState.Bootstrapped, async function() {
                await new Promise((resolve, reject) => {
                    // on_transition not defined because no way to leave Bootstrapped state
                    // notify observers of bootstrap completion
                    Services.obs.notifyObservers(null, TorConnectTopics.BootstrapComplete);
                });
            })],
            /* Error */
            [TorConnectState.Error, new StateCallback(TorConnectState.Error, async function(errorMessage, errorDetails) {
                await new Promise((resolve, reject) => {
                    this.on_transition = async(nextState) => {
                        resolve();
                    };

                    TorConnect._errorMessage = errorMessage;
                    TorConnect._errorDetails = errorDetails;

                    Services.obs.notifyObservers({message: errorMessage, details: errorDetails}, TorConnectTopics.BootstrapError);

                    TorConnect._changeState(TorConnectState.Configuring);
                });
            })],
            /* Disabled */
            [TorConnectState.Disabled, new StateCallback(TorConnectState.Disabled, async function() {
                await new Promise((resolve, reject) => {
                    // no-op, on_transition not defined because no way to leave Disabled state
                });
            })],
        ])),

        _callback: function(state) {
            return this._stateCallbacks.get(state);
        },

        _changeState: function(newState, ...args) {
            const prevState = this._state;

            // ensure this is a valid state transition
            if (!TorConnectStateTransitions.get(prevState)?.includes(newState)) {
                throw Error(`TorConnect: Attempted invalid state transition from ${prevState} to ${newState}`);
            }

            console.log(`TorConnect: Try transitioning from ${prevState} to ${newState}`);

            // set our new state first so that state transitions can themselves trigger
            // a state transition
            this._state = newState;

            // call our state function and forward any args
            this._callback(prevState).transition(newState, ...args);
        },

        _updateBootstrapStatus: function(progress, status) {
            this._bootstrapProgress= progress;
            this._bootstrapStatus = status;

            console.log(`TorConnect: Bootstrapping ${this._bootstrapProgress}% complete (${this._bootstrapStatus})`);
            Services.obs.notifyObservers({
                progress: TorConnect._bootstrapProgress,
                status: TorConnect._bootstrapStatus,
                hasWarnings: TorConnect._logHasWarningOrError
            }, TorConnectTopics.BootstrapProgress);
        },

        // init should be called on app-startup in MainProcessingSingleton.jsm
        init: function() {
            console.log("TorConnect: init()");

            // delay remaining init until after profile-after-change
            Services.obs.addObserver(this, BrowserTopics.ProfileAfterChange);

            this._callback(TorConnectState.Initial).begin();
        },

        observe: async function(subject, topic, data) {
            console.log(`TorConnect: Observed ${topic}`);

            switch(topic) {

            /* Determine which state to move to from Initial */
            case BrowserTopics.ProfileAfterChange: {
                if (TorLauncherUtil.useLegacyLauncher || !TorProtocolService.ownsTorDaemon) {
                    // Disabled
                    this._changeState(TorConnectState.Disabled);
                } else {
                    let observeTopic = (topic) => {
                        Services.obs.addObserver(this, topic);
                        console.log(`TorConnect: Observing topic '${topic}'`);
                    };

                   // register the Tor topics we always care about
                   observeTopic(TorTopics.ProcessExited);
                   observeTopic(TorTopics.LogHasWarnOrErr);
                   observeTopic(TorSettingsTopics.Ready);
                }
                Services.obs.removeObserver(this, topic);
                break;
            }
            /* We need to wait until TorSettings have been loaded and applied before we can Quickstart */
            case TorSettingsTopics.Ready: {
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
            default:
                // ignore
                break;
            }
        },

        /*
        Various getters
        */

        get shouldShowTorConnect() {
                   // TorBrowser must control the daemon
            return (TorProtocolService.ownsTorDaemon &&
                   // and we're not using the legacy launcher
                   !TorLauncherUtil.useLegacyLauncher &&
                   // if we have succesfully bootstraped, then no need to show TorConnect
                   this.state != TorConnectState.Bootstrapped);
        },

        get shouldQuickStart() {
                   // quickstart must be enabled
            return TorSettings.quickstart.enabled &&
                   // and the previous bootstrap attempt must have succeeded
                   !Services.prefs.getBoolPref(TorLauncherPrefs.prompt_at_startup, true);
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

        get errorMessage() {
            return this._errorMessage;
        },

        get errorDetails() {
            return this._errorDetails;
        },

        get logHasWarningOrError() {
            return this._logHasWarningOrError;
        },

        /*
        These functions allow external consumers to tell TorConnect to transition states
        */

        beginBootstrap: function() {
            console.log("TorConnect: beginBootstrap()");
            this._changeState(TorConnectState.Bootstrapping);
        },

        cancelBootstrap: function() {
            console.log("TorConnect: cancelBootstrap()");
            this._changeState(TorConnectState.Configuring);
        },

        beginAutoBootstrap: function(countryCode) {
            console.log("TorConnect: beginAutoBootstrap()");
            this._changeState(TorConnectState.AutoBootstrapping, countryCode);
        },

        cancelAutoBootstrap: function() {
            console.log("TorConnect: cancelAutoBootstrap()");
            this._changeState(TorConnectState.Configuring);
        },

        /*
        Further external commands and helper methods
        */
        openTorPreferences: function() {
            const win = BrowserWindowTracker.getTopWindow();
            win.switchToTabHavingURI("about:preferences#tor", true);
        },

        openTorConnect: function() {
            const win = BrowserWindowTracker.getTopWindow();
            win.switchToTabHavingURI("about:torconnect", true, {ignoreQueryString: true});
        },

        copyTorLogs: function() {
            // Copy tor log messages to the system clipboard.
            const chSvc = Cc["@mozilla.org/widget/clipboardhelper;1"].getService(
              Ci.nsIClipboardHelper
            );
            const countObj = { value: 0 };
            chSvc.copyString(TorProtocolService.getLog(countObj));
            const count = countObj.value;
            return TorLauncherUtil.getFormattedLocalizedString(
              "copiedNLogMessagesShort",
              [count],
              1
            );
        },

        getRedirectURL: function(url) {
            return `about:torconnect?redirect=${encodeURIComponent(url)}`;
        },

        // called from browser.js on browser startup, passed in either the user's homepage(s)
        // or uris passed via command-line; we want to replace them with about:torconnect uris
        // which redirect after bootstrapping
        getURIsToLoad: function(uriVariant) {
            // convert the object we get from browser.js
            let uriStrings = ((v) => {
                // an interop array
                if (v instanceof Ci.nsIArray) {
                    // Transform the nsIArray of nsISupportsString's into a JS Array of
                    // JS strings.
                    return Array.from(
                      v.enumerate(Ci.nsISupportsString),
                      supportStr => supportStr.data
                    );
                // an interop string
                } else if (v instanceof Ci.nsISupportsString) {
                    return [v.data];
                // a js string
                } else if (typeof v === "string") {
                    return v.split("|");
                // a js array of js strings
                } else if (Array.isArray(v) &&
                           v.reduce((allStrings, entry) => {return allStrings && (typeof entry === "string");}, true)) {
                    return v;
                }
                // about:tor as safe fallback
                console.log(`TorConnect: getURIsToLoad() received unknown variant '${JSON.stringify(v)}'`);
                return ["about:tor"];
            })(uriVariant);

            // will attempt to convert user-supplied string to a uri, fallback to about:tor if cannot convert
            // to valid uri object
            let uriStringToUri = (uriString) => {
                const fixupFlags = Ci.nsIURIFixup.FIXUP_FLAG_NONE;
                let uri = Services.uriFixup.getFixupURIInfo(uriString, fixupFlags)
                  .preferredURI;
                return uri ? uri : Services.io.newURI("about:tor");
            };
            let uris = uriStrings.map(uriStringToUri);

            // assume we have a valid uri and generate an about:torconnect redirect uri
            let redirectUrls = uris.map((uri) => this.getRedirectURL(uri.spec));

            console.log(`TorConnect: Will load after bootstrap => [${uris.map((uri) => {return uri.spec;}).join(", ")}]`);
            return redirectUrls;
        },
    };
    retval.init();
    return retval;
})(); /* TorConnect */
