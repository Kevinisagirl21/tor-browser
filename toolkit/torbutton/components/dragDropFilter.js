/*************************************************************************
 * Drag and Drop Handler.
 *
 * Implements an observer that filters drag events to prevent OS
 * access to URLs (a potential proxy bypass vector).
 *************************************************************************/

const { XPCOMUtils } = ChromeUtils.import(
  "resource://gre/modules/XPCOMUtils.jsm"
);
const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");

XPCOMUtils.defineLazyModuleGetters(this, {
  ComponentUtils: "resource://gre/modules/ComponentUtils.jsm",
});

// Module specific constants
const kMODULE_NAME = "Torbutton Drag and Drop Handler";
const kCONTRACT_ID = "@torproject.org/torbutton-dragDropFilter;1";
const kMODULE_CID = Components.ID("f605ec27-d867-44b5-ad97-2a29276642c3");

const kInterfaces = [Ci.nsIObserver, Ci.nsIClassInfo];

const URLISH_TYPES = Object.freeze([
  "text/x-moz-url",
  "text/x-moz-url-data",
  "text/uri-list",
  "application/x-moz-file-promise-url",
]);

/*
  Returns true if the text resembles a URL or even just a hostname
  in a way that may prompt the O.S. or other applications to send out a
  validation DNS query, if not a full request (e.g. " torproject.org",
  even with the leading whitespace).
*/
function isURLish(text) {
  // Ignore leading whitespace.
  text = text.trim();

  // Without any protocol or dot in the first chunk, this is unlikely
  // to be considered URLish (exception: localhost, but we don't care).
  if (!/^[a-z][a-z0-9+-]*:\/\//i.test(text)) {
    // no protocol
    if (!/^[^.\s\/]+\.[^.\s\/]/.test(text)) {
      // no dot
      return false;
    }
    // Prepare for hostname validation via relative URL building.
    text = `//${text}`;
  }
  // Validate URL or hostname.
  try {
    new URL(text, "https://localhost");
    return true;
  } catch (e) {
    // invalid URL, bail out
  }
  return false;
}

// Returns true if any chunk of text is URLish
const hasURLish = text => text.split(/[^\p{L}_.-:\/%~@$-]+/u).some(isURLish);

function DragDropFilter() {
  this.logger = Cc["@torproject.org/torbutton-logger;1"].getService(
    Ci.nsISupports
  ).wrappedJSObject;
  this.logger.log(3, "Component Load 0: New DragDropFilter.");

  try {
    Services.obs.addObserver(this, "on-datatransfer-available");
  } catch (e) {
    this.logger.log(5, "Failed to register drag observer");
  }
}

DragDropFilter.prototype = {
  QueryInterface: ChromeUtils.generateQI([Ci.nsIObserver]),

  // make this an nsIClassInfo object
  flags: Ci.nsIClassInfo.DOM_OBJECT,
  classDescription: kMODULE_NAME,
  contractID: kCONTRACT_ID,
  classID: kMODULE_CID,

  // method of nsIClassInfo
  getInterfaces(count) {
    count.value = kInterfaces.length;
    return kInterfaces;
  },

  // method of nsIClassInfo
  getHelperForLanguage(count) {
    return null;
  },

  // method of nsIObserver
  observe(subject, topic, data) {
    if (topic === "on-datatransfer-available") {
      this.logger.log(3, "The DataTransfer is available");
      this.filterDataTransferURLs(subject);
    }
  },

  filterDataTransferURLs(aDataTransfer) {
    for (let i = 0, count = aDataTransfer.mozItemCount; i < count; ++i) {
      this.logger.log(3, `Inspecting the data transfer: ${i}.`);
      const types = aDataTransfer.mozTypesAt(i);
      for (const type of types) {
        this.logger.log(3, `Type is: ${type}.`);
        if (
          URLISH_TYPES.includes(type) ||
          ((type === "text/plain" || type === "text/html") &&
            hasURLish(aDataTransfer.getData(type)))
        ) {
          this.logger.log(
            3,
            `Removing transfer data ${aDataTransfer.getData(type)}`
          );
          for (const type of types) {
            aDataTransfer.clearData(type);
          }
          break;
        }
      }
    }
  },
};

// Assign factory to global object.
const NSGetFactory = XPCOMUtils.generateNSGetFactory
  ? XPCOMUtils.generateNSGetFactory([DragDropFilter])
  : ComponentUtils.generateNSGetFactory([DragDropFilter]);
