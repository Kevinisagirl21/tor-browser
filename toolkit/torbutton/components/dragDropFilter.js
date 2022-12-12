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
XPCOMUtils.defineLazyGlobalGetters(this, ["crypto"]);

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

const MAIN_PROCESS =
  Services.appinfo.processType === Services.appinfo.PROCESS_TYPE_DEFAULT;

const EMPTY_PAYLOAD = {};
const OpaqueDrag = {
  listening: false,
  payload: EMPTY_PAYLOAD,
  store(value, type) {
    let opaqueKey = crypto.randomUUID();
    this.payload = { opaqueKey, value, type };
    if (!this.listening && MAIN_PROCESS) {
      Services.ppmm.addMessageListener(
        "DragDropFilter:GetOpaqueDrag",
        () => this.payload
      );
      this.listening = true;
    }
    return opaqueKey;
  },
  retrieve(key) {
    let { opaqueKey, value, type } = this.payload;
    if (opaqueKey === key) {
      return { value, type };
    }
    if (!MAIN_PROCESS) {
      this.payload = Services.cpmm.sendSyncMessage(
        "DragDropFilter:GetOpaqueDrag"
      )[0];
      if (key === this.payload.opaqueKey) {
        return this.retrieve(key);
      }
    }
    return EMPTY_PAYLOAD;
  },
};

function DragDropFilter() {
  this.logger = Cc["@torproject.org/torbutton-logger;1"].getService(
    Ci.nsISupports
  ).wrappedJSObject;
  this.logger.log(3, "Component Load 0: New DragDropFilter.");
  if (MAIN_PROCESS) {
    // We want to update our status in the main process only, in order to
    // serve the same opaque drag payload in every process.
    try {
      Services.obs.addObserver(this, "on-datatransfer-available");
    } catch (e) {
      this.logger.log(5, "Failed to register drag observer");
    }
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
      const urlType = "text/x-moz-url";
      // Fallback url type, to be parsed by this browser but not externally
      const INTERNAL_FALLBACK = "application/x-torbrowser-opaque";
      if (types.contains(urlType)) {
        const links = aDataTransfer.mozGetDataAt(urlType, i);
        // Skip DNS-safe URLs (no hostname, e.g. RFC 3966 tel:)
        const mayLeakDNS = links.split("\n").some(link => {
          try {
            return new URL(link).hostname;
          } catch (e) {
            return false;
          }
        });
        if (!mayLeakDNS) {
          continue;
        }
        const opaqueKey = OpaqueDrag.store(links, urlType);
        aDataTransfer.mozSetDataAt(INTERNAL_FALLBACK, opaqueKey, i);
      }
      for (const type of types) {
        this.logger.log(3, `Type is: ${type}.`);
        if (URLISH_TYPES.includes(type)) {
          this.logger.log(
            3,
            `Removing transfer data ${aDataTransfer.mozGetDataAt(type, i)}`
          );
          for (const type of types) {
            if (
              type !== INTERNAL_FALLBACK &&
              type !== "text/x-moz-place" &&    // don't touch bookmarks
              type !== "application/x-moz-file" // don't touch downloads
            ) {
              aDataTransfer.mozClearDataAt(type, i);
            }
          }
          break;
        }
      }
    }
  },

  opaqueDrag: {
    get(opaqueKey) {
      return OpaqueDrag.retrieve(opaqueKey);
    },
  },
};

// Assign factory to global object.
const NSGetFactory = XPCOMUtils.generateNSGetFactory
  ? XPCOMUtils.generateNSGetFactory([DragDropFilter])
  : ComponentUtils.generateNSGetFactory([DragDropFilter]);
