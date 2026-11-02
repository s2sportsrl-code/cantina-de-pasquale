const test = require("node:test");
const assert = require("node:assert/strict");
const resolveWineMarketValue = require("../market-value.js");

const approvedSource = {
  type: "manual_approved_valuation",
  assessed_on: "2026-10-31",
  note: "Valutazione manuale approvata",
};

test("uses the approved manual median without treating old ranges as verified quotes", () => {
  const wine = {
    market_value_min: 285,
    market_value_max: 330,
    market_value_median: 300,
    market_sources: [approvedSource],
    market_source_count: 0,
  };

  assert.deepEqual(resolveWineMarketValue(wine), {
    amount: 300,
    approvedManual: true,
    hasVerifiedQuotes: false,
  });
});

test("preserves max-then-min selection for other wines", () => {
  assert.equal(resolveWineMarketValue({
    market_value_min: 10,
    market_value_max: 20,
    market_value_median: 15,
  }).amount, 20);
  assert.equal(resolveWineMarketValue({
    market_value_min: 10,
    market_value_max: null,
    market_value_median: 15,
  }).amount, 10);
});

test("uses the five approved medians once to calculate the 840 euro total", () => {
  const wines = [
    { quantity: 1, market_value_min: 285, market_value_max: 330, market_value_median: 300, market_sources: [approvedSource], market_source_count: 0 },
    { quantity: 1, market_value_min: 195, market_value_max: 240, market_value_median: 230, market_sources: [approvedSource], market_source_count: 0 },
    { quantity: 1, market_value_min: 110, market_value_max: 110, market_value_median: 123, market_sources: [approvedSource], market_source_count: 0 },
    { quantity: 1, market_value_min: 109, market_value_max: 126, market_value_median: 127, market_sources: [approvedSource], market_source_count: 0 },
    { quantity: 1, market_value_min: 65, market_value_max: 65, market_value_median: 60, market_sources: [approvedSource], market_source_count: 0 },
  ];

  const total = wines.reduce((sum, wine) =>
    sum + wine.quantity * (resolveWineMarketValue(wine).amount ?? 0), 0);

  assert.equal(total, 840);
});
