// Copyright (c) 2020, The Tor Project, Inc.

"use strict";

var EXPORTED_SYMBOLS = ["OnionLocationChild"];

class OnionLocationChild extends JSWindowActorChild {
  handleEvent(event) {
    this.onPageShow(event);
  }

  onPageShow(event) {
    if (event.target != this.document) {
      return;
    }
    const onionLocationURI = this.document.onionLocationURI;
    if (onionLocationURI) {
      this.sendAsyncMessage("OnionLocation:Set");
    }
  }

  receiveMessage(aMessage) {
    if (aMessage.name == "OnionLocation:Refresh") {
      const doc = this.document;
      const docShell = this.docShell;
      const onionLocationURI = doc.onionLocationURI;
      const refreshURI = docShell.QueryInterface(Ci.nsIRefreshURI);
      if (onionLocationURI && refreshURI) {
        refreshURI.refreshURI(
          onionLocationURI,
          doc.nodePrincipal,
          0,
          false,
          true
        );
      }
    }
  }
}
