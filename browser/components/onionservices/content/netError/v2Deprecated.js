// Copyright (c) 2021, The Tor Project, Inc.

"use strict";

/* eslint-env mozilla/frame-script */

var V2DeprecatedAboutNetError = {

  _selector: {
    header: ".title-text",
    longDesc: "#errorLongDesc",
    learnMoreLink: "#learnMoreLink",
    contentContainer: "#errorLongContent",
    tryAgainButton: "div#netErrorButtonContainer button.try-again",
  },

  initPage(aDoc) {
    this._insertStylesheet(aDoc);
    this._populateStrings(aDoc);
  },

  _populateStrings(aDoc) {
    // populate strings
    const TorStrings = RPMGetTorStrings();

    aDoc.title = TorStrings.v2Deprecated.pageTitle;

    let headerElem = aDoc.querySelector(this._selector.header);
    headerElem.textContent = TorStrings.v2Deprecated.header;

    let longDescriptionElem = aDoc.querySelector(this._selector.longDesc);
    longDescriptionElem.textContent = TorStrings.v2Deprecated.longDescription;

    let learnMoreElem = aDoc.querySelector(this._selector.learnMoreLink);
    learnMoreElem.setAttribute("href", TorStrings.v2Deprecated.learnMoreURL);

    let tryAgainElem = aDoc.querySelector(this._selector.tryAgainButton);
    tryAgainElem.textContent = TorStrings.v2Deprecated.tryAgain;
  },

  _insertStylesheet(aDoc) {
    const url =
      "chrome://browser/content/onionservices/netError/v2Deprecated.css";
    let linkElem = aDoc.createElement("link");
    linkElem.rel = "stylesheet";
    linkElem.href = url;
    linkElem.type = "text/css";
    aDoc.head.appendChild(linkElem);
  },
};
