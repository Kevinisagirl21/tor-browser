const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  AboutTorMessage: "resource:///modules/AboutTorMessage.sys.mjs",
});

export class AboutTorParent extends JSWindowActorParent {
  receiveMessage(message) {
    const onionizePref = "torbrowser.homepage.search.onionize";
    switch (message.name) {
      case "AboutTor:GetMessage":
        return Promise.resolve(lazy.AboutTorMessage.getNext());
      case "AboutTor:GetSearchOnionize":
        return Promise.resolve(Services.prefs.getBoolPref(onionizePref, false));
      case "AboutTor:SetSearchOnionize":
        Services.prefs.setBoolPref(onionizePref, message.data);
        break;
    }
    return undefined;
  }
}
