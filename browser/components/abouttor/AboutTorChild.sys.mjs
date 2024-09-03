export class AboutTorChild extends JSWindowActorChild {
  actorCreated() {
    if (this.contentWindow.matchMedia("not (prefers-contrast)").matches) {
      // When prefers-contrast is not set, the page only has one style because
      // we always set a dark background and a light <form>.
      // We force prefers-color-scheme to be light, regardless of the user's
      // settings so that we inherit the "light" theme styling from
      // in-content/common.css for the <form> element. In particular, we want
      // the light styling for the <input> and <moz-toggle> elements, which are
      // on a light background.
      this.browsingContext.prefersColorSchemeOverride = "light";
    }
  }

  handleEvent(event) {
    switch (event.type) {
      case "DOMContentLoaded":
        this.sendQuery("AboutTor:GetInitialData").then(data => {
          const initialDataEvent = new this.contentWindow.CustomEvent(
            "InitialData",
            { detail: Cu.cloneInto(data, this.contentWindow) }
          );
          this.contentWindow.dispatchEvent(initialDataEvent);
        });
        break;
      case "SubmitSearchOnionize":
        this.sendAsyncMessage("AboutTor:SetSearchOnionize", !!event.detail);
        break;
      case "YECHidden":
        // YEC 2024 banner was closed. Persist this for the rest of this
        // session. See tor-browser#43098 and tor-browser#42188.
        this.sendAsyncMessage("AboutTor:HideYEC");
        break;
    }
  }
}
