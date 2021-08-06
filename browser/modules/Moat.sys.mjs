/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  TorSettings,
  TorBridgeSource,
} from "resource:///modules/TorSettings.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  Subprocess: "resource://gre/modules/Subprocess.sys.mjs",
  TorLauncherUtil: "resource://gre/modules/TorLauncherUtil.sys.mjs",
  TorProviderBuilder: "resource://gre/modules/TorProviderBuilder.sys.mjs",
});

const TorLauncherPrefs = Object.freeze({
  bridgedb_front: "extensions.torlauncher.bridgedb_front",
  bridgedb_reflector: "extensions.torlauncher.bridgedb_reflector",
  moat_service: "extensions.torlauncher.moat_service",
});

//
// Launches and controls the PT process lifetime
//
class MeekTransport {
  // These members are used by consumers to setup the proxy to do requests over
  // meek. They are passed to newProxyInfoWithAuth.
  proxyType = null;
  proxyAddress = null;
  proxyPort = 0;
  proxyUsername = null;
  proxyPassword = null;

  #inited = false;
  #meekClientProcess = null;

  // launches the meekprocess
  async init() {
    // ensure we haven't already init'd
    if (this.#inited) {
      throw new Error("MeekTransport: Already initialized");
    }

    try {
      // figure out which pluggable transport to use
      const supportedTransports = ["meek", "meek_lite"];
      const provider = await lazy.TorProviderBuilder.build();
      const proxy = (await provider.getPluggableTransports()).find(
        pt =>
          pt.type === "exec" &&
          supportedTransports.some(t => pt.transports.includes(t))
      );
      if (!proxy) {
        throw new Error("No supported transport found.");
      }

      const meekTransport = proxy.transports.find(t =>
        supportedTransports.includes(t)
      );
      // Convert meek client path to absolute path if necessary
      const meekWorkDir = lazy.TorLauncherUtil.getTorFile(
        "pt-startup-dir",
        false
      );
      if (lazy.TorLauncherUtil.isPathRelative(proxy.pathToBinary)) {
        const meekPath = meekWorkDir.clone();
        meekPath.appendRelativePath(proxy.pathToBinary);
        proxy.pathToBinary = meekPath.path;
      }

      // Construct the per-connection arguments.
      let meekClientEscapedArgs = "";
      const meekReflector = Services.prefs.getStringPref(
        TorLauncherPrefs.bridgedb_reflector
      );

      // Escape aValue per section 3.5 of the PT specification:
      //   First the "<Key>=<Value>" formatted arguments MUST be escaped,
      //   such that all backslash, equal sign, and semicolon characters
      //   are escaped with a backslash.
      const escapeArgValue = aValue =>
        aValue
          ? aValue
              .replaceAll("\\", "\\\\")
              .replaceAll("=", "\\=")
              .replaceAll(";", "\\;")
          : "";

      if (meekReflector) {
        meekClientEscapedArgs += "url=";
        meekClientEscapedArgs += escapeArgValue(meekReflector);
      }
      const meekFront = Services.prefs.getStringPref(
        TorLauncherPrefs.bridgedb_front
      );
      if (meekFront) {
        if (meekClientEscapedArgs.length) {
          meekClientEscapedArgs += ";";
        }
        meekClientEscapedArgs += "front=";
        meekClientEscapedArgs += escapeArgValue(meekFront);
      }

      // Setup env and start meek process
      const ptStateDir = lazy.TorLauncherUtil.getTorFile("tordatadir", false);
      ptStateDir.append("pt_state"); // Match what tor uses.

      const envAdditions = {
        TOR_PT_MANAGED_TRANSPORT_VER: "1",
        TOR_PT_STATE_LOCATION: ptStateDir.path,
        TOR_PT_EXIT_ON_STDIN_CLOSE: "1",
        TOR_PT_CLIENT_TRANSPORTS: meekTransport,
      };
      if (TorSettings.proxy.enabled) {
        envAdditions.TOR_PT_PROXY = TorSettings.proxy.uri;
      }

      const opts = {
        command: proxy.pathToBinary,
        arguments: proxy.options.split(/s+/),
        workdir: meekWorkDir.path,
        environmentAppend: true,
        environment: envAdditions,
        stderr: "pipe",
      };

      // Launch meek client
      this.#meekClientProcess = await lazy.Subprocess.call(opts);

      // Callback chain for reading stderr
      const stderrLogger = async () => {
        while (this.#meekClientProcess) {
          const errString = await this.#meekClientProcess.stderr.readString();
          if (errString) {
            console.log(`MeekTransport: stderr => ${errString}`);
          }
        }
      };
      stderrLogger();

      // Read pt's stdout until terminal (CMETHODS DONE) is reached
      // returns array of lines for parsing
      const getInitLines = async (stdout = "") => {
        stdout += await this.#meekClientProcess.stdout.readString();

        // look for the final message
        const CMETHODS_DONE = "CMETHODS DONE";
        let endIndex = stdout.lastIndexOf(CMETHODS_DONE);
        if (endIndex != -1) {
          endIndex += CMETHODS_DONE.length;
          return stdout.substring(0, endIndex).split("\n");
        }
        return getInitLines(stdout);
      };

      // read our lines from pt's stdout
      const meekInitLines = await getInitLines();
      // tokenize our pt lines
      const meekInitTokens = meekInitLines.map(line => {
        const tokens = line.split(" ");
        return {
          keyword: tokens[0],
          args: tokens.slice(1),
        };
      });

      // parse our pt tokens
      for (const { keyword, args } of meekInitTokens) {
        const argsJoined = args.join(" ");
        let keywordError = false;
        switch (keyword) {
          case "VERSION": {
            if (args.length != 1 || args[0] !== "1") {
              keywordError = true;
            }
            break;
          }
          case "PROXY": {
            if (args.length != 1 || args[0] !== "DONE") {
              keywordError = true;
            }
            break;
          }
          case "CMETHOD": {
            if (args.length != 3) {
              keywordError = true;
              break;
            }
            const transport = args[0];
            const proxyType = args[1];
            const addrPortString = args[2];
            const addrPort = addrPortString.split(":");

            if (transport !== meekTransport) {
              throw new Error(
                `MeekTransport: Expected ${meekTransport} but found ${transport}`
              );
            }
            if (!["socks4", "socks4a", "socks5"].includes(proxyType)) {
              throw new Error(
                `MeekTransport: Invalid proxy type => ${proxyType}`
              );
            }
            if (addrPort.length != 2) {
              throw new Error(
                `MeekTransport: Invalid proxy address => ${addrPortString}`
              );
            }
            const addr = addrPort[0];
            const port = parseInt(addrPort[1]);
            if (port < 1 || port > 65535) {
              throw new Error(`MeekTransport: Invalid proxy port => ${port}`);
            }

            // convert proxy type to strings used by protocol-proxy-servce
            this.proxyType = proxyType === "socks5" ? "socks" : "socks4";
            this.proxyAddress = addr;
            this.proxyPort = port;

            break;
          }
          // terminal
          case "CMETHODS": {
            if (args.length != 1 || args[0] !== "DONE") {
              keywordError = true;
            }
            break;
          }
          // errors (all fall through):
          case "VERSION-ERROR":
          case "ENV-ERROR":
          case "PROXY-ERROR":
          case "CMETHOD-ERROR":
            throw new Error(`MeekTransport: ${keyword} => '${argsJoined}'`);
        }
        if (keywordError) {
          throw new Error(
            `MeekTransport: Invalid ${keyword} keyword args => '${argsJoined}'`
          );
        }
      }

      // register callback to cleanup on process exit
      this.#meekClientProcess.wait().then(exitObj => {
        this.#meekClientProcess = null;
        this.uninit();
      });

