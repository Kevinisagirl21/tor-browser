// A module for TorBrowser that provides an asynchronous controller for
// Tor, through its ControlPort.
//
// This file is written in call stack order (later functions
// call earlier functions). The file can be processed
// with docco.js to produce pretty documentation.
//
// To import the module, use
//
//  let { configureControlPortModule, controller, wait_for_controller } =
//                Components.utils.import("path/to/tor-control-port.js", {});
//
// See the third-to-last function defined in this file:
//   configureControlPortModule(ipcFile, host, port, password)
// for usage of the configureControlPortModule function.
//
// See the last functions defined in this file:
//   controller(avoidCache), wait_for_controller(avoidCache)
// for usage of the controller functions.

/* jshint esnext: true */
/* jshint -W097 */
/* global console */
"use strict";

// ### Import Mozilla Services
const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");

ChromeUtils.defineModuleGetter(
  this,
  "TorMonitorService",
  "resource://gre/modules/TorMonitorService.jsm"
);

// tor-launcher observer topics
const TorTopics = Object.freeze({
  ProcessIsReady: "TorProcessIsReady",
});

// __log__.
// Logging function
let logger = Cc["@torproject.org/torbutton-logger;1"].getService(Ci.nsISupports)
  .wrappedJSObject;
let log = x => logger.eclog(3, x.trimRight().replace(/\r\n/g, "\n"));

// ### announce this file
log("Loading tor-control-port.js\n");

class AsyncSocket {
  constructor(ipcFile, host, port) {
    let sts = Cc["@mozilla.org/network/socket-transport-service;1"].getService(
      Ci.nsISocketTransportService
    );
    const OPEN_UNBUFFERED = Ci.nsITransport.OPEN_UNBUFFERED;

    let socketTransport = ipcFile
      ? sts.createUnixDomainTransport(ipcFile)
      : sts.createTransport([], host, port, null, null);

    this.outputStream = socketTransport
      .openOutputStream(OPEN_UNBUFFERED, 1, 1)
      .QueryInterface(Ci.nsIAsyncOutputStream);
    this.outputQueue = [];

    this.inputStream = socketTransport
      .openInputStream(OPEN_UNBUFFERED, 1, 1)
      .QueryInterface(Ci.nsIAsyncInputStream);
    this.scriptableInputStream = Cc[
      "@mozilla.org/scriptableinputstream;1"
    ].createInstance(Ci.nsIScriptableInputStream);
    this.scriptableInputStream.init(this.inputStream);
    this.inputQueue = [];
  }

  // asynchronously write string to underlying socket and return number of bytes written
  async write(str) {
    return new Promise((resolve, reject) => {
      // asyncWait next write request
      const tryAsyncWait = () => {
        if (this.outputQueue.length) {
          this.outputStream.asyncWait(
            this.outputQueue.at(0), // next request
            0,
            0,
            Services.tm.currentThread
          );
        }
      };

      // output stream can only have 1 registered callback at a time, so multiple writes
      // need to be queued up (see nsIAsyncOutputStream.idl)
      this.outputQueue.push({
        // Implement an nsIOutputStreamCallback:
        onOutputStreamReady: () => {
          try {
            let bytesWritten = this.outputStream.write(str, str.length);

            // remove this callback object from queue as it is now completed
            this.outputQueue.shift();

            // request next wait if there is one
            tryAsyncWait();

            // finally resolve promise
            resolve(bytesWritten);
          } catch (err) {
            // reject promise on error
            reject(err);
          }
        },
      });

      // length 1 imples that there is no in-flight asyncWait, so we may immediately
      // follow through on this write
      if (this.outputQueue.length == 1) {
        tryAsyncWait();
      }
    });
  }

