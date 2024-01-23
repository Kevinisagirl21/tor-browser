# Tor browser manual link shown in the menu bar.
# Uses Title case.
menu-open-tor-manual =
    .label = Tor Browser Manual
    .accesskey = M
# Tor browser manual link shown in the application menu (aka: hamburger menu).
# Uses Sentence case.
appmenu-open-tor-manual =
    .label = Tor Browser manual
    .accesskey = m

## Tor Browser home page.

tor-browser-home-heading-stable = Explore. Privately.
tor-browser-home-heading-testing = Test. Thoroughly.

# Only shown when underlying Tor process was not started by Tor Browser.
# "Tails" refers to the operating system, and should be translated as a brand name.
# <a data-l10n-name="tor-check-link"> should contain the link text and close with </a>.
tor-browser-home-tor-check-warning = Your connection to Tor is not being managed by Tor Browser. Some operating systems (like Tails) will manage this for you, or you could have set up a custom configuration. <a data-l10n-name="tor-check-link">Test your connection</a>

tor-browser-home-duck-duck-go-input =
    .placeholder = Search with DuckDuckGo
# Toggle to switch from DuckDuckGo's plain ".com" domain to its ".onion" domain.
tor-browser-home-onionize-toggle =
    .label = Onionize
    .title = Search using the onion site

# Update message.
# <a data-l10n-name="update-link"> should contain the link text and close with </a>.
# $version (String) - The new tor browser version.
tor-browser-home-message-updated = Tor Browser has been updated to { $version }. <a data-l10n-name="update-link">See what’s new</a>

tor-browser-home-message-introduction = You’re ready for the world’s most private browsing experience.

tor-browser-home-message-donate = Tor is free to use because of donations from people like you. <a data-l10n-name="donate-link">Donate now</a>

tor-browser-home-message-news = Get the latest news from Tor straight to your inbox. <a data-l10n-name="news-link">Sign up for Tor news</a>

tor-browser-home-message-testing = This is an unstable version of Tor Browser for testing new features. <a data-l10n-name="learn-more-link">Learn more</a>

##

# Shown in Home settings, corresponds to the default about:tor home page.
home-mode-choice-tor =
    .label = Tor Browser Home

## Tor Bridges Settings

# Toggle button for enabling and disabling the use of bridges.
tor-bridges-use-bridges =
    .label = Use bridges

tor-bridges-none-added = No bridges added
tor-bridges-your-bridges = Your bridges
tor-bridges-source-user = Added by you
tor-bridges-source-built-in = Built-in
tor-bridges-source-requested = Requested from Tor
# The "..." menu button for all current bridges.
tor-bridges-options-button =
    .title = All bridges
# Shown in the "..." menu for all bridges when the user can generate a QR code for all of their bridges.
tor-bridges-menu-item-qr-all-bridge-addresses = Show QR code
    .accesskey = Q
# Shown in the "..." menu for all bridges when the user can copy all of their bridges.
tor-bridges-menu-item-copy-all-bridge-addresses = Copy bridge addresses
    .accesskey = C
# Only shown in the "..." menu for bridges added by the user.
tor-bridges-menu-item-edit-all-bridges = Edit bridges
    .accesskey = E
# Shown in the "..." menu for all current bridges.
tor-bridges-menu-item-remove-all-bridges = Remove all bridges
    .accesskey = R

# Shown when one of the built-in bridges is in use.
tor-bridges-built-in-status-connected = Connected

# Shown at the start of a Tor bridge line.
# $type (String) - The Tor bridge type ("snowflake", "obfs4", "meek-azure").
tor-bridges-type-prefix = { $type } bridge:
# The name and accessible description for a bridge emoji cell. Each bridge address can be hashed into four emojis shown to the user (bridgemoji feature). This cell corresponds to a *single* such emoji. The "title" should just be emojiName. The "aria-description" should give screen reader users enough of a hint that the cell contains a single emoji.
# $emojiName (String) - The name of the emoji, already localized.
# E.g. with Orca screen reader in en-US this would read "unicorn. Row 2 Column 2. Emoji".
tor-bridges-emoji-cell =
    .title = { $emojiName }
    .aria-description = Emoji
# The emoji name to show on hover when a bridge emoji's name is unknown.
tor-bridges-emoji-unknown = Unknown
# Shown when the bridge has been used for the most recent Tor circuit, i.e. the most recent bridge we have connected to.
tor-bridges-status-connected = Connected
# Used when the bridge has no status, i.e. the *absence* of a status to report to the user. This is only visibly shown when the status cell has keyboard focus.
tor-bridges-status-none = No status
# The "..." menu button for an individual bridge row.
tor-bridges-individual-bridge-options-button =
    .title = Bridge options
# Shown in the "..." menu for an individual bridge. Shows the QR code for this one bridge.
tor-bridges-menu-item-qr-address = Show QR code
    .accesskey = Q
# Shown in the "..." menu for an individual bridge. Copies the single bridge address to clipboard.
tor-bridges-menu-item-copy-address = Copy bridge address
    .accesskey = C
