export class AboutTorParent extends JSWindowActorParent {
  async receiveMessage(message) {
    if (message.name === "AboutTor:ContentLoaded") {
      this.#sendChromeData();
      this.#sendLocale();
    }
  }

  #sendChromeData() {
    const tbbVersion = Services.prefs.getCharPref("torbrowser.version");
    this.sendAsyncMessage("AboutTor:ChromeData", {
      tbbVersion,
      torOn: true,
      updateChannel: "alpha",
      hasBeenUpdated: true,
    });
  }

  #sendLocale() {
    try {
      const kBrandBundle = "chrome://branding/locale/brand.properties";
      const brandBundle = Services.strings.createBundle(kBrandBundle);
      const productName = brandBundle.GetStringFromName("brandFullName");
      let locale = Services.locale.appLocaleAsBCP47;
      if (locale === "ja-JP-macos") {
        locale = "ja";
      }
      this.sendAsyncMessage("AboutTor:LocaleData", { locale, productName });
    } catch (e) {}
  }
}
