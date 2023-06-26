/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  TorMonitorService: "resource://gre/modules/TorMonitorService.sys.mjs",
  TorProtocolService: "resource://gre/modules/TorProtocolService.sys.mjs",
});

export class TorProviderBuilder {
  static async init() {
    await lazy.TorProtocolService.init();
    lazy.TorMonitorService.init();
  }

  static uninit() {
    // Close any helper connection first...
    lazy.TorProtocolService.uninit();
    // ... and only then closes the event monitor connection, which will cause
    // Tor to stop.
    lazy.TorMonitorService.uninit();
  }

  // TODO: Switch to an async build?
  static build() {
    return lazy.TorProtocolService;
  }
}
