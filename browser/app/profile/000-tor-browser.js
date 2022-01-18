#include 001-base-profile.js

pref("app.update.notifyDuringDownload", true);
pref("app.update.url.manual", "https://www.torproject.org/download/languages/");
pref("app.update.url.details", "https://www.torproject.org/download/");
pref("app.update.badgeWaitTime", 0);
pref("app.releaseNotesURL", "about:blank");
// disables the 'What's New?' link in the about dialog, otherwise we need to
// duplicate logic for generating the url to the blog post that is already more
// easily found in about:tor
pref("app.releaseNotesURL.aboutDialog", "about:blank");
// point to our feedback url rather than Mozilla's
pref("app.feedback.baseURL", "https://support.torproject.org/%LOCALE%/get-in-touch/");

pref("browser.shell.checkDefaultBrowser", false);

// Proxy and proxy security
pref("network.proxy.socks", "127.0.0.1");
pref("network.proxy.socks_port", 9150);
pref("network.proxy.socks_remote_dns", true);
pref("network.proxy.no_proxies_on", ""); // For fingerprinting and local service vulns (#10419)
pref("network.proxy.allow_hijacking_localhost", true); // Allow proxies for localhost (#31065)
pref("network.proxy.type", 1);
// Bug 40548: Disable proxy-bypass
pref("network.proxy.failover_direct", false);
pref("network.security.ports.banned", "9050,9051,9150,9151");
pref("network.dns.disabled", true); // This should cover the #5741 patch for DNS leaks
pref("network.http.max-persistent-connections-per-proxy", 256);

pref("browser.uiCustomization.state", "{\"placements\":{\"widget-overflow-fixed-list\":[],\"PersonalToolbar\":[\"personal-bookmarks\"],\"nav-bar\":[\"back-button\",\"forward-button\",\"stop-reload-button\",\"urlbar-container\",\"torbutton-button\",\"security-level-button\",\"new-identity-button\",\"downloads-button\"],\"TabsToolbar\":[\"tabbrowser-tabs\",\"new-tab-button\",\"alltabs-button\"],\"toolbar-menubar\":[\"menubar-items\"],\"PanelUI-contents\":[\"home-button\",\"edit-controls\",\"zoom-controls\",\"new-window-button\",\"save-page-button\",\"print-button\",\"bookmarks-menu-button\",\"history-panelmenu\",\"find-button\",\"preferences-button\",\"add-ons-button\",\"developer-button\"],\"addon-bar\":[\"addonbar-closebutton\",\"status-bar\"]},\"seen\":[\"developer-button\",\"_73a6fe31-595d-460b-a920-fcc0f8843232_-browser-action\"],\"dirtyAreaCache\":[\"PersonalToolbar\",\"nav-bar\",\"TabsToolbar\",\"toolbar-menubar\"],\"currentVersion\":14,\"newElementCount\":1}");

// Treat .onions as secure
pref("dom.securecontext.allowlist_onions", true);

// Bug 40423/41137: Disable http/3
// We should re-enable it as soon as Tor gets UDP support
pref("network.http.http3.enabled", false);

#expand pref("torbrowser.version", __TOR_BROWSER_VERSION_QUOTED__);

// Old torbutton prefs

// debug prefs
pref("extensions.torbutton.loglevel",4);
pref("extensions.torbutton.logmethod",1); // 0=stdout, 1=errorconsole, 2=debuglog

// Display prefs
pref("extensions.torbutton.display_circuit", true);
pref("extensions.torbutton@torproject.org.description", "chrome://torbutton/locale/torbutton.properties");
pref("extensions.torbutton.updateNeeded", false);

// Tor check and proxy prefs
pref("extensions.torbutton.test_enabled",true);
pref("extensions.torbutton.test_url","https://check.torproject.org/?TorButton=true");
pref("extensions.torbutton.local_tor_check",true);
pref("extensions.torbutton.versioncheck_enabled",true);
pref("extensions.torbutton.use_nontor_proxy",false);

// State prefs:
pref("extensions.torbutton.startup",false);
pref("extensions.torbutton.inserted_button",false);
pref("extensions.torbutton.inserted_security_level",false);

// This is only used when letterboxing is disabled.
// See #7255 for details. We display the warning three times to make sure the
// user did not click on it by accident.
pref("extensions.torbutton.maximize_warnings_remaining", 3);

// Security prefs:
pref("extensions.torbutton.clear_http_auth",true);
pref("extensions.torbutton.close_newnym",true);
pref("extensions.torbutton.resize_new_windows",false);
pref("extensions.torbutton.startup_state", 2); // 0=non-tor, 1=tor, 2=last
pref("extensions.torbutton.tor_memory_jar",false);
pref("extensions.torbutton.nontor_memory_jar",false);
pref("extensions.torbutton.launch_warning",true);

// Opt out of Firefox addon pings:
// https://developer.mozilla.org/en/Addons/Working_with_AMO
pref("extensions.torbutton@torproject.org.getAddons.cache.enabled", false);

// Security Slider
pref("extensions.torbutton.security_slider", 4);
pref("extensions.torbutton.security_custom", false);

pref("extensions.torbutton.confirm_plugins", true);
pref("extensions.torbutton.confirm_newnym", true);

pref("extensions.torbutton.noscript_inited", false);
pref("extensions.torbutton.noscript_persist", false);

// Browser home page:
pref("browser.startup.homepage", "about:tor");

// This pref specifies an ad-hoc "version" for various pref update hacks we need to do
pref("extensions.torbutton.pref_fixup_version", 0);
