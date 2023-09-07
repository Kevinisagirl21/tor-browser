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


## 2023 year-end-campaign.

# Large introduction text.
yec-2023-introduction = Right now, Tor Browser is protecting your privacy and the privacy of millions of people like you!
# Follows directly below yec-2023-introduction.
# The <span data-l10n-name="attention"> tag is meant to bring some styling attention to the first phrase, but doesn't have any semantic meaning.
yec-2023-please-donate = <span data-l10n-name="attention">This is possible because of donations from our community.</span> If you value the privacy that Tor Browser offers yourself and others, please make a donation today. You’ll ensure Tor Browser continues to provide online privacy to everyone who needs it.
# Shown only during a period where donations will be matched. The end date should match the end of the year.
# $amount (Number) - The donation limit. This will be a whole-number and will be automatically formatted according to the language/locale: using the language's numeral symbols and thousand-separators.
# NOTE: The amount should be shown as USD (United States dollar) currency. In the original English string, the first "$" is the literal USD currency symbol, and this can be changed or removed when translating to whatever is most appropriate for USD currency in the locale. In contrast, the "$" at the start of "$amount" is part of the Fluent format's syntax and should not be changed when translating.
# For example, "${ $amount }" for English would eventually be shown as "$5,000", whilst "{ $amount } US$" for Arabic would be shown as "٥٬٠٠٠ US$".
# Translators: If you need any help or clarification, feel free to ask a question on weblate or in IRC (#tor-l10n).
yec-2023-matched-donation = From now until December 31, donations to the Tor Project will be matched one-to-one, up to ${ $amount }!
yec-2023-close-button =
    .title = Close
yec-2023-donate-button = Donate now
