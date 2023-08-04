// Copyright (c) 2022, The Tor Project, Inc.

import { TorProviderTopics } from "resource://gre/modules/TorProviderBuilder.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  TorProtocolService: "resource://gre/modules/TorProtocolService.sys.mjs",
});

export const TorMonitorTopics = Object.freeze({
  BridgeChanged: TorProviderTopics.BridgeChanged,
  StreamSucceeded: TorProviderTopics.StreamSucceeded,
});

/**
 * This service monitors an existing Tor instance, or starts one, if needed, and
 * then starts monitoring it.
 *
 * This is the service which should be queried to know information about the
 * status of the bootstrap, the logs, etc...
 */
export const TorMonitorService = {
  get currentBridge() {
    return lazy.TorProtocolService.currentBridge;
  },

  get ownsTorDaemon() {
    return lazy.TorProtocolService.ownsTorDaemon;
  },

  get isRunning() {
    return lazy.TorProtocolService.isRunning;
  },

  get isBootstrapDone() {
    return lazy.TorProtocolService.isBootstrapDone;
  },

  getLog() {
    return lazy.TorProtocolService.getLog();
  },
};
