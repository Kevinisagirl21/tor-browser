"use strict";

var EXPORTED_SYMBOLS = ["TorConnect", "TorConnectTopics", "TorConnectState"];

const { Services } = ChromeUtils.import(
    "resource://gre/modules/Services.jsm"
);

const { BrowserWindowTracker } = ChromeUtils.import(
    "resource:///modules/BrowserWindowTracker.jsm"
);

const { TorProtocolService, TorProcessStatus } = ChromeUtils.import(
    "resource:///modules/TorProtocolService.jsm"
);

const { TorLauncherUtil } = ChromeUtils.import(
    "resource://torlauncher/modules/tl-util.jsm"
);

/* Browser observer topis */
const BrowserTopics = Object.freeze({
    ProfileAfterChange: "profile-after-change",
});

/* tor-launcher observer topics */
const TorTopics = Object.freeze({
    ProcessIsReady: "TorProcessIsReady",
    BootstrapStatus: "TorBootstrapStatus",
    BootstrapError: "TorBootstrapError",
    ProcessExited: "TorProcessExited",
    LogHasWarnOrErr: "TorLogHasWarnOrErr",
});

/* Relevant prefs used by tor-launcher */
const TorLauncherPrefs = Object.freeze({
  quickstart: "extensions.torlauncher.quickstart",
  prompt_at_startup: "extensions.torlauncher.prompt_at_startup",
});

const TorConnectState = Object.freeze({
    /* Our initial state */
    Initial: "Initial",
    /* In-between initial boot and bootstrapping, users can change tor network settings during this state */
    Configuring: "Configuring",
    /* Geo-location and setting bridges/etc */
    AutoConfiguring: "AutoConfiguring",
    /* Tor is bootstrapping */
    Bootstrapping: "Bootstrapping",
    /* Passthrough state back to Configuring or Fatal */
    Error: "Error",
    /* An unrecoverable error */
    FatalError: "FatalError",
    /* Final state, after successful bootstrap */
    Bootstrapped: "Bootstrapped",
    /* If we are using System tor or the legacy Tor-Launcher */
    Disabled: "Disabled",
});

/*

                                               TorConnect State Transitions

                                              ┌──────────────────────┐
                                              │       Disabled       │
                                              └──────────────────────┘
                                                ▲
                                                │ legacyOrSystemTor()
                                                │
                                              ┌──────────────────────┐
                      ┌────────────────────── │       Initial        │ ───────────────────────────┐
                      │                       └──────────────────────┘                            │
                      │                         │                                                 │
                      │                         │ beginBootstrap()                                │
                      │                         ▼                                                 │
┌────────────────┐    │  bootstrapComplete()  ┌────────────────────────────────────────────────┐  │  beginBootstrap()
│  Bootstrapped  │ ◀──┼────────────────────── │                 Bootstrapping                  │ ◀┼─────────────────┐
└────────────────┘    │                       └────────────────────────────────────────────────┘  │                 │
                      │                         │                       ▲                    │    │                 │
                      │                         │ cancelBootstrap()     │ beginBootstrap()   └────┼─────────────┐   │
                      │                         ▼                       │                         │             │   │
                      │   beginConfigure()    ┌────────────────────────────────────────────────┐  │             │   │
                      └─────────────────────▶ │                                                │  │             │   │
                                              │                                                │  │             │   │
                       beginConfigure()       │                                                │  │             │   │
                 ┌──────────────────────────▶ │                  Configuring                   │  │             │   │
                 │                            │                                                │  │             │   │
                 │                            │                                                │  │             │   │
                 │    ┌─────────────────────▶ │                                                │  │             │   │
                 │    │                       └────────────────────────────────────────────────┘  │             │   │
                 │    │                         │                       │                         │             │   │
                 │    │ cancelAutoconfigure()   │ autoConfigure()       │                    ┌────┼─────────────┼───┘
                 │    │                         ▼                       │                    │    │             │
                 │    │                       ┌──────────────────────┐  │                    │    │             │
                 │    └────────────────────── │   AutoConfiguring    │ ─┼────────────────────┘    │             │
                 │                            └──────────────────────┘  │                         │             │
                 │                              │                       │                         │ onError()   │
                 │                              │ onError()             │ onError()               │             │
                 │                              ▼                       ▼                         │             │
                 │                            ┌────────────────────────────────────────────────┐  │             │
                 └─────────────────────────── │                     Error                      │ ◀┘             │
                                              └────────────────────────────────────────────────┘                │
                                                │                                            ▲   onError()      │
                                                │ onFatalError()                             └──────────────────┘
                                                ▼
                                              ┌──────────────────────┐
                                              │      FatalError      │
                                              └──────────────────────┘

*/


