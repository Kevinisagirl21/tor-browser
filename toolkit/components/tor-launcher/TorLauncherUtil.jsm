// Copyright (c) 2022, The Tor Project, Inc.
// See LICENSE for licensing information.

"use strict";

/*************************************************************************
 * Tor Launcher Util JS Module
 *************************************************************************/

var EXPORTED_SYMBOLS = ["TorLauncherUtil"];

const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");

const kPropBundleURI = "chrome://torbutton/locale/torlauncher.properties";
const kPropNamePrefix = "torlauncher.";
const kIPCDirPrefName = "extensions.torlauncher.tmp_ipc_dir";

let gStringBundle = null;

class TorFile {
  // The nsIFile to be returned
  file = null;

  // A relative or absolute path that will determine file
  path = null;
  pathIsRelative = false;
  // If true, path is ignored
  useAppDir = false;

  isIPC = false;
  checkIPCPathLen = true;

  static _isFirstIPCPathRequest = true;
  static _isUserDataOutsideOfAppDir = undefined;
  static _dataDir = null;
  static _appDir = null;

  constructor(aTorFileType, aCreate) {
    this.fileType = aTorFileType;

    this.getFromPref();
    this.getIPC();
    // No preference and no pre-determined IPC path: use a default path.
    if (!this.file && !this.path) {
      this.getDefault();
    }

    if (!this.file && this.path) {
      this.pathToFile();
    }
    if (this.file && !this.file.exists() && !this.isIPC && aCreate) {
      this.createFile();
    }
    this.normalize();
  }

  getFile() {
    return this.file;
  }

  getFromPref() {
    const prefName = `extensions.torlauncher.${this.fileType}_path`;
    this.path = Services.prefs.getCharPref(prefName, "");
    if (this.path) {
      const re = TorLauncherUtil.isWindows ? /^[A-Za-z]:\\/ : /^\//;
      this.isRelativePath = !re.test(this.path);
      // always try to use path if provided in pref
      this.checkIPCPathLen = false;
    }
  }

  getIPC() {
    const isControlIPC = this.fileType === "control_ipc";
    const isSOCKSIPC = this.fileType === "socks_ipc";
    this.isIPC = isControlIPC || isSOCKSIPC;

    const kControlIPCFileName = "control.socket";
    const kSOCKSIPCFileName = "socks.socket";
    this.ipcFileName = isControlIPC ? kControlIPCFileName : kSOCKSIPCFileName;
    this.extraIPCPathLen = this.isSOCKSIPC ? 2 : 0;

    // Do not do anything else if this.path has already been populated with the
    // _path preference for this file type (or if we are not looking for an IPC
    // file).
    if (this.path || !this.isIPC) {
      return;
    }

    // If this is the first request for an IPC path during this browser
    // session, remove the old temporary directory. This helps to keep /tmp
    // clean if the browser crashes or is killed.
    if (TorFile._isFirstIPCPathRequest) {
      TorLauncherUtil.cleanupTempDirectories();
      TorFile._isFirstIPCPathRequest = false;
    } else {
      // FIXME: Do we really need a preference? Or can we save it in a static
      // member?
      // Retrieve path for IPC objects (it may have already been determined).
      const ipcDirPath = Services.prefs.getCharPref(kIPCDirPrefName, "");
      if (ipcDirPath) {
        // We have already determined where IPC objects will be placed.
        this.file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
        this.file.initWithPath(ipcDirPath);
        this.file.append(this.ipcFileName);
        this.checkIPCPathLen = false; // already checked.
        return;
      }
    }

    // If XDG_RUNTIME_DIR is set, use it as the base directory for IPC
    // objects (e.g., Unix domain sockets) -- assuming it is not too long.
    const env = Cc["@mozilla.org/process/environment;1"].getService(
      Ci.nsIEnvironment
    );
    if (!env.exists("XDG_RUNTIME_DIR")) {
      return;
    }
    const ipcDir = this.createUniqueIPCDir(env.get("XDG_RUNTIME_DIR"));
    if (ipcDir) {
      const f = ipcDir.clone();
      f.append(this.ipcFileName);
      if (this.isIPCPathLengthOK(f.path, this.extraIPCPathLen)) {
        this.file = f;
        this.checkIPCPathLen = false; // no need to check again.

        // Store directory path so it can be reused for other IPC objects
        // and so it can be removed during exit.
        Services.prefs.setCharPref(kIPCDirPrefName, ipcDir.path);
      } else {
        // too long; remove the directory that we just created.
        ipcDir.remove(false);
      }
    }
  }

