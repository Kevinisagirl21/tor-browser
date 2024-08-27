/**
 * Actor child class for the about:tor page.
 */
export class AboutTorChild extends JSWindowActorChild {
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
    }
  }
}
