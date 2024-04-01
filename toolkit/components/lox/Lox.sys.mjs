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
  #invites = null;
  #pubKeys = null;
  #encTable = null;
  #constants = null;
  #credentials = null;
  #events = [];
  #backgroundInterval = null;

  observe(subject, topic, data) {
    switch (topic) {
      case lazy.TorSettingsTopics.SettingsChanged:
        const { changes } = subject.wrappedJSObject;
        if (
          changes.includes("bridges.enabled") ||
          changes.includes("bridges.source") ||
          changes.includes("bridges.lox_id")
        ) {
          // if lox_id has changed, clear event and invite queues
          if (changes.includes("bridges.lox_id")) {
            this.clearEventData();
            this.clearInvites();
          }

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
      lazy.TorSettings.bridges.enabled === true &&
      lazy.TorSettings.bridges.source === lazy.TorBridgeSource.Lox &&
      lazy.TorSettings.bridges.lox_id
    );
  }

  /**
   * Formats and returns bridges from the stored Lox credential.
   *
   * @param {string} loxid The id string associated with a lox credential.
   *
   * @returns {string[]} An array of formatted bridge lines. The array is empty
   *   if there are no bridges.
   */
  getBridges(loxid) {
    if (!this.#initialized) {
      throw new LoxError(LoxErrors.NotInitialized);
    }
    if (loxid === null) {
      return [];
    }
    if (!this.#credentials[loxid]) {
      // This lox id doesn't correspond to a stored credential
      throw new LoxError(LoxErrors.MissingCredential);
    }
    // Note: this is messy now but can be mostly removed after we have
    // https://gitlab.torproject.org/tpo/anti-censorship/lox/-/issues/46
    let bridgelines = JSON.parse(this.#credentials[loxid]).bridgelines;
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
    if (this.#credentials === null) {
      let cred = Services.prefs.getStringPref(LoxSettingsPrefs.credentials, "");
      this.#credentials = cred !== "" ? JSON.parse(cred) : {};
      let invites = Services.prefs.getStringPref(LoxSettingsPrefs.invites, "");
      if (invites !== "") {
        this.#invites = JSON.parse(invites);
      }
      let events = Services.prefs.getStringPref(LoxSettingsPrefs.events, "");
      if (events !== "") {
        this.#events = JSON.parse(events);
      }
    }
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
          this.#constants = JSON.stringify(constants);
          this.#store();
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
    const loxid = lazy.TorSettings.bridges.lox_id;
    try {
      const levelup = await this.#attemptUpgrade(loxid);
      if (levelup) {
        const level = lazy.get_trust_level(this.#credentials[loxid]);
        const newEvent = {
          type: "levelup",
          newlevel: level,
        };
        this.#events.push(newEvent);
        this.#store();
      }
    } catch (err) {
      lazy.logger.error(err);
    }
    try {
      const leveldown = await this.#blockageMigration(loxid);
      if (leveldown) {
        let level = lazy.get_trust_level(this.#credentials[loxid]);
        const newEvent = {
          type: "blockage",
          newlevel: level,
        };
        this.#events.push(newEvent);
        this.#store();
      }
    } catch (err) {
      lazy.logger.error(err);
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
    this.#invites = [];
    this.#events = [];
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
    this.#invites = null;
    this.#pubKeys = null;
    this.#encTable = null;
    this.#constants = null;
    this.#pubKeyPromise = null;
    this.#encTablePromise = null;
    this.#constantsPromise = null;
    this.#credentials = null;
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
   * @returns {string} The loxid of the associated credential on success.
   */
  async redeemInvite(invite) {
    if (!this.#initialized) {
      throw new LoxError(LoxErrors.NotInitialized);
    }
    await this.#getPubKeys();
    let request = await lazy.open_invite(JSON.parse(invite).invite);
    let id = this.#genLoxId();
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
    this.#credentials[id] = cred;
    this.#store();
    return id;
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
    return this.#invites;
  }

  /**
   * Generates a new trusted Lox invitation that a user can pass to their
   * contacts.
   *
   * Throws if:
   *  - there is no saved Lox credential, or
   *  - the saved credential does not have any invitations available.
   *
   * @returns {string} A valid Lox invitation.
   */
  async generateInvite() {
    if (!this.#initialized) {
      throw new LoxError(LoxErrors.NotInitialized);
    }
    const loxid = lazy.TorSettings.bridges.lox_id;
    if (!loxid || !this.#credentials[loxid]) {
      throw new LoxError(LoxErrors.MissingCredential);
    }
    await this.#getPubKeys();
    await this.#getEncTable();
    let level = lazy.get_trust_level(this.#credentials[loxid]);
    if (level < 1) {
      throw new LoxError(LoxErrors.NoInvitations);
    }
    let request = lazy.issue_invite(
      JSON.stringify(this.#credentials[loxid]),
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
      this.#credentials[loxid] = response;
      const invite = lazy.prepare_invite(response);
      this.#invites.push(invite);
      // cap length of stored invites
      if (this.#invites.len > 50) {
        this.#invites.shift();
      }
      return invite;
    }
  }

  /**
   * Get the number of invites that a user has remaining.
   *
   * @returns {int} The number of invites that can still be generated by a
   *   user's credential.
   */
  getRemainingInviteCount() {
    if (!this.#initialized) {
      throw new LoxError(LoxErrors.NotInitialized);
    }
    const loxid = lazy.TorSettings.bridges.lox_id;
    if (!loxid || !this.#credentials[loxid]) {
      throw new LoxError(LoxErrors.MissingCredential);
    }
    return parseInt(lazy.get_invites_remaining(this.#credentials[loxid]));
  }

  async #blockageMigration(loxid) {
    if (!loxid || !this.#credentials[loxid]) {
      throw new LoxError(LoxErrors.MissingCredential);
    }
    await this.#getPubKeys();
    let request;
    try {
      request = lazy.check_blockage(this.#credentials[loxid], this.#pubKeys);
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
      this.#credentials[loxid],
      JSON.stringify(response)
    );
    request = lazy.blockage_migration(
      this.#credentials[loxid],
      migrationCred,
      this.#pubKeys
    );
    response = await this.#makeRequest("blockagemigration", request);
    if (response.hasOwnProperty("error")) {
      lazy.logger.error(response.error);
      throw new LoxError(LoxErrors.LoxServerUnreachable);
    }
    const cred = lazy.handle_blockage_migration(
      this.#credentials[loxid],
      JSON.stringify(response),
      this.#pubKeys
    );
    this.#credentials[loxid] = cred;
    this.#store();
    return true;
  }

  /** Attempts to upgrade the currently saved Lox credential.
   *  If an upgrade is available, save an event in the event list.
   *
   *  @returns {boolean} whether a levelup event occured
   */
  async #attemptUpgrade(loxid) {
    if (!loxid || !this.#credentials[loxid]) {
      throw new LoxError(LoxErrors.MissingCredential);
    }
    await this.#getPubKeys();
    await this.#getEncTable();
    await this.#getConstants();
    let success = false;
    let level = lazy.get_trust_level(this.#credentials[loxid]);
    if (level < 1) {
      // attempt trust promotion instead
      try {
        success = await this.#trustMigration();
      } catch (err) {
        lazy.logger.error(err);
        return false;
      }
    } else {
      let request = lazy.level_up(
        this.#credentials[loxid],
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
      this.#credentials[loxid] = cred;
      return true;
    }
    return success;
  }

  /**
   * Attempt to migrate from an untrusted to a trusted Lox credential
   *
   * @returns {Promise<bool>} A bool value indicated whether the credential
   *    was successfully migrated.
   */
  async #trustMigration() {
    const loxid = lazy.TorSettings.bridges.lox_id;
    if (!loxid || !this.#credentials[loxid]) {
      throw new LoxError(LoxErrors.MissingCredential);
    }
    await this.#getPubKeys();
    return new Promise((resolve, reject) => {
      let request = "";
      try {
        request = lazy.trust_promotion(this.#credentials[loxid], this.#pubKeys);
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
            this.#credentials[loxid],
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
              this.#credentials[loxid] = cred;
              this.#store();
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
   * @returns {EventData[]} A list of the accumulated, unacknowledged events
   *   associated with a user's credential.
   */
  getEventData() {
    if (!this.#initialized) {
      throw new LoxError(LoxErrors.NotInitialized);
    }
    const loxid = lazy.TorSettings.bridges.lox_id;
    if (!loxid || !this.#credentials[loxid]) {
      throw new LoxError(LoxErrors.MissingCredential);
    }
    return this.#events;
  }

  /**
   * Clears accumulated event data.
   */
  clearEventData() {
    if (!this.#initialized) {
      throw new LoxError(LoxErrors.NotInitialized);
    }
    this.#events = [];
    this.#store();
  }

  /**
   * Clears accumulated invitations.
   */
  clearInvites() {
    if (!this.#initialized) {
      throw new LoxError(LoxErrors.NotInitialized);
    }
    this.#invites = [];
    this.#store();
  }

  /**
   * @typedef {object} UnlockData
   *
   * @property {string} date - The date-time for the next level up, formatted as YYYY-MM-DDTHH:mm:ssZ.
   * @property {integer} nextLevel - The next level. Levels count from 0, so this will be 1 or greater.
   *
   */

  /**
   * Get details about the next feature unlock.
   *
   * @returns {UnlockData} - Details about the next unlock.
   */
  async getNextUnlock() {
    if (!this.#initialized) {
      throw new LoxError(LoxErrors.NotInitialized);
    }
    const loxid = lazy.TorSettings.bridges.lox_id;
    if (!loxid || !this.#credentials[loxid]) {
      throw new LoxError(LoxErrors.MissingCredential);
    }
    await this.#getConstants();
    let nextUnlocks = JSON.parse(
      lazy.get_next_unlock(this.#constants, this.#credentials[loxid])
    );
    const level = parseInt(lazy.get_trust_level(this.#credentials[loxid]));
    const unlocks = {
      date: nextUnlocks.trust_level_unlock_date,
      nextLevel: level + 1,
    };
    return unlocks;
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
