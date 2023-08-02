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
        this.sendQuery("AboutTor:GetSearchOnionize").then(searchOnionize => {
          const onionizeEvent = new this.contentWindow.CustomEvent(
            "InitialSearchOnionize",
            {
              detail: Cu.cloneInto(searchOnionize, this.contentWindow),
            }
          );
          this.contentWindow.dispatchEvent(onionizeEvent);
        });

        this.sendQuery("AboutTor:GetMessage").then(messageData => {
          const messageEvent = new this.contentWindow.CustomEvent(
            "MessageData",
            {
              detail: Cu.cloneInto(messageData, this.contentWindow),
            }
          );
          this.contentWindow.dispatchEvent(messageEvent);
        });
        break;
      case "SubmitSearchOnionize":
        this.sendAsyncMessage("AboutTor:SetSearchOnionize", !!event.detail);
        break;
    }
  }
}
