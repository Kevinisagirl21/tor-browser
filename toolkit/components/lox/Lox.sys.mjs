import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";
import {
  clearInterval,
  setInterval,
} from "resource://gre/modules/Timer.sys.mjs";

const lazy = {};

ChromeUtils.defineLazyGetter(lazy, "logger", () => {
  let { ConsoleAPI } = ChromeUtils.importESModule(
    "resource://gre/modules/Console.sys.mjs"
  );
  return new ConsoleAPI({
    maxLogLevel: "warn",
    maxLogLevelPref: "lox.log_level",
    prefix: "Lox",
  });
});

ChromeUtils.defineESModuleGetters(lazy, {
  DomainFrontRequestBuilder:
    "resource://gre/modules/DomainFrontedRequests.sys.mjs",
  TorConnect: "resource://gre/modules/TorConnect.sys.mjs",
  TorConnectState: "resource://gre/modules/TorConnect.sys.mjs",
  TorSettings: "resource://gre/modules/TorSettings.sys.mjs",
  TorSettingsTopics: "resource://gre/modules/TorSettings.sys.mjs",
  TorBridgeSource: "resource://gre/modules/TorSettings.sys.mjs",
});

XPCOMUtils.defineLazyModuleGetters(lazy, {
  init: "resource://gre/modules/lox_wasm.jsm",
  open_invite: "resource://gre/modules/lox_wasm.jsm",
  handle_new_lox_credential: "resource://gre/modules/lox_wasm.jsm",
  set_panic_hook: "resource://gre/modules/lox_wasm.jsm",
  invitation_is_trusted: "resource://gre/modules/lox_wasm.jsm",
  issue_invite: "resource://gre/modules/lox_wasm.jsm",
  prepare_invite: "resource://gre/modules/lox_wasm.jsm",
  get_invites_remaining: "resource://gre/modules/lox_wasm.jsm",
  get_trust_level: "resource://gre/modules/lox_wasm.jsm",
  level_up: "resource://gre/modules/lox_wasm.jsm",
  handle_level_up: "resource://gre/modules/lox_wasm.jsm",
  trust_promotion: "resource://gre/modules/lox_wasm.jsm",
  handle_trust_promotion: "resource://gre/modules/lox_wasm.jsm",
  trust_migration: "resource://gre/modules/lox_wasm.jsm",
  handle_trust_migration: "resource://gre/modules/lox_wasm.jsm",
  get_next_unlock: "resource://gre/modules/lox_wasm.jsm",
  check_blockage: "resource://gre/modules/lox_wasm.jsm",
  handle_check_blockage: "resource://gre/modules/lox_wasm.jsm",
  blockage_migration: "resource://gre/modules/lox_wasm.jsm",
  handle_blockage_migration: "resource://gre/modules/lox_wasm.jsm",
});

export const LoxTopics = Object.freeze({
  // Whenever the bridges *might* have changed.
  // getBridges only uses #credentials, so this will only fire when it changes.
  UpdateBridges: "lox:update-bridges",
  // Whenever we gain a new upgrade or blockage event, or clear events.
  UpdateEvents: "lox:update-events",
  // Whenever the next unlock *might* have changed.
  // getNextUnlock uses #credentials and #constants, sow ill fire when either
  // value changes.
  UpdateNextUnlock: "lox:update-next-unlock",
  // Whenever the remaining invites *might* have changed.
  // getRemainingInviteCount only uses #credentials, so will only fire when it
  // changes.
  UpdateRemainingInvites: "lox:update-remaining-invites",
  // Whenever we generate a new invite.
  NewInvite: "lox:new-invite",
});

export const LoxErrors = Object.freeze({
  BadInvite: "BadInvite",
  MissingCredential: "MissingCredential",
  LoxServerUnreachable: "LoxServerUnreachable",
  NoInvitations: "NoInvitations",
  InitError: "InitializationError",
  NotInitialized: "NotInitialized",
});

const LoxSettingsPrefs = Object.freeze({
  /* string: the lox credential */
  credentials: "lox.settings.credentials",
  invites: "lox.settings.invites",
  events: "lox.settings.events",
  pubkeys: "lox.settings.pubkeys",
  enctable: "lox.settings.enctable",
  constants: "lox.settings.constants",
});

