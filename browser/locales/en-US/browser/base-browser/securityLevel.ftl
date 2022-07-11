-security-level = Security Level
-security-level-standard = Standard
-security-level-safer = Safer
-security-level-safest = Safest
-security-level-tooltip-standard = Security Level: Standard
-security-level-tooltip-safer = Security Level: Safer
-security-level-tooltip-safest = Security Level: Safest
# Shown only for custom level
-security-level-restore = Restore Defaults

## Security level button: when changing level, the id will be updated accordingly
# Not yet loaded (generic placeholders)
security-level-button =
  .tooltiptext = { -security-level }
  .label = { -security-level }
security-level-button-standard =
  .tooltiptext = { -security-level-tooltip-standard }
  .label = { -security-level-tooltip-standard }
security-level-button-safer =
  .tooltiptext = { -security-level-tooltip-safer }
  .label = { -security-level-tooltip-safer }
security-level-button-safest =
  .tooltiptext = { -security-level-tooltip-safest }
  .label = { -security-level-tooltip-safest }

## Security level panel
security-level-change = Change…
security-level-standard-label =
  .value = { -security-level-standard }
security-level-standard-radio =
  .label = { -security-level-standard }
security-level-standard-summary = All Tor Browser and website features are enabled.
security-level-safer-label =
  .value = { -security-level-safer }
security-level-safer-radio =
  .label = { -security-level-safer }
security-level-safer-summary = Disables website features that are often dangerous, causing some sites to lose functionality.
security-level-safest-label =
  .value = { -security-level-safest }
security-level-safest-radio =
  .label = { -security-level-safest }
security-level-safest-summary = Only allows website features required for static sites and basic services. These changes affect images, media, and scripts.
security-level-custom =
  .value = Custom
security-level-custom-summary = Your custom browser preferences have resulted in unusual security settings. For security and privacy reasons, we recommend you choose one of the default security levels.
security-level-restore-defaults = { -security-level-restore }

## Security level section in about:preferences#privacy
security-level-overview = Disable certain web features that can be used to attack your security and anonymity.
security-level-list-safer =
  .value = At the safer setting:
security-level-list-safest =
  .value = At the safest setting:
security-level-restore-link =
  .value = { -security-level-restore }
# Strings for descriptions
security-level-js-https-only = JavaScript is disabled on non-HTTPS sites.
security-level-js-disabled = JavaScript is disabled by default on all sites.
security-level-limit-typography = Some fonts and math symbols are disabled.
security-level-limit-typography-svg = Some fonts, icons, math symbols, and images are disabled.
security-level-limit-media = Audio and video (HTML5 media), and WebGL are click-to-play.

## Shared strings (both panel and preferences)
security-level-header = { -security-level }
security-level-learn-more =
  .value = Learn more
