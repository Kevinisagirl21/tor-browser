/* eslint-env mozilla/browser-window */

/**
 * Stores the data associated with a circuit node.
 *
 * @typedef NodeData
 * @property {string[]} ipAddrs - The ip addresses associated with this node.
 * @property {string?} bridgeType - The bridge type for this node, or "" if the
 *   node is a bridge but the type is unknown, or null if this is not a bridge
 *   node.
 * @property {string?} regionCode - An upper case 2-letter ISO3166-1 code for
 *   the first ip address, or null if there is no region. This should also be a
 *   valid BCP47 Region subtag.
 */

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
   * A list of IDs for "mature" circuits (those that have conveyed a stream).
   *
   * @type {string[]}
   */
  _knownCircuitIDs: [],
  /**
   * Stores the circuit nodes for each SOCKS username/password pair. The keys
   * are of the form "<username>|<password>".
   *
   * @type {Map<string, NodeData[]>}
   */
  _credentialsToCircuitNodes: new Map(),
  /**
   * Browser data for their currently shown page.
   *
   * This data may be stale for a given browser since we only update this data
   * when loading a new page in the currently selected browser, when switching
   * tabs, or if we find a new circuit for the current browser.
   *
   * @type {WeakMap<MozBrowser, BrowserCircuitData>}
   */
  _browserData: new WeakMap(),
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

    const { wait_for_controller } = ChromeUtils.import(
      "resource://torbutton/modules/tor-control-port.js"
    );
    wait_for_controller().then(
      controller => {
        if (!this._isActive) {
          // uninit() was called before resolution.
          return;
        }
        // FIXME: We should be using some dedicated integrated back end to
        // store circuit information, rather than collecting it all here in the
        // front end. See tor-browser#41700.
        controller.watchEvent(
          "STREAM",
          streamEvent => streamEvent.StreamStatus === "SENTCONNECT",
          streamEvent => this._collectCircuit(controller, streamEvent)
        );
      },
      error => {
        this._log.error(
          `Not collecting circuits because of an error: ${error.message}`
        );
      }
    );

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

    document.getElementById(
      "tor-circuit-start-item"
    ).textContent = this._getString("torbutton.circuit_display.this_browser");

    this._panelElements.relaysItem.textContent = this._getString(
      "torbutton.circuit_display.onion-site-relays"
    );

    // Button is a xul:toolbarbutton, so we use "command" rather than "click".
    document
      .getElementById("tor-circuit-new-circuit")
      .addEventListener("command", () => {
        torbutton_new_circuit();
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
  },

  /**
   * Uninitialize the panel.
   */
  uninit() {
    this._isActive = false;
    gBrowser.removeProgressListener(this._locationListener);
  },

  /**
   * Show the circuit panel.
   *
   * This should only be called if the toolbar button is visible.
   */
  show() {
    this.panel.openPopup(this.toolbarButton, "bottomcenter topleft", 0, 0);
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
   * Collect circuit data for the found circuits, to be used later for display.
   *
   * @param {controller} controller - The tor controller.
   * @param {object} streamEvent - The streamEvent for the new circuit.
   */
  async _collectCircuit(controller, streamEvent) {
    const id = streamEvent.CircuitID;
    if (this._knownCircuitIDs.includes(id)) {
      return;
    }
    this._log.debug(`New streamEvent.CircuitID: ${id}.`);
    // FIXME: This list grows and is never freed. See tor-browser#41700.
    this._knownCircuitIDs.push(id);
    const circuitStatus = (await controller.getInfo("circuit-status"))?.find(
      circuit => circuit.id === id
    );
    if (!circuitStatus?.SOCKS_USERNAME || !circuitStatus?.SOCKS_PASSWORD) {
      return;
    }
    const nodes = await Promise.all(
      circuitStatus.circuit.map(names =>
        this._nodeDataForCircuit(controller, names)
      )
    );
    // Remove quotes from the strings.
    const username = circuitStatus.SOCKS_USERNAME.replace(/^"(.*)"$/, "$1");
    const password = circuitStatus.SOCKS_PASSWORD.replace(/^"(.*)"$/, "$1");
    const credentials = `${username}|${password}`;
    // FIXME: This map grows and is never freed. We cannot simply request this
    // information when needed because it is no longer available once the
    // circuit is dropped, even if the web page is still displayed.
    // See tor-browser#41700.
    this._credentialsToCircuitNodes.set(credentials, nodes);
    // Update the circuit in case the current page gains a new circuit whilst
    // the popup is still open.
    this._updateCurrentBrowser(credentials);
  },

  /**
   * Fetch the node data for the given circuit node.
   *
   * @param {controller} controller - The tor controller.
   * @param {string[]} circuitNodeNames - The names for the circuit node. Only
   *   the first name, the node id, will be used.
   *
   * @return {NodeData} - The data for this circuit node.
   */
  async _nodeDataForCircuit(controller, circuitNodeNames) {
    // The first "name" in circuitNodeNames is the id.
    // Remove the leading '$' if present.
    const id = circuitNodeNames[0].replace(/^\$/, "");
    let result = { ipAddrs: [], bridgeType: null, regionCode: null };
    const bridge = (await controller.getConf("bridge"))?.find(
      foundBridge => foundBridge.ID?.toUpperCase() === id.toUpperCase()
    );
    const addrRe = /^\[?([^\]]+)\]?:\d+$/;
    if (bridge) {
      result.bridgeType = bridge.type ?? "";
      // Attempt to get an IP address from bridge address string.
      const ip = bridge.address.match(addrRe)?.[1];
      if (ip && !ip.startsWith("0.")) {
        result.ipAddrs.push(ip);
      }
    } else {
      // Either dealing with a relay, or a bridge whose fingerprint is not saved
      // in torrc.
      let statusMap;
      try {
        statusMap = await controller.getInfo("ns/id/" + id);
      } catch {
        // getInfo will throw if the given id is not a relay.
        // This probably means we are dealing with a user-provided bridge with
        // no fingerprint.
        // We don't know the ip/ipv6 or type, so leave blank.
        result.bridgeType = "";
        return result;
      }
      if (statusMap.IP && !statusMap.IP.startsWith("0.")) {
        result.ipAddrs.push(statusMap.IP);
      }
      const ip6 = statusMap.IPv6?.match(addrRe)?.[1];
      if (ip6) {
        result.ipAddrs.push(ip6);
      }
    }
    if (result.ipAddrs.length) {
      // Get the country code for the node's IP address.
      let regionCode;
      try {
        // Expect a 2-letter ISO3166-1 code, which should also be a valid BCP47
        // Region subtag.
        regionCode = await controller.getInfo(
          "ip-to-country/" + result.ipAddrs[0]
        );
      } catch {}
      if (regionCode && regionCode !== "??") {
        result.regionCode = regionCode.toUpperCase();
      }
    }
    return result;
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
  // FIXME: Have a back end that handles this instead. See tor-browser#41700.
  _ignoredSchemes: ["about", "file", "chrome", "resource"],

  /**
   * Update the current circuit and domain data for the currently selected
   * browser, possibly changing the UI.
   *
   * @param {string?} [matchingCredentials=null] - If given, only update the
   *   current browser data if the current browser's credentials match.
   */
  _updateCurrentBrowser(matchingCredentials = null) {
    const browser = gBrowser.selectedBrowser;
    const { getDomainForBrowser } = ChromeUtils.import(
      "resource://torbutton/modules/utils.js"
    );
    const domain = getDomainForBrowser(browser);
    // We choose the currentURI, which matches what is shown in the URL bar and
    // will match up with the domain.
    // In contrast, documentURI corresponds to the shown page. E.g. it could
    // point to "about:certerror".
    const scheme = browser.currentURI?.scheme;

    const domainIsolator = Cc["@torproject.org/domain-isolator;1"].getService(
      Ci.nsISupports
    ).wrappedJSObject;
    let credentials = domainIsolator.getSocksProxyCredentials(
      domain,
      browser.contentPrincipal.originAttributes.userContextId
    );
    if (credentials) {
      credentials = `${credentials.username}|${credentials.password}`;
    }

    if (matchingCredentials && matchingCredentials !== credentials) {
      // This update was triggered by the circuit update for some other browser
      // or process.
      return;
    }

    let nodes = this._credentialsToCircuitNodes.get(credentials) ?? [];

    const prevData = this._browserData.get(browser);
    if (
      prevData &&
      prevData.domain &&
      prevData.domain === domain &&
      prevData.scheme === scheme &&
      prevData.nodes.length &&
      !nodes.length
    ) {
      // Since this is the same domain, for the same browser, and we used to
      // have circuit nodes, we *assume* we are re-generating a circuit. So we
      // keep the old circuit data around for the time being.
      // FIXME: Have a back end that makes this explicit, rather than an
      // assumption. See tor-browser#41700.
      nodes = prevData.nodes;
      this._log.debug(`Keeping old circuit for ${domain}.`);
    }

    this._browserData.set(browser, { domain, scheme, nodes });
    if (
      this._currentBrowserData &&
      this._currentBrowserData.domain === domain &&
      this._currentBrowserData.scheme === scheme &&
      this._currentBrowserData.nodes === nodes
    ) {
      // No change.
      return;
    }

    this._currentBrowserData = this._browserData.get(browser);

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
   * @return {string} The alias domain, or null if it has no alias.
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
   * @return {string} The string.
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
   * Shorten the given address if it is an onion address.
   *
   * @param {string} address - The address to shorten.
   *
   * @return {string} The shortened form of the address, or the address itself
   *   if it was not shortened.
   */
  _shortenOnionAddress(address) {
    if (!address.endsWith(".onion") || address.length <= 22) {
      return address;
    }
    return `${address.slice(0, 7)}…${address.slice(-12)}`;
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
      [onionAlias ? domain : this._shortenOnionAddress(domain)]
    );

    if (onionAlias) {
      this._panelElements.aliasLink.textContent = this._shortenOnionAddress(
        onionAlias
      );
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
    this._panelElements.endItem.textContent = this._shortenOnionAddress(domain);

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
   * @return {HTMLImgElement?} The emoji flag img, or null if there is no flag.
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