      // socks5
      if (this.proxyType === "socks") {
        if (meekClientEscapedArgs.length <= 255) {
          this.proxyUsername = meekClientEscapedArgs;
          this.proxyPassword = "\x00";
        } else {
          this.proxyUsername = meekClientEscapedArgs.substring(0, 255);
          this.proxyPassword = meekClientEscapedArgs.substring(255);
        }
        // socks4
      } else {
        this.proxyUsername = meekClientEscapedArgs;
        this.proxyPassword = undefined;
      }

      this.#inited = true;
    } catch (ex) {
      if (this.#meekClientProcess) {
        this.#meekClientProcess.kill();
        this.#meekClientProcess = null;
      }
      throw ex;
    }
  }

  async uninit() {
    this.#inited = false;

    await this.#meekClientProcess?.kill();
    this.#meekClientProcess = null;
    this.proxyType = null;
    this.proxyAddress = null;
    this.proxyPort = 0;
    this.proxyUsername = null;
    this.proxyPassword = null;
  }
}

//
// Callback object with a cached promise for the returned Moat data
//
class MoatResponseListener {
  #response = "";
  #responsePromise;
  #resolve;
  #reject;
  constructor() {
    this.#response = "";
    // we need this promise here because await nsIHttpChannel::asyncOpen does
    // not return only once the request is complete, it seems to return
    // after it begins, so we have to get the result from this listener object.
    // This promise is only resolved once onStopRequest is called
    this.#responsePromise = new Promise((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
  }