  // asynchronously read string from underlying socket and return it
  async read() {
    return new Promise((resolve, reject) => {
      const tryAsyncWait = () => {
        if (this.inputQueue.length) {
          this.inputStream.asyncWait(
            this.inputQueue.at(0), // next input request
            0,
            0,
            Services.tm.currentThread
          );
        }
      };

      this.inputQueue.push({
        onInputStreamReady: stream => {
          try {
            if (!this.scriptableInputStream.available()) {
              // This means EOF, but not closed yet. However, arriving at EOF
              // should be an error condition for us, since we are in a socket,
              // and EOF should mean peer disconnected.
              // If the stream has been closed, this function itself should
              // throw.
              reject(
                new Error("onInputStreamReady called without available bytes.")
              );
              return;
            }

            // read our string from input stream
            let str = this.scriptableInputStream.read(
              this.scriptableInputStream.available()
            );

            // remove this callback object from queue now that we have read
            this.inputQueue.shift();

            // request next wait if there is one
            tryAsyncWait();

            // finally resolve promise
            resolve(str);
          } catch (err) {
            reject(err);
          }
        },
      });

      // length 1 imples that there is no in-flight asyncWait, so we may immediately
      // follow through on this read
      if (this.inputQueue.length == 1) {
        tryAsyncWait();
      }
    });
  }

  close() {
    this.outputStream.close();
    this.inputStream.close();
  }
}

class ControlSocket {
  constructor(asyncSocket) {
    this.socket = asyncSocket;
    this._isOpen = true;
    this.pendingData = "";
    this.pendingLines = [];

    this.mainDispatcher = io.callbackDispatcher();
    this.notificationDispatcher = io.callbackDispatcher();
    // mainDispatcher pushes only async notifications (650) to notificationDispatcher
    this.mainDispatcher.addCallback(
      /^650/,
      this._handleNotification.bind(this)
    );
    // callback for handling responses and errors
    this.mainDispatcher.addCallback(
      /^[245]\d\d/,
      this._handleCommandReply.bind(this)
    );

    this.commandQueue = [];

    this._startMessagePump();
  }

  // blocks until an entire line is read and returns it
  // immediately returns next line in queue (pendingLines) if present
  async _readLine() {
    // keep reading from socket until we have a full line to return
    while (!this.pendingLines.length) {
      // read data from our socket and spit on newline tokens
      this.pendingData += await this.socket.read();
      let lines = this.pendingData.split("\r\n");

      // the last line will either be empty string, or a partial read of a response/event
      // so save it off for the next socket read
      this.pendingData = lines.pop();

      // copy remaining full lines to our pendingLines list
      this.pendingLines = this.pendingLines.concat(lines);
    }
    return this.pendingLines.shift();
  }

  // blocks until an entire message is ready and returns it
  async _readMessage() {
    // whether we are searching for the end of a multi-line values
    // See control-spec section 3.9
    let handlingMultlineValue = false;
    let endOfMessageFound = false;
    const message = [];

    do {
      const line = await this._readLine();
      message.push(line);

      if (handlingMultlineValue) {
        // look for end of multiline
        if (line.match(/^\.$/)) {
          handlingMultlineValue = false;
        }
      } else {
        // 'Multiline values' are possible. We avoid interrupting one by detecting it
        // and waiting for a terminating "." on its own line.
        // (See control-spec section 3.9 and https://trac.torproject.org/16990#comment:28
        // Ensure this is the first line of a new message
        // eslint-disable-next-line no-lonely-if
        if (message.length === 1 && line.match(/^\d\d\d\+.+?=$/)) {
          handlingMultlineValue = true;
        }
        // look for end of message (note the space character at end of the regex)
        else if (line.match(/^\d\d\d /)) {
          if (message.length == 1) {
            endOfMessageFound = true;
          } else {
            let firstReplyCode = message[0].substring(0, 3);
            let lastReplyCode = line.substring(0, 3);
            if (firstReplyCode == lastReplyCode) {
              endOfMessageFound = true;
            }
          }
        }
      }
    } while (!endOfMessageFound);

    // join our lines back together to form one message
    return message.join("\r\n");
  }