class LoxError extends Error {
  constructor(type) {
    super("");
    this.type = type;
  }
}

class LoxImpl {
  #initialized = false;
  #window = null;
  #pubKeyPromise = null;
  #encTablePromise = null;
  #constantsPromise = null;
  #domainFrontedRequests = null;
  /**
   * The list of invites generated.
   *
   * @type {string[]}
   */
  #invites = [];
  #pubKeys = null;
  #encTable = null;
  #constants = null;
  /**
   * The latest credentials for a given lox id.
   *
   * @type {Object<string, string>}
   */
  #credentials = {};
  /**
   * The list of accumulated blockage or upgrade events.
   *
   * This can be cleared when the user acknowledges the events.
   *
   * @type {EventData[]}
   */
  #events = [];
  #backgroundInterval = null;

  /**
   * The lox ID that is currently active.
   *
   * Stays in sync with TorSettings.bridges.lox_id. null when uninitialized.
   *
   * @type {string?}
   */
  #activeLoxId = null;

  /**
   * Update the active lox id.
   */
  #updateActiveLoxId() {
    const loxId = lazy.TorSettings.bridges.lox_id;
    if (loxId === this.#activeLoxId) {
      return;
    }
    lazy.logger.debug(
      `#activeLoxId switching from "${this.#activeLoxId}" to "${loxId}"`
    );
    if (this.#activeLoxId !== null) {
      lazy.logger.debug(
        `Clearing event data and invites for "${this.#activeLoxId}"`
      );
      // If not initializing clear the metadata for the old lox ID when it
      // changes.
      this.clearEventData(this.#activeLoxId);
      // TODO: Do we want to keep invites? See tor-browser#42453
      this.#invites = [];
      this.#store();
    }
    this.#activeLoxId = loxId;
  }

