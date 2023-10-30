/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ConsoleAPI } from "resource://gre/modules/Console.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  EventDispatcher: "resource://gre/modules/Messaging.sys.mjs",
});

// The only event we might emit
const TOR_START_EVENT = "GeckoView:Tor:StartTor";

const logger = new ConsoleAPI({
  maxLogLevel: "info",
  prefix: "TorProcessAndroid",
});

// The events we will listen to
const TorEvents = Object.freeze({
  started: "GeckoView:Tor:TorStarted",
  startFailed: "GeckoView:Tor:TorStartFailed",
  exited: "GeckoView:Tor:TorExited",
});

export class TorProcessAndroid {
  /**
   * The handle the Java counterpart uses to refer to the process we started.
   * We use it to filter the exit events and make sure they refer to the daemon
   * we are interested in.
   */
  #processHandle = null;
  /**
   * The promise resolver we call when the Java counterpart sends the event that
   * tor has started.
   */
  #startResolve = null;
  /**
   * The promise resolver we call when the Java counterpart sends the event that
   * it failed to start tor.
   */
  #startReject = null;

  onExit = () => {};

  get isRunning() {
    return !!this.#processHandle;
  }

  async start() {
    // Generate the handle on the JS side so that it's ready in case it takes
    // less to start the process than to propagate the success.
    this.#processHandle = crypto.randomUUID();
    logger.info(`Starting new process with handle ${this.#processHandle}`);
    // Let's declare it immediately, so that the Java side can do its stuff in
    // an async manner and we avoid possible race conditions (at most we await
    // an already resolved/rejected promise.
    const startEventPromise = new Promise((resolve, reject) => {
      this.#startResolve = resolve;
      this.#startReject = reject;
    });
    lazy.EventDispatcher.instance.registerListener(
      this,
      Object.values(TorEvents)
    );
    let config;
    try {
      config = await lazy.EventDispatcher.instance.sendRequestForResult({
        type: TOR_START_EVENT,
        handle: this.#processHandle,
      });
      logger.debug("Sent the start event.");
    } catch (e) {
      this.forget();
      throw e;
    }
    await startEventPromise;
    return config;
  }

  forget() {
    // Processes usually exit when we close the control port connection to them.
    logger.trace(`Forgetting process ${this.#processHandle}`);
    this.#processHandle = null;
    lazy.EventDispatcher.instance.unregisterListener(
      this,
      Object.values(TorEvents)
    );
  }

  onEvent(event, data, callback) {
    if (data?.handle !== this.#processHandle) {
      logger.debug(`Ignoring event ${event} with another handle`, data);
      return;
    }
    logger.info(`Received an event ${event}`, data);
    switch (event) {
      case TorEvents.started:
        this.#startResolve();
        break;
      case TorEvents.startFailed:
        this.#startReject(new Error(data.error));
        break;
      case TorEvents.exited:
        this.forget();
        if (this.#startReject !== null) {
          this.#startReject();
        }
        this.onExit(data.status);
        break;
    }
  }
}