  async _startMessagePump() {
    try {
      while (true) {
        let message = await this._readMessage();
        log("controlPort >> " + message);
        this.mainDispatcher.pushMessage(message);
      }
    } catch (err) {
      this._isOpen = false;
      for (const cmd of this.commandQueue) {
        cmd.reject(err);
      }
      this.commandQueue = [];
    }
  }

  _writeNextCommand() {
    let cmd = this.commandQueue[0];
    log("controlPort << " + cmd.commandString);
    this.socket.write(`${cmd.commandString}\r\n`).catch(cmd.reject);
  }

  async sendCommand(commandString) {
    if (!this.isOpen()) {
      throw new Error("ControlSocket not open");
    }

    // this promise is resolved either in _handleCommandReply, or
    // in _startMessagePump (on stream error)
    return new Promise((resolve, reject) => {
      let command = {
        commandString,
        resolve,
        reject,
      };

      this.commandQueue.push(command);
      if (this.commandQueue.length == 1) {
        this._writeNextCommand();
      }
    });
  }

  _handleCommandReply(message) {
    let cmd = this.commandQueue.shift();
    if (message.match(/^2/)) {
      cmd.resolve(message);
    } else if (message.match(/^[45]/)) {
      let myErr = new Error(cmd.commandString + " -> " + message);
      // Add Tor-specific information to the Error object.
      let idx = message.indexOf(" ");
      if (idx > 0) {
        myErr.torStatusCode = message.substring(0, idx);
        myErr.torMessage = message.substring(idx);
      } else {
        myErr.torStatusCode = message;
      }
      cmd.reject(myErr);
    } else {
      cmd.reject(
        new Error(
          `ControlSocket::_handleCommandReply received unexpected message:\n----\n${message}\n----`
        )
      );
    }

    // send next command if one is available
    if (this.commandQueue.length) {
      this._writeNextCommand();
    }
  }

  _handleNotification(message) {
    this.notificationDispatcher.pushMessage(message);
  }

  close() {
    this.socket.close();
    this._isOpen = false;
  }

  addNotificationCallback(regex, callback) {
    this.notificationDispatcher.addCallback(regex, callback);
  }

  isOpen() {
    return this._isOpen;
  }
}

// ## io
// I/O utilities namespace

let io = {};

// __io.callbackDispatcher()__.
// Returns dispatcher object with three member functions:
// dispatcher.addCallback(regex, callback), dispatcher.removeCallback(callback),
// and dispatcher.pushMessage(message).
// Pass pushMessage to another function that needs a callback with a single string
// argument. Whenever dispatcher.pushMessage receives a string, the dispatcher will
// check for any regex matches and pass the string on to the corresponding callback(s).
io.callbackDispatcher = function() {
  let callbackPairs = [],
    removeCallback = function(aCallback) {
      callbackPairs = callbackPairs.filter(function([regex, callback]) {
        return callback !== aCallback;
      });
    },
    addCallback = function(regex, callback) {
      if (callback) {
        callbackPairs.push([regex, callback]);
      }
      return function() {
        removeCallback(callback);
      };
    },
    pushMessage = function(message) {
      for (let [regex, callback] of callbackPairs) {
        if (message.match(regex)) {
          callback(message);
        }
      }
    };
  return {
    pushMessage,
    removeCallback,
    addCallback,
  };
};

// __io.controlSocket(ipcFile, host, port, password)__.
// Instantiates and returns a socket to a tor ControlPort at ipcFile or
// host:port, authenticating with the given password. Example:
//
//     // Open the socket
//     let socket = await io.controlSocket(undefined, "127.0.0.1", 9151, "MyPassw0rd");
//     // Send command and receive "250" response reply or error is thrown
//     await socket.sendCommand(commandText);
//     // Register or deregister for "650" notifications
//     // that match regex
//     socket.addNotificationCallback(regex, callback);
//     socket.removeNotificationCallback(callback);
//     // Close the socket permanently
//     socket.close();
io.controlSocket = async function(ipcFile, host, port, password) {
  let socket = new AsyncSocket(ipcFile, host, port);
  let controlSocket = new ControlSocket(socket);

  // Log in to control port.
  await controlSocket.sendCommand("authenticate " + (password || ""));
  // Activate needed events.
  await controlSocket.sendCommand("setevents stream");

  return controlSocket;
};