  // callers wait on this for final response
  response() {
    return this.#responsePromise;
  }

  // noop
  onStartRequest(request) {}

  // resolve or reject our Promise
  onStopRequest(request, status) {
    try {
      if (!Components.isSuccessCode(status)) {
        const errorMessage =
          lazy.TorLauncherUtil.getLocalizedStringForError(status);
        this.#reject(new Error(errorMessage));
      }
      if (request.responseStatus != 200) {
        this.#reject(new Error(request.responseStatusText));
      }
    } catch (err) {
      this.#reject(err);
    }
    this.#resolve(this.#response);
  }

  // read response data
  onDataAvailable(request, stream, offset, length) {
    const scriptableStream = Cc[
      "@mozilla.org/scriptableinputstream;1"
    ].createInstance(Ci.nsIScriptableInputStream);
    scriptableStream.init(stream);
    this.#response += scriptableStream.read(length);
  }
}

class InternetTestResponseListener {
  #promise;
  #resolve;
  #reject;
  constructor() {
    this.#promise = new Promise((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
  }

  // callers wait on this for final response
  get status() {
    return this.#promise;
  }

  onStartRequest(request) {}

  // resolve or reject our Promise
  onStopRequest(request, status) {
    try {
      const statuses = {
        components: status,
        successful: Components.isSuccessCode(status),
      };
      try {
        if (statuses.successful) {
          statuses.http = request.responseStatus;
          statuses.date = request.getResponseHeader("Date");
        }
      } catch (err) {
        console.warn(
          "Successful request, but could not get the HTTP status or date",
          err
        );
      }
      this.#resolve(statuses);
    } catch (err) {
      this.#reject(err);
    }
  }

  onDataAvailable(request, stream, offset, length) {
    // We do not care of the actual data, as long as we have a successful
    // connection
  }
}

// constructs the json objects and sends the request over moat
export class MoatRPC {
  #inited = false;
  #meekTransport = null;

  get inited() {
    return this.#inited;
  }

  async init() {
    if (this.#inited) {
      throw new Error("MoatRPC: Already initialized");
    }

    let meekTransport = new MeekTransport();
    await meekTransport.init();
    this.#meekTransport = meekTransport;
    this.#inited = true;
  }

  async uninit() {
    await this.#meekTransport?.uninit();
    this.#meekTransport = null;
    this.#inited = false;
  }

  #makeHttpHandler(uriString) {
    if (!this.#inited) {
      throw new Error("MoatRPC: Not initialized");
    }

    const { proxyType, proxyAddress, proxyPort, proxyUsername, proxyPassword } =
      this.#meekTransport;

    const proxyPS = Cc[
      "@mozilla.org/network/protocol-proxy-service;1"
    ].getService(Ci.nsIProtocolProxyService);
    const flags = Ci.nsIProxyInfo.TRANSPARENT_PROXY_RESOLVES_HOST;
    const noTimeout = 0xffffffff; // UINT32_MAX
    const proxyInfo = proxyPS.newProxyInfoWithAuth(
      proxyType,
      proxyAddress,
      proxyPort,
      proxyUsername,
      proxyPassword,
      undefined,
      undefined,
      flags,
      noTimeout,
      undefined
    );

    const uri = Services.io.newURI(uriString);
    // There does not seem to be a way to directly create an nsILoadInfo from
    // JavaScript, so we create a throw away non-proxied channel to get one.
    const secFlags = Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL;
    const loadInfo = Services.io.newChannelFromURI(
      uri,
      undefined,
      Services.scriptSecurityManager.getSystemPrincipal(),
      undefined,
      secFlags,
      Ci.nsIContentPolicy.TYPE_OTHER
    ).loadInfo;

    const httpHandler = Services.io
      .getProtocolHandler("http")
      .QueryInterface(Ci.nsIHttpProtocolHandler);
    const ch = httpHandler
      .newProxiedChannel(uri, proxyInfo, 0, undefined, loadInfo)
      .QueryInterface(Ci.nsIHttpChannel);

    // remove all headers except for 'Host"
    const headers = [];
    ch.visitRequestHeaders({
      visitHeader: (key, val) => {
        if (key !== "Host") {
          headers.push(key);
        }
      },
    });
    headers.forEach(key => ch.setRequestHeader(key, "", false));

