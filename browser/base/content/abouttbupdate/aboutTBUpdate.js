// Copyright (c) 2020, The Tor Project, Inc.
// See LICENSE for licensing information.
//
// vim: set sw=2 sts=2 ts=8 et syntax=javascript:

/* eslint-env mozilla/frame-script */

// aData may contain the following string properties:
//   version
//   releaseDate
//   moreInfoURL
//   releaseNotes
function onUpdate(aData) {
  document.getElementById("version-content").textContent = aData.version;
  if (aData.releaseDate) {
    document.body.setAttribute("havereleasedate", "true");
    document.getElementById("releasedate-content").textContent =
      aData.releaseDate;
  }
  if (aData.moreInfoURL) {
    document.getElementById("infolink").setAttribute("href", aData.moreInfoURL);
  }
  document.getElementById("releasenotes-content").textContent =
    aData.releaseNotes;
}

RPMSendQuery("FetchUpdateData").then(onUpdate);
