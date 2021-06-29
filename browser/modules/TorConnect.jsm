"use strict";

var EXPORTED_SYMBOLS = ["TorConnect"];

const { Services } = ChromeUtils.import(
  "resource://gre/modules/Services.jsm"
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