  // This block is used for the TorBrowser-Data/ case.
  getDefault() {
    let torPath = "";
    let dataDir = "";
    // FIXME: TOR_BROWSER_DATA_OUTSIDE_APP_DIR is used only on macOS at the
    // moment. In Linux and Windows it might not work anymore.
    // We might simplify the code here, if we get rid of this macro.
    // Also, we allow specifying directly a relative path, for a portable mode.
    // Anyway, that macro is also available in AppConstants.
    if (TorFile.isUserDataOutsideOfAppDir) {
      if (TorLauncherUtil.isMac) {
        torPath = "Contents/Resources/";
      }
      torPath += "TorBrowser/Tor";
    } else {
      torPath = "Tor";
      dataDir = "Data/";
    }

    switch (this.fileType) {
      case "tor":
        if (TorLauncherUtil.isMac) {
          this.path = `${torPath}/tor`;
        } else {
          this.path =
            torPath + "/tor" + (TorLauncherUtil.isWindows ? ".exe" : "");
        }
        break;
      case "torrc-defaults":
        this.path = TorFile.isUserDataOutsideOfAppDir
          ? `${torPath}/torrc-defaults`
          : `${dataDir}Tor/torrc-defaults`;
        break;
      case "torrc":
        this.path = `${dataDir}Tor/torrc`;
        break;
      case "tordatadir":
        this.path = `${dataDir}Tor`;
        break;
      case "toronionauthdir":
        this.path = `${dataDir}Tor/onion-auth`;
        break;
      case "pt-profiles-dir":
        this.path = TorFile.isUserDataOutsideOfAppDir
          ? "Tor/PluggableTransports"
          : `${dataDir}Browser`;
        break;
      case "pt-startup-dir":
        if (TorLauncherUtil.isMac && TorFile.isUserDataOutsideOfAppDir) {
          this.path = "Contents/MacOS/Tor";
        } else {
          this.file = TorFile.appDir.clone();
          return;
        }
        break;
      default:
        if (!TorLauncherUtil.isWindows && this.isIPC) {
          this.path = "Tor/" + this.ipcFileName;
          break;
        }
        throw new Error("Unknown file type");
    }
    if (TorLauncherUtil.isWindows) {
      this.path = this.path.replaceAll("/", "\\");
    }
    this.isRelativePath = true;
  }

  pathToFile() {
    if (TorLauncherUtil.isWindows) {
      this.path = this.path.replaceAll("/", "\\");
    }
    // Turn 'path' into an absolute path when needed.
    if (this.isRelativePath) {
      const isUserData =
        this.fileType !== "tor" &&
        this.fileType !== "pt-startup-dir" &&
        this.fileType !== "torrc-defaults";
      if (TorFile.isUserDataOutsideOfAppDir) {
        let baseDir = isUserData ? TorFile.dataDir : TorFile.appDir;
        this.file = baseDir.clone();
      } else {
        this.file = TorFile.appDir.clone();
        this.file.append("TorBrowser");
      }
      this.file.appendRelativePath(this.path);
    } else {
      this.file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      this.file.initWithPath(this.path);
    }
  }

  createFile() {
    if (
      "tordatadir" == this.fileType ||
      "toronionauthdir" == this.fileType ||
      "pt-profiles-dir" == this.fileType
    ) {
      this.file.create(this.file.DIRECTORY_TYPE, 0o700);
    } else {
      this.file.create(this.file.NORMAL_FILE_TYPE, 0o600);
    }
  }

