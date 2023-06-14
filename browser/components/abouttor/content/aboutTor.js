/*************************************************************************
 * Copyright (c) 2023, The Tor Project, Inc.
 * See LICENSE for licensing information.
 *
 * vim: set sw=2 sts=2 ts=8 et syntax=javascript:
 *************************************************************************/

const AboutTorListener = {
  init() {
    window.addEventListener("ChromeData", this.onChromeData.bind(this));
    window.addEventListener("LocaleData", this.onLocaleData.bind(this));
  },

  onChromeData(e) {
    const body = document.body;
    const data = e.detail;

    // Update status: tor on/off, Tor Browser manual shown.
    if (data.torOn) {
      body.setAttribute("toron", "yes");
    } else {
      body.removeAttribute("toron");
    }

    if (data.updateChannel) {
      body.setAttribute("updatechannel", data.updateChannel);
    } else {
      body.removeAttribute("updatechannel");
    }

    if (data.hasBeenUpdated) {
      body.setAttribute("hasbeenupdated", "yes");
      document
        .getElementById("update-infolink")
        .setAttribute("href", data.updateMoreInfoURL);
    }

    // Setting body.initialized="yes" displays the body.
    body.setAttribute("initialized", "yes");
  },

  onLocaleData(e) {
    const { locale, productInfo } = e.detail;
    // Set localized "Get Involved" link.
    document.getElementById(
      "getInvolvedLink"
    ).href = `https://community.torproject.org/${locale}`;

    // Display the Tor Browser product name and version.
    document.getElementById("torbrowser-version").textContent = productInfo;
  },
};

AboutTorListener.init();