// ## utils
// A namespace for utility functions
let utils = {};

// __utils.identity(x)__.
// Returns its argument unchanged.
utils.identity = function(x) {
  return x;
};

// __utils.isString(x)__.
// Returns true iff x is a string.
utils.isString = function(x) {
  return typeof x === "string" || x instanceof String;
};

// __utils.capture(string, regex)__.
// Takes a string and returns an array of capture items, where regex must have a single
// capturing group and use the suffix /.../g to specify a global search.
utils.capture = function(string, regex) {
  let matches = [];
  // Special trick to use string.replace for capturing multiple matches.
  string.replace(regex, function(a, captured) {
    matches.push(captured);
  });
  return matches;
};

// __utils.extractor(regex)__.
// Returns a function that takes a string and returns an array of regex matches. The
// regex must use the suffix /.../g to specify a global search.
utils.extractor = function(regex) {
  return function(text) {
    return utils.capture(text, regex);
  };
};

// __utils.splitLines(string)__.
// Splits a string into an array of strings, each corresponding to a line.
utils.splitLines = function(string) {
  return string.split(/\r?\n/);
};

// __utils.splitAtSpaces(string)__.
// Splits a string into chunks between spaces. Does not split at spaces
// inside pairs of quotation marks.
utils.splitAtSpaces = utils.extractor(/((\S*?"(.*?)")+\S*|\S+)/g);

// __utils.splitAtFirst(string, regex)__.
// Splits a string at the first instance of regex match. If no match is
// found, returns the whole string.
utils.splitAtFirst = function(string, regex) {
  let match = string.match(regex);
  return match
    ? [
        string.substring(0, match.index),
        string.substring(match.index + match[0].length),
      ]
    : string;
};

// __utils.splitAtEquals(string)__.
// Splits a string into chunks between equals. Does not split at equals
// inside pairs of quotation marks.
utils.splitAtEquals = utils.extractor(/(([^=]*?"(.*?)")+[^=]*|[^=]+)/g);

// __utils.mergeObjects(arrayOfObjects)__.
// Takes an array of objects like [{"a":"b"},{"c":"d"}] and merges to a single object.
// Pure function.
utils.mergeObjects = function(arrayOfObjects) {
  let result = {};
  for (let obj of arrayOfObjects) {
    for (let key in obj) {
      result[key] = obj[key];
    }
  }
  return result;
};

// __utils.listMapData(parameterString, listNames)__.
// Takes a list of parameters separated by spaces, of which the first several are
// unnamed, and the remainder are named, in the form `NAME=VALUE`. Apply listNames
// to the unnamed parameters, and combine them in a map with the named parameters.
// Example: `40 FAILED 0 95.78.59.36:80 REASON=CANT_ATTACH`
//
//     utils.listMapData("40 FAILED 0 95.78.59.36:80 REASON=CANT_ATTACH",
//                       ["streamID", "event", "circuitID", "IP"])
//     // --> {"streamID" : "40", "event" : "FAILED", "circuitID" : "0",
//     //      "address" : "95.78.59.36:80", "REASON" : "CANT_ATTACH"}"
utils.listMapData = function(parameterString, listNames) {
  // Split out the space-delimited parameters.
  let parameters = utils.splitAtSpaces(parameterString),
    dataMap = {};
  // Assign listNames to the first n = listNames.length parameters.
  for (let i = 0; i < listNames.length; ++i) {
    dataMap[listNames[i]] = parameters[i];
  }
  // Read key-value pairs and copy these to the dataMap.
  for (let i = listNames.length; i < parameters.length; ++i) {
    let [key, value] = utils.splitAtEquals(parameters[i]);
    if (key && value) {
      dataMap[key] = value;
    }
  }
  return dataMap;
};

