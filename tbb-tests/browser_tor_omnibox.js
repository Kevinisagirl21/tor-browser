// # Test Tor Omnibox
// Check what search engines are installed in the search box.

add_task(async function() {
  // Grab engine IDs.
  let browserSearchService = Cc[
      "@mozilla.org/browser/search-service;1"
    ].getService(Ci.nsISearchService),
    engineIDs = (await browserSearchService.getEngines()).map(
      e => e.identifier
    );

  // Check that we have the correct engines installed, in the right order.
  is(engineIDs[0], "ddg", "Default search engine is duckduckgo");
  is(engineIDs[1], "youtube", "Secondary search engine is youtube");
  is(engineIDs[2], "google", "Google is third search engine");
  is(engineIDs[3], "blockchair", "Blockchair is fourth search engine");
  is(engineIDs[4], "ddg-onion", "Duck Duck Go Onion is fifth search engine");
  is(engineIDs[5], "startpage", "Startpage is sixth search engine");
  is(engineIDs[6], "twitter", "Twitter is sixth search engine");
  is(engineIDs[7], "wikipedia", "Wikipedia is seventh search engine");
  is(engineIDs[8], "yahoo", "Yahoo is eighth search engine");
});
