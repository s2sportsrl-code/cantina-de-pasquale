(function (root) {
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[character]);
  }

  function formatMarketDate(value) {
    if (!value) return "non disponibile";
    const dateOnly = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (dateOnly) return `${dateOnly[3]}/${dateOnly[2]}/${dateOnly[1]}`;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "non disponibile" : date.toLocaleDateString("it-IT");
  }

  function formatMarketReference(reference) {
    if (reference.amount == null) return "—";
    const amount = Number(reference.amount).toLocaleString("it-IT", { maximumFractionDigits: 2 });
    return `<span class="market-reference">≈ €${amount}</span>`;
  }

  function formatMarketMetadata(wine, reference) {
    const sources = Array.isArray(wine.market_sources)
      ? wine.market_sources.filter((source) => source && typeof source === "object")
      : [];
    const manualSource = sources.find((source) => source.type === "manual_approved_valuation");
    const provenance = manualSource
      ? manualSource.note || "Valutazione manuale approvata"
      : [...new Set(sources.map((source) => source.retailer).filter(Boolean))].join(", ") || "non disponibile";
    const sourceDate = sources.find((source) => source.assessed_on || source.retrieved_at);
    const assessedDate = formatMarketDate(
      sourceDate?.assessed_on || sourceDate?.retrieved_at || wine.last_market_check,
    );
    const minimum = Number(wine.market_value_min);
    const maximum = Number(wine.market_value_max);
    const hasRange = reference.hasVerifiedQuotes &&
      Number.isFinite(minimum) && Number.isFinite(maximum);
    const range = hasRange
      ? minimum === maximum
        ? `€${minimum.toLocaleString("it-IT", { maximumFractionDigits: 2 })}`
        : `€${minimum.toLocaleString("it-IT", { maximumFractionDigits: 2 })}–€${maximum.toLocaleString("it-IT", { maximumFractionDigits: 2 })}`
      : "non disponibile";

    return `<div class="market-metadata"><span>Provenienza: ${escapeHtml(provenance)}</span><span>Data: ${escapeHtml(assessedDate)}</span><span>Fascia di mercato: ${range}</span></div>`;
  }

  root.formatMarketReference = formatMarketReference;
  root.formatMarketMetadata = formatMarketMetadata;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { formatMarketReference, formatMarketMetadata };
  }
})(globalThis);
