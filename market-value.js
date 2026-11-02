(function (root) {
  function resolveWineMarketValue(wine) {
    const approvedManual = Array.isArray(wine?.market_sources) &&
      wine.market_sources.some((source) =>
        source && typeof source === "object" && source.type === "manual_approved_valuation"
      );
    const sourceCount = Number(wine?.market_source_count);
    const hasVerifiedQuotes = Number.isFinite(sourceCount) && sourceCount > 0;
    const rawValue = approvedManual
      ? wine.market_value_median
      : wine.market_value_max ?? wine.market_value_min;
    const amount = rawValue == null ? null : Number(rawValue);

    return {
      amount: Number.isFinite(amount) ? amount : null,
      approvedManual,
      hasVerifiedQuotes,
    };
  }

  root.resolveWineMarketValue = resolveWineMarketValue;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = resolveWineMarketValue;
  }
})(globalThis);
