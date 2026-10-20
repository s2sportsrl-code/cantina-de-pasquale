import { assessRetailerMarket, type MarketWine } from "../supabase/functions/_shared/retailer-market.ts";

const contact = Deno.env.get("MARKET_RESEARCH_CONTACT") || "";
if (!contact) throw new Error("Set MARKET_RESEARCH_CONTACT to a real maintainer email before live requests.");

const wines: MarketWine[] = [
  { name: "Le Réserve", producer: "Billecart-Salmon", vintage: null },
  { name: "Carte Blanche", producer: "Haton & Filles", vintage: null },
  { name: "Chablis", producer: "Maison Simonnet-Febvre", vintage: 2020 },
  { name: "Château Beychevelle", producer: "Château Beychevelle", vintage: 2020 },
  { name: "Brut Imperial Rosé", producer: "Moët & Chandon", vintage: null },
];

let nextRequestAt = 0;
async function localRateGuard(_host: string, intervalSeconds: number, backoffSeconds = 0) {
  const now = Date.now();
  if (backoffSeconds > 0) {
    nextRequestAt = Math.max(nextRequestAt, now) + backoffSeconds * 1000;
    return;
  }
  const reservedAt = Math.max(nextRequestAt, now);
  nextRequestAt = reservedAt + intervalSeconds * 1000;
  const delay = reservedAt - now;
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
}

const results = [];
for (const wine of wines) {
  try {
    results.push({ wine: { name: wine.name, producer: wine.producer, vintage: wine.vintage }, ...(await assessRetailerMarket(wine, contact, localRateGuard)) });
  } catch (error) {
    results.push({
      wine: { name: wine.name, producer: wine.producer, vintage: wine.vintage },
      status: "error",
      reason: error instanceof Error ? error.message : String(error),
    });
    if ((error as { category?: string })?.category === "rate_limited") break;
  }
}

const report = {
  test: "live retailer HTML/structured-data pilot",
  checked_at: new Date().toISOString(),
  requested: wines.length,
  tested: results.length,
  saved_prices: false,
  retailer: "Vinatis (www.vinatis.it)",
  results,
};
console.log(JSON.stringify(report, null, 2));
if (results.length !== wines.length) Deno.exitCode = 1;
