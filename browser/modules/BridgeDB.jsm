"use strict";

var EXPORTED_SYMBOLS = ["BridgeDB"];

const { MoatRPC } = ChromeUtils.import("resource:///modules/Moat.jsm");

var BridgeDB = {
  _moatRPC: null,
  _challenge: null,
  _image: null,
  _bridges: null,

  get currentCaptchaImage() {
    return this._image;
  },

  get currentBridges() {
    return this._bridges;
  },

  async submitCaptchaGuess(solution) {
    if (!this._moatRPC) {
      this._moatRPC = new MoatRPC();
      await this._moatRPC.init();
    }

    const response = await this._moatRPC.check(
      "obfs4",
      this._challenge,
      solution,
      false
    );
    this._bridges = response?.bridges;
    return this._bridges;
  },

  async requestNewCaptchaImage() {
    try {
      if (!this._moatRPC) {
        this._moatRPC = new MoatRPC();
        await this._moatRPC.init();
      }

      const response = await this._moatRPC.fetch(["obfs4"]);
      this._challenge = response.challenge;
      this._image =
        "data:image/jpeg;base64," + encodeURIComponent(response.image);
    } catch (err) {
      console.log(`error : ${err}`);
    }
    return this._image;
  },

  close() {
    this._moatRPC?.uninit();
    this._moatRPC = null;
    this._challenge = null;
    this._image = null;
    this._bridges = null;
  },
};
