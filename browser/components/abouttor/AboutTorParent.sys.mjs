import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const kTorCheckFailedTopic = "Torbutton:TorCheckFailed";

class TorCheckObserver {
  #callback = null;

  constructor(callback) {
    this.#callback = callback;
    Services.obs.addObserver(this, kTorCheckFailedTopic);
  }

  stop() {
    Services.obs.removeObserver(this, kTorCheckFailedTopic);
  }

  observe(subject, topic, data) {
    if (topic === kTorCheckFailedTopic && this.#callback) {
      this.#callback();
    }
  }
}

export class AboutTorParent extends JSWindowActorParent {
  #observer = null;

  constructor() {
    super();
    this.#observer = new TorCheckObserver(() => {
      this.#sendChromeData(false);
    });
  }

  didDestroy() {
    if (this.#observer) {
      this.#observer.stop();
      this.#observer = null;
    }
  }

  receiveMessage(message) {
    if (message.name === "AboutTor:ContentLoaded") {
      this.#sendChromeData(true);
      this.#sendLocale();
    }
  }

  async #sendChromeData(isRespondingToPageLoad) {
    const data = {
      updateChannel: AppConstants.MOZ_UPDATE_CHANNEL,
    };

    const checkSvc = Cc[
      "@torproject.org/torbutton-torCheckService;1"
    ].getService(Ci.nsISupports).wrappedJSObject;
    await checkSvc.runTorCheck();
    if (checkSvc.statusOfTorCheck !== checkSvc.kCheckFailed) {
      data.torOn = true;
    }

    if (isRespondingToPageLoad) {
      const kShouldNotifyPref = "torbrowser.post_update.shouldNotify";
      if (Services.prefs.getBoolPref(kShouldNotifyPref, false)) {
        Services.prefs.clearUserPref(kShouldNotifyPref);
        data.hasBeenUpdated = true;
        data.updateMoreInfoURL = Services.prefs.getCharPref(
          "torbrowser.post_update.url",
          ""
        );
        if (!data.updateMoreInfoURL) {
          // Use the default URL as a fallback.
          data.updateMoreInfoURL = Services.urlFormatter.formatURLPref(
            "startup.homepage_override_url"
          );
        }
      }
    }

    this.sendAsyncMessage("AboutTor:ChromeData", data);
  }

  #sendLocale() {
    try {
      let locale = Services.locale.appLocaleAsBCP47;
      if (locale === "ja-JP-macos") {
        locale = "ja";
      }
      const kBrandBundle = "chrome://branding/locale/brand.properties";
      const brandBundle = Services.strings.createBundle(kBrandBundle);
      const productName = brandBundle.GetStringFromName("brandFullName");
      const productVersion = Services.prefs.getCharPref("torbrowser.version");
      this.sendAsyncMessage("AboutTor:LocaleData", {
        locale,
        // FIXME: This is probably wrong! But that's what we've done until now.
        // I think we can wait the about:tor refactor to fix it.
        productInfo: `${productName} ${productVersion}`,
      });
    } catch (e) {}
  }
}