// __utils.rejectPromise(errorMessage)__.
// Returns a rejected promise with the given error message.
utils.rejectPromise = errorMessage => Promise.reject(new Error(errorMessage));

// ## info
// A namespace for functions related to tor's GETINFO and GETCONF command.
let info = {};

// __info.keyValueStringsFromMessage(messageText)__.
// Takes a message (text) response to GETINFO or GETCONF and provides
// a series of key-value strings, which are either multiline (with a `250+` prefix):
//
//     250+config/defaults=
//     AccountingMax "0 bytes"
//     AllowDotExit "0"
//     .
//
// or single-line (with a `250-` or `250 ` prefix):
//
//     250-version=0.2.6.0-alpha-dev (git-b408125288ad6943)
info.keyValueStringsFromMessage = utils.extractor(
  /^(250\+[\s\S]+?^\.|250[- ].+?)$/gim
);

// __info.applyPerLine(transformFunction)__.
// Returns a function that splits text into lines,
// and applies transformFunction to each line.
info.applyPerLine = function(transformFunction) {
  return function(text) {
    return utils.splitLines(text.trim()).map(transformFunction);
  };
};

// __info.routerStatusParser(valueString)__.
// Parses a router status entry as, described in
// https://gitweb.torproject.org/torspec.git/tree/dir-spec.txt
// (search for "router status entry")
info.routerStatusParser = function(valueString) {
  let lines = utils.splitLines(valueString),
    objects = [];
  for (let line of lines) {
    // Drop first character and grab data following it.
    let myData = line.substring(2),
      // Accumulate more maps with data, depending on the first character in the line.
      dataFun = {
        r: data =>
          utils.listMapData(data, [
            "nickname",
            "identity",
            "digest",
            "publicationDate",
            "publicationTime",
            "IP",
            "ORPort",
            "DirPort",
          ]),
        a: data => ({ IPv6: data }),
        s: data => ({ statusFlags: utils.splitAtSpaces(data) }),
        v: data => ({ version: data }),
        w: data => utils.listMapData(data, []),
        p: data => ({ portList: data.split(",") }),
      }[line.charAt(0)];
    if (dataFun !== undefined) {
      objects.push(dataFun(myData));
    }
  }
  return utils.mergeObjects(objects);
};

// __info.circuitStatusParser(line)__.
// Parse the output of a circuit status line.
info.circuitStatusParser = function(line) {
  let data = utils.listMapData(line, ["id", "status", "circuit"]),
    circuit = data.circuit;
  // Parse out the individual circuit IDs and names.
  if (circuit) {
    data.circuit = circuit.split(",").map(function(x) {
      return x.split(/~|=/);
    });
  }
  return data;
};

// __info.streamStatusParser(line)__.
// Parse the output of a stream status line.
info.streamStatusParser = function(text) {
  return utils.listMapData(text, [
    "StreamID",
    "StreamStatus",
    "CircuitID",
    "Target",
  ]);
};

// TODO: fix this parsing logic to handle bridgeLine correctly
// fingerprint/id is an optional parameter
// __info.bridgeParser(bridgeLine)__.
// Takes a single line from a `getconf bridge` result and returns
// a map containing the bridge's type, address, and ID.
info.bridgeParser = function(bridgeLine) {
  let result = {},
    tokens = bridgeLine.split(/\s+/);
  // First check if we have a "vanilla" bridge:
  if (tokens[0].match(/^\d+\.\d+\.\d+\.\d+/)) {
    result.type = "vanilla";
    [result.address, result.ID] = tokens;
    // Several bridge types have a similar format:
  } else {
    result.type = tokens[0];
    if (
      [
        "flashproxy",
        "fte",
        "meek",
        "meek_lite",
        "obfs3",
        "obfs4",
        "scramblesuit",
        "snowflake",
      ].includes(result.type)
    ) {
      [result.address, result.ID] = tokens.slice(1);
    }
  }
  return result.type ? result : null;
};

