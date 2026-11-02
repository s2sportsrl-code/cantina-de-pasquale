const test = require("node:test");
const assert = require("node:assert/strict");
const {
  formatMarketMetadata,
  formatMarketReference,
} = require("../market-presentation.js");

test("formats a concise approximate price for cards and detail values", () => {
  assert.equal(formatMarketReference({ amount: 127 }), '<span class="market-reference">≈ €127</span>');
  assert.equal(formatMarketReference({ amount: null }), "—");
});

test("shows approved provenance and unavailable range without verified quotes", () => {
  const wine = {
    market_value_min: 109,
    market_value_max: 126,
    market_sources: [{
      type: "manual_approved_valuation",
      assessed_on: "2026-10-31",
      note: "Valutazione manuale approvata",
    }],
    market_source_count: 0,
  };
  const metadata = formatMarketMetadata(wine, {
    approvedManual: true,
    hasVerifiedQuotes: false,
  });

  assert.match(metadata, /Provenienza: Valutazione manuale approvata/);
  assert.match(metadata, /Data: 31\/10\/2026/);
  assert.match(metadata, /Fascia di mercato: non disponibile/);
  assert.doesNotMatch(metadata, /109|126/);
});

test("escapes provenance and formats verified ranges without altering them", () => {
  const wine = {
    market_value_min: 109,
    market_value_max: 127,
    market_sources: [{ retailer: "<Vineria>" }],
    market_source_count: 1,
  };
  const metadata = formatMarketMetadata(wine, {
    approvedManual: false,
    hasVerifiedQuotes: true,
  });

  assert.match(metadata, /Provenienza: &lt;Vineria&gt;/);
  assert.match(metadata, /Fascia di mercato: €109–€127/);
});
