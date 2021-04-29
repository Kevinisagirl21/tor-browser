"use strict";

var EXPORTED_SYMBOLS = ["TorConnect"];

const { Services } = ChromeUtils.import(
    "resource://gre/modules/Services.jsm"
);

const { BrowserWindowTracker } = ChromeUtils.import(
    "resource:///modules/BrowserWindowTracker.jsm"
);

const { TorProtocolService } = ChromeUtils.import(
    "resource:///modules/TorProtocolService.jsm"
);

// TODO: move the bootstrap state management out of each of the individual
// about:torconnect pages and stick it here
var TorConnect = (() => {
    let retval = {
        init : function() {
            let topics = [
                "TorBootstrapStatus",
            ];

            for(const topic of topics) {
                Services.obs.addObserver(this, topic);
            }
        },

        observe: function(subject, topic, data) {
            switch(topic) {
            case "TorBootstrapStatus":
                const obj = subject?.wrappedJSObject;
                if (obj?.PROGRESS === 100) {
                    // open home page(s) in new tabs
                    const win = BrowserWindowTracker.getTopWindow()
                    const urls = Services.prefs.getStringPref("browser.startup.homepage").split('|');

                    let location="tab";
                    for(const url of urls) {
                        win.openTrustedLinkIn(url, location);
                        // open subsequent tabs behind first tab
                        location = "tabshifted";
                    }

                    Services.obs.notifyObservers(null, "torconnect:bootstrap-complete");
                }
                break;
            default:
                // ignore
                break;
            }
        },

        shouldShowTorConnect : function() {
            return TorProtocolService.shouldShowTorConnect();
        },
    };
    retval.init();
    return retval;
})(); /* TorConnect */