// __info.parsers__.
// A map of GETINFO and GETCONF keys to parsing function, which convert
// result strings to JavaScript data.
info.parsers = {
  "ns/id/": info.routerStatusParser,
  "ip-to-country/": utils.identity,
  "circuit-status": info.applyPerLine(info.circuitStatusParser),
  bridge: info.bridgeParser,
  // Currently unused parsers:
  //  "ns/name/" : info.routerStatusParser,
  //  "stream-status" : info.applyPerLine(info.streamStatusParser),
  //  "version" : utils.identity,
  //  "config-file" : utils.identity,
};

// __info.getParser(key)__.
// Takes a key and determines the parser function that should be used to
// convert its corresponding valueString to JavaScript data.
info.getParser = function(key) {
  return (
    info.parsers[key] ||
    info.parsers[key.substring(0, key.lastIndexOf("/") + 1)]
  );
};

// __info.stringToValue(string)__.
// Converts a key-value string as from GETINFO or GETCONF to a value.
info.stringToValue = function(string) {
  // key should look something like `250+circuit-status=` or `250-circuit-status=...`
  // or `250 circuit-status=...`
  let matchForKey = string.match(/^250[ +-](.+?)=/),
    key = matchForKey ? matchForKey[1] : null;
  if (key === null) {
    return null;
  }
  // matchResult finds a single-line result for `250-` or `250 `,
  // or a multi-line one for `250+`.
  let matchResult =
      string.match(/^250[ -].+?=(.*)$/) ||
      string.match(/^250\+.+?=([\s\S]*?)^\.$/m),
    // Retrieve the captured group (the text of the value in the key-value pair)
    valueString = matchResult ? matchResult[1] : null,
    // Get the parser function for the key found.
    parse = info.getParser(key.toLowerCase());
  if (parse === undefined) {
    throw new Error("No parser found for '" + key + "'");
  }
  // Return value produced by the parser.
  return parse(valueString);
};

// __info.getMultipleResponseValues(message)__.
// Process multiple responses to a GETINFO or GETCONF request.
info.getMultipleResponseValues = function(message) {
  return info
    .keyValueStringsFromMessage(message)
    .map(info.stringToValue)
    .filter(utils.identity);
};

// __info.getInfo(controlSocket, key)__.
// Sends GETINFO for a single key. Returns a promise with the result.
info.getInfo = function(aControlSocket, key) {
  if (!utils.isString(key)) {
    return utils.rejectPromise("key argument should be a string");
  }
  return aControlSocket
    .sendCommand("getinfo " + key)
    .then(response => info.getMultipleResponseValues(response)[0]);
};

// __info.getConf(aControlSocket, key)__.
// Sends GETCONF for a single key. Returns a promise with the result.
info.getConf = function(aControlSocket, key) {
  // GETCONF with a single argument returns results with
  // one or more lines that look like `250[- ]key=value`.
  // Any GETCONF lines that contain a single keyword only are currently dropped.
  // So we can use similar parsing to that for getInfo.
  if (!utils.isString(key)) {
    return utils.rejectPromise("key argument should be a string");
  }
  return aControlSocket
    .sendCommand("getconf " + key)
    .then(info.getMultipleResponseValues);
};

// ## onionAuth
// A namespace for functions related to tor's ONION_CLIENT_AUTH_* commands.
let onionAuth = {};

onionAuth.keyInfoStringsFromMessage = utils.extractor(/^250-CLIENT\s+(.+)$/gim);

onionAuth.keyInfoObjectsFromMessage = function(message) {
  let keyInfoStrings = onionAuth.keyInfoStringsFromMessage(message);
  return keyInfoStrings.map(infoStr =>
    utils.listMapData(infoStr, ["hsAddress", "typeAndKey"])
  );
};