  // If the file exists or an IPC object was requested, normalize the path
  // and return a file object. The control and SOCKS IPC objects will be
  // created by tor.
  normalize() {
    if (!this.file.exists() && !this.isIPC) {
      throw new Error(`${this.fileType} file not found: ${this.file.path}`);
    }
    try {
      this.file.normalize();
    } catch (e) {
      console.warn("Normalization of the path failed", e);
    }

    // Ensure that the IPC path length is short enough for use by the
    // operating system. If not, create and use a unique directory under
    // /tmp for all IPC objects. The created directory path is stored in
    // a preference so it can be reused for other IPC objects and so it
    // can be removed during exit.
    if (
      this.isIPC &&
      this.checkIPCPathLen &&
      !this.isIPCPathLengthOK(this.file.path, this.extraIPCPathLen)
    ) {
      this.file = this.createUniqueIPCDir("/tmp");
      if (!this.file) {
        throw new Error("failed to create unique directory under /tmp");
      }

      Services.prefs.setCharPref(kIPCDirPrefName, this.file.path);
      this.file.append(this.ipcFileName);
    }
  }

  // Return true if aPath is short enough to be used as an IPC object path,
  // e.g., for a Unix domain socket path. aExtraLen is the "delta" necessary
  // to accommodate other IPC objects that have longer names; it is used to
  // account for "control.socket" vs. "socks.socket" (we want to ensure that
  // all IPC objects are placed in the same parent directory unless the user
  // has set prefs or env vars to explicitly specify the path for an object).
  // We enforce a maximum length of 100 because all operating systems allow
  // at least 100 characters for Unix domain socket paths.
  isIPCPathLengthOK(aPath, aExtraLen) {
    const kMaxIPCPathLen = 100;
    return aPath && aPath.length + aExtraLen <= kMaxIPCPathLen;
  }

