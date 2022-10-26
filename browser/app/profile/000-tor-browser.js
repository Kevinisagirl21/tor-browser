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
// localhost is already blocked by setting `network.proxy.allow_hijacking_localhost` to
// true, allowing users to explicitly block ports makes them fingerprintable; for details, see
// Bug 41317: Tor Browser leaks banned ports in network.security.ports.banned
pref("network.security.ports.banned", "", locked);
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

// Tor check and proxy prefs
pref("extensions.torbutton.test_enabled",true);
pref("extensions.torbutton.test_url","https://check.torproject.org/?TorButton=true");
pref("extensions.torbutton.local_tor_check",true);
pref("extensions.torbutton.use_nontor_proxy",false);

// State prefs:
pref("extensions.torbutton.startup",false);

// This is only used when letterboxing is disabled.
// See #7255 for details. We display the warning three times to make sure the
// user did not click on it by accident.
pref("extensions.torbutton.maximize_warnings_remaining", 3);

// Security prefs:
pref("extensions.torbutton.clear_http_auth",true);
pref("extensions.torbutton.close_newnym",true);
pref("extensions.torbutton.resize_new_windows",false);
pref("extensions.torbutton.launch_warning",true);

// Security Slider
pref("extensions.torbutton.security_slider", 4);
pref("extensions.torbutton.security_custom", false);

pref("extensions.torbutton.confirm_newnym", true);

pref("extensions.torbutton.noscript_inited", false);
pref("extensions.torbutton.noscript_persist", false);

// Browser home page:
pref("browser.startup.homepage", "about:tor");

// This pref specifies an ad-hoc "version" for various pref update hacks we need to do
pref("extensions.torbutton.pref_fixup_version", 0);

// Formerly tor-launcher defaults
// When presenting the setup wizard, first prompt for locale.
pref("intl.locale.matchOS", true);
pref("extensions.torlauncher.prompt_for_locale", true);

pref("extensions.torlauncher.start_tor", true);
pref("extensions.torlauncher.prompt_at_startup", true);
pref("extensions.torlauncher.quickstart", false);

// This pref controls whether Tor Launcher will try to remove the old
// meek and moat http helper browser profiles. This only has an effect
// on macOS; for Windows and Linux profile removal is handled by the
// updater (since on those platforms the profiles are embedded within
// the browser install directory).
pref("extensions.torlauncher.should_remove_meek_helper_profiles", true);

pref("extensions.torlauncher.loglevel", 4);  // 1=verbose, 2=debug, 3=info, 4=note, 5=warn
pref("extensions.torlauncher.logmethod", 1);  // 0=stdout, 1=errorconsole, 2=debuglog
pref("extensions.torlauncher.max_tor_log_entries", 1000);

// By default, Tor Launcher configures a TCP listener for the Tor
// control port, as defined by control_host and control_port.
// Set control_port_use_ipc to true to use an IPC object (e.g., a Unix
// domain socket) instead. You may also modify control_ipc_path to
// override the default IPC object location. If a relative path is used,
// it is handled like torrc_path (see below).
pref("extensions.torlauncher.control_host", "127.0.0.1");
pref("extensions.torlauncher.control_port", 9151);
pref("extensions.torlauncher.control_port_use_ipc", false);
pref("extensions.torlauncher.control_ipc_path", "");

// By default, Tor Launcher configures a TCP listener for the Tor
// SOCKS port. The host is taken from the network.proxy.socks pref and
// the port is taken from the network.proxy.socks_port pref.
// Set socks_port_use_ipc to true to use an IPC object (e.g., a Unix
// domain socket) instead. You may also modify socks_ipc_path to
// override the default IPC object location. If a relative path is used,
// it is handled like torrc_path (see below).
// Modify socks_port_flags to use a different set of SocksPort flags (but be
// careful).
pref("extensions.torlauncher.socks_port_use_ipc", false);
pref("extensions.torlauncher.socks_ipc_path", "");
pref("extensions.torlauncher.socks_port_flags", "ExtendedErrors IPv6Traffic PreferIPv6 KeepAliveIsolateSOCKSAuth");

// The tor_path is relative to the application directory. On Linux and
// Windows this is the Browser/ directory that contains the firefox
// executables, and on Mac OS it is the TorBrowser.app directory.
pref("extensions.torlauncher.tor_path", "");

// The torrc_path and tordatadir_path are relative to the data directory,
// which is TorBrowser-Data/ if it exists as a sibling of the application
// directory. If TorBrowser-Data/ does not exist, these paths are relative
// to the TorBrowser/ directory within the application directory.
pref("extensions.torlauncher.torrc_path", "");
pref("extensions.torlauncher.tordatadir_path", "");

// BridgeDB-related preferences (used for Moat).
pref("extensions.torlauncher.bridgedb_front", "cdn.sstatic.net");
pref("extensions.torlauncher.bridgedb_reflector", "https://moat.torproject.org.global.prod.fastly.net/");
pref("extensions.torlauncher.moat_service", "https://bridges.torproject.org/moat");
pref("extensions.torlauncher.bridgedb_bridge_type", "obfs4");

// Recommended default bridge type (can be set per localized bundle).
// pref("extensions.torlauncher.default_bridge_recommended_type", "obfs3");

// Default bridges.
// pref("extensions.torlauncher.default_bridge.TYPE.1", "TYPE x.x.x.x:yy");
// pref("extensions.torlauncher.default_bridge.TYPE.2", "TYPE x.x.x.x:yy");