/* Maps allowed state transitions
   TorConnectStateTransitions[state] maps to an array of allowed states to transition to
*/
const TorConnectStateTransitions =
    Object.freeze(new Map([
        [TorConnectState.Initial,
            [TorConnectState.Disabled,
             TorConnectState.Bootstrapping,
             TorConnectState.Configuring,
             TorConnectState.Error]],
        [TorConnectState.Configuring,
            [TorConnectState.AutoConfiguring,
             TorConnectState.Bootstrapping,
             TorConnectState.Error]],
        [TorConnectState.AutoConfiguring,
            [TorConnectState.Configuring,
             TorConnectState.Bootstrapping,
             TorConnectState.Error]],
        [TorConnectState.Bootstrapping,
            [TorConnectState.Configuring,
             TorConnectState.Bootstrapped,
             TorConnectState.Error]],
        [TorConnectState.Error,
            [TorConnectState.Configuring,
             TorConnectState.FatalError]],
        // terminal states
        [TorConnectState.FatalError, []],
        [TorConnectState.Bootstrapped, []],
        [TorConnectState.Disabled, []],
    ]));

/* Topics Notified by the TorConnect module */
const TorConnectTopics = Object.freeze({
    StateChange: "torconnect:state-change",
    BootstrapProgress: "torconnect:bootstrap-progress",
    BootstrapComplete: "torconnect:bootstrap-complete",
    BootstrapError: "torconnect:bootstrap-error",
    FatalError: "torconnect:fatal-error",
});

