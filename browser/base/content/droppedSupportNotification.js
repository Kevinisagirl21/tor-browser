"use strict";

// Show a prompt that a user's system will no longer be supported.
window.addEventListener("load", () => {
  let labelId;
  // Firefox moved ESR 115 EOL to 1st April 2025.
  const isExpired = Date.now() > Date.UTC(2025, 3, 1);

  if (
    AppConstants.platform === "macosx" &&
    Services.vc.compare(
      Services.sysinfo.getProperty("version"),
      "19.0" // MacOS 10.15 begins with Darwin 19.0
    ) < 0
  ) {
    labelId = isExpired
      ? "dropped-support-notification-macos-version-less-than-10-15-expired"
      : "dropped-support-notification-macos-version-less-than-10-15-extended-13-5";
  } else if (
    AppConstants.platform === "win" &&
    Services.vc.compare(Services.sysinfo.getProperty("version"), "10.0") < 0
  ) {
    labelId = isExpired
      ? "dropped-support-notification-win-os-version-less-than-10-expired"
      : "dropped-support-notification-win-os-version-less-than-10-extended-13-5";
  }

  const dismissedPref =
    "browser.dropped_support_notification_v14.dismiss_version";

  if (!labelId) {
    // Avoid setting any preferences for supported versions, and clean up any
    // old values if the user ported their profile.
    Services.prefs.clearUserPref(dismissedPref);
    return;
  }

  if (
    !isExpired &&
    Services.prefs.getStringPref(dismissedPref, "") ===
      AppConstants.BASE_BROWSER_VERSION
  ) {
    // Already dismissed since the last update.
    return;
  }

  // Locales that have support pages.
  // Note, these correspond to their app locale names.
  const supportLocales = [
    "en-US",
    "ar",
    "de",
    "es-ES",
    "fa",
    "fr",
    "id",
    "it",
    "ko",
    "pt-BR",
    "ro",
    "ru",
    "sw",
    "tr",
    "uk",
    "vi",
    "zh-CN",
    "zh-TW",
  ];
  // Find the first locale that matches.
  let locale = Services.locale.appLocalesAsBCP47.find(l => {
    return supportLocales.includes(l);
  });
  if (locale === "es-ES") {
    // Support page uses "es". All other locales use the same code in Tor
    // Browser as the support page.
    locale = "es";
  } else if (locale === "en-US") {
    // This is the default.
    locale = undefined;
  }

  const link = `https://support.torproject.org/${
    locale ? `${locale}/` : ""
  }tbb/tor-browser-and-legacy-os/`;

  const buttons = [
    {
      "l10n-id": "notification-learnmore-default-label",
      link,
    },
  ];

  if (!isExpired) {
    buttons.push({
      "l10n-id": "dropped-support-notification-dismiss-button",
      callback: () => {
        Services.prefs.setStringPref(
          dismissedPref,
          AppConstants.BASE_BROWSER_VERSION
        );
      },
    });
  }

  gNotificationBox.appendNotification(
    "dropped-support-notification",
    {
      label: { "l10n-id": labelId },
      priority: gNotificationBox.PRIORITY_WARNING_HIGH,
    },
    buttons
  );
});
