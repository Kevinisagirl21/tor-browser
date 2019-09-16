// Copyright (c) 2022, The Tor Project, Inc.
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

"use strict";

/* global Services, gSubDialog */

const { setTimeout, clearTimeout } = ChromeUtils.import(
  "resource://gre/modules/Timer.jsm"
);

const { TorSettings, TorSettingsTopics, TorSettingsData, TorBridgeSource } =
  ChromeUtils.importESModule("resource:///modules/TorSettings.sys.mjs");

const { TorParsers } = ChromeUtils.importESModule(
  "resource://gre/modules/TorParsers.sys.mjs"
);
const { TorProviderBuilder, TorProviderTopics } = ChromeUtils.importESModule(
  "resource://gre/modules/TorProviderBuilder.sys.mjs"
);

const { TorConnect, TorConnectTopics, TorConnectState, TorCensorshipLevel } =
  ChromeUtils.importESModule("resource:///modules/TorConnect.sys.mjs");

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

const { MoatRPC } = ChromeUtils.importESModule(
  "resource:///modules/Moat.sys.mjs"
);

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
const gConnectionPane = (function () {
  /* CSS selectors for all of the Tor Network DOM elements we need to access */
  const selectors = {
    category: {
      title: "label#torPreferences-labelCategory",
    },
    torPreferences: {
      header: "h1#torPreferences-header",
      description: "span#torPreferences-description",
      learnMore: "label#torPreferences-learnMore",
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
      currentDescription: "#torPreferences-currentBridges-description",
      currentDescriptionText: "#torPreferences-currentBridges-descriptionText",
      controls: "#torPreferences-currentBridges-controls",
      switch: "#torPreferences-currentBridges-switch",
      cards: "#torPreferences-currentBridges-cards",
      cardTemplate: "#torPreferences-bridgeCard-template",
      card: ".torPreferences-bridgeCard",
      cardId: ".torPreferences-bridgeCard-id",
      cardHeadingManualLink: ".torPreferences-bridgeCard-manualLink",
      cardHeadingAddr: ".torPreferences-bridgeCard-headingAddr",
      cardConnectedLabel: ".torPreferences-current-bridge-label",
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

  const retval = {
    // cached frequently accessed DOM elements
    _enableQuickstartCheckbox: null,

    _internetStatus: InternetStatus.Unknown,

    _currentBridgeId: null,

    // populate xul with strings and cache the relevant elements
    _populateXUL() {
      // saves tor settings to disk when navigate away from about:preferences
      window.addEventListener("blur", async () => {
        try {
          // Build a new provider each time because this might be called also
          // when closing the browser (if about:preferences was open), maybe
          // when the provider was already uninitialized.
          const provider = await TorProviderBuilder.build();
          provider.flushSettings();
        } catch (e) {
          console.warn("Could not save the tor settings.", e);
        }
      });

      document
        .querySelector(selectors.category.title)
        .setAttribute("value", TorStrings.settings.categoryTitle);

      const prefpane = document.getElementById("mainPrefPane");

      // Heading
      prefpane.querySelector(selectors.torPreferences.header).innerText =
        TorStrings.settings.categoryTitle;
      prefpane.querySelector(selectors.torPreferences.description).textContent =
        TorStrings.settings.torPreferencesDescription;
      {
        const learnMore = prefpane.querySelector(
          selectors.torPreferences.learnMore
        );
        learnMore.setAttribute("value", TorStrings.settings.learnMore);
        learnMore.setAttribute(
          "href",
          TorStrings.settings.learnMoreTorBrowserURL
        );
        if (TorStrings.settings.learnMoreTorBrowserURL.startsWith("about:")) {
          learnMore.setAttribute("useoriginprincipal", "true");
        }
      }

      // Internet and Tor status
      const internetStatus = document.getElementById(
        "torPreferences-status-internet"
      );
      internetStatus.querySelector(".torPreferences-status-name").textContent =
        TorStrings.settings.statusInternetLabel;
      const internetResult = internetStatus.querySelector(
        ".torPreferences-status-result"
      );
      const internetTest = document.getElementById(
        "torPreferences-status-internet-test"
      );
      internetTest.setAttribute(
        "label",
        TorStrings.settings.statusInternetTest
      );
      internetTest.addEventListener("command", () => {
        this.onInternetTest();
      });

      const torConnectStatus = document.getElementById(
        "torPreferences-status-tor-connect"
      );
      torConnectStatus.querySelector(
        ".torPreferences-status-name"
      ).textContent = TorStrings.settings.statusTorLabel;
      const torConnectResult = torConnectStatus.querySelector(
        ".torPreferences-status-result"
      );
      const torConnectButton = document.getElementById(
        "torPreferences-status-tor-connect-button"
      );
      torConnectButton.setAttribute(
        "label",
        TorStrings.torConnect.torConnectButton
      );
      torConnectButton.addEventListener("command", () => {
        TorConnect.openTorConnect({ beginBootstrap: true });
      });

      this._populateStatus = () => {
        switch (this._internetStatus) {
          case InternetStatus.Online:
            internetStatus.classList.remove("offline");
            internetResult.textContent =
              TorStrings.settings.statusInternetOnline;
            internetResult.hidden = false;
            break;
          case InternetStatus.Offline:
            internetStatus.classList.add("offline");
            internetResult.textContent =
              TorStrings.settings.statusInternetOffline;
            internetResult.hidden = false;
            break;
          case InternetStatus.Unknown:
          default:
            internetStatus.classList.remove("offline");
            internetResult.hidden = true;
            break;
        }
        // FIXME: What about the TorConnectState.Disabled state?
        if (TorConnect.state === TorConnectState.Bootstrapped) {
          torConnectStatus.classList.add("connected");
          torConnectStatus.classList.remove("blocked");
          torConnectResult.textContent = TorStrings.settings.statusTorConnected;
          // NOTE: If the button is focused when we hide it, the focus may be
          // lost. But we don't have an obvious place to put the focus instead.
          torConnectButton.hidden = true;
        } else {
          torConnectStatus.classList.remove("connected");
          torConnectStatus.classList.toggle(
            "blocked",
            TorConnect.potentiallyBlocked
          );
          torConnectResult.textContent = TorConnect.potentiallyBlocked
            ? TorStrings.settings.statusTorBlocked
            : TorStrings.settings.statusTorNotConnected;
          torConnectButton.hidden = false;
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
        TorStrings.settings.bridgesDescription2;
      {
        const learnMore = prefpane.querySelector(selectors.bridges.learnMore);
        learnMore.setAttribute("value", TorStrings.settings.learnMore);
        learnMore.setAttribute("href", TorStrings.settings.learnMoreBridgesURL);
        if (TorStrings.settings.learnMoreBridgesURL.startsWith("about:")) {
          learnMore.setAttribute("useoriginprincipal", "true");
        }
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
          TorConnect.openTorConnect({
            beginAutoBootstrap: location.value,
          });
        });
        this._populateLocations = () => {
          const currentValue = location.value;
          locationEntries.textContent = "";
          const createItem = (value, label, disabled) => {
            const item = document.createXULElement("menuitem");
            item.setAttribute("value", value);
            item.setAttribute("label", label);
            if (disabled) {
              item.setAttribute("disabled", "true");
            }
            return item;
          };
          const addLocations = codes => {
            const items = [];
            for (const code of codes) {
              items.push(
                createItem(
                  code,
                  TorConnect.countryNames[code]
                    ? TorConnect.countryNames[code]
                    : code
                )
              );
            }
            items.sort((left, right) => left.label.localeCompare(right.label));
            locationEntries.append(...items);
          };
          locationEntries.append(
            createItem("", TorStrings.settings.bridgeLocationAutomatic)
          );
          if (TorConnect.countryCodes.length) {
            locationEntries.append(
              createItem("", TorStrings.settings.bridgeLocationFrequent, true)
            );
            addLocations(TorConnect.countryCodes);
            locationEntries.append(
              createItem("", TorStrings.settings.bridgeLocationOther, true)
            );
          }
          addLocations(Object.keys(TorConnect.countryNames));
          location.value = currentValue;
        };
        this._showAutoconfiguration = () => {
          if (
            !TorConnect.canBeginAutoBootstrap ||
            !TorConnect.potentiallyBlocked
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
      bridgeHeader.textContent = TorStrings.settings.bridgeCurrent;
      const bridgeControls = prefpane.querySelector(selectors.bridges.controls);
      const bridgeSwitch = prefpane.querySelector(selectors.bridges.switch);
      bridgeSwitch.setAttribute("label", TorStrings.settings.allBridgesEnabled);
      bridgeSwitch.addEventListener("toggle", () => {
        TorSettings.bridges.enabled = bridgeSwitch.pressed;
        TorSettings.saveToPrefs();
        TorSettings.applySettings().finally(() => {
          this._populateBridgeCards();
        });
      });
      const bridgeDescription = prefpane.querySelector(
        selectors.bridges.currentDescription
      );
      bridgeDescription.querySelector(
        selectors.bridges.currentDescriptionText
      ).textContent = TorStrings.settings.bridgeCurrentDescription;
      const bridgeTemplate = prefpane.querySelector(
        selectors.bridges.cardTemplate
      );
      {
        const learnMore = bridgeTemplate.querySelector(
          selectors.bridges.cardLearnMore
        );
        learnMore.setAttribute("value", TorStrings.settings.learnMore);
        learnMore.setAttribute(
          "href",
          TorStrings.settings.learnMoreBridgesCardURL
        );
        if (TorStrings.settings.learnMoreBridgesCardURL.startsWith("about:")) {
          learnMore.setAttribute("useoriginprincipal", "true");
        }
      }
      {
        const manualLink = bridgeTemplate.querySelector(
          selectors.bridges.cardHeadingManualLink
        );
        manualLink.setAttribute("value", TorStrings.settings.whatAreThese);
        manualLink.setAttribute(
          "href",
          TorStrings.settings.learnMoreBridgesCardURL
        );
        if (TorStrings.settings.learnMoreBridgesCardURL.startsWith("about:")) {
          manualLink.setAttribute("useoriginprincipal", "true");
        }
      }
      bridgeTemplate.querySelector(
        selectors.bridges.cardConnectedLabel
      ).textContent = TorStrings.settings.connectedBridge;
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
          if (
            card.classList.contains("currently-connected") ||
            bridgeCards.classList.contains("single-card")
          ) {
            return;
          }
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
        const emojis = makeBridgeId(bridgeString).map(emojiIndex => {
          const img = document.createElement("img");
          img.classList.add("emoji");
          // Image is set in _updateBridgeEmojis.
          img.dataset.emojiIndex = emojiIndex;
          return img;
        });
        const idString = TorStrings.settings.bridgeId;
        const id = card.querySelector(selectors.bridges.cardId);
        let details;
        try {
          details = TorParsers.parseBridgeLine(bridgeString);
        } catch (e) {
          console.error(`Detected invalid bridge line: ${bridgeString}`, e);
        }
        if (details && details.id !== undefined) {
          card.setAttribute("data-bridge-id", details.id);
        }
        // TODO: properly handle "vanilla" bridges?
        const type =
          details && details.transport !== undefined
            ? details.transport
            : "vanilla";
        for (const piece of idString.split(/(%[12]\$S)/)) {
          if (piece == "%1$S") {
            id.append(type);
          } else if (piece == "%2$S") {
            id.append(...emojis);
          } else {
            id.append(piece);
          }
        }
        card.querySelector(selectors.bridges.cardHeadingAddr).textContent =
          bridgeString;
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
                bridgeSwitch.pressed && !!strings.length;
              TorSettings.bridges.bridge_strings = strings.join("\n");
              TorSettings.saveToPrefs();
              TorSettings.applySettings().finally(() => {
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
        if (details?.id && details.id === this._currentBridgeId) {
          card.classList.add("currently-connected");
          bridgeCards.prepend(card);
        } else {
          bridgeCards.append(card);
        }
        // Add the QR only after appending the card, to have the computed style
        try {
          const container = card.querySelector(selectors.bridges.cardQr);
          const style = getComputedStyle(container);
          const width = style.width.substring(0, style.width.length - 2);
          const height = style.height.substring(0, style.height.length - 2);
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
          if (
            card.classList.contains("expanded") ||
            card.classList.contains("currently-connected")
          ) {
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
        this._currentBridgesExpanded = !this._currentBridgesExpanded;
        this._populateBridgeCards();
        if (!this._currentBridgesExpanded) {
          bridgeSwitch.scrollIntoView({ behavior: "smooth" });
        }
      });
      const removeAll = prefpane.querySelector(selectors.bridges.removeAll);
      removeAll.setAttribute("label", TorStrings.settings.bridgeRemoveAll);
      removeAll.addEventListener("command", () => {
        this._confirmBridgeRemoval();
      });
      this._populateBridgeCards = () => {
        const collapseThreshold = 4;

        const newStrings = new Set(TorSettings.bridges.bridge_strings);
        const numBridges = newStrings.size;
        const noBridges = !numBridges;
        bridgeHeader.hidden = noBridges;
        bridgeDescription.hidden = noBridges;
        bridgeControls.hidden = noBridges;
        bridgeCards.hidden = noBridges;
        if (noBridges) {
          showAll.hidden = true;
          removeAll.hidden = true;
          bridgeCards.textContent = "";
          return;
        }
        // Changing the pressed property on moz-toggle should not trigger its
        // "toggle" event.
        bridgeSwitch.pressed = TorSettings.bridges.enabled;
        bridgeCards.classList.toggle("disabled", !TorSettings.bridges.enabled);
        bridgeCards.classList.toggle("single-card", numBridges === 1);

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
            if (!this._currentBridgeId) {
              break;
            } else if (!bridge.includes(this._currentBridgeId)) {
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

        // Newly added emojis.
        this._updateBridgeEmojis();

        // And finally update the buttons
        removeAll.hidden = false;
        showAll.classList.toggle("primary", TorSettings.bridges.enabled);
        if (numBridges > collapseThreshold) {
          showAll.hidden = false;
          showAll.setAttribute(
            "aria-expanded",
            // Boolean value gets converted to string "true" or "false".
            this._currentBridgesExpanded
          );
          showAll.setAttribute(
            "label",
            this._currentBridgesExpanded
              ? TorStrings.settings.bridgeShowFewer
              : TorStrings.settings.bridgeShowAll
          );
          // We do not want both collapsed and disabled at the same time,
          // because we use collapsed only to display a gradient on the list.
          bridgeCards.classList.toggle(
            "list-collapsed",
            !this._currentBridgesExpanded && TorSettings.bridges.enabled
          );
        } else {
          // NOTE: We do not expect the showAll button to have focus when we
          // hide it since we do not expect `numBridges` to decrease whilst
          // this button is focused.
          showAll.hidden = true;
          bridgeCards.classList.remove("list-collapsed");
        }
      };
      this._populateBridgeCards();
      this._updateConnectedBridges = () => {
        for (const card of bridgeCards.querySelectorAll(
          ".currently-connected"
        )) {
          card.classList.remove("currently-connected");
          card.querySelector(selectors.bridges.cardQrGrid).style.height = "";
        }
        if (!this._currentBridgeId) {
          return;
        }
        // Make sure we have the connected bridge in the list
        this._populateBridgeCards();
        // At the moment, IDs do not have to be unique (and it is a concrete
        // case also with built-in bridges!). E.g., one line for the IPv4
        // address and one for the IPv6 address, so use querySelectorAll
        const cards = bridgeCards.querySelectorAll(
          `[data-bridge-id="${this._currentBridgeId}"]`
        );
        for (const card of cards) {
          card.classList.add("currently-connected");
        }
        const placeholder = document.createElement("span");
        bridgeCards.prepend(placeholder);
        placeholder.replaceWith(...cards);
        this._checkBridgeCardsHeight();
      };
      this._checkConnectedBridge = async () => {
        // TODO: We could make sure TorSettings is in sync by monitoring also
        // changes of settings. At that point, we could query it, instead of
        // doing a query over the control port.
        let bridge = null;
        try {
          const provider = await TorProviderBuilder.build();
          bridge = provider.currentBridge;
        } catch (e) {
          console.warn("Could not get current bridge", e);
        }
        if (bridge?.fingerprint !== this._currentBridgeId) {
          this._currentBridgeId = bridge?.fingerprint ?? null;
          this._updateConnectedBridges();
        }
      };
      this._checkConnectedBridge();

      // Add a new bridge
      prefpane.querySelector(selectors.bridges.addHeader).textContent =
        TorStrings.settings.bridgeAdd;
      prefpane.querySelector(selectors.bridges.addBuiltinLabel).textContent =
        TorStrings.settings.bridgeSelectBrowserBuiltin;
      {
        const button = prefpane.querySelector(
          selectors.bridges.addBuiltinButton
        );
        button.setAttribute("label", TorStrings.settings.bridgeSelectBuiltin);
        button.addEventListener("command", e => {
          this.onAddBuiltinBridge();
        });
      }
      prefpane.querySelector(selectors.bridges.requestLabel).textContent =
        TorStrings.settings.bridgeRequestFromTorProject;
      {
        const button = prefpane.querySelector(selectors.bridges.requestButton);
        button.setAttribute("label", TorStrings.settings.bridgeRequest);
        button.addEventListener("command", e => {
          this.onRequestBridge();
        });
      }
      prefpane.querySelector(selectors.bridges.enterLabel).textContent =
        TorStrings.settings.bridgeEnterKnown;
      {
        const button = prefpane.querySelector(selectors.bridges.enterButton);
        button.setAttribute("label", TorStrings.settings.bridgeAddManually);
        button.addEventListener("command", e => {
          this.onAddBridgeManually();
        });
      }

      this._confirmBridgeRemoval = () => {
        const aParentWindow =
          Services.wm.getMostRecentWindow("navigator:browser");

        const ps = Services.prompt;
        const btnFlags =
          ps.BUTTON_POS_0 * ps.BUTTON_TITLE_IS_STRING +
          ps.BUTTON_POS_0_DEFAULT +
          ps.BUTTON_POS_1 * ps.BUTTON_TITLE_CANCEL;

        const notUsed = { value: false };
        const btnIndex = ps.confirmEx(
          aParentWindow,
          TorStrings.settings.bridgeRemoveAllDialogTitle,
          TorStrings.settings.bridgeRemoveAllDialogDescription,
          btnFlags,
          TorStrings.settings.remove,
          null,
          null,
          null,
          notUsed
        );

        if (btnIndex === 0) {
          this.onRemoveAllBridges();
        }
      };

      // Advanced setup
      prefpane.querySelector(selectors.advanced.header).innerText =
        TorStrings.settings.advancedHeading;
      prefpane.querySelector(selectors.advanced.label).textContent =
        TorStrings.settings.advancedLabel;
      {
        const settingsButton = prefpane.querySelector(
          selectors.advanced.button
        );
        settingsButton.setAttribute(
          "label",
          TorStrings.settings.advancedButton
        );
        settingsButton.addEventListener("command", () => {
          this.onAdvancedSettings();
        });
      }

      // Tor logs
      prefpane.querySelector(selectors.advanced.torLogsLabel).textContent =
        TorStrings.settings.showTorDaemonLogs;
      const torLogsButton = prefpane.querySelector(
        selectors.advanced.torLogsButton
      );
      torLogsButton.setAttribute("label", TorStrings.settings.showLogs);
      torLogsButton.addEventListener("command", () => {
        this.onViewTorLogs();
      });

      Services.obs.addObserver(this, TorConnectTopics.StateChange);
      Services.obs.addObserver(this, TorProviderTopics.BridgeChanged);
      Services.obs.addObserver(this, "intl:app-locales-changed");
    },

    init() {
      this._populateXUL();

      const onUnload = () => {
        window.removeEventListener("unload", onUnload);
        gConnectionPane.uninit();
      };
      window.addEventListener("unload", onUnload);

      window.addEventListener("resize", () => {
        this._checkBridgeCardsHeight();
      });
      window.addEventListener("hashchange", () => {
        this._checkBridgeCardsHeight();
      });
    },

    uninit() {
      // unregister our observer topics
      Services.obs.removeObserver(this, TorSettingsTopics.SettingChanged);
      Services.obs.removeObserver(this, TorConnectTopics.StateChange);
      Services.obs.removeObserver(this, TorProviderTopics.BridgeChanged);
      Services.obs.removeObserver(this, "intl:app-locales-changed");
    },

    // whether the page should be present in about:preferences
    get enabled() {
      return TorConnect.enabled;
    },

    //
    // Callbacks
    //

    observe(subject, topic, data) {
      switch (topic) {
        // triggered when a TorSettings param has changed
        case TorSettingsTopics.SettingChanged: {
          const obj = subject?.wrappedJSObject;
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
        case TorProviderTopics.BridgeChanged: {
          if (data?.fingerprint !== this._currentBridgeId) {
            this._checkConnectedBridge();
          }
          break;
        }
        case "intl:app-locales-changed": {
          this._updateBridgeEmojis();
          break;
        }
      }
    },

    /**
     * Update the bridge emojis to show their corresponding emoji with an
     * annotation that matches the current locale.
     */
    async _updateBridgeEmojis() {
      if (!this._emojiPromise) {
        this._emojiPromise = Promise.all([
          fetch(
            "chrome://browser/content/torpreferences/bridgemoji/bridge-emojis.json"
          ).then(response => response.json()),
          fetch(
            "chrome://browser/content/torpreferences/bridgemoji/annotations.json"
          ).then(response => response.json()),
        ]);
      }
      const [emojiList, emojiAnnotations] = await this._emojiPromise;
      let langCode;
      // Find the first desired locale we have annotations for.
      // Add "en" as a fallback.
      for (const bcp47 of [...Services.locale.appLocalesAsBCP47, "en"]) {
        langCode = bcp47;
        if (langCode in emojiAnnotations) {
          break;
        }
        // Remove everything after the dash, if there is one.
        langCode = bcp47.replace(/-.*/, "");
        if (langCode in emojiAnnotations) {
          break;
        }
      }
      for (const img of document.querySelectorAll(".emoji[data-emoji-index]")) {
        const emoji = emojiList[img.dataset.emojiIndex];
        if (!emoji) {
          // Unexpected.
          console.error(`No emoji for index ${img.dataset.emojiIndex}`);
          img.removeAttribute("src");
          img.removeAttribute("alt");
          img.removeAttribute("title");
          continue;
        }
        const cp = emoji.codePointAt(0).toString(16);
        img.setAttribute(
          "src",
          `chrome://browser/content/torpreferences/bridgemoji/svgs/${cp}.svg`
        );
        img.setAttribute("alt", emoji);
        img.setAttribute("title", emojiAnnotations[langCode][cp]);
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
      this._populateStatus();
      this._showAutoconfiguration();
      this._populateBridgeCards();
    },

    onShowQr(bridgeString) {
      const dialog = new BridgeQrDialog();
      dialog.openDialog(gSubDialog, bridgeString);
    },

    onCopyBridgeAddress(addressElem) {
      const clipboard = Cc["@mozilla.org/widget/clipboardhelper;1"].getService(
        Ci.nsIClipboardHelper
      );
      clipboard.copyString(addressElem.value);
    },

    onRemoveAllBridges() {
      TorSettings.bridges.enabled = false;
      TorSettings.bridges.bridge_strings = "";
      if (TorSettings.bridges.source === TorBridgeSource.BuiltIn) {
        TorSettings.bridges.builtin_type = "";
      }
      TorSettings.saveToPrefs();
      TorSettings.applySettings().finally(() => {
        this._populateBridgeCards();
      });
    },

    /**
     * Save and apply settings, then optionally open about:torconnect and start
     * bootstrapping.
     *
     * @param {boolean} connect - Whether to open about:torconnect and start
     *   bootstrapping if possible.
     */
    async saveBridgeSettings(connect) {
      TorSettings.saveToPrefs();
      // FIXME: This can throw if the user adds a bridge manually with invalid
      // content. Should be addressed by tor-browser#41913.
      try {
        await TorSettings.applySettings();
      } catch (e) {
        console.error("Applying settings failed", e);
      }

      this._populateBridgeCards();

      if (!connect) {
        return;
      }

      // The bridge dialog button is "connect" when Tor is not bootstrapped,
      // so do the connect.

      // Start Bootstrapping, which should use the configured bridges.
      // NOTE: We do this regardless of any previous TorConnect Error.
      if (TorConnect.canBeginBootstrap) {
        TorConnect.beginBootstrap();
      }
      // Open "about:torconnect".
      // FIXME: If there has been a previous bootstrapping error then
      // "about:torconnect" will be trying to get the user to use
      // AutoBootstrapping. It is not set up to handle a forced direct
      // entry to plain Bootstrapping from this dialog so the UI will not
      // be aligned. In particular the
      // AboutTorConnect.uiState.bootstrapCause will be aligned to
      // whatever was shown previously in "about:torconnect" instead.
      TorConnect.openTorConnect();
    },

    onAddBuiltinBridge() {
      const builtinBridgeDialog = new BuiltinBridgeDialog(
        (bridgeType, connect) => {
          TorSettings.bridges.enabled = true;
          TorSettings.bridges.source = TorBridgeSource.BuiltIn;
          TorSettings.bridges.builtin_type = bridgeType;

          this.saveBridgeSettings(connect);
        }
      );
      builtinBridgeDialog.openDialog(gSubDialog);
    },

    // called when the request bridge button is activated
    onRequestBridge() {
      const requestBridgeDialog = new RequestBridgeDialog(
        (aBridges, connect) => {
          if (!aBridges.length) {
            return;
          }
          const bridgeStrings = aBridges.join("\n");
          TorSettings.bridges.enabled = true;
          TorSettings.bridges.source = TorBridgeSource.BridgeDB;
          TorSettings.bridges.bridge_strings = bridgeStrings;

          this.saveBridgeSettings(connect);
        }
      );
      requestBridgeDialog.openDialog(gSubDialog);
    },

    onAddBridgeManually() {
      const provideBridgeDialog = new ProvideBridgeDialog(
        (aBridgeString, connect) => {
          TorSettings.bridges.enabled = true;
          TorSettings.bridges.source = TorBridgeSource.UserProvided;
          TorSettings.bridges.bridge_strings = aBridgeString;

          this.saveBridgeSettings(connect);
        }
      );
      provideBridgeDialog.openDialog(gSubDialog);
    },

    onAdvancedSettings() {
      const connectionSettingsDialog = new ConnectionSettingsDialog();
      connectionSettingsDialog.openDialog(gSubDialog);
    },

    onViewTorLogs() {
      const torLogDialog = new TorLogDialog();
      torLogDialog.openDialog(gSubDialog);
    },
  };
  return retval;
})(); /* gConnectionPane */

/**
 * Convert the given bridgeString into an array of emoji indices between 0 and
 * 255.
 *
 * @param {string} bridgeString - The bridge string.
 *
 * @returns {integer[]} - A list of emoji indices between 0 and 255.
 */
function makeBridgeId(bridgeString) {
  // JS uses UTF-16. While most of these emojis are surrogate pairs, a few
  // ones fit one UTF-16 character. So we could not use neither indices,
  // nor substr, nor some function to split the string.
  // FNV-1a implementation that is compatible with other languages
  const prime = 0x01000193;
  const offset = 0x811c9dc5;
  let hash = offset;
  const encoder = new TextEncoder();
  for (const byte of encoder.encode(bridgeString)) {
    hash = Math.imul(hash ^ byte, prime);
  }

  return [
    ((hash & 0x7f000000) >> 24) | (hash < 0 ? 0x80 : 0),
    (hash & 0x00ff0000) >> 16,
    (hash & 0x0000ff00) >> 8,
    hash & 0x000000ff,
  ];
}
