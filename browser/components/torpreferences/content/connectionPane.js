"use strict";

/* global Services, gSubDialog */

const { setTimeout, clearTimeout } = ChromeUtils.import(
  "resource://gre/modules/Timer.jsm"
);

const {
  TorSettings,
  TorSettingsTopics,
  TorSettingsData,
  TorBridgeSource,
} = ChromeUtils.import("resource:///modules/TorSettings.jsm");

const { TorProtocolService } = ChromeUtils.import(
  "resource:///modules/TorProtocolService.jsm"
);

const {
  TorConnect,
  TorConnectTopics,
  TorConnectState,
  TorCensorshipLevel,
} = ChromeUtils.import("resource:///modules/TorConnect.jsm");

const { TorLogDialog } = ChromeUtils.import(
  "chrome://browser/content/torpreferences/torLogDialog.jsm"
);

const { ConnectionSettingsDialog } = ChromeUtils.import(
  "chrome://browser/content/torpreferences/connectionSettingsDialog.jsm"
);

const { BridgeQrDialog } = ChromeUtils.import(
  "chrome://browser/content/torpreferences/bridgeQrDialog.jsm"
);

const { BuiltinBridgeDialog } = ChromeUtils.import(
  "chrome://browser/content/torpreferences/builtinBridgeDialog.jsm"
);

const { RequestBridgeDialog } = ChromeUtils.import(
  "chrome://browser/content/torpreferences/requestBridgeDialog.jsm"
);

const { ProvideBridgeDialog } = ChromeUtils.import(
  "chrome://browser/content/torpreferences/provideBridgeDialog.jsm"
);

const { MoatRPC } = ChromeUtils.import("resource:///modules/Moat.jsm");

const { QRCode } = ChromeUtils.import("resource://gre/modules/QRCode.jsm");

ChromeUtils.defineModuleGetter(
  this,
  "TorStrings",
  "resource:///modules/TorStrings.jsm"
);

const InternetStatus = Object.freeze({
  Unknown: 0,
  Online: 1,
  Offline: -1,
});

