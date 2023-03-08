/* eslint-env mozilla/browser-window */

/**
 * Data about the current domain and circuit for a xul:browser.
 *
 * @typedef BrowserCircuitData
 * @property {string?} domain - The first party domain.
 * @property {string?} scheme - The scheme.
 * @property {NodeData[]} nodes - The circuit in use for the browser.
 */

var gTorCircuitPanel = {
  /**
   * The panel node.
   *
   * @type {MozPanel}
   */
  panel: null,
  /**
   * The toolbar button that opens the panel.
   *
   * @type {Element}
   */
  toolbarButton: null,
  /**
   * The data for the currently shown browser.
   *
   * @type {BrowserCircuitData?}
   */
  _currentBrowserData: null,
  /**
   * Whether the panel has been initialized and has not yet been uninitialized.
   *
   * @type {bool}
   */
  _isActive: false,

  /**
   * The topic on which circuit changes are broadcast.
   *
   * @type {string}
   */
  TOR_CIRCUIT_TOPIC: "TorCircuitChange",

  /**
   * Initialize the panel.
   */
  init() {
    this._isActive = true;

    const { ConsoleAPI } = ChromeUtils.import(
      "resource://gre/modules/Console.jsm"
    );
    this._log = new ConsoleAPI({
      prefix: "TorCircuitPanel",
      maxLogLevel: "log",
      maxLogLevelPref: "browser.torcircuitpanel.loglevel",
    });

    this.panel = document.getElementById("tor-circuit-panel");
    this._panelElements = {
      heading: document.getElementById("tor-circuit-heading"),
      alias: document.getElementById("tor-circuit-alias"),
      aliasLabel: document.getElementById("tor-circuit-alias-label"),
      aliasLink: document.querySelector("#tor-circuit-alias-label a"),
      aliasMenu: document.getElementById("tor-circuit-panel-alias-menu"),
      list: document.getElementById("tor-circuit-node-list"),
      relaysItem: document.getElementById("tor-circuit-relays-item"),
      endItem: document.getElementById("tor-circuit-end-item"),
      newCircuitDescription: document.getElementById(
        "tor-circuit-new-circuit-description"
      ),
    };
    this.toolbarButton = document.getElementById("tor-circuit-button");

    // TODO: These strings should be set in the HTML markup with fluent.

    // NOTE: There is already whitespace before and after the link from the
    // XHTML markup.
    const [aliasBefore, aliasAfter] = this._getString(
      "torbutton.circuit_display.connected-to-alias",
      // Placeholder is replaced with the same placeholder. This is a bit of a
      // hack since we want the inserted address to be the rich anchor
      // element already in the DOM, rather than a plain address.
      // We won't have to do this with fluent by using data-l10n-name on the
      // anchor element.
      ["%S"]
    ).split("%S");
    this._panelElements.aliasLabel.prepend(aliasBefore);
    this._panelElements.aliasLabel.append(aliasAfter);

    this._panelElements.aliasLink.addEventListener("click", event => {
      event.preventDefault();
      if (event.button !== 0) {
        return;
      }
      this._openAlias("tab");
    });
    this._panelElements.aliasLink.addEventListener("contextmenu", event => {
      event.preventDefault();
      this._panelElements.aliasMenu.openPopupAtScreen(
        event.screenX,
        event.screenY,
        true
      );
    });

    // Commands similar to nsContextMenu.js
    document
      .getElementById("tor-circuit-panel-alias-menu-new-tab")
      .addEventListener("command", () => {
        this._openAlias("tab");
      });
    document
      .getElementById("tor-circuit-panel-alias-menu-new-window")
      .addEventListener("command", () => {
        this._openAlias("window");
      });
    document
      .getElementById("tor-circuit-panel-alias-menu-copy")
      .addEventListener("command", () => {
        if (!this._panelElements.aliasLink.href) {
          return;
        }
        Cc["@mozilla.org/widget/clipboardhelper;1"]
          .getService(Ci.nsIClipboardHelper)
          .copyString(this._panelElements.aliasLink.href);
      });

    document.getElementById("tor-circuit-start-item").textContent =
      this._getString("torbutton.circuit_display.this_browser");

    this._panelElements.relaysItem.textContent = this._getString(
      "torbutton.circuit_display.onion-site-relays"
    );

    // Button is a xul:toolbarbutton, so we use "command" rather than "click".
    document
      .getElementById("tor-circuit-new-circuit")
      .addEventListener("command", () => {
        TorDomainIsolator.newCircuitForBrowser(gBrowser);
      });

    // Update the display just before opening.
    this.panel.addEventListener("popupshowing", event => {
      if (event.target !== this.panel) {
        return;
      }
      this._updateCircuitPanel();
    });

    // Set the initial focus to the panel element itself, which has been made a
    // focusable target. Similar to dialogs, or webextension-popup-browser.
    this.panel.addEventListener("popupshown", event => {
      if (event.target !== this.panel) {
        return;
      }
      this.panel.focus();
    });

    // this.toolbarButton follows "identity-button" markup, so is a <xul:box>
    // rather than a <html:button>, or <xul:toolbarbutton>, so we need to set up
    // listeners for both "click" and "keydown", and not for "command".
    this.toolbarButton.addEventListener("keydown", event => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      event.stopPropagation();
      this.show();
    });
    this.toolbarButton.addEventListener("click", event => {
      event.stopPropagation();
      if (event.button !== 0) {
        return;
      }
      this.show();
    });

    this._locationListener = {
      onLocationChange: (webProgress, request, locationURI, flags) => {
        if (
          webProgress.isTopLevel &&
          !(flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT)
        ) {
          // We have switched tabs or finished loading a new page, this can hide
          // the toolbar button if the new page has no circuit.
          this._updateCurrentBrowser();
        }
      },
    };
    // Notified of new locations for the currently selected browser (tab) *and*
    // switching selected browser.
    gBrowser.addProgressListener(this._locationListener);

    // Get notifications for circuit changes.
    Services.obs.addObserver(this, this.TOR_CIRCUIT_TOPIC);
  },

  /**
   * Uninitialize the panel.
   */
  uninit() {
    this._isActive = false;
    gBrowser.removeProgressListener(this._locationListener);
    Services.obs.removeObserver(this, this.TOR_CIRCUIT_TOPIC);
  },

  /**
   * Observe circuit changes.
   */
  observe(subject, topic, data) {
    if (topic === this.TOR_CIRCUIT_TOPIC) {
      // TODO: Maybe check if we actually need to do something earlier.
      this._updateCurrentBrowser();
    }
  },

  /**
   * Show the circuit panel.
   *
   * This should only be called if the toolbar button is visible.
   */
  show() {
    this.panel.openPopup(this.toolbarButton, "bottomleft topleft", 0, 0);
  },

  /**
   * Hide the circuit panel.
   */
  hide() {
    this.panel.hidePopup();
  },

  /**
   * Open the onion alias present in the alias link.
   *
   * @param {"window"|"tab"} where - Whether to open in a new tab or a new
   *   window.
   */
  _openAlias(where) {
    if (!this._panelElements.aliasLink.href) {
      return;
    }
    // We hide the panel before opening the link.
    this.hide();
    window.openWebLinkIn(this._panelElements.aliasLink.href, where);
  },

  /**
   * A list of schemes to never show the circuit display for.
   *
   * NOTE: Some of these pages may still have remote content within them, so
   * will still use tor circuits. But it doesn't make much sense to show the
   * circuit for the page itself.
   *
   * @type {string[]}
   */
  // FIXME: Check if we find a UX to handle some of these cases, and if we
  // manage to solve some technical issues.
  // See tor-browser#41700 and tor-browser!699.
  _ignoredSchemes: ["about", "file", "chrome", "resource"],

  /**
   * Update the current circuit and domain data for the currently selected
   * browser, possibly changing the UI.
   */
  _updateCurrentBrowser() {
    const browser = gBrowser.selectedBrowser;
    const domain = TorDomainIsolator.getDomainForBrowser(browser);
    const nodes = TorDomainIsolator.getCircuit(
      browser,
      domain,
      browser.contentPrincipal.originAttributes.userContextId
    );
    // We choose the currentURI, which matches what is shown in the URL bar and
    // will match up with the domain.
    // In contrast, documentURI corresponds to the shown page. E.g. it could
    // point to "about:certerror".
    let scheme = browser.currentURI?.scheme;
    if (scheme === "about" && browser.currentURI?.filePath === "reader") {
      const searchParams = new URLSearchParams(browser.currentURI.query);
      if (searchParams.has("url")) {
        try {
          const uri = Services.io.newURI(searchParams.get("url"));
          scheme = uri.scheme;
        } catch (err) {
          this._log.error(err);
        }
      }
    }

    if (
      this._currentBrowserData &&
      this._currentBrowserData.domain === domain &&
      this._currentBrowserData.scheme === scheme &&
      this._currentBrowserData.nodes.length === nodes.length &&
      // If non-null, the fingerprints of the nodes match.
      (!nodes ||
        nodes.every(
          (n, index) =>
            n.fingerprint === this._currentBrowserData.nodes[index].fingerprint
        ))
    ) {
      // No change.
      this._log.debug(
        "Skipping browser update because the data is already up to date."
      );
      return;
    }

    this._currentBrowserData = { domain, scheme, nodes };
    this._log.debug("Updating current browser.", this._currentBrowserData);

    if (
      // Schemes where we always want to hide the display.
      this._ignoredSchemes.includes(scheme) ||
      // Can't show the display without a domain. Don't really expect this
      // outside of "about" pages.
      !domain ||
      // As a fall back, we do not show the circuit for new pages which have no
      // circuit nodes (yet).
      // FIXME: Have a back end that handles this instead, and can tell us
      // whether the circuit is being established, even if the path details are
      // unknown right now. See tor-browser#41700.
      !nodes.length
    ) {
      // Only show the Tor circuit if we have credentials and node data.
      this._log.debug("No circuit found for current document.");
      // Make sure we close the popup.
      if (
        this.panel.contains(document.activeElement) ||
        this.toolbarButton.contains(document.activeElement)
      ) {
        // Focus is about to be lost.
        // E.g. navigating back to a page without a circuit with Alt+ArrowLeft
        // whilst the popup is open, or focus on the toolbar button.
        // By default when the panel closes after being opened with a keyboard,
        // focus will move back to the toolbar button. But we are about to hide
        // the toolbar button, and ToolbarKeyboardNavigator does not currently
        // handle re-assigning focus when the current item is hidden or removed.
        // See bugzilla bug 1823664.
        // Without editing ToolbarKeyboardNavigator, it is difficult to
        // re-assign focus to the next focusable item, so as a compromise we
        // focus the URL bar, which is close by.
        gURLBar.focus();
      }
      this.hide();
      this.toolbarButton.hidden = true;
      return;
    }

    this.toolbarButton.hidden = false;

    if (this.panel.state !== "open" && this.panel.state !== "showing") {
      // Don't update the panel content if it is not open or about to open.
      return;
    }

    this._updateCircuitPanel();
  },

  /**
   * Get the tor onion address alias for the given domain.
   *
   * @returns {string} The alias domain, or null if it has no alias.
   */
  _getOnionAlias(domain) {
    let alias = null;
    try {
      const service = Cc["@torproject.org/onion-alias-service;1"].getService(
        Ci.IOnionAliasService
      );
      alias = service.getOnionAlias(domain);
    } catch (e) {
      this._log.error(
        `Cannot verify if we are visiting an onion alias: ${e.message}`
      );
      return null;
    }
    if (alias === domain) {
      return null;
    }
    return alias;
  },

  /**
   * Get a string from the properties bundle.
   *
   * @param {string} name - The string name.
   * @param {string[]} args - The arguments to pass to the string.
   *
   * @returns {string} The string.
   */
  _getString(name, args = []) {
    if (!this._stringBundle) {
      this._stringBundle = Services.strings.createBundle(
        "chrome://torbutton/locale/torbutton.properties"
      );
    }
    try {
      return this._stringBundle.formatStringFromName(name, args);
    } catch {}
    if (!this._fallbackStringBundle) {
      this._fallbackStringBundle = Services.strings.createBundle(
        "resource://torbutton/locale/en-US/torbutton.properties"
      );
    }
    return this._fallbackStringBundle.formatStringFromName(name, args);
  },

  /**
   * Updates the circuit display in the panel to show the current browser data.
   */
  _updateCircuitPanel() {
    // NOTE: The _currentBrowserData.nodes data may be stale. In particular, the
    // circuit may have expired already, or we're still waiting on the new
    // circuit.
    if (
      !this._currentBrowserData?.domain ||
      !this._currentBrowserData?.nodes.length
    ) {
      // Unexpected since the toolbar button should be hidden in this case.
      this._log.warn(
        "Hiding panel since we have no domain, or no circuit data."
      );
      this.hide();
      return;
    }
    let domain = this._currentBrowserData.domain;
    const onionAlias = this._getOnionAlias(domain);

    this._updateHeading(domain, onionAlias, this._currentBrowserData.scheme);

    if (onionAlias) {
      // Show the circuit ending with the alias instead.
      domain = onionAlias;
    }
    this._updateBody(this._currentBrowserData.nodes, domain);
  },

  /**
   * Update the display of the heading to show the given domain.
   *
   * @param {string} domain - The domain to show.
   * @param {string?} onionAlias - The onion alias address for this domain, if
   *   it has one.
   * @param {string?} scheme - The scheme in use for the current domain.
   */
  _updateHeading(domain, onionAlias, scheme) {
    this._panelElements.heading.textContent = this._getString(
      "torbutton.circuit_display.heading",
      // Only shorten the onion domain if it has no alias.
      [TorUIUtils.shortenOnionAddress(domain)]
    );

    if (onionAlias) {
      this._panelElements.aliasLink.textContent =
        TorUIUtils.shortenOnionAddress(onionAlias);
      if (scheme === "http" || scheme === "https") {
        // We assume the same scheme as the current page for the alias, which we
        // expect to be either http or https.
        // NOTE: The href property is partially presentational so that the link
        // location appears on hover.
        this._panelElements.aliasLink.href = `${scheme}://${onionAlias}`;
      } else {
        this._panelElements.aliasLink.removeAttribute("href");
      }
      this._showPanelElement(this._panelElements.alias, true);
    } else {
      this._showPanelElement(this._panelElements.alias, false);
    }
  },

  /**
   * The currently shown circuit node items.
   *
   * @type {HTMLLIElement[]}
   */
  _nodeItems: [],

  /**
   * Update the display of the circuit body.
   *
   * @param {NodeData[]} nodes - The non-empty circuit nodes to show.
   * @param {string} domain - The domain to show for the last node.
   */
  _updateBody(nodes, domain) {
    // Clean up old items.
    // NOTE: We do not expect focus within a removed node.
    for (const nodeItem of this._nodeItems) {
      nodeItem.remove();
    }

    this._nodeItems = nodes.map((nodeData, index) => {
      const nodeItem = this._createCircuitNodeItem(nodeData, index === 0);
      this._panelElements.list.insertBefore(
        nodeItem,
        this._panelElements.relaysItem
      );
      return nodeItem;
    });

    this._showPanelElement(
      this._panelElements.relaysItem,
      domain.endsWith(".onion")
    );

    // Set the address that we want to copy.
    this._panelElements.endItem.textContent =
      TorUIUtils.shortenOnionAddress(domain);

    // Button description text, depending on whether our first node was a
    // bridge, or otherwise a guard.
    this._panelElements.newCircuitDescription.value = this._getString(
      nodes[0].bridgeType === null
        ? "torbutton.circuit_display.new-circuit-guard-description"
        : "torbutton.circuit_display.new-circuit-bridge-description"
    );
  },

  /**
   * Create a node item for the given circuit node data.
   *
   * @param {NodeData} node - The circuit node data to create an item for.
   * @param {bool} isCircuitStart - Whether this is the first node in the
   *   circuit.
   */
  _createCircuitNodeItem(node, isCircuitStart) {
    let nodeName;
    // We do not show a flag for bridge nodes.
    let regionCode = null;
    if (node.bridgeType === null) {
      regionCode = node.regionCode;
      if (!regionCode) {
        nodeName = this._getString("torbutton.circuit_display.unknown_region");
      } else {
        nodeName = Services.intl.getRegionDisplayNames(undefined, [
          regionCode,
        ])[0];
      }
      if (isCircuitStart) {
        nodeName = this._getString(
          "torbutton.circuit_display.region-guard-node",
          [nodeName]
        );
      }
    } else {
      let bridgeType = node.bridgeType;
      if (bridgeType === "meek_lite") {
        bridgeType = "meek";
      } else if (bridgeType === "vanilla") {
        bridgeType = "";
      }
      if (bridgeType) {
        nodeName = this._getString(
          "torbutton.circuit_display.tor_typed_bridge",
          [bridgeType]
        );
      } else {
        nodeName = this._getString("torbutton.circuit_display.tor_bridge");
      }
    }
    const nodeItem = document.createElement("li");
    nodeItem.classList.add("tor-circuit-node-item");

    const regionFlagEl = this._regionFlag(regionCode);
    if (regionFlagEl) {
      nodeItem.append(regionFlagEl);
    }

    // Add whitespace after name for the addresses.
    nodeItem.append(nodeName + " ");

    if (node.ipAddrs) {
      const addressesEl = document.createElement("span");
      addressesEl.classList.add("tor-circuit-addresses");
      let firstAddr = true;
      for (const ip of node.ipAddrs) {
        if (firstAddr) {
          firstAddr = false;
        } else {
          addressesEl.append(", ");
        }
        // We use a <code> element to give screen readers a hint that
        // punctuation is different for IP addresses.
        const ipEl = document.createElement("code");
        // TODO: Current HTML-aam 1.0 specs map the <code> element to the "code"
        // role.
        // However, mozilla-central commented out this mapping in
        // accessible/base/HTMLMarkupMap.h because the HTML-aam specs at the
        // time did not do this.
        // See hg.mozilla.org/mozilla-central/rev/51eebe7d6199#l2.12
        // For now we explicitly add the role="code", but once this is fixed
        // from mozilla-central we should remove this.
        ipEl.setAttribute("role", "code");
        ipEl.classList.add("tor-circuit-ip-address");
        ipEl.textContent = ip;
        addressesEl.append(ipEl);
      }
      nodeItem.append(addressesEl);
    }

    return nodeItem;
  },

  /**
   * Convert a region code into an emoji flag sequence.
   *
   * @param {string?} regionCode - The code to convert. It should be an upper
   *   case 2-letter BCP47 Region subtag to be converted into a flag.
   *
   * @returns {HTMLImgElement?} The emoji flag img, or null if there is no flag.
   */
  _regionFlag(regionCode) {
    if (!regionCode?.match(/^[A-Z]{2}$/)) {
      return null;
    }
    // Convert the regionCode into an emoji flag sequence.
    const regionalIndicatorA = 0x1f1e6;
    const flagName = [
      regionalIndicatorA + (regionCode.codePointAt(0) - 65),
      regionalIndicatorA + (regionCode.codePointAt(1) - 65),
    ]
      .map(cp => cp.toString(16))
      .join("-");

    const flagEl = document.createElement("img");
    // Decorative.
    flagEl.alt = "";
    flagEl.classList.add("tor-circuit-region-flag");
    // Remove self if there is no matching flag found.
    flagEl.addEventListener(
      "error",
      () => {
        flagEl.classList.add("no-region-flag-src");
      },
      { once: true }
    );
    flagEl.src = `chrome://browser/content/tor-circuit-flags/${flagName}.svg`;
    return flagEl;
  },

  /**
   * Show or hide an element.
   *
   * Handles moving focus if it is contained within the element.
   *
   * @param {Element} element - The element to show or hide.
   * @param {bool} show - Whether to show the element.
   */
  _showPanelElement(element, show) {
    if (!show && element.contains(document.activeElement)) {
      // Move focus to the panel, otherwise it will be lost to the top-level.
      this.panel.focus();
    }
    element.hidden = !show;
  },
};
