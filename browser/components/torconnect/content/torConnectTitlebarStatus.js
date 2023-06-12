/* eslint-env mozilla/browser-window */

/**
 * A TorConnect status shown in the application title bar.
 */
var gTorConnectTitlebarStatus = {
  /**
   * The status element in the title bar.
   *
   * @type {Element}
   */
  node: null,
  /**
   * The status label.
   *
   * @type {Element}
   */
  label: null,
  /**
   * The status icon.
   *
   * @type {Element}
   */
  icon: null,

  /**
   * Initialize the component.
   */
  init() {
    const { TorStrings } = ChromeUtils.import(
      "resource:///modules/TorStrings.jsm"
    );

    this._strings = TorStrings.torConnect;

    this.node = document.getElementById("tor-connect-titlebar-status");
    this.icon = document.getElementById("tor-connect-titlebar-status-icon");
    this.label = document.getElementById("tor-connect-titlebar-status-label");
    // The title also acts as an accessible name for the role="status".
    this.node.setAttribute("title", this._strings.titlebarStatusName);

    this._observeTopic = TorConnectTopics.StateChange;
    this._stateListener = {
      observe: (subject, topic, data) => {
        if (topic !== this._observeTopic) {
          return;
        }
        this._torConnectStateChanged();
      },
    };
    Services.obs.addObserver(this._stateListener, this._observeTopic);

    this._torConnectStateChanged();
  },

  /**
   * De-initialize the component.
   */
  uninit() {
    Services.obs.removeObserver(this._stateListener, this._observeTopic);
  },

  /**
   * Callback for when the TorConnect state changes.
   */
  _torConnectStateChanged() {
    let textId;
    let connected = false;
    let potentiallyBlocked = false;
    switch (TorConnect.state) {
      case TorConnectState.Disabled:
        // Hide immediately.
        this.node.hidden = true;
        return;
      case TorConnectState.Bootstrapped:
        this._startHiding();
        textId = "titlebarStatusConnected";
        connected = true;
        break;
      case TorConnectState.Bootstrapping:
      case TorConnectState.AutoBootstrapping:
        textId = "titlebarStatusConnecting";
        break;
      default:
        if (TorConnect.potentiallyBlocked) {
          textId = "titlebarStatusPotentiallyBlocked";
          potentiallyBlocked = true;
        } else {
          textId = "titlebarStatusNotConnected";
        }
        break;
    }
    this.label.textContent = this._strings[textId];
    this.icon.classList.toggle("tor-connect-status-connected", connected);
    this.icon.classList.toggle(
      "tor-connect-status-potentially-blocked",
      potentiallyBlocked
    );
  },

  /**
   * Mark the component to be hidden after some delay.
   */
  _startHiding() {
    setTimeout(() => {
      this.node.hidden = true;
    }, 5000);
  },
};