// __onionAuth.viewKeys()__.
// Sends a ONION_CLIENT_AUTH_VIEW command to retrieve the list of private keys.
// Returns a promise that is fulfilled with an array of key info objects which
// contain the following properties:
//   hsAddress
//   typeAndKey
//   Flags (e.g., "Permanent")
onionAuth.viewKeys = function(aControlSocket) {
  let cmd = "onion_client_auth_view";
  return aControlSocket
    .sendCommand(cmd)
    .then(onionAuth.keyInfoObjectsFromMessage);
};

// __onionAuth.add(controlSocket, hsAddress, b64PrivateKey, isPermanent)__.
// Sends a ONION_CLIENT_AUTH_ADD command to add a private key to the
// Tor configuration.
onionAuth.add = function(
  aControlSocket,
  hsAddress,
  b64PrivateKey,
  isPermanent
) {
  if (!utils.isString(hsAddress)) {
    return utils.rejectPromise("hsAddress argument should be a string");
  }

  if (!utils.isString(b64PrivateKey)) {
    return utils.rejectPromise("b64PrivateKey argument should be a string");
  }

  const keyType = "x25519";
  let cmd = `onion_client_auth_add ${hsAddress} ${keyType}:${b64PrivateKey}`;
  if (isPermanent) {
    cmd += " Flags=Permanent";
  }
  return aControlSocket.sendCommand(cmd);
};

// __onionAuth.remove(controlSocket, hsAddress)__.
// Sends a ONION_CLIENT_AUTH_REMOVE command to remove a private key from the
// Tor configuration.
onionAuth.remove = function(aControlSocket, hsAddress) {
  if (!utils.isString(hsAddress)) {
    return utils.rejectPromise("hsAddress argument should be a string");
  }

  let cmd = `onion_client_auth_remove ${hsAddress}`;
  return aControlSocket.sendCommand(cmd);
};

// ## event
// Handlers for events

let event = {};

// __event.parsers__.
// A map of EVENT keys to parsing functions, which convert result strings to JavaScript
// data.
event.parsers = {
  stream: info.streamStatusParser,
  // Currently unused:
  // "circ" : info.circuitStatusParser,
};

// __event.messageToData(type, message)__.
// Extract the data from an event. Note, at present
// we only extract streams that look like `"650" SP...`
event.messageToData = function(type, message) {
  let dataText = message.match(/^650 \S+?\s(.*)/m)[1];
  return dataText && type.toLowerCase() in event.parsers
    ? event.parsers[type.toLowerCase()](dataText)
    : null;
};

// __event.watchEvent(controlSocket, type, filter, onData)__.
// Watches for a particular type of event. If filter(data) returns true, the event's
// data is passed to the onData callback. Returns a zero arg function that
// stops watching the event. Note: we only observe `"650" SP...` events
// currently (no `650+...` or `650-...` events).
event.watchEvent = function(controlSocket, type, filter, onData, raw = false) {
  controlSocket.addNotificationCallback(
    new RegExp("^650 " + type),
    function(message) {
      let data = event.messageToData(type, message);
      if (filter === null || filter(data)) {
        if (raw || !data) {
          onData(message);
          return;
        }
        onData(data);
      }
    }
  );
};

// ## tor
// Things related to the main controller.
let tor = {};

// __tor.controllerCache__.
// A map from "unix:socketpath" or "host:port" to controller objects. Prevents
// redundant instantiation of control sockets.
tor.controllerCache = new Map();

