"use strict";

const { QRCode } = ChromeUtils.importESModule(
  "resource://gre/modules/QRCode.sys.mjs"
);

const { TorStrings } = ChromeUtils.importESModule(
  "resource://gre/modules/TorStrings.sys.mjs"
);

window.addEventListener(
  "DOMContentLoaded",
  () => {
    const bridgeString = window.arguments[0];

    document.documentElement.setAttribute(
      "title",
      TorStrings.settings.scanQrTitle
    );
    const target = document.getElementById("bridgeQr-target");
    const style = window.getComputedStyle(target);
    const width = style.width.substr(0, style.width.length - 2);
    const height = style.height.substr(0, style.height.length - 2);
    new QRCode(target, {
      text: bridgeString,
      width,
      height,
      colorDark: style.color,
      colorLight: style.backgroundColor,
      document,
    });
  },
  { once: true }
);
