// Copyright (c) 2022, The Tor Project, Inc.

export const TorStatuses = Object.freeze({
  OK: 250,
  EventNotification: 650,
});

export const TorParsers = Object.freeze({
  commandSucceeded(aReply) {
    return aReply?.statusCode === TorStatuses.OK;
  },

  // parseReply() understands simple GETCONF and GETINFO replies.
  parseReply(aCmd, aKey, aReply) {
    if (!aCmd || !aKey || !aReply || !aReply.lineArray?.length) {
      return [];
    }

    const lcKey = aKey.toLowerCase();
    const prefix = lcKey + "=";
    const prefixLen = prefix.length;
    const tmpArray = [];
    for (const line of aReply.lineArray) {
      var lcLine = line.toLowerCase();
      if (lcLine === lcKey) {
        tmpArray.push("");
      } else if (lcLine.indexOf(prefix) !== 0) {
        console.warn(`Unexpected ${aCmd} response: ${line}`);
      } else {
        try {
          let s = this.unescapeString(line.substring(prefixLen));
          tmpArray.push(s);
        } catch (e) {
          console.warn(
            `Error while unescaping the response of ${aCmd}: ${line}`,
            e
          );
        }
      }
    }

    return tmpArray;
  },

  // Returns false if more lines are needed.  The first time, callers
  // should pass an empty aReplyObj.
  // Parsing errors are indicated by aReplyObj._parseError = true.
  parseReplyLine(aLine, aReplyObj) {
    if (!aLine || !aReplyObj) {
      return false;
    }

    if (!("_parseError" in aReplyObj)) {
      aReplyObj.statusCode = 0;
      aReplyObj.lineArray = [];
      aReplyObj._parseError = false;
    }

    if (aLine.length < 4) {
      console.error("Unexpected response: ", aLine);
      aReplyObj._parseError = true;
      return true;
    }

    // TODO: handle + separators (data)
    aReplyObj.statusCode = parseInt(aLine.substring(0, 3), 10);
    const s = aLine.length < 5 ? "" : aLine.substring(4);
    // Include all lines except simple "250 OK" ones.
    if (aReplyObj.statusCode !== TorStatuses.OK || s !== "OK") {
      aReplyObj.lineArray.push(s);
    }

    return aLine.charAt(3) === " ";
  },

  // Split aStr at spaces, accounting for quoted values.
  // Returns an array of strings.
  splitReplyLine(aStr) {
    // Notice: the original function did not check for escaped quotes.
    return aStr
      .split('"')
      .flatMap((token, index) => {
        const inQuotedStr = index % 2 === 1;
        return inQuotedStr ? `"${token}"` : token.split(" ");
      })
      .filter(s => s);
  },

  // Helper function for converting a raw controller response into a parsed object.
  parseCommandResponse(reply) {
    if (!reply) {
      return {};
    }
    const lines = reply.split("\r\n");
    const rv = {};
    for (const line of lines) {
      if (this.parseReplyLine(line, rv) || rv._parseError) {
        break;
      }
    }
    return rv;
  },

  // If successful, returns a JS object with these fields:
  //   status.TYPE            -- "NOTICE" or "WARN"
  //   status.PROGRESS        -- integer
  //   status.TAG             -- string
  //   status.SUMMARY         -- string
  //   status.WARNING         -- string (optional)
  //   status.REASON          -- string (optional)
  //   status.COUNT           -- integer (optional)
  //   status.RECOMMENDATION  -- string (optional)
  //   status.HOSTADDR        -- string (optional)
  // Returns null upon failure.
  parseBootstrapStatus(aStatusMsg) {
    if (!aStatusMsg || !aStatusMsg.length) {
      return null;
    }

    let sawBootstrap = false;
    const statusObj = {};
    statusObj.TYPE = "NOTICE";

    // The following code assumes that this is a one-line response.
    for (const tokenAndVal of this.splitReplyLine(aStatusMsg)) {
      let token, val;
      const idx = tokenAndVal.indexOf("=");
      if (idx < 0) {
        token = tokenAndVal;
      } else {
        token = tokenAndVal.substring(0, idx);
        try {
          val = TorParsers.unescapeString(tokenAndVal.substring(idx + 1));
        } catch (e) {
          console.debug("Could not parse the token value", e);
        }
        if (!val) {
          // skip this token/value pair.
          continue;
        }
      }

      switch (token) {
        case "BOOTSTRAP":
          sawBootstrap = true;
          break;
        case "WARN":
        case "NOTICE":
        case "ERR":
          statusObj.TYPE = token;
          break;
        case "COUNT":
        case "PROGRESS":
          statusObj[token] = parseInt(val, 10);
          break;
        default:
          statusObj[token] = val;
          break;
      }
    }

    if (!sawBootstrap) {
      if (statusObj.TYPE === "NOTICE") {
        console.info(aStatusMsg);
      } else {
        console.warn(aStatusMsg);
      }
      return null;
    }

    return statusObj;
  },

  // Escape non-ASCII characters for use within the Tor Control protocol.
  // Based on Vidalia's src/common/stringutil.cpp:string_escape().
  // Returns the new string.
  escapeString(aStr) {
    // Just return if all characters are printable ASCII excluding SP, ", and #
    const kSafeCharRE = /^[\x21\x24-\x7E]*$/;
    if (!aStr || kSafeCharRE.test(aStr)) {
      return aStr;
    }
    const escaped = aStr
      .replaceAll("\\", "\\\\")
      .replaceAll('"', '\\"')
      .replaceAll("\n", "\\n")
      .replaceAll("\r", "\\r")
      .replaceAll("\t", "\\t")
      .replaceAll(/[^\x20-\x7e]+/g, text => {
        const encoder = new TextEncoder();
        return Array.from(
          encoder.encode(text),
          ch => "\\x" + ch.toString(16)
        ).join("");
      });
    return `"${escaped}"`;
  },

  // Unescape Tor Control string aStr (removing surrounding "" and \ escapes).
  // Based on Vidalia's src/common/stringutil.cpp:string_unescape().
  // Returns the unescaped string. Throws upon failure.
  // Within Torbutton, the file modules/utils.js also contains a copy of
  // _strUnescape().
  unescapeString(aStr) {
    if (
      !aStr ||
      aStr.length < 2 ||
      aStr[0] !== '"' ||
      aStr[aStr.length - 1] !== '"'
    ) {
      return aStr;
    }

    // Regular expression by Tim Pietzcker
    // https://stackoverflow.com/a/15569588
    if (!/^(?:[^"\\]|\\.|"(?:\\.|[^"\\])*")*$/.test(aStr)) {
      throw new Error('Unescaped " within string');
    }

    const matchUnicode = /^(\\x[0-9A-Fa-f]{2}|\\[0-7]{3})+/;
    let rv = "";
    let lastAdded = 1;
    let bs;
    while ((bs = aStr.indexOf("\\", lastAdded)) !== -1) {
      rv += aStr.substring(lastAdded, bs);
      // We always increment lastAdded, because we will either add something, or
      // ignore the backslash.
      lastAdded = bs + 2;
      if (lastAdded === aStr.length) {
        // The string ends with \", which is illegal
        throw new Error("Missing character after \\");
      }
      switch (aStr[bs + 1]) {
        case "n":
          rv += "\n";
          break;
        case "r":
          rv += "\r";
          break;
        case "t":
          rv += "\t";
          break;
        case '"':
        case "\\":
          rv += aStr[bs + 1];
          break;
        default:
          aStr.substring(bs).replace(matchUnicode, sequence => {
            const bytes = [];
            for (let i = 0; i < sequence.length; i += 4) {
              if (sequence[i + 1] === "x") {
                bytes.push(parseInt(sequence.substring(i + 2, i + 4), 16));
              } else {
                bytes.push(parseInt(sequence.substring(i + 1, i + 4), 8));
              }
            }
            lastAdded = bs + sequence.length;
            const decoder = new TextDecoder();
            rv += decoder.decode(new Uint8Array(bytes));
            return "";
          });
          // We have already incremented lastAdded, which means we ignore the
          // backslash, and we will do something at the next one.
          break;
      }
    }
    rv += aStr.substring(lastAdded, aStr.length - 1);
    return rv;
  },

  parseBridgeLine(line) {
    if (!line) {
      return null;
    }
    const re =
      /\s*(?:(?<transport>\S+)\s+)?(?<addr>[0-9a-fA-F\.\[\]\:]+:\d{1,5})(?:\s+(?<id>[0-9a-fA-F]{40}))?(?:\s+(?<args>.+))?/;
    const match = re.exec(line);
    if (!match) {
      throw new Error(`Invalid bridge line: ${line}.`);
    }
    const bridge = match.groups;
    if (!bridge.transport) {
      bridge.transport = "vanilla";
    }
    return bridge;
  },
});