const TorConnect = (() => {
    let retval = {

        _state: TorConnectState.Initial,
        _bootstrapProgress: 0,
        _bootstrapStatus: null,
        _errorMessage: null,
        _errorDetails: null,
        _logHasWarningOrError: false,

        /* These functions are called after transitioning to a new state */
        _transitionCallbacks: Object.freeze(new Map([
            /* Initial is never transitioned to */
            [TorConnectState.Initial, null],
            /* Configuring */
            [TorConnectState.Configuring, async (self, prevState) => {
                // TODO move this to the transition function
                if (prevState === TorConnectState.Bootstrapping) {
                    await TorProtocolService.torStopBootstrap();
                }
            }],
            /* AutoConfiguring */
            [TorConnectState.AutoConfiguring, async (self, prevState) => {

            }],
            /* Bootstrapping */
            [TorConnectState.Bootstrapping, async (self, prevState) => {
                let error = await TorProtocolService.connect();
                if (error) {
                    self.onError(error.message, error.details);
                } else {
                    self._errorMessage = self._errorDetails = null;
                }
            }],
            /* Bootstrapped */
            [TorConnectState.Bootstrapped, async (self,prevState) => {
                // notify observers of bootstrap completion
                Services.obs.notifyObservers(null, TorConnectTopics.BootstrapComplete);
            }],
            /* Error */
            [TorConnectState.Error, async (self, prevState, errorMessage, errorDetails, fatal) => {
                self._errorMessage = errorMessage;
                self._errorDetails = errorDetails;

                Services.obs.notifyObservers({message: errorMessage, details: errorDetails}, TorConnectTopics.BootstrapError);
                if (fatal) {
                    self.onFatalError();
                } else {
                    self.beginConfigure();
                }
            }],
            /* FatalError */
            [TorConnectState.FatalError, async (self, prevState) => {
                Services.obs.notifyObservers(null, TorConnectTopics.FatalError);
            }],
            /* Disabled */
            [TorConnectState.Disabled, (self, prevState) => {

            }],
        ])),

        _changeState: async function(newState, ...args) {
            const prevState = this._state;

            // ensure this is a valid state transition
            if (!TorConnectStateTransitions.get(prevState)?.includes(newState)) {
                throw Error(`TorConnect: Attempted invalid state transition from ${prevState} to ${newState}`);
            }

            console.log(`TorConnect: transitioning state from ${prevState} to ${newState}`);

            // set our new state first so that state transitions can themselves trigger
            // a state transition
            this._state = newState;

            // call our transition function and forward any args
            await this._transitionCallbacks.get(newState)(this, prevState, ...args);

            Services.obs.notifyObservers({state: newState}, TorConnectTopics.StateChange);
        },

        // init should be called on app-startup in MainProcessingSingleton.jsm
        init : function() {
            console.log("TorConnect: Init");

            // delay remaining init until after profile-after-change
            Services.obs.addObserver(this, BrowserTopics.ProfileAfterChange);
        },

        observe: async function(subject, topic, data) {
            console.log(`TorConnect: observed ${topic}`);

            switch(topic) {

            /* Determine which state to move to from Initial */
            case BrowserTopics.ProfileAfterChange: {
                if (TorLauncherUtil.useLegacyLauncher || !TorProtocolService.ownsTorDaemon) {
                    // Disabled
                    this.legacyOrSystemTor();
                } else {
                    // register the Tor topics we always care about
                    for (const topicKey in TorTopics) {
                        const topic = TorTopics[topicKey];
                        Services.obs.addObserver(this, topic);
                        console.log(`TorConnect: observing topic '${topic}'`);
                    }

                    if (TorProtocolService.torProcessStatus == TorProcessStatus.Running) {
                        if (this.shouldQuickStart) {
                            // Quickstart
                            this.beginBootstrap();
                        } else {
                            // Configuring
                            this.beginConfigure();
                        }
                    }
                }

                Services.obs.removeObserver(this, topic);
                break;
            }
            /* Transition out of Initial if Tor daemon wasn't running yet in BrowserTopics.ProfileAfterChange */
            case TorTopics.ProcessIsReady: {
                if (this.state === TorConnectState.Initial)
                {
                    if (this.shouldQuickStart) {
                        // Quickstart
                        this.beginBootstrap();
                    } else {
                        // Configuring
                        this.beginConfigure();
                    }
                }
                break;
            }
            /* Updates our bootstrap status */
            case TorTopics.BootstrapStatus: {
                if (this._state != TorConnectState.Bootstrapping) {
                    console.log(`TorConnect: observed ${TorTopics.BootstrapStatus} topic while in state TorConnectState.${this._state}`);
                    break;
                }

                const obj = subject?.wrappedJSObject;
                if (obj) {
                    this._bootstrapProgress= obj.PROGRESS;
                    this._bootstrapStatus = TorLauncherUtil.getLocalizedBootstrapStatus(obj, "TAG");

                    console.log(`TorConnect: Bootstrapping ${this._bootstrapProgress}% complete (${this._bootstrapStatus})`);
                    Services.obs.notifyObservers({
                        progress: this._bootstrapProgress,
                        status: this._bootstrapStatus,
                        hasWarnings: this._logHasWarningOrError
                    }, TorConnectTopics.BootstrapProgress);

                    if (this._bootstrapProgress === 100) {
                        this.bootstrapComplete();
                    }
                }
                break;
            }
            /* Handle bootstrap error*/
            case TorTopics.BootstrapError: {
                const obj = subject?.wrappedJSObject;
                await TorProtocolService.torStopBootstrap();
                this.onError(obj.message, obj.details);
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
            return Services.prefs.getBoolPref(TorLauncherPrefs.quickstart, false) &&
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
        These functions tell TorConnect to transition states
        */

        legacyOrSystemTor: function() {
            console.log("TorConnect: legacyOrSystemTor()");
            this._changeState(TorConnectState.Disabled);
        },

        beginBootstrap: function() {
            console.log("TorConnect: beginBootstrap()");
            this._changeState(TorConnectState.Bootstrapping);
        },

        beginConfigure: function() {
            console.log("TorConnect: beginConfigure()");
            this._changeState(TorConnectState.Configuring);
        },

        autoConfigure: function() {
            console.log("TorConnect: autoConfigure()");
            // TODO: implement
            throw Error("TorConnect: not implemented");
        },

        cancelAutoConfigure: function() {
            console.log("TorConnect: cancelAutoConfigure()");
            // TODO: implement
            throw Error("TorConnect: not implemented");
        },

        cancelBootstrap: function() {
            console.log("TorConnect: cancelBootstrap()");
            this._changeState(TorConnectState.Configuring);
        },

        bootstrapComplete: function() {
            console.log("TorConnect: bootstrapComplete()");
            this._changeState(TorConnectState.Bootstrapped);
        },

        onError: function(message, details) {
            console.log("TorConnect: onError()");
            this._changeState(TorConnectState.Error, message, details, false);
        },

        onFatalError: function() {
            console.log("TorConnect: onFatalError()");
            // TODO: implement
            throw Error("TorConnect: not implemented");
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
            let uriToRedirectUri = (uri) => {
                return`about:torconnect?redirect=${encodeURIComponent(uri.spec)}`;
            };
            let redirectUris = uris.map(uriToRedirectUri);

            console.log(`TorConnect: will load after bootstrap => [${uris.map((uri) => {return uri.spec;}).join(", ")}]`);
            return redirectUris;
        },
    };
    retval.init();
    return retval;
})(); /* TorConnect */