    return ch;
  }

  async #makeRequest(procedure, args) {
    const procedureURIString = `${Services.prefs.getStringPref(
      TorLauncherPrefs.moat_service
    )}/${procedure}`;
    const ch = this.#makeHttpHandler(procedureURIString);

    // Arrange for the POST data to be sent.
    const argsJson = JSON.stringify(args);

    const inStream = Cc["@mozilla.org/io/string-input-stream;1"].createInstance(
      Ci.nsIStringInputStream
    );
    inStream.setData(argsJson, argsJson.length);
    const upChannel = ch.QueryInterface(Ci.nsIUploadChannel);
    const contentType = "application/vnd.api+json";
    upChannel.setUploadStream(inStream, contentType, argsJson.length);
    ch.requestMethod = "POST";

    // Make request
    const listener = new MoatResponseListener();
    await ch.asyncOpen(listener, ch);

    // wait for response
    const responseJSON = await listener.response();

    // parse that JSON
    return JSON.parse(responseJSON);
  }

  async testInternetConnection() {
    const uri = `${Services.prefs.getStringPref(
      TorLauncherPrefs.moat_service
    )}/circumvention/countries`;
    const ch = this.#makeHttpHandler(uri);
    ch.requestMethod = "HEAD";

    const listener = new InternetTestResponseListener();
    await ch.asyncOpen(listener, ch);
    return listener.status;
  }

  //
  // Moat APIs
  //

  // Receive a CAPTCHA challenge, takes the following parameters:
  // - transports: array of transport strings available to us eg: ["obfs4", "meek"]
  //
  // returns an object with the following fields:
  // - transport: a transport string the moat server decides it will send you selected
  //   from the list of provided transports
  // - image: a base64 encoded jpeg with the captcha to complete
  // - challenge: a nonce/cookie string associated with this request
  async fetch(transports) {
    if (
      // ensure this is an array
      Array.isArray(transports) &&
      // ensure array has values
      !!transports.length &&
      // ensure each value in the array is a string
      transports.reduce((acc, cur) => acc && typeof cur === "string", true)
    ) {
      const args = {
        data: [
          {
            version: "0.1.0",
            type: "client-transports",
            supported: transports,
          },
        ],
      };
      const response = await this.#makeRequest("fetch", args);
      if ("errors" in response) {
        const code = response.errors[0].code;
        const detail = response.errors[0].detail;
        throw new Error(`MoatRPC: ${detail} (${code})`);
      }

      const transport = response.data[0].transport;
      const image = response.data[0].image;
      const challenge = response.data[0].challenge;

      return { transport, image, challenge };
    }
    throw new Error("MoatRPC: fetch() expects a non-empty array of strings");
  }

  // Submit an answer for a CAPTCHA challenge and get back bridges, takes the following
  // parameters:
  // - transport: the transport string associated with a previous fetch request
  // - challenge: the nonce string associated with the fetch request
  // - solution: solution to the CAPTCHA associated with the fetch request
  // - qrcode: true|false whether we want to get back a qrcode containing the bridge strings
  //
  // returns an object with the following fields:
  // - bridges: an array of bridge line strings
  // - qrcode: base64 encoded jpeg of bridges if requested, otherwise null
  // if the provided solution is incorrect, returns an empty object
  async check(transport, challenge, solution, qrcode) {
    const args = {
      data: [
        {
          id: "2",
          version: "0.1.0",
          type: "moat-solution",
          transport,
          challenge,
          solution,
          qrcode: qrcode ? "true" : "false",
        },
      ],
    };
    const response = await this.#makeRequest("check", args);
    if ("errors" in response) {
      const code = response.errors[0].code;
      const detail = response.errors[0].detail;
      if (code == 419 && detail === "The CAPTCHA solution was incorrect.") {
        return {};
      }

      throw new Error(`MoatRPC: ${detail} (${code})`);
    }

    const bridges = response.data[0].bridges;
    const qrcodeImg = qrcode ? response.data[0].qrcode : null;

    return { bridges, qrcode: qrcodeImg };
  }

  // Convert received settings object to format used by TorSettings module
  // In the event of error, just return null
  #fixupSettings(settings) {
    try {
      let retval = TorSettings.defaultSettings();
      if ("bridges" in settings) {
        retval.bridges.enabled = true;
        switch (settings.bridges.source) {
          case "builtin":
            retval.bridges.source = TorBridgeSource.BuiltIn;
            retval.bridges.builtin_type = settings.bridges.type;
            // Tor Browser will periodically update the built-in bridge strings list using the
            // circumvention_builtin() function, so we can ignore the bridge strings we have received here;
            // BridgeDB only returns a subset of the available built-in bridges through the circumvention_settings()
            // function which is fine for our 3rd parties, but we're better off ignoring them in Tor Browser, otherwise
            // we get in a weird situation of needing to update our built-in bridges in a piece-meal fashion which
            // seems over-complicated/error-prone
            break;
          case "bridgedb":
            retval.bridges.source = TorBridgeSource.BridgeDB;
            if (settings.bridges.bridge_strings) {
              retval.bridges.bridge_strings = settings.bridges.bridge_strings;
              retval.bridges.disabled_strings = [];
            } else {
              throw new Error(
                "MoatRPC::_fixupSettings(): Received no bridge-strings for BridgeDB bridge source"
              );
            }
            break;
          default:
            throw new Error(
              `MoatRPC::_fixupSettings(): Unexpected bridge source '${settings.bridges.source}'`
            );
        }
      }
      if ("proxy" in settings) {
        // TODO: populate proxy settings
      }
      if ("firewall" in settings) {
        // TODO: populate firewall settings
      }
      return retval;
    } catch (ex) {
      console.log(ex.message);
      return null;
    }
  }

  // Converts a list of settings objects received from BridgeDB to a list of settings objects
  // understood by the TorSettings module
  // In the event of error, returns and empty list
  #fixupSettingsList(settingsList) {
    try {
      let retval = [];
      for (let settings of settingsList) {
        settings = this.#fixupSettings(settings);
        if (settings != null) {
          retval.push(settings);
        }
      }
      return retval;
    } catch (ex) {
      console.log(ex.message);
      return [];
    }
  }

  // Request tor settings for the user optionally based on their location (derived
  // from their IP), takes the following parameters:
  // - transports: optional, an array of transports available to the client; if empty (or not
  //   given) returns settings using all working transports known to the server
  // - country: optional, an ISO 3166-1 alpha-2 country code to request settings for;
  //   if not provided the country is determined by the user's IP address
  //
  // returns an array of settings objects in roughly the same format as the _settings
  // object on the TorSettings module.
  // - If the server cannot determine the user's country (and no country code is provided),
  //   then null is returned
  // - If the country has no associated settings, an empty array is returned
  async circumvention_settings(transports, country) {
    const args = {
      transports: transports ? transports : [],
      country,
    };
    const response = await this.#makeRequest("circumvention/settings", args);
    let settings = {};
    if ("errors" in response) {
      const code = response.errors[0].code;
      const detail = response.errors[0].detail;
      if (code == 406) {
        console.log(
          "MoatRPC::circumvention_settings(): Cannot automatically determine user's country-code"
        );
        // cannot determine user's country
        return null;
      }

      throw new Error(`MoatRPC: ${detail} (${code})`);
    } else if ("settings" in response) {
      settings.settings = this.#fixupSettingsList(response.settings);
    }
    if ("country" in response) {
      settings.country = response.country;
    }
    return settings;
  }

  // Request a list of country codes with available censorship circumvention settings
  //
  // returns an array of ISO 3166-1 alpha-2 country codes which we can query settings
  // for
  async circumvention_countries() {
    const args = {};
    return this.#makeRequest("circumvention/countries", args);
  }

  // Request a copy of the builtin bridges, takes the following parameters:
  // - transports: optional, an array of transports we would like the latest bridge strings
  //   for; if empty (or not given) returns all of them
  //
  // returns a map whose keys are pluggable transport types and whose values are arrays of
  // bridge strings for that type
  async circumvention_builtin(transports) {
    const args = {
      transports: transports ? transports : [],
    };
    const response = await this.#makeRequest("circumvention/builtin", args);
    if ("errors" in response) {
      const code = response.errors[0].code;
      const detail = response.errors[0].detail;
      throw new Error(`MoatRPC: ${detail} (${code})`);
    }

    let map = new Map();
    for (const [transport, bridge_strings] of Object.entries(response)) {
      map.set(transport, bridge_strings);
    }

    return map;
  }

  // Request a copy of the defaul/fallback bridge settings, takes the following parameters:
  // - transports: optional, an array of transports available to the client; if empty (or not
  //   given) returns settings using all working transports known to the server
  //
  // returns an array of settings objects in roughly the same format as the _settings
  // object on the TorSettings module
  async circumvention_defaults(transports) {
    const args = {
      transports: transports ? transports : [],
    };
    const response = await this.#makeRequest("circumvention/defaults", args);
    if ("errors" in response) {
      const code = response.errors[0].code;
      const detail = response.errors[0].detail;
      throw new Error(`MoatRPC: ${detail} (${code})`);
    } else if ("settings" in response) {
      return this.#fixupSettingsList(response.settings);
    }
    return [];
  }
}