# Shown in the "..." menu for an individual bridge. Removes this one bridge.
tor-bridges-menu-item-remove-bridge = Remove bridge
    .accesskey = R

# Text shown just before a description of the most recent change to the list of user's bridges. Some white space will separate this text from the change description.
# This text is not visible, but is instead used for screen reader users.
# E.g. in English this could be "Recent update: One of your Tor bridges has been removed."
tor-bridges-update-area-intro = Recent update:
# Update text for screen reader users when only one of their bridges has been removed.
tor-bridges-update-removed-one-bridge = One of your Tor bridges has been removed.
# Update text for screen reader users when all of their bridges have been removed.
tor-bridges-update-removed-all-bridges = All of your Tor bridges have been removed.
# Update text for screen reader users when their bridges have changed in some arbitrary way.
tor-bridges-update-changed-bridges = Your Tor bridges have changed.

# Shown for requested bridges and bridges added by the user.
tor-bridges-share-heading = Help others connect
#
tor-bridges-share-description = Share your bridges with trusted contacts.
tor-bridges-copy-addresses-button = Copy addresses
tor-bridges-qr-addresses-button =
    .title = Show QR code

# Shown as a heading when the user has no current bridges.
tor-bridges-add-bridges-heading = Add bridges
# Shown as a heading when the user has existing bridges that can be replaced.
tor-bridges-replace-bridges-heading = Replace your bridges

tor-bridges-select-built-in-description = Choose from one of { -brand-short-name }’s built-in bridges
tor-bridges-select-built-in-button = Select a built-in bridge…

tor-bridges-add-addresses-description = Enter bridge addresses you already know
# Shown when the user has no current bridges.
# Opens a dialog where the user can provide a new bridge address or share code.
tor-bridges-add-new-button = Add new bridges…
# Shown when the user has existing bridges.
# Opens a dialog where the user can provide a new bridge address or share code to replace their current bridges.
tor-bridges-replace-button = Replace bridges…

tor-bridges-find-more-heading = Find more bridges
# "Tor Project" is the organisation name.
tor-bridges-find-more-description = Since many bridge addresses aren’t public, you may need to request some from the Tor Project.

# "Telegram" is the common brand name of the Telegram Messenger application
tor-bridges-provider-telegram-name = Telegram
# Here "Message" is a verb, short for "Send a message to". This is an instruction to send a message to the given Telegram Messenger user to receive a new bridge.
# $telegramUserName (String) - The Telegram Messenger user name that should receive messages. Should be wrapped in '<a data-l10n-name="user">' and '</a>'.
# E.g. in English, "Message GetBridgesBot".
tor-bridges-provider-telegram-instruction = Message <a data-l10n-name="user">{ $telegramUserName }</a>

# "Web" is the proper noun for the "World Wide Web".
tor-bridges-provider-web-name = Web
# Instructions to visit the given website.
# $url (String) - The URL for Tor Project bridges. Should be wrapped in '<a data-l10n-name"url">' and '</a>'.
tor-bridges-provider-web-instruction = Visit <a data-l10n-name="url">{ $url }</a>

# "Gmail" is the Google brand name. "Riseup" refers to the Riseup organisation at riseup.net.
tor-bridges-provider-email-name = Gmail or Riseup
# Here "Email" is a verb, short for "Send an email to". This is an instruction to send an email to the given address to receive a new bridge.
# $address (String) - The email address that should receive the email.
# E.g. in English, "Email bridges@torproject.org".
tor-bridges-provider-email-instruction = Email { $address }

tor-bridges-request-from-browser = You can also get bridges from the bridge bot without leaving { -brand-short-name }.
tor-bridges-request-button = Request bridges…

## User provided bridge dialog.

# Used when the user is editing their existing bridge addresses.
user-provide-bridge-dialog-edit-title =
    .title = Edit your bridges
# Used when the user has no existing bridges.
user-provide-bridge-dialog-add-title =
    .title = Add new bridges
# Used when the user is replacing their existing bridges with new ones.
user-provide-bridge-dialog-replace-title =
    .title = Replace your bridges
# Description shown when adding new bridges, replacing existing bridges, or editing existing bridges.
user-provide-bridge-dialog-description = Use bridges provided by a trusted organisation or someone you know.
# "Learn more" link shown in the "Add new bridges"/"Replace your bridges" dialog.
user-provide-bridge-dialog-learn-more = Learn more
# Short accessible name for the bridge addresses text area.
user-provide-bridge-dialog-textarea-addresses-label = Bridge addresses
# Placeholder shown when adding new bridge addresses.
user-provide-bridge-dialog-textarea-addresses =
    .placeholder = Paste your bridge addresses here
# Error shown when one of the address lines is invalid.
# $line (Number) - The line number for the invalid address.
user-provide-bridge-dialog-address-error = Incorrectly formatted bridge address on line { $line }.

user-provide-bridge-dialog-result-addresses = The following bridges were entered by you.
user-provide-bridge-dialog-next-button =
    .label = Next