// __tor.controller(ipcFile, host, port, password)__.
// Creates a tor controller at the given ipcFile or host and port, with the
// given password.
tor.controller = async function(ipcFile, host, port, password) {
  let socket = await io.controlSocket(ipcFile, host, port, password);
  return {
    getInfo: key => info.getInfo(socket, key),
    getConf: key => info.getConf(socket, key),
    onionAuthViewKeys: () => onionAuth.viewKeys(socket),
    onionAuthAdd: (hsAddress, b64PrivateKey, isPermanent) =>
      onionAuth.add(socket, hsAddress, b64PrivateKey, isPermanent),
    onionAuthRemove: hsAddress => onionAuth.remove(socket, hsAddress),
    watchEvent: (type, filter, onData, raw = false) => {
      event.watchEvent(socket, type, filter, onData, raw);
    },
    isOpen: () => socket.isOpen(),
    close: () => {
      socket.close();
    },
    sendCommand: cmd => socket.sendCommand(cmd),
  };
};

// ## Export

let controlPortInfo = {};

// __configureControlPortModule(ipcFile, host, port, password)__.
// Sets Tor control port connection parameters to be used in future calls to
// the controller() function. Example:
//     configureControlPortModule(undefined, "127.0.0.1", 9151, "MyPassw0rd");
var configureControlPortModule = function(ipcFile, host, port, password) {
  controlPortInfo.ipcFile = ipcFile;
  controlPortInfo.host = host;
  controlPortInfo.port = port || 9151;
  controlPortInfo.password = password;
};

// __controller(avoidCache)__.
// Instantiates and returns a controller object that is connected and
// authenticated to a Tor ControlPort using the connection parameters
// provided in the most recent call to configureControlPortModule(), if
// the controller doesn't yet exist. Otherwise returns the existing
// controller to the given ipcFile or host:port. Throws on error.
//
// Example:
//
//     // Get a new controller
//     const avoidCache = true;
//     let c = controller(avoidCache);
//     // Send command and receive `250` reply or error message in a promise:
//     let replyPromise = c.getInfo("ip-to-country/16.16.16.16");
//     // Close the controller permanently
//     c.close();
var controller = async function(avoidCache) {
  if (!controlPortInfo.ipcFile && !controlPortInfo.host) {
    throw new Error("Please call configureControlPortModule first");
  }

  const dest = controlPortInfo.ipcFile
    ? `unix:${controlPortInfo.ipcFile.path}`
    : `${controlPortInfo.host}:${controlPortInfo.port}`;

  // constructor shorthand
  const newTorController = async () => {
    return tor.controller(
      controlPortInfo.ipcFile,
      controlPortInfo.host,
      controlPortInfo.port,
      controlPortInfo.password
    );
  };

  // avoid cache so always return a new controller
  if (avoidCache) {
    return newTorController();
  }

  // first check our cache and see if we already have one
  let cachedController = tor.controllerCache.get(dest);
  if (cachedController && cachedController.isOpen()) {
    return cachedController;
  }

  // create a new one and store in the map
  cachedController = await newTorController();
  // overwrite the close() function to prevent consumers from closing a shared/cached controller
  cachedController.close = () => {
    throw new Error("May not close cached Tor Controller as it may be in use");
  };

  tor.controllerCache.set(dest, cachedController);
  return cachedController;
};

// __wait_for_controller(avoidCache)
// Same as controller() function, but explicitly waits until there is a tor daemon
// to connect to (either launched by tor-launcher, or if we have an existing system
// tor daemon)
var wait_for_controller = function(avoidCache) {
  // if tor process is running (either ours or system) immediately return controller
  if (!TorMonitorService.ownsTorDaemon || TorMonitorService.isRunning) {
    return controller(avoidCache);
  }

  // otherwise we must wait for tor to finish launching before resolving
  return new Promise((resolve, reject) => {
    let observer = {
      observe: async (subject, topic, data) => {
        if (topic === TorTopics.ProcessIsReady) {
          try {
            resolve(await controller(avoidCache));
          } catch (err) {
            reject(err);
          }
          Services.obs.removeObserver(observer, TorTopics.ProcessIsReady);
        }
      },
    };
    Services.obs.addObserver(observer, TorTopics.ProcessIsReady);
  });
};

// Export functions for external use.
var EXPORTED_SYMBOLS = [
  "configureControlPortModule",
  "controller",
  "wait_for_controller",
];
