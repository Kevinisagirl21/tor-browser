export class AboutTorChild extends JSWindowActorChild {
  handleEvent(e) {
    switch (e.type) {
      case "DOMContentLoaded":
        this.sendAsyncMessage("AboutTor:ContentLoaded");
    }
  }

  receiveMessage(message) {
    switch (message.name) {
      case "AboutTor:ChromeData":
        this.#sendToContent("ChromeData", message.data);
        break;
      case "AboutTor:LocaleData":
        this.#sendToContent("LocaleData", message.data);
        break;
    }
  }

  #sendToContent(eventName, detail) {
    let event = new this.contentWindow.CustomEvent(eventName, {
      detail: Cu.cloneInto(detail, this.contentWindow),
    });
    this.contentWindow.dispatchEvent(event);
  }
}