  // Returns an nsIFile or null if a unique directory could not be created.
  createUniqueIPCDir(aBasePath) {
    try {
      const d = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      d.initWithPath(aBasePath);
      d.append("Tor");
      d.createUnique(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
      return d;
    } catch (e) {
      console.error(`createUniqueIPCDir failed for ${aBasePath}: `, e);
      return null;
    }
  }

  static get isUserDataOutsideOfAppDir() {
    if (this._isUserDataOutsideOfAppDir === undefined) {
      // Determine if we are using a "side-by-side" data model by checking
      // whether the user profile is outside of the app directory.
      try {
        const profDir = Services.dirsvc.get("ProfD", Ci.nsIFile);
        this._isUserDataOutsideOfAppDir = !this.appDir.contains(profDir);
      } catch (e) {
        this._isUserDataOutsideOfAppDir = false;
      }
    }
    return this._isUserDataOutsideOfAppDir;
  }

  // Returns an nsIFile that points to the application directory.
  static get appDir() {
    if (!this._appDir) {
      let topDir = Services.dirsvc.get("CurProcD", Ci.nsIFile);
      // On Linux and Windows, we want to return the Browser/ directory.
      // Because topDir ("CurProcD") points to Browser/browser on those
      // platforms, we need to go up one level.
      // On Mac OS, we want to return the TorBrowser.app/ directory.
      // Because topDir points to Contents/Resources/browser on Mac OS,
      // we need to go up 3 levels.
      let tbbBrowserDepth = TorLauncherUtil.isMac ? 3 : 1;
      while (tbbBrowserDepth > 0) {
        let didRemove = topDir.leafName != ".";
        topDir = topDir.parent;
        if (didRemove) {
          tbbBrowserDepth--;
        }
      }
      this._appDir = topDir;
    }
    return this._appDir;
  }

  // Returns an nsIFile that points to the TorBrowser-Data/ directory.
  // This function is only used when isUserDataOutsideOfAppDir === true.
  // May throw.
  static get dataDir() {
    if (!this._dataDir) {
      const profDir = Services.dirsvc.get("ProfD", Ci.nsIFile);
      this._dataDir = profDir.parent.parent;
    }
    return this._dataDir;
  }
}

const TorLauncherUtil = Object.freeze({
  get isMac() {
    return Services.appinfo.OS === "Darwin";
  },

  get isWindows() {
    return Services.appinfo.OS === "WINNT";
  },

  // Returns true if user confirms; false if not.
  showConfirm(aParentWindow, aMsg, aDefaultButtonLabel, aCancelButtonLabel) {
    if (!aParentWindow) {
      aParentWindow = Services.wm.getMostRecentWindow("navigator:browser");
    }

    const ps = Services.prompt;
    const title = this.getLocalizedString("error_title");
    const btnFlags =
      ps.BUTTON_POS_0 * ps.BUTTON_TITLE_IS_STRING +
      ps.BUTTON_POS_0_DEFAULT +
      ps.BUTTON_POS_1 * ps.BUTTON_TITLE_IS_STRING;

    const notUsed = { value: false };
    const btnIndex = ps.confirmEx(
      aParentWindow,
      title,
      aMsg,
      btnFlags,
      aDefaultButtonLabel,
      aCancelButtonLabel,
      null,
      null,
      notUsed
    );
    return btnIndex === 0;
  },

  // Localized Strings
  // TODO: Switch to fluent also these ones.

  // "torlauncher." is prepended to aStringName.
  getLocalizedString(aStringName) {
    if (!aStringName) {
      return aStringName;
    }
    try {
      const key = kPropNamePrefix + aStringName;
      return this._stringBundle.GetStringFromName(key);
    } catch (e) {}
    return aStringName;
  },

  // "torlauncher." is prepended to aStringName.
  getFormattedLocalizedString(aStringName, aArray, aLen) {
    if (!aStringName || !aArray) {
      return aStringName;
    }
    try {
      const key = kPropNamePrefix + aStringName;
      return this._stringBundle.formatStringFromName(key, aArray, aLen);
    } catch (e) {}
    return aStringName;
  },

  getLocalizedStringForError(aNSResult) {
    for (let prop in Cr) {
      if (Cr[prop] === aNSResult) {
        const key = "nsresult." + prop;
        const rv = this.getLocalizedString(key);
        if (rv !== key) {
          return rv;
        }
        return prop; // As a fallback, return the NS_ERROR... name.
      }
    }
    return undefined;
  },

  getLocalizedBootstrapStatus(aStatusObj, aKeyword) {
    if (!aStatusObj || !aKeyword) {
      return "";
    }

    let result;
    let fallbackStr;
    if (aStatusObj[aKeyword]) {
      let val = aStatusObj[aKeyword].toLowerCase();
      let key;
      if (aKeyword === "TAG") {
        // The bootstrap status tags in tagMap below are used by Tor
        // versions prior to 0.4.0.x. We map each one to the tag that will
        // produce the localized string that is the best fit.
        const tagMap = {
          conn_dir: "conn",
          handshake_dir: "onehop_create",
          conn_or: "enough_dirinfo",
          handshake_or: "ap_conn",
        };
        if (val in tagMap) {
          val = tagMap[val];
        }

        key = "bootstrapStatus." + val;
        fallbackStr = aStatusObj.SUMMARY;
      } else if (aKeyword === "REASON") {
        if (val === "connectreset") {
          val = "connectrefused";
        }

        key = "bootstrapWarning." + val;
        fallbackStr = aStatusObj.WARNING;
      }

      result = TorLauncherUtil.getLocalizedString(key);
      if (result === key) {
        result = undefined;
      }
    }

    if (!result) {
      result = fallbackStr;
    }

    if (aKeyword === "REASON" && aStatusObj.HOSTADDR) {
      result += " - " + aStatusObj.HOSTADDR;
    }

    return result ? result : "";
  },

  get shouldStartAndOwnTor() {
    const kPrefStartTor = "extensions.torlauncher.start_tor";
    try {
      const kBrowserToolboxPort = "MOZ_BROWSER_TOOLBOX_PORT";
      const kEnvSkipLaunch = "TOR_SKIP_LAUNCH";
      const env = Cc["@mozilla.org/process/environment;1"].getService(
        Ci.nsIEnvironment
      );
      if (env.exists(kBrowserToolboxPort)) {
        return false;
      }
      if (env.exists(kEnvSkipLaunch)) {
        const value = parseInt(env.get(kEnvSkipLaunch));
        return isNaN(value) || !value;
      }
    } catch (e) {}
    return Services.prefs.getBoolPref(kPrefStartTor, true);
  },

  get shouldShowNetworkSettings() {
    try {
      const kEnvForceShowNetConfig = "TOR_FORCE_NET_CONFIG";
      const env = Cc["@mozilla.org/process/environment;1"].getService(
        Ci.nsIEnvironment
      );
      if (env.exists(kEnvForceShowNetConfig)) {
        const value = parseInt(env.get(kEnvForceShowNetConfig));
        return !isNaN(value) && value;
      }
    } catch (e) {}
    return true;
  },

  get shouldOnlyConfigureTor() {
    const kPrefOnlyConfigureTor = "extensions.torlauncher.only_configure_tor";
    try {
      const kEnvOnlyConfigureTor = "TOR_CONFIGURE_ONLY";
      const env = Cc["@mozilla.org/process/environment;1"].getService(
        Ci.nsIEnvironment
      );
      if (env.exists(kEnvOnlyConfigureTor)) {
        const value = parseInt(env.get(kEnvOnlyConfigureTor));
        return !isNaN(value) && value;
      }
    } catch (e) {}
    return Services.prefs.getBoolPref(kPrefOnlyConfigureTor, false);
  },

  // Returns an nsIFile.
  // If aTorFileType is "control_ipc" or "socks_ipc", aCreate is ignored
  // and there is no requirement that the IPC object exists.
  // For all other file types, null is returned if the file does not exist
  // and it cannot be created (it will be created if aCreate is true).
  getTorFile(aTorFileType, aCreate) {
    if (!aTorFileType) {
      return null;
    }
    try {
      const torFile = new TorFile(aTorFileType, aCreate);
      return torFile.getFile();
    } catch (e) {
      console.error(`getTorFile: cannot get ${aTorFileType}`, e);
    }
    return null; // File not found or error (logged above).
  },

  cleanupTempDirectories() {
    const dirPath = Services.prefs.getCharPref(kIPCDirPrefName, "");
    try {
      Services.prefs.clearUserPref(kIPCDirPrefName);
    } catch (e) {}
    try {
      if (dirPath) {
        const f = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
        f.initWithPath(dirPath);
        if (f.exists()) {
          f.remove(false);
        }
      }
    } catch (e) {
      console.warn("Could not remove the IPC directory", e);
    }
  },

  removeMeekAndMoatHelperProfiles() {
    // FIXME: Is this something we can remove?
    const removeDirectory = (aParentDir, aName) => {
      try {
        const dir = aParentDir.clone();
        dir.appendRelativePath(aName);
        if (dir.exists()) {
          dir.remove(true);
        }
      } catch (e) {
        console.error(`Failed to remove ${aName}:`, e);
      }
    };

    const kPrefRemoveHelperProfiles =
      "extensions.torlauncher.should_remove_meek_helper_profiles";
    if (Services.prefs.getBoolPref(kPrefRemoveHelperProfiles, false)) {
      try {
        // Only attempt removal once.
        Services.prefs.setBoolPref(kPrefRemoveHelperProfiles, false);
      } catch (e) {
        console.warn(`Could not set ${kPrefRemoveHelperProfiles}`, e);
      }

      if (this.isMac) {
        let ptProfilesDir = this.getTorFile("pt-profiles-dir", true);
        if (ptProfilesDir) {
          removeDirectory(ptProfilesDir, "profile.meek-http-helper");
          removeDirectory(ptProfilesDir, "profile.moat-http-helper");
        }
      }
    }
  },

  get _stringBundle() {
    if (!gStringBundle) {
      gStringBundle = Services.strings.createBundle(kPropBundleURI);
    }
    return gStringBundle;
  },
});
