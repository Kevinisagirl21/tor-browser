"use strict";

var EXPORTED_SYMBOLS = ["TorProcessService"];

var TorProcessService = {
  get isBootstrapDone() {
    const svc = Cc["@torproject.org/torlauncher-process-service;1"].getService(
      Ci.nsISupports
    ).wrappedJSObject;
    return svc.mIsBootstrapDone;
  },
};