  observe(subject, topic, data) {
    switch (topic) {
      case lazy.TorSettingsTopics.SettingsChanged:
        const { changes } = subject.wrappedJSObject;
        if (
          changes.includes("bridges.enabled") ||
          changes.includes("bridges.source") ||
          changes.includes("bridges.lox_id")
        ) {
          // The lox_id may have changed.
          this.#updateActiveLoxId();

          // Only run background tasks if Lox is enabled
          if (this.#inuse) {
            if (!this.#backgroundInterval) {
              this.#backgroundInterval = setInterval(
                this.#backgroundTasks.bind(this),
                1000 * 60 * 60 * 12
              );
            }
          } else if (this.#backgroundInterval) {
            clearInterval(this.#backgroundInterval);
            this.#backgroundInterval = null;
          }
        }
        break;
      case lazy.TorSettingsTopics.Ready:
        // Set the initial #activeLoxId.
        this.#updateActiveLoxId();
        // Run background tasks every 12 hours if Lox is enabled
        if (this.#inuse) {
          this.#backgroundInterval = setInterval(
            this.#backgroundTasks.bind(this),
            1000 * 60 * 60 * 12
          );
        }
        break;
    }
  }

  get #inuse() {
    return (
      Boolean(this.#activeLoxId) &&
      lazy.TorSettings.bridges.enabled === true &&
      lazy.TorSettings.bridges.source === lazy.TorBridgeSource.Lox
    );
  }

  /**
   * Change some existing credentials for an ID to a new value.
   *
   * @param {string} loxId - The ID to change the credentials for.
   * @param {string} newCredentials - The new credentials to set.
   */
  #changeCredentials(loxId, newCredentials) {
    // FIXME: Several async methods want to update the credentials, but they
    // might race and conflict with each. tor-browser#42492
    if (!newCredentials) {
      // Avoid overwriting and losing our current credentials.
      throw new LoxError(`Empty credentials being set for ${loxId}`);
    }
    if (!this.#credentials[loxId]) {
      // Unexpected, but we still want to save the value to storage.
      lazy.logger.warn(`Lox ID ${loxId} is missing existing credentials`);
    }

    this.#credentials[loxId] = newCredentials;
    this.#store();

    // NOTE: In principle we could determine within this module whether the
    // bridges, remaining invites, or next unlock changes in value when
    // switching credentials.
    // However, this logic can be done by the topic observers, as needed. In
    // particular, TorSettings.bridges.bridge_strings has its own logic
    // determining whether its value has changed.

    // Let TorSettings know about possibly new bridges.
    Services.obs.notifyObservers(null, LoxTopics.UpdateBridges);
    // Let UI know about changes.
    Services.obs.notifyObservers(null, LoxTopics.UpdateRemainingInvites);
    Services.obs.notifyObservers(null, LoxTopics.UpdateNextUnlock);
  }

  /**
   * Fetch the latest credentials.
   *
   * @param {string} loxId - The ID to get the credentials for.
   *
   * @returns {string} - The credentials.
   */
  #getCredentials(loxId) {
    const cred = loxId ? this.#credentials[loxId] : undefined;
    if (!cred) {
      throw new LoxError(LoxErrors.MissingCredential);
    }
    return cred;
  }

  /**
   * Formats and returns bridges from the stored Lox credential.
   *
   * @param {string} loxId The id string associated with a lox credential.
   *
   * @returns {string[]} An array of formatted bridge lines. The array is empty
   *   if there are no bridges.
   */
  getBridges(loxId) {
    if (!this.#initialized) {
      throw new LoxError(LoxErrors.NotInitialized);
    }
    // Note: this is messy now but can be mostly removed after we have
    // https://gitlab.torproject.org/tpo/anti-censorship/lox/-/issues/46
    let bridgelines = JSON.parse(this.#getCredentials(loxId)).bridgelines;
    let bridges = [];
    for (const bridge of bridgelines) {
      let addr = bridge.addr;
      while (addr[addr.length - 1] === 0) {
        addr.pop();
      }
      addr = new Uint8Array(addr);
      let decoder = new TextDecoder("utf-8");
      addr = decoder.decode(addr);

      let info = bridge.info;
      while (info[info.length - 1] === 0) {
        info.pop();
      }
      info = new Uint8Array(info);
      info = decoder.decode(info);

      let regexpTransport = /type=([a-zA-Z0-9]*)/;
      let transport = info.match(regexpTransport);
      if (transport !== null) {
        transport = transport[1];
      } else {
        transport = "";
      }

      let regexpFingerprint = /fingerprint=\"([a-zA-Z0-9]*)\"/;
      let fingerprint = info.match(regexpFingerprint);
      if (fingerprint !== null) {
        fingerprint = fingerprint[1];
      } else {
        fingerprint = "";
      }

      let regexpParams = /params=Some\(\{(.*)\}\)/;
      let params = info.match(regexpParams);
      if (params !== null) {
        params = params[1]
          .replaceAll('"', "")
          .replaceAll(": ", "=")
          .replaceAll(",", " ");
      } else {
        params = "";
      }

      bridges.push(
        `${transport} ${addr}:${bridge.port} ${fingerprint} ${params}`
      );
    }
    return bridges;
  }

  #store() {
    Services.prefs.setStringPref(LoxSettingsPrefs.pubkeys, this.#pubKeys);
    Services.prefs.setStringPref(LoxSettingsPrefs.enctable, this.#encTable);
    Services.prefs.setStringPref(LoxSettingsPrefs.constants, this.#constants);
    Services.prefs.setStringPref(
      LoxSettingsPrefs.credentials,
      JSON.stringify(this.#credentials)
    );
    Services.prefs.setStringPref(
      LoxSettingsPrefs.invites,
      JSON.stringify(this.#invites)
    );
    Services.prefs.setStringPref(
      LoxSettingsPrefs.events,
      JSON.stringify(this.#events)
    );
  }

  #load() {
    const cred = Services.prefs.getStringPref(LoxSettingsPrefs.credentials, "");
    this.#credentials = cred ? JSON.parse(cred) : {};
    const invites = Services.prefs.getStringPref(LoxSettingsPrefs.invites, "");
    this.#invites = invites ? JSON.parse(invites) : [];
    const events = Services.prefs.getStringPref(LoxSettingsPrefs.events, "");
    this.#events = events ? JSON.parse(events) : [];
    this.#pubKeys = Services.prefs.getStringPref(
      LoxSettingsPrefs.pubkeys,
      null
    );
    this.#encTable = Services.prefs.getStringPref(
      LoxSettingsPrefs.enctable,
      null
    );
    this.#constants = Services.prefs.getStringPref(
      LoxSettingsPrefs.constants,
      null
    );
  }

  async #getPubKeys() {
    if (this.#pubKeyPromise === null) {
      this.#pubKeyPromise = this.#makeRequest("pubkeys", [])
        .then(pubKeys => {
          this.#pubKeys = JSON.stringify(pubKeys);
          this.#store();
        })
        .catch(() => {
          // We always try to update, but if that doesn't work fall back to stored data
          if (!this.#pubKeys) {
            throw new LoxError(LoxErrors.LoxServerUnreachable);
          }
        });
    }
    await this.#pubKeyPromise;
  }

  async #getEncTable() {
    if (this.#encTablePromise === null) {
      this.#encTablePromise = this.#makeRequest("reachability", [])
        .then(encTable => {
          this.#encTable = JSON.stringify(encTable);
          this.#store();
        })
        .catch(() => {
          // Try to update first, but if that doesn't work fall back to stored data
          if (!this.#encTable) {
            throw new LoxError(LoxErrors.LoxServerUnreachable);
          }
        });
    }
    await this.#encTablePromise;
  }

  async #getConstants() {
    if (this.#constantsPromise === null) {
      // Try to update first, but if that doesn't work fall back to stored data
      this.#constantsPromise = this.#makeRequest("constants", [])
        .then(constants => {
          const prevValue = this.#constants;
          this.#constants = JSON.stringify(constants);
          this.#store();
          if (prevValue !== this.#constants) {
            Services.obs.notifyObservers(null, LoxTopics.UpdateNextUnlock);
          }
        })
        .catch(() => {
          if (!this.#constants) {
            throw new LoxError(LoxErrors.LoxServerUnreachable);
          }
        });
    }
    await this.#constantsPromise;
  }

  /**
   * Check for blockages and attempt to perform a levelup
   *
   * If either blockages or a levelup happened, add an event to the event queue
   */
  async #backgroundTasks() {
    if (!this.#initialized) {
      throw new LoxError(LoxErrors.NotInitialized);
    }
    let addedEvent = false;
    // Only run background tasks for the active lox ID.
    const loxId = this.#activeLoxId;
    if (!loxId) {
      lazy.logger.warn("No loxId for the background task");
      return;
    }
    try {
      const levelup = await this.#attemptUpgrade(loxId);
      if (levelup) {
        const level = lazy.get_trust_level(this.#getCredentials(loxId));
        const newEvent = {
          type: "levelup",
          newlevel: level,
        };
        this.#events.push(newEvent);
        this.#store();
        addedEvent = true;
      }
    } catch (err) {
      lazy.logger.error(err);
    }
    try {
      const leveldown = await this.#blockageMigration(loxId);
      if (leveldown) {
        let level = lazy.get_trust_level(this.#getCredentials(loxId));
        const newEvent = {
          type: "blockage",
          newlevel: level,
        };
        this.#events.push(newEvent);
        this.#store();
        addedEvent = true;
      }
    } catch (err) {
      lazy.logger.error(err);
    }
    if (addedEvent) {
      Services.obs.notifyObservers(null, LoxTopics.UpdateEvents);
    }
  }

  /**
   * Generates a new random lox id to be associated with an invitation/credential
   */
  #genLoxId() {
    return crypto.randomUUID();
  }

  async init() {
    // If lox_id is set, load it
    Services.obs.addObserver(this, lazy.TorSettingsTopics.SettingsChanged);
    Services.obs.addObserver(this, lazy.TorSettingsTopics.Ready);

    // Hack to make the generated wasm happy
    this.#window = {
      crypto,
    };
    this.#window.window = this.#window;
    await lazy.init(this.#window);
    lazy.set_panic_hook();
    if (typeof lazy.open_invite !== "function") {
      throw new LoxError(LoxErrors.InitError);
    }
    this.#load();
    this.#initialized = true;
  }

  async uninit() {
    Services.obs.removeObserver(this, lazy.TorSettingsTopics.SettingsChanged);
    Services.obs.removeObserver(this, lazy.TorSettingsTopics.Ready);
    if (this.#domainFrontedRequests !== null) {
      try {
        const domainFronting = await this.#domainFrontedRequests;
        domainFronting.uninit();
      } catch {}
      this.#domainFrontedRequests = null;
    }
    this.#initialized = false;
    this.#window = null;
    this.#invites = [];
    this.#pubKeys = null;
    this.#encTable = null;
    this.#constants = null;
    this.#pubKeyPromise = null;
    this.#encTablePromise = null;
    this.#constantsPromise = null;
    this.#credentials = {};
    this.#events = [];
    if (this.#backgroundInterval) {
      clearInterval(this.#backgroundInterval);
    }
    this.#backgroundInterval = null;
  }

  /**
   * Parses an input string to check if it is a valid Lox invitation.
   *
   * @param {string} invite A Lox invitation.
   * @returns {bool} Whether the value passed in was a Lox invitation.
   */
  validateInvitation(invite) {
    if (!this.#initialized) {
      throw new LoxError(LoxErrors.NotInitialized);
    }
    try {
      lazy.invitation_is_trusted(invite);
    } catch (err) {
      lazy.logger.error(err);
      return false;
    }
    return true;
  }

  // Note: This is only here for testing purposes. We're going to be using telegram
  // to issue open invitations for Lox bridges.
  async requestOpenInvite() {
    if (!this.#initialized) {
      throw new LoxError(LoxErrors.NotInitialized);
    }
    let invite = await this.#makeRequest("invite", []);
    lazy.logger.debug(invite);
    return invite;
  }

  /**
   * Redeems a Lox invitation to obtain a credential and bridges.
   *
   * @param {string} invite A Lox invitation.
   * @returns {string} The loxId of the associated credential on success.
   */
  async redeemInvite(invite) {
    if (!this.#initialized) {
      throw new LoxError(LoxErrors.NotInitialized);
    }
    await this.#getPubKeys();
    let request = await lazy.open_invite(JSON.parse(invite).invite);
    let response;
    try {
      response = await this.#makeRequest(
        "openreq",
        JSON.parse(request).request
      );
    } catch {
      throw new LoxError(LoxErrors.LoxServerUnreachable);
    }
    lazy.logger.debug("openreq response: ", response);
    if (response.hasOwnProperty("error")) {
      throw new LoxError(LoxErrors.BadInvite);
    }
    let cred = lazy.handle_new_lox_credential(
      request,
      JSON.stringify(response),
      this.#pubKeys
    );
    // Generate an id that is not already in the #credentials map.
    let loxId;
    do {
      loxId = this.#genLoxId();
    } while (Object.hasOwn(this.#credentials, loxId));
    // Set new credentials.
    this.#credentials[loxId] = cred;
    this.#store();
    return loxId;
  }

  /**
   * Get metadata on all invites historically generated by this credential.
   *
   * @returns {string[]} A list of all historical invites.
   */
  getInvites() {
    if (!this.#initialized) {
      throw new LoxError(LoxErrors.NotInitialized);
    }
    // Return a copy.
    return structuredClone(this.#invites);
  }

  /**
   * Generates a new trusted Lox invitation that a user can pass to their
   * contacts.
   *
   * Throws if:
   *  - there is no saved Lox credential, or
   *  - the saved credential does not have any invitations available.
   *
   * @param {string} loxId - The ID to generate an invite for.
   * @returns {string} A valid Lox invitation.
   */
  async generateInvite(loxId) {
    if (!this.#initialized) {
      throw new LoxError(LoxErrors.NotInitialized);
    }
    await this.#getPubKeys();
    await this.#getEncTable();
    let level = lazy.get_trust_level(this.#getCredentials(loxId));
    if (level < 1) {
      throw new LoxError(LoxErrors.NoInvitations);
    }
    let request = lazy.issue_invite(
      JSON.stringify(this.#getCredentials(loxId)),
      this.#encTable,
      this.#pubKeys
    );
    let response;
    try {
      response = await this.#makeRequest(
        "issueinvite",
        JSON.parse(request).request
      );
    } catch {
      throw new LoxError(LoxErrors.LoxServerUnreachable);
    }
    if (response.hasOwnProperty("error")) {
      lazy.logger.error(response.error);
      throw new LoxError(LoxErrors.NoInvitations);
    } else {
      const invite = lazy.prepare_invite(response);
      this.#invites.push(invite);
      // cap length of stored invites
      if (this.#invites.len > 50) {
        this.#invites.shift();
      }
      this.#store();
      this.#changeCredentials(loxId, response);
      Services.obs.notifyObservers(null, LoxTopics.NewInvite);
      // Return a copy.
      // Right now invite is just a string, but that might change in the future.
      return structuredClone(invite);
    }
  }

  /**
   * Get the number of invites that a user has remaining.
   *
   * @param {string} loxId - The ID to check.
   * @returns {int} The number of invites that can still be generated by a
   *   user's credential.
   */
  getRemainingInviteCount(loxId) {
    if (!this.#initialized) {
      throw new LoxError(LoxErrors.NotInitialized);
    }
    return parseInt(lazy.get_invites_remaining(this.#getCredentials(loxId)));
  }

  async #blockageMigration(loxId) {
    await this.#getPubKeys();
    let request;
    try {
      request = lazy.check_blockage(this.#getCredentials(loxId), this.#pubKeys);
    } catch {
      lazy.logger.log("Not ready for blockage migration");
      return false;
    }
    let response = await this.#makeRequest("checkblockage", request);
    if (response.hasOwnProperty("error")) {
      lazy.logger.error(response.error);
      throw new LoxError(LoxErrors.LoxServerUnreachable);
    }
    const migrationCred = lazy.handle_check_blockage(
      this.#getCredentials(loxId),
      JSON.stringify(response)
    );
    request = lazy.blockage_migration(
      this.#getCredentials(loxId),
      migrationCred,
      this.#pubKeys
    );
    response = await this.#makeRequest("blockagemigration", request);
    if (response.hasOwnProperty("error")) {
      lazy.logger.error(response.error);
      throw new LoxError(LoxErrors.LoxServerUnreachable);
    }
    const cred = lazy.handle_blockage_migration(
      this.#getCredentials(loxId),
      JSON.stringify(response),
      this.#pubKeys
    );
    this.#changeCredentials(loxId, cred);
    return true;
  }

  /** Attempts to upgrade the currently saved Lox credential.
   *  If an upgrade is available, save an event in the event list.
   *
   *  @returns {boolean} whether a levelup event occured
   */
  async #attemptUpgrade(loxId) {
    await this.#getPubKeys();
    await this.#getEncTable();
    await this.#getConstants();
    let success = false;
    let level = lazy.get_trust_level(this.#getCredentials(loxId));
    if (level < 1) {
      // attempt trust promotion instead
      try {
        success = await this.#trustMigration(loxId);
      } catch (err) {
        lazy.logger.error(err);
        return false;
      }
    } else {
      let request = lazy.level_up(
        this.#getCredentials(loxId),
        this.#encTable,
        this.#pubKeys
      );
      const response = await this.#makeRequest("levelup", request);
      if (response.hasOwnProperty("error")) {
        lazy.logger.error(response.error);
        throw new LoxError(LoxErrors.LoxServerUnreachable);
      }
      const cred = lazy.handle_level_up(
        request,
        JSON.stringify(response),
        this.#pubKeys
      );
      this.#changeCredentials(loxId, cred);
      return true;
    }
    return success;
  }

  /**
   * Attempt to migrate from an untrusted to a trusted Lox credential
   *
   * @param {string} loxId - The ID to use.
   * @returns {Promise<bool>} A bool value indicated whether the credential
   *    was successfully migrated.
   */
  async #trustMigration(loxId) {
    await this.#getPubKeys();
    return new Promise((resolve, reject) => {
      let request = "";
      try {
        request = lazy.trust_promotion(
          this.#getCredentials(loxId),
          this.#pubKeys
        );
      } catch (err) {
        lazy.logger.debug("Not ready to upgrade");
        resolve(false);
      }
      this.#makeRequest("trustpromo", JSON.parse(request).request)
        .then(response => {
          if (response.hasOwnProperty("error")) {
            lazy.logger.error("Error response from trustpromo", response.error);
            resolve(false);
          }
          lazy.logger.debug("Got promotion cred", response, request);
          let promoCred = lazy.handle_trust_promotion(
            request,
            JSON.stringify(response)
          );
          lazy.logger.debug("Formatted promotion cred");
          request = lazy.trust_migration(
            this.#getCredentials(loxId),
            promoCred,
            this.#pubKeys
          );
          lazy.logger.debug("Formatted migration request");
          this.#makeRequest("trustmig", JSON.parse(request).request)
            .then(response => {
              if (response.hasOwnProperty("error")) {
                lazy.logger.error(
                  "Error response from trustmig",
                  response.error
                );
                resolve(false);
              }
              lazy.logger.debug("Got new credential");
              let cred = lazy.handle_trust_migration(request, response);
              this.#changeCredentials(loxId, cred);
              resolve(true);
            })
            .catch(err => {
              lazy.logger.error("Failed trust migration", err);
              resolve(false);
            });
        })
        .catch(err => {
          lazy.logger.error("Failed trust promotion", err);
          resolve(false);
        });
    });
  }

  /**
   * @typedef {object} EventData
   *
   * @property {string} [type] - the type of event. This should be one of:
   *   ("levelup", "blockage")
   * @property {integer} [newlevel] - the new level, after the event. Levels count
   * from 0, but "blockage" events can never take the user to 0, so this will always
   * be 1 or greater.
   */

  /**
   * Get a list of accumulated events.
   *
   * @param {string} loxId - The ID to get events for.
   * @returns {EventData[]} A list of the accumulated, unacknowledged events
   *   associated with a user's credential.
   */
  getEventData(loxId) {
    if (!this.#initialized) {
      throw new LoxError(LoxErrors.NotInitialized);
    }
    if (loxId !== this.#activeLoxId) {
      lazy.logger.warn(
        `No event data for loxId ${loxId} since it was replaced by ${
          this.#activeLoxId
        }`
      );
      return [];
    }
    // Return a copy.
    return structuredClone(this.#events);
  }

  /**
   * Clears accumulated event data.
   *
   * Should be called whenever the user acknowledges the existing events.
   *
   * @param {string} loxId - The ID to clear events for.
   */
  clearEventData(loxId) {
    if (!this.#initialized) {
      throw new LoxError(LoxErrors.NotInitialized);
    }
    if (loxId !== this.#activeLoxId) {
      lazy.logger.warn(
        `Not clearing event data for loxId ${loxId} since it was replaced by ${
          this.#activeLoxId
        }`
      );
      return;
    }
    this.#events = [];
    this.#store();
    Services.obs.notifyObservers(null, LoxTopics.UpdateEvents);
  }

  /**
   * @typedef {object} UnlockData
   *
   * @property {string} date - The date-time for the next level up, formatted as
   *   YYYY-MM-DDTHH:mm:ssZ.
   * @property {integer} nextLevel - The next level. Levels count from 0, so
   *   this will be 1 or greater.
   */

  /**
   * Get details about the next feature unlock.
   *
   * NOTE: A call to this method may trigger LoxTopics.UpdateNextUnlock.
   *
   * @param {string} loxId - The ID to get the unlock for.
   * @returns {UnlockData} - Details about the next unlock.
   */
  async getNextUnlock(loxId) {
    if (!this.#initialized) {
      throw new LoxError(LoxErrors.NotInitialized);
    }
    await this.#getConstants();
    let nextUnlock = JSON.parse(
      lazy.get_next_unlock(this.#constants, this.#getCredentials(loxId))
    );
    const level = parseInt(lazy.get_trust_level(this.#getCredentials(loxId)));
    return {
      date: nextUnlock.trust_level_unlock_date,
      nextLevel: level + 1,
    };
  }

  async #makeRequest(procedure, args) {
    // TODO: Customize to for Lox
    const serviceUrl = "https://rdsys-frontend-01.torproject.org/lox";
    const url = `${serviceUrl}/${procedure}`;

    if (lazy.TorConnect.state === lazy.TorConnectState.Bootstrapped) {
      const request = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.api+json",
        },
        body: JSON.stringify(args),
      });
      return request.json();
    }

    if (this.#domainFrontedRequests === null) {
      this.#domainFrontedRequests = new Promise((resolve, reject) => {
        // TODO: Customize to the values for Lox
        const reflector = Services.prefs.getStringPref(
          "extensions.torlauncher.bridgedb_reflector"
        );
        const front = Services.prefs.getStringPref(
          "extensions.torlauncher.bridgedb_front"
        );
        const builder = new lazy.DomainFrontRequestBuilder();
        builder
          .init(reflector, front)
          .then(() => resolve(builder))
          .catch(reject);
      });
    }
    const builder = await this.#domainFrontedRequests;
    return builder.buildPostRequest(url, args);
  }
}

export const Lox = new LoxImpl();
