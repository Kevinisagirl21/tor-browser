// Copyright (c) 2020, The Tor Project, Inc.

"use strict";

ChromeUtils.defineESModuleGetters(this, {
  TorStrings: "resource://gre/modules/TorStrings.sys.mjs",
});

ChromeUtils.defineESModuleGetters(this, {
  TorProviderBuilder: "resource://gre/modules/TorProviderBuilder.sys.mjs",
});

var gOnionServicesSavedKeysDialog = {
  selector: {
    dialog: "#onionservices-savedkeys-dialog",
    intro: "#onionservices-savedkeys-intro",
    tree: "#onionservices-savedkeys-tree",
    onionSiteCol: "#onionservices-savedkeys-siteCol",
    onionKeyCol: "#onionservices-savedkeys-keyCol",
    errorIcon: "#onionservices-savedkeys-errorIcon",
    errorMessage: "#onionservices-savedkeys-errorMessage",
    removeButton: "#onionservices-savedkeys-remove",
    removeAllButton: "#onionservices-savedkeys-removeall",
  },

  _tree: undefined,
  _busyCount: 0,
  get _isBusy() {
    // true when loading data, deleting a key, etc.
    return this._busyCount > 0;
  },

  // Public functions (called from outside this file).
  async deleteSelectedKeys() {
    this._withBusy(async () => {
      const indexesToDelete = [];
      const count = this._tree.view.selection.getRangeCount();
      for (let i = 0; i < count; ++i) {
        const minObj = {};
        const maxObj = {};
        this._tree.view.selection.getRangeAt(i, minObj, maxObj);
        for (let idx = minObj.value; idx <= maxObj.value; ++idx) {
          indexesToDelete.push(idx);
        }
      }

      if (indexesToDelete.length) {
        const controllerFailureMsg =
          TorStrings.onionServices.authPreferences.failedToRemoveKey;
        const provider = await TorProviderBuilder.build();
        try {
          // Remove in reverse index order to avoid issues caused by index
          // changes.
          for (let i = indexesToDelete.length - 1; i >= 0; --i) {
            await this._deleteOneKey(provider, indexesToDelete[i]);
          }
        } catch (e) {
          console.error("Removing a saved key failed", e);
          if (e.torMessage) {
            this._showError(e.torMessage);
          } else {
            this._showError(controllerFailureMsg);
          }
        }
      }
    });
  },

  async deleteAllKeys() {
    this._tree.view.selection.selectAll();
    await this.deleteSelectedKeys();
  },

  updateButtonsState() {
    const haveSelection = this._tree.view.selection.getRangeCount() > 0;
    const dialog = document.querySelector(this.selector.dialog);
    const removeSelectedBtn = dialog.querySelector(this.selector.removeButton);
    removeSelectedBtn.disabled = this._isBusy || !haveSelection;
    const removeAllBtn = dialog.querySelector(this.selector.removeAllButton);
    removeAllBtn.disabled = this._isBusy || this.rowCount === 0;
  },

  // Private functions.
  _onLoad() {
    document.mozSubdialogReady = this._init();
  },

  async _init() {
    this._populateXUL();
    window.addEventListener("keypress", this._onWindowKeyPress.bind(this));
    this._loadSavedKeys();
  },

  _populateXUL() {
    const dialog = document.querySelector(this.selector.dialog);
    const authPrefStrings = TorStrings.onionServices.authPreferences;
    dialog.setAttribute("title", authPrefStrings.dialogTitle);

    let elem = dialog.querySelector(this.selector.intro);
    elem.textContent = authPrefStrings.dialogIntro;

    elem = dialog.querySelector(this.selector.onionSiteCol);
    elem.setAttribute("label", authPrefStrings.onionSite);

    elem = dialog.querySelector(this.selector.onionKeyCol);
    elem.setAttribute("label", authPrefStrings.onionKey);

    elem = dialog.querySelector(this.selector.removeButton);
    elem.setAttribute("label", authPrefStrings.remove);

    elem = dialog.querySelector(this.selector.removeAllButton);
    elem.setAttribute("label", authPrefStrings.removeAll);

    this._tree = dialog.querySelector(this.selector.tree);
  },

  async _loadSavedKeys() {
    const controllerFailureMsg =
      TorStrings.onionServices.authPreferences.failedToGetKeys;
    this._withBusy(async () => {
      try {
        this._tree.view = this;

        const provider = await TorProviderBuilder.build();
        const keyInfoList = await provider.onionAuthViewKeys();
        if (keyInfoList) {
          // Filter out temporary keys.
          this._keyInfoList = keyInfoList.filter(aKeyInfo =>
            aKeyInfo.flags?.includes("Permanent")
          );
          // Sort by the .onion address.
          this._keyInfoList.sort((aObj1, aObj2) => {
            const hsAddr1 = aObj1.address.toLowerCase();
            const hsAddr2 = aObj2.address.toLowerCase();
            if (hsAddr1 < hsAddr2) {
              return -1;
            }
            return hsAddr1 > hsAddr2 ? 1 : 0;
          });
        }

        // Render the tree content.
        this._tree.rowCountChanged(0, this.rowCount);
      } catch (e) {
        if (e.torMessage) {
          this._showError(e.torMessage);
        } else {
          this._showError(controllerFailureMsg);
        }
      }
    });
  },

  // This method may throw; callers should catch errors.
  async _deleteOneKey(provider, aIndex) {
    const keyInfoObj = this._keyInfoList[aIndex];
    await provider.onionAuthRemove(keyInfoObj.address);
    this._tree.view.selection.clearRange(aIndex, aIndex);
    this._keyInfoList.splice(aIndex, 1);
    this._tree.rowCountChanged(aIndex + 1, -1);
  },

  async _withBusy(func) {
    this._busyCount++;
    if (this._busyCount === 1) {
      this.updateButtonsState();
    }
    try {
      await func();
    } finally {
      this._busyCount--;
      if (this._busyCount === 0) {
        this.updateButtonsState();
      }
    }
  },

  _onWindowKeyPress(event) {
    if (this._isBusy) {
      return;
    }
    if (event.keyCode === KeyEvent.DOM_VK_ESCAPE) {
      window.close();
    } else if (event.keyCode === KeyEvent.DOM_VK_DELETE) {
      this.deleteSelectedKeys();
    }
  },

  _showError(aMessage) {
    document
      .getElementById("onionservices-savedkeys-errorContainer")
      .classList.toggle("show-error", !!aMessage);
    const errorDesc = document.querySelector(this.selector.errorMessage);
    errorDesc.textContent = aMessage ? aMessage : "";
  },

  // XUL tree widget view implementation.
  get rowCount() {
    return this._keyInfoList?.length ?? 0;
  },

  getCellText(aRow, aCol) {
    if (this._keyInfoList && aRow < this._keyInfoList.length) {
      const keyInfo = this._keyInfoList[aRow];
      if (aCol.id.endsWith("-siteCol")) {
        return keyInfo.address;
      } else if (aCol.id.endsWith("-keyCol")) {
        // keyType is always "x25519", so do not show it.
        return keyInfo.keyBlob;
      }
    }
    return "";
  },

  isSeparator(index) {
    return false;
  },

  isSorted() {
    return false;
  },

  isContainer(index) {
    return false;
  },

  setTree(tree) {},

  getImageSrc(row, column) {},

  getCellValue(row, column) {},

  cycleHeader(column) {},

  getRowProperties(row) {
    return "";
  },

  getColumnProperties(column) {
    return "";
  },

  getCellProperties(row, column) {
    return "";
  },
};

window.addEventListener("load", () => gOnionServicesSavedKeysDialog._onLoad());