/*
  Connection Pane

  Code for populating the XUL in about:preferences#connection, handling input events, interfacing with tor-launcher
*/
const gConnectionPane = (function() {
  /* CSS selectors for all of the Tor Network DOM elements we need to access */
  const selectors = {
    category: {
      title: "label#torPreferences-labelCategory",
    },
    messageBox: {
      box: "div#torPreferences-connectMessageBox",
      message: "td#torPreferences-connectMessageBox-message",
      button: "button#torPreferences-connectMessageBox-button",
    },
    torPreferences: {
      header: "h1#torPreferences-header",
      description: "span#torPreferences-description",
      learnMore: "label#torPreferences-learnMore",
    },
    status: {
      internetLabel: "#torPreferences-status-internet-label",
      internetTest: "#torPreferences-status-internet-test",
      internetIcon: "#torPreferences-status-internet-statusIcon",
      internetStatus: "#torPreferences-status-internet-status",
      torLabel: "#torPreferences-status-tor-label",
      torIcon: "#torPreferences-status-tor-statusIcon",
      torStatus: "#torPreferences-status-tor-status",
    },
    quickstart: {
      header: "h2#torPreferences-quickstart-header",
      description: "span#torPreferences-quickstart-description",
      enableQuickstartCheckbox: "checkbox#torPreferences-quickstart-toggle",
    },
    bridges: {
      header: "h1#torPreferences-bridges-header",
      description: "span#torPreferences-bridges-description",
      learnMore: "label#torPreferences-bridges-learnMore",
      locationGroup: "#torPreferences-bridges-locationGroup",
      locationLabel: "#torPreferences-bridges-locationLabel",
      location: "#torPreferences-bridges-location",
      locationEntries: "#torPreferences-bridges-locationEntries",
      chooseForMe: "#torPreferences-bridges-buttonChooseBridgeForMe",
      currentHeader: "#torPreferences-currentBridges-header",
      currentHeaderText: "#torPreferences-currentBridges-headerText",
      switch: "#torPreferences-currentBridges-switch",
      cards: "#torPreferences-currentBridges-cards",
      cardTemplate: "#torPreferences-bridgeCard-template",
      card: ".torPreferences-bridgeCard",
      cardId: ".torPreferences-bridgeCard-id",
      cardHeadingAddr: ".torPreferences-bridgeCard-headingAddr",
      cardConnectedLabel: ".torPreferences-bridgeCard-connectedLabel",
      cardOptions: ".torPreferences-bridgeCard-options",
      cardMenu: "#torPreferences-bridgeCard-menu",
      cardQrGrid: ".torPreferences-bridgeCard-grid",
      cardQrContainer: ".torPreferences-bridgeCard-qr",
      cardQr: ".torPreferences-bridgeCard-qrCode",
      cardShare: ".torPreferences-bridgeCard-share",
      cardAddr: ".torPreferences-bridgeCard-addr",
      cardLearnMore: ".torPreferences-bridgeCard-learnMore",
      cardCopy: ".torPreferences-bridgeCard-copyButton",
      showAll: "#torPreferences-currentBridges-showAll",
      removeAll: "#torPreferences-currentBridges-removeAll",
      addHeader: "#torPreferences-addBridge-header",
      addBuiltinLabel: "#torPreferences-addBridge-labelBuiltinBridge",
      addBuiltinButton: "#torPreferences-addBridge-buttonBuiltinBridge",
      requestLabel: "#torPreferences-addBridge-labelRequestBridge",
      requestButton: "#torPreferences-addBridge-buttonRequestBridge",
      enterLabel: "#torPreferences-addBridge-labelEnterBridge",
      enterButton: "#torPreferences-addBridge-buttonEnterBridge",
    },
    advanced: {
      header: "h1#torPreferences-advanced-header",
      label: "#torPreferences-advanced-label",
      button: "#torPreferences-advanced-button",
      torLogsLabel: "label#torPreferences-torLogs",
      torLogsButton: "button#torPreferences-buttonTorLogs",
    },
  }; /* selectors */

  let retval = {
    // cached frequently accessed DOM elements
    _enableQuickstartCheckbox: null,

    _internetStatus: InternetStatus.Unknown,

    _controller: null,

    _currentBridge: "",

    // disables the provided list of elements
    _setElementsDisabled(elements, disabled) {
      for (let currentElement of elements) {
        currentElement.disabled = disabled;
      }
    },

    // populate xul with strings and cache the relevant elements
    _populateXUL() {
      // saves tor settings to disk when navigate away from about:preferences
      window.addEventListener("blur", val => {
        TorProtocolService.flushSettings();
      });

      document
        .querySelector(selectors.category.title)
        .setAttribute("value", TorStrings.settings.categoryTitle);

      let prefpane = document.getElementById("mainPrefPane");

      // 'Connect to Tor' Message Bar

      const messageBox = prefpane.querySelector(selectors.messageBox.box);
      const messageBoxMessage = prefpane.querySelector(
        selectors.messageBox.message
      );
      const messageBoxButton = prefpane.querySelector(
        selectors.messageBox.button
      );
      // wire up connect button
      messageBoxButton.addEventListener("click", () => {
        TorConnect.beginBootstrap();
        TorConnect.openTorConnect();
      });

      this._populateMessagebox = () => {
        if (
          TorConnect.shouldShowTorConnect &&
          TorConnect.state === TorConnectState.Configuring
        ) {
          // set messagebox style and text
          if (TorProtocolService.torBootstrapErrorOccurred()) {
            messageBox.parentNode.style.display = null;
            messageBox.className = "error";
            messageBoxMessage.innerText = TorStrings.torConnect.tryAgainMessage;
            messageBoxButton.innerText = TorStrings.torConnect.tryAgain;
          } else {
            messageBox.parentNode.style.display = null;
            messageBox.className = "warning";
            messageBoxMessage.innerText = TorStrings.torConnect.connectMessage;
            messageBoxButton.innerText = TorStrings.torConnect.torConnectButton;
          }
        } else {
          // we need to explicitly hide the groupbox, as switching between
          // the tor pane and other panes will 'unhide' (via the 'hidden'
          // attribute) the groupbox, offsetting all of the content down
          // by the groupbox's margin (even if content is 0 height)
          messageBox.parentNode.style.display = "none";
          messageBox.className = "hidden";
          messageBoxMessage.innerText = "";
          messageBoxButton.innerText = "";
        }
      };
      this._populateMessagebox();

      // Heading
      prefpane.querySelector(selectors.torPreferences.header).innerText =
        TorStrings.settings.categoryTitle;
      prefpane.querySelector(selectors.torPreferences.description).textContent =
        TorStrings.settings.torPreferencesDescription;
      {
        let learnMore = prefpane.querySelector(
          selectors.torPreferences.learnMore
        );
        learnMore.setAttribute("value", TorStrings.settings.learnMore);
        learnMore.setAttribute(
          "href",
          TorStrings.settings.learnMoreTorBrowserURL
        );
      }

      // Internet and Tor status
      prefpane.querySelector(selectors.status.internetLabel).textContent =
        TorStrings.settings.statusInternetLabel;
      prefpane.querySelector(selectors.status.torLabel).textContent =
        TorStrings.settings.statusTorLabel;
      const internetTest = prefpane.querySelector(
        selectors.status.internetTest
      );
      internetTest.setAttribute(
        "label",
        TorStrings.settings.statusInternetTest
      );
      internetTest.addEventListener("command", async () => {
        this.onInternetTest();
      });
      const internetIcon = prefpane.querySelector(
        selectors.status.internetIcon
      );
      const internetStatus = prefpane.querySelector(
        selectors.status.internetStatus
      );
      const torIcon = prefpane.querySelector(selectors.status.torIcon);
      const torStatus = prefpane.querySelector(selectors.status.torStatus);
      this._populateStatus = () => {
        switch (this._internetStatus) {
          case InternetStatus.Unknown:
            internetTest.removeAttribute("hidden");
            break;
          case InternetStatus.Online:
            internetTest.setAttribute("hidden", "true");
            internetIcon.className = "online";
            internetStatus.textContent =
              TorStrings.settings.statusInternetOnline;
            break;
          case InternetStatus.Offline:
            internetTest.setAttribute("hidden", "true");
            internetIcon.className = "offline";
            internetStatus.textContent =
              TorStrings.settings.statusInternetOffline;
            break;
        }
        if (TorConnect.state === TorConnectState.Bootstrapped) {
          torIcon.className = "connected";
          torStatus.textContent = TorStrings.settings.statusTorConnected;
        } else if (
          TorConnect.detectedCensorshipLevel > TorCensorshipLevel.None
        ) {
          torIcon.className = "blocked";
          torStatus.textContent = TorStrings.settings.statusTorBlocked;
        } else {
          torIcon.className = "";
          torStatus.textContent = TorStrings.settings.statusTorNotConnected;
        }
      };
      this._populateStatus();

      // Quickstart
      prefpane.querySelector(selectors.quickstart.header).innerText =
        TorStrings.settings.quickstartHeading;
      prefpane.querySelector(selectors.quickstart.description).textContent =
        TorStrings.settings.quickstartDescription;

      this._enableQuickstartCheckbox = prefpane.querySelector(
        selectors.quickstart.enableQuickstartCheckbox
      );
      this._enableQuickstartCheckbox.setAttribute(
        "label",
        TorStrings.settings.quickstartCheckbox
      );
      this._enableQuickstartCheckbox.addEventListener("command", e => {
        const checked = this._enableQuickstartCheckbox.checked;
        TorSettings.quickstart.enabled = checked;
        TorSettings.saveToPrefs().applySettings();
      });
      this._enableQuickstartCheckbox.checked = TorSettings.quickstart.enabled;
      Services.obs.addObserver(this, TorSettingsTopics.SettingChanged);

      // Bridge setup
      prefpane.querySelector(selectors.bridges.header).innerText =
        TorStrings.settings.bridgesHeading;
      prefpane.querySelector(selectors.bridges.description).textContent =
        TorStrings.settings.bridgesDescription;
      {
        let learnMore = prefpane.querySelector(selectors.bridges.learnMore);
        learnMore.setAttribute("value", TorStrings.settings.learnMore);
        learnMore.setAttribute("href", TorStrings.settings.learnMoreBridgesURL);
      }

      // Location
      {
        const locationGroup = prefpane.querySelector(
          selectors.bridges.locationGroup
        );
        prefpane.querySelector(selectors.bridges.locationLabel).textContent =
          TorStrings.settings.bridgeLocation;
        const location = prefpane.querySelector(selectors.bridges.location);
        const locationEntries = prefpane.querySelector(
          selectors.bridges.locationEntries
        );
        const chooseForMe = prefpane.querySelector(
          selectors.bridges.chooseForMe
        );
        chooseForMe.setAttribute(
          "label",
          TorStrings.settings.bridgeChooseForMe
        );
        chooseForMe.addEventListener("command", e => {
          TorConnect.beginAutoBootstrap(location.value);
        });
        this._populateLocations = () => {
          let value = location.value;
          locationEntries.textContent = "";

          {
            const item = document.createXULElement("menuitem");
            item.setAttribute("value", "");
            item.setAttribute(
              "label",
              TorStrings.settings.bridgeLocationAutomatic
            );
            locationEntries.appendChild(item);
          }

          const codes = TorConnect.countryCodes;
          const items = codes.map(code => {
            const item = document.createXULElement("menuitem");
            item.setAttribute("value", code);
            item.setAttribute(
              "label",
              TorConnect.countryNames[code]
                ? TorConnect.countryNames[code]
                : code
            );
            return item;
          });
          items.sort((left, right) =>
            left.textContent.localeCompare(right.textContent)
          );
          locationEntries.append(...items);
          location.value = value;
        };
        this._showAutoconfiguration = () => {
          if (
            !TorConnect.shouldShowTorConnect ||
            !TorProtocolService.torBootstrapErrorOccurred()
          ) {
            locationGroup.setAttribute("hidden", "true");
            return;
          }
          // Populate locations, even though we will show only the automatic
          // item for a moment. In my opinion showing the button immediately is
          // better then waiting for the Moat query to finish (after a while)
          // and showing the controls only after that.
          this._populateLocations();
          locationGroup.removeAttribute("hidden");
          if (!TorConnect.countryCodes.length) {
            TorConnect.getCountryCodes().then(() => this._populateLocations());
          }
        };
        this._showAutoconfiguration();
      }

      // Bridge cards
      const bridgeHeader = prefpane.querySelector(
        selectors.bridges.currentHeader
      );
      bridgeHeader.querySelector(
        selectors.bridges.currentHeaderText
      ).textContent = TorStrings.settings.bridgeCurrent;
      const bridgeSwitch = bridgeHeader.querySelector(selectors.bridges.switch);
      bridgeSwitch.addEventListener("change", () => {
        TorSettings.bridges.enabled = bridgeSwitch.checked;
        TorSettings.saveToPrefs();
        TorSettings.applySettings().then(result => {
          this._populateBridgeCards();
        });
      });
      const bridgeTemplate = prefpane.querySelector(
        selectors.bridges.cardTemplate
      );
      {
        const learnMore = bridgeTemplate.querySelector(
          selectors.bridges.cardLearnMore
        );
        learnMore.setAttribute("value", TorStrings.settings.learnMore);
        learnMore.setAttribute("href", "about:blank");
      }
      bridgeTemplate.querySelector(
        selectors.bridges.cardConnectedLabel
      ).textContent = TorStrings.settings.statusTorConnected;
      bridgeTemplate
        .querySelector(selectors.bridges.cardCopy)
        .setAttribute("label", TorStrings.settings.bridgeCopy);
      bridgeTemplate.querySelector(selectors.bridges.cardShare).textContent =
        TorStrings.settings.bridgeShare;
      const bridgeCards = prefpane.querySelector(selectors.bridges.cards);
      const bridgeMenu = prefpane.querySelector(selectors.bridges.cardMenu);

      this._addBridgeCard = bridgeString => {
        const card = bridgeTemplate.cloneNode(true);
        card.removeAttribute("id");
        const grid = card.querySelector(selectors.bridges.cardQrGrid);
        card.addEventListener("click", e => {
          let target = e.target;
          let apply = true;
          while (target !== null && target !== card && apply) {
            // Deal with mixture of "command" and "click" events
            apply = !target.classList?.contains("stop-click");
            target = target.parentElement;
          }
          if (apply) {
            if (card.classList.toggle("expanded")) {
              grid.classList.add("to-animate");
              grid.style.height = `${grid.scrollHeight}px`;
            } else {
              // Be sure we still have the to-animate class
              grid.classList.add("to-animate");
              grid.style.height = "";
            }
          }
        });
        const emojis = makeBridgeId(bridgeString).map(e => {
          const span = document.createElement("span");
          span.className = "emoji";
          span.textContent = e;
          return span;
        });
        const idString = TorStrings.settings.bridgeId;
        const id = card.querySelector(selectors.bridges.cardId);
        const details = parseBridgeLine(bridgeString);
        if (details && details.id !== undefined) {
          card.setAttribute("data-bridge-id", details.id);
        }
        // TODO: properly handle "vanilla" bridges?
        const type =
          details && details.transport !== undefined
            ? details.transport
            : "vanilla";
        for (const piece of idString.split(/(#[12])/)) {
          if (piece == "#1") {
            id.append(type);
          } else if (piece == "#2") {
            id.append(...emojis);
          } else {
            id.append(piece);
          }
        }
        card.querySelector(
          selectors.bridges.cardHeadingAddr
        ).textContent = bridgeString;
        const optionsButton = card.querySelector(selectors.bridges.cardOptions);
        if (TorSettings.bridges.source === TorBridgeSource.BuiltIn) {
          optionsButton.setAttribute("hidden", "true");
        } else {
          // Cloning the menupopup element does not work as expected.
          // Therefore, we use only one, and just before opening it, we remove
          // its previous items, and add the ones relative to the bridge whose
          // button has been pressed.
          optionsButton.addEventListener("click", () => {
            const menuItem = document.createXULElement("menuitem");
            menuItem.setAttribute("label", TorStrings.settings.remove);
            menuItem.classList.add("menuitem-iconic");
            menuItem.image = "chrome://global/skin/icons/delete.svg";
            menuItem.addEventListener("command", e => {
              const strings = TorSettings.bridges.bridge_strings;
              const index = strings.indexOf(bridgeString);
              if (index !== -1) {
                strings.splice(index, 1);
              }
              TorSettings.bridges.enabled =
                bridgeSwitch.checked && !!strings.length;
              TorSettings.bridges.bridge_strings = strings.join("\n");
              TorSettings.saveToPrefs();
              TorSettings.applySettings().then(result => {
                this._populateBridgeCards();
              });
            });
            if (bridgeMenu.firstChild) {
              bridgeMenu.firstChild.remove();
            }
            bridgeMenu.append(menuItem);
            bridgeMenu.openPopup(optionsButton, {
              position: "bottomleft topleft",
            });
          });
        }
        const bridgeAddr = card.querySelector(selectors.bridges.cardAddr);
        bridgeAddr.setAttribute("value", bridgeString);
        const bridgeCopy = card.querySelector(selectors.bridges.cardCopy);
        let restoreTimeout = null;
        bridgeCopy.addEventListener("command", e => {
          this.onCopyBridgeAddress(bridgeAddr);
          const label = bridgeCopy.querySelector("label");
          label.setAttribute("value", TorStrings.settings.copied);
          bridgeCopy.classList.add("primary");

          const RESTORE_TIME = 1200;
          if (restoreTimeout !== null) {
            clearTimeout(restoreTimeout);
          }
          restoreTimeout = setTimeout(() => {
            label.setAttribute("value", TorStrings.settings.bridgeCopy);
            bridgeCopy.classList.remove("primary");
            restoreTimeout = null;
          }, RESTORE_TIME);
        });
        if (details && details.id === this._currentBridge) {
          card.classList.add("currently-connected");
          bridgeCards.prepend(card);
        } else {
          bridgeCards.append(card);
        }
        // Add the QR only after appending the card, to have the computed style
        try {
          const container = card.querySelector(selectors.bridges.cardQr);
          const style = getComputedStyle(container);
          const width = style.width.substr(0, style.width.length - 2);
          const height = style.height.substr(0, style.height.length - 2);
          new QRCode(container, {
            text: bridgeString,
            width,
            height,
            colorDark: style.color,
            colorLight: style.backgroundColor,
            document,
          });
          container.parentElement.addEventListener("click", () => {
            this.onShowQr(bridgeString);
          });
        } catch (err) {
          // TODO: Add a generic image in case of errors such as code overflow.
          // It should never happen with correct codes, but after all this
          // content can be generated by users...
          console.error("Could not generate the QR code for the bridge:", err);
        }
      };
      this._checkBridgeCardsHeight = () => {
        for (const card of bridgeCards.children) {
          // Expanded cards have the height set manually to their details for
          // the CSS animation. However, when resizing the window, we may need
          // to adjust their height.
          if (card.classList.contains("expanded")) {
            const grid = card.querySelector(selectors.bridges.cardQrGrid);
            // Reset it first, to avoid having a height that is higher than
            // strictly needed. Also, remove the to-animate class, because the
            // animation interferes with this process!
            grid.classList.remove("to-animate");
            grid.style.height = "";
            grid.style.height = `${grid.scrollHeight}px`;
          }
        }
      };
      this._currentBridgesExpanded = false;
      const showAll = prefpane.querySelector(selectors.bridges.showAll);
      showAll.setAttribute("label", TorStrings.settings.bridgeShowAll);
      showAll.addEventListener("command", () => {
        this._currentBridgesExpanded = true;
        this._populateBridgeCards();
      });
      const removeAll = prefpane.querySelector(selectors.bridges.removeAll);
      removeAll.setAttribute("label", TorStrings.settings.bridgeRemoveAll);
      removeAll.addEventListener("command", () => {
        this.onRemoveAllBridges();
      });
      this._populateBridgeCards = async () => {
        const collapseThreshold = 4;

        let newStrings = new Set(TorSettings.bridges.bridge_strings);
        const numBridges = newStrings.size;
        if (!newStrings.size) {
          bridgeHeader.setAttribute("hidden", "true");
          bridgeCards.setAttribute("hidden", "true");
          showAll.setAttribute("hidden", "true");
          removeAll.setAttribute("hidden", "true");
          bridgeCards.textContent = "";
          return;
        }
        bridgeHeader.removeAttribute("hidden");
        bridgeCards.removeAttribute("hidden");
        bridgeSwitch.checked = TorSettings.bridges.enabled;
        bridgeCards.classList.toggle("disabled", !TorSettings.bridges.enabled);

        let shownCards = 0;
        const toShow = this._currentBridgesExpanded
          ? numBridges
          : collapseThreshold;

        // Do not remove all the old cards, because it makes scrollbar "jump"
        const currentCards = bridgeCards.querySelectorAll(
          selectors.bridges.card
        );
        for (const card of currentCards) {
          const string = card.querySelector(selectors.bridges.cardAddr).value;
          const hadString = newStrings.delete(string);
          if (!hadString || shownCards == toShow) {
            card.remove();
          } else {
            shownCards++;
          }
        }

        // Add only the new strings that remained in the set
        for (const bridge of newStrings) {
          if (shownCards >= toShow) {
            if (this._currentBridge === "") {
              break;
            } else if (!bridge.includes(this._currentBridge)) {
              continue;
            }
          }
          this._addBridgeCard(bridge);
          shownCards++;
        }

        // If we know the connected bridge, we may have added more than the ones
        // we should actually show (but the connected ones have been prepended,
        // if needed). So, remove any exceeding ones.
        while (shownCards > toShow) {
          bridgeCards.lastElementChild.remove();
          shownCards--;
        }

        // And finally update the buttons
        if (numBridges > collapseThreshold && !this._currentBridgesExpanded) {
          showAll.removeAttribute("hidden");
          if (TorSettings.bridges.enabled) {
            showAll.classList.add("primary");
          } else {
            showAll.classList.remove("primary");
          }
          removeAll.setAttribute("hidden", "true");
          if (TorSettings.bridges.enabled) {
            // We do not want both collapsed and disabled at the same time,
            // because we use collapsed only to display a gradient on the list.
            bridgeCards.classList.add("list-collapsed");
          }
        } else {
          showAll.setAttribute("hidden", "true");
          removeAll.removeAttribute("hidden");
          bridgeCards.classList.remove("list-collapsed");
        }
      };
      this._populateBridgeCards();
      this._updateConnectedBridges = () => {
        for (const card of bridgeCards.querySelectorAll(
          ".currently-connected"
        )) {
          card.classList.remove("currently-connected");
        }
        if (this._currentBridge === "") {
          return;
        }
        // Make sure we have the connected bridge in the list
        this._populateBridgeCards();
        // At the moment, IDs do not have to be unique (and it is a concrete
        // case also with built-in bridges!). E.g., one line for the IPv4
        // address and one for the IPv6 address, so use querySelectorAll
        const cards = bridgeCards.querySelectorAll(
          `[data-bridge-id="${this._currentBridge}"]`
        );
        for (const card of cards) {
          card.classList.add("currently-connected");
        }
        const placeholder = document.createElement("span");
        bridgeCards.prepend(placeholder);
        placeholder.replaceWith(...cards);
      };
      try {
        const { controller } = ChromeUtils.import(
          "resource://torbutton/modules/tor-control-port.js",
          {}
        );
        // Avoid the cache because we set our custom event watcher, and at the
        // moment, watchers cannot be removed from a controller.
        controller(true).then(aController => {
          this._controller = aController;
          // Getting the circuits may be enough, if we have bootstrapped for a
          // while, but at the beginning it gives many bridges as connected,
          // because tor pokes all the bridges to find the best one.
          // Also, watching circuit events does not work, at the moment, but in
          // any case, checking the stream has the advantage that we can see if
          // it really used for a connection, rather than tor having created
          // this circuit to check if the bridge can be used. We do this by
          // checking if the stream has SOCKS username, which actually contains
          // the destination of the stream.
          this._controller.watchEvent(
            "STREAM",
            event =>
              event.StreamStatus === "SUCCEEDED" && "SOCKS_USERNAME" in event,
            async event => {
              const circuitStatuses = await this._controller.getInfo(
                "circuit-status"
              );
              if (!circuitStatuses) {
                return;
              }
              for (const status of circuitStatuses) {
                if (status.id === event.CircuitID && status.circuit.length) {
                  // The id in the circuit begins with a $ sign
                  const bridgeId = status.circuit[0][0].substr(1);
                  if (bridgeId !== this._currentBridge) {
                    this._currentBridge = bridgeId;
                    this._updateConnectedBridges();
                  }
                  break;
                }
              }
            }
          );
        });
      } catch (err) {
        console.warn(
          "We could not load torbutton, bridge statuses will not be updated",
          err
        );
      }

      // Add a new bridge
      prefpane.querySelector(selectors.bridges.addHeader).textContent =
        TorStrings.settings.bridgeAdd;
      prefpane
        .querySelector(selectors.bridges.addBuiltinLabel)
        .setAttribute("value", TorStrings.settings.bridgeSelectBrowserBuiltin);
      {
        let button = prefpane.querySelector(selectors.bridges.addBuiltinButton);
        button.setAttribute("label", TorStrings.settings.bridgeSelectBuiltin);
        button.addEventListener("command", e => {
          this.onAddBuiltinBridge();
        });
      }
      prefpane
        .querySelector(selectors.bridges.requestLabel)
        .setAttribute("value", TorStrings.settings.bridgeRequestFromTorProject);
      {
        let button = prefpane.querySelector(selectors.bridges.requestButton);
        button.setAttribute("label", TorStrings.settings.bridgeRequest);
        button.addEventListener("command", e => {
          this.onRequestBridge();
        });
      }
      prefpane
        .querySelector(selectors.bridges.enterLabel)
        .setAttribute("value", TorStrings.settings.bridgeEnterKnown);
      {
        const button = prefpane.querySelector(selectors.bridges.enterButton);
        button.setAttribute("label", TorStrings.settings.bridgeAddManually);
        button.addEventListener("command", e => {
          this.onAddBridgeManually();
        });
      }

      Services.obs.addObserver(this, TorConnectTopics.StateChange);

      // Advanced setup
      prefpane.querySelector(selectors.advanced.header).innerText =
        TorStrings.settings.advancedHeading;
      prefpane.querySelector(selectors.advanced.label).textContent =
        TorStrings.settings.advancedLabel;
      {
        let settingsButton = prefpane.querySelector(selectors.advanced.button);
        settingsButton.setAttribute(
          "label",
          TorStrings.settings.advancedButton
        );
        settingsButton.addEventListener("command", () => {
          this.onAdvancedSettings();
        });
      }

      // Tor logs
      prefpane
        .querySelector(selectors.advanced.torLogsLabel)
        .setAttribute("value", TorStrings.settings.showTorDaemonLogs);
      let torLogsButton = prefpane.querySelector(
        selectors.advanced.torLogsButton
      );
      torLogsButton.setAttribute("label", TorStrings.settings.showLogs);
      torLogsButton.addEventListener("command", () => {
        this.onViewTorLogs();
      });
    },

    init() {
      this._populateXUL();

      let onUnload = () => {
        window.removeEventListener("unload", onUnload);
        gConnectionPane.uninit();
      };
      window.addEventListener("unload", onUnload);

      window.addEventListener("resize", () => {
        this._checkBridgeCardsHeight();
      });
    },

    uninit() {
      // unregister our observer topics
      Services.obs.removeObserver(this, TorSettingsTopics.SettingChanged);
      Services.obs.removeObserver(this, TorConnectTopics.StateChange);

      if (this._controller !== null) {
        this._controller.close();
        this._controller = null;
      }
    },

    // whether the page should be present in about:preferences
    get enabled() {
      return TorProtocolService.ownsTorDaemon;
    },

    //
    // Callbacks
    //

    observe(subject, topic, data) {
      switch (topic) {
        // triggered when a TorSettings param has changed
        case TorSettingsTopics.SettingChanged: {
          let obj = subject?.wrappedJSObject;
          switch (data) {
            case TorSettingsData.QuickStartEnabled: {
              this._enableQuickstartCheckbox.checked = obj.value;
              break;
            }
          }
          break;
        }
        // triggered when tor connect state changes and we may
        // need to update the messagebox
        case TorConnectTopics.StateChange: {
          this.onStateChange();
          break;
        }
      }
    },

    async onInternetTest() {
      const mrpc = new MoatRPC();
      let status = null;
      try {
        await mrpc.init();
        status = await mrpc.testInternetConnection();
      } catch (err) {
        console.log("Error while checking the Internet connection", err);
      } finally {
        mrpc.uninit();
      }
      if (status) {
        this._internetStatus = status.successful
          ? InternetStatus.Online
          : InternetStatus.Offline;
        this._populateStatus();
      }
    },

    onStateChange() {
      this._populateMessagebox();
      this._populateStatus();
      this._showAutoconfiguration();
      this._populateBridgeCards();
    },

    onShowQr(bridgeString) {
      const dialog = new BridgeQrDialog();
      dialog.openDialog(gSubDialog, bridgeString);
    },

    onCopyBridgeAddress(addressElem) {
      let clipboard = Cc["@mozilla.org/widget/clipboardhelper;1"].getService(
        Ci.nsIClipboardHelper
      );
      clipboard.copyString(addressElem.value);
    },

    onRemoveAllBridges() {
      TorSettings.bridges.enabled = false;
      TorSettings.bridges.bridge_strings = "";
      TorSettings.saveToPrefs();
      TorSettings.applySettings().then(result => {
        this._populateBridgeCards();
      });
    },

    onAddBuiltinBridge() {
      let builtinBridgeDialog = new BuiltinBridgeDialog();

      let sizeObserver = null;
      {
        let ds = document.querySelector("#dialogStack");
        let boxObserver;
        boxObserver = new MutationObserver(() => {
          let dialogBox = document.querySelector(".dialogBox");
          if (dialogBox) {
            sizeObserver = new MutationObserver(mutations => {
              for (const m of mutations) {
                if (m.attributeName === "style") {
                  builtinBridgeDialog.resized();
                  break;
                }
              }
            });
            sizeObserver.observe(dialogBox, { attributes: true });
            boxObserver.disconnect();
          }
        });
        boxObserver.observe(ds, { childList: true, subtree: true });
      }

      builtinBridgeDialog.openDialog(gSubDialog, aBridgeType => {
        sizeObserver.disconnect();

        if (!aBridgeType) {
          TorSettings.bridges.enabled = false;
          TorSettings.bridges.builtin_type = "";
        } else {
          TorSettings.bridges.enabled = true;
          TorSettings.bridges.source = TorBridgeSource.BuiltIn;
          TorSettings.bridges.builtin_type = aBridgeType;
        }
        TorSettings.saveToPrefs();
        TorSettings.applySettings().then(result => {
          this._populateBridgeCards();
        });
      });
    },

    // called when the request bridge button is activated
    onRequestBridge() {
      let requestBridgeDialog = new RequestBridgeDialog();
      requestBridgeDialog.openDialog(gSubDialog, aBridges => {
        if (aBridges.length) {
          let bridgeStrings = aBridges.join("\n");
          TorSettings.bridges.enabled = true;
          TorSettings.bridges.source = TorBridgeSource.BridgeDB;
          TorSettings.bridges.bridge_strings = bridgeStrings;
          TorSettings.saveToPrefs();
          TorSettings.applySettings().then(result => {
            this._populateBridgeCards();
          });
        } else {
          TorSettings.bridges.enabled = false;
        }
      });
    },

    onAddBridgeManually() {
      let provideBridgeDialog = new ProvideBridgeDialog();
      provideBridgeDialog.openDialog(gSubDialog, aBridgeString => {
        if (aBridgeString.length) {
          TorSettings.bridges.enabled = true;
          TorSettings.bridges.source = TorBridgeSource.UserProvided;
          TorSettings.bridges.bridge_strings = aBridgeString;
          TorSettings.saveToPrefs();
          TorSettings.applySettings().then(result => {
            this._populateBridgeCards();
          });
        } else {
          TorSettings.bridges.enabled = false;
          TorSettings.bridges.source = TorBridgeSource.Invalid;
        }
      });
    },

    onAdvancedSettings() {
      let connectionSettingsDialog = new ConnectionSettingsDialog();
      connectionSettingsDialog.openDialog(gSubDialog);
    },

    onViewTorLogs() {
      let torLogDialog = new TorLogDialog();
      torLogDialog.openDialog(gSubDialog);
    },
  };
  return retval;
})(); /* gConnectionPane */

function makeBridgeId(bridgeString) {
  // JS uses UTF-16. While most of these emojis are surrogate pairs, a few
  // ones fit one UTF-16 character. So we could not use neither indices,
  // nor substr, nor some function to split the string.
  const emojis = [
    "😄️",
    "😒️",
    "😉",
    "😭️",
    "😂️",
    "😎️",
    "🤩️",
    "😘",
    "😜️",
    "😏️",
    "😷",
    "🤢",
    "🤕",
    "🤧",
    "🥵",
    "🥶",
    "🥴",
    "😵️",
    "🤮️",
    "🤑",
    "🤔",
    "🫢",
    "🤐",
    "😮‍💨",
    "😐",
    "🤤",
    "😴",
    "🤯",
    "🤠",
    "🥳",
    "🥸",
    "🤓",
    "🧐",
    "😨",
    "😳",
    "🥺",
    "🤬",
    "😈",
    "👿",
    "💀",
    "💩",
    "🤡",
    "👺",
    "👻",
    "👽",
    "🦴",
    "🤖",
    "😸",
    "🙈",
    "🙉",
    "🙊",
    "💋",
    "💖",
    "💯",
    "💢",
    "💧",
    "💨",
    "💭",
    "💤",
    "👋",
    "👌",
    "✌",
    "👍",
    "👎",
    "🤛",
    "🙌",
    "💪",
    "🙏",
    "✍",
    "🧠",
    "👀",
    "👂",
    "👅",
    "🦷",
    "🐾",
    "🐶",
    "🦊",
    "🦝",
    "🐈",
    "🦁",
    "🐯",
    "🐴",
    "🦄",
    "🦓",
    "🐮",
    "🐷",
    "🐑",
    "🐪",
    "🐘",
    "🐭",
    "🐰",
    "🦔",
    "🦇",
    "🐻",
    "🐨",
    "🐼",
    "🐔",
    "🦨",
    "🦘",
    "🐦",
    "🐧",
    "🦩",
    "🦉",
    "🦜",
    "🪶",
    "🐸",
    "🐊",
    "🐢",
    "🦎",
    "🐍",
    "🦖",
    "🦀",
    "🐬",
    "🐙",
    "🐌",
    "🐝",
    "🐞",
    "🌸",
    "🌲",
    "🌵",
    "🍀",
    "🍁",
    "🍇",
    "🍉",
    "🍊",
    "🍋",
    "🍌",
    "🍍",
    "🍎",
    "🥥",
    "🍐",
    "🍒",
    "🍓",
    "🫐",
    "🥝",
    "🥔",
    "🥕",
    "🧅",
    "🌰",
    "🍄",
    "🍞",
    "🥞",
    "🧀",
    "🍖",
    "🍔",
    "🍟",
    "🍕",
    "🥚",
    "🍿",
    "🧂",
    "🍙",
    "🍦",
    "🍩",
    "🍪",
    "🎂",
    "🍬",
    "🍭",
    "🥛",
    "☕",
    "🫖",
    "🍾",
    "🍷",
    "🍹",
    "🍺",
    "🍴",
    "🥄",
    "🫙",
    "🧭",
    "🌋",
    "🪵",
    "🏡",
    "🏢",
    "🏰",
    "⛲",
    "⛺",
    "🎡",
    "🚂",
    "🚘",
    "🚜",
    "🚲",
    "🚔",
    "🚨",
    "⛽",
    "🚥",
    "🚧",
    "⚓",
    "⛵",
    "🛟",
    "🪂",
    "🚀",
    "⌛",
    "⏰",
    "🌂",
    "🌞",
    "🌙",
    "🌟",
    "⛅",
    "⚡",
    "🔥",
    "🌊",
    "🎃",
    "🎈",
    "🎉",
    "✨",
    "🎀",
    "🎁",
    "🏆",
    "🏅",
    "🔮",
    "🪄",
    "🎾",
    "🎳",
    "🎲",
    "🎭",
    "🎨",
    "🧵",
    "🎩",
    "📢",
    "🔔",
    "🎵",
    "🎤",
    "🎧",
    "🎷",
    "🎸",
    "🥁",
    "🔋",
    "🔌",
    "💻",
    "💾",
    "💿",
    "🎬",
    "📺",
    "📷",
    "🎮",
    "🧩",
    "🔍",
    "💡",
    "📖",
    "💰",
    "💼",
    "📈",
    "📌",
    "📎",
    "🔒",
    "🔑",
    "🔧",
    "🪛",
    "🔩",
    "🧲",
    "🔬",
    "🔭",
    "📡",
    "🚪",
    "🪑",
    "⛔",
    "🚩",
  ];

  // FNV-1a implementation that is compatible with other languages
  const prime = 0x01000193;
  const offset = 0x811c9dc5;
  let hash = offset;
  const encoder = new TextEncoder();
  for (const charCode of encoder.encode(bridgeString)) {
    hash = Math.imul(hash ^ charCode, prime);
  }

  const hashBytes = [
    ((hash & 0x7f000000) >> 24) | (hash < 0 ? 0x80 : 0),
    (hash & 0x00ff0000) >> 16,
    (hash & 0x0000ff00) >> 8,
    hash & 0x000000ff,
  ];
  return hashBytes.map(b => emojis[b]);
}

function parseBridgeLine(line) {
  const re = /^([^\s]+\s+)?([0-9a-fA-F\.\[\]\:]+:[0-9]{1,5})\s*([0-9a-fA-F]{40})(\s+.+)?/;
  const matches = line.match(re);
  if (!matches) {
    return null;
  }
  let bridge = { addr: matches[2] };
  if (matches[1] !== undefined) {
    bridge.transport = matches[1].trim();
  }
  if (matches[3] !== undefined) {
    bridge.id = matches[3].toUpperCase();
  }
  if (matches[4] !== undefined) {
    bridge.args = matches[4].trim();
  }
  return bridge;
}
