import {
  calculateMarketAssessment,
  expectedFormatMl,
  median,
  normalizeMarketText,
  parseProductPageOffers,
  parseRobots,
  parseVinatisSearchResults,
  productIdentityMatches,
  robotsAllows,
  type RetailerOffer,
} from "./retailer-market.ts";

Deno.test("normalizes wine identities consistently", () => {
  if (normalizeMarketText("Moët & Chandon — Réserve") !== "moet e chandon reserve") {
    throw new Error("Accents, punctuation, and ampersands should normalize consistently.");
  }
});

Deno.test("computes a median without mutating its input", () => {
  const prices = [90, 10, 50, 30];
  if (median(prices) !== 40) throw new Error("Expected the median of four prices to be 40.");
  if (prices.join(",") !== "90,10,50,30") throw new Error("Median calculation mutated its input.");
  if (median([]) !== null || median([10, Number.NaN]) !== null) throw new Error("Invalid median inputs must return null.");
});

Deno.test("extracts the retailer's structured product search payload", () => {
  const html = `<script>var product_elastic = {"products":[{"id":7,"name":"Barolo; \\\"Riserva\\\"","prices":{"price":42.5}}]};</script>`;
  const products = parseVinatisSearchResults(html);
  if (products.length !== 1 || products[0].id !== 7 || products[0].prices.price !== 42.5) {
    throw new Error("Could not parse the embedded product search results.");
  }
  if (parseVinatisSearchResults("<html></html>").length !== 0) {
    throw new Error("Missing search data should not produce a product.");
  }
});

Deno.test("checks producer, label, vintage, and exact bottle size", () => {
  const wine = { name: "Le Réserve", producer: "Billecart-Salmon", vintage: null, format_ml: 750 };
  const product = {
    name: "Champagne Billecart Salmon - Le Réserve",
    manufacturer_name: "Champagne Billecart-Salmon",
    features: { capacity: 0.75 },
  };
  if (!productIdentityMatches(wine, product).valid) throw new Error("An exact non-vintage 750 ml wine should match.");
  if (productIdentityMatches(wine, { ...product, manufacturer_name: "Other Producer" }).valid) {
    throw new Error("A different producer must not match.");
  }
  if (productIdentityMatches(wine, { ...product, features: { capacity: 1.5 } }).valid) {
    throw new Error("A magnum must not match a standard bottle.");
  }
  if (productIdentityMatches({ ...wine, vintage: 2020 }, product).valid) {
    throw new Error("A non-vintage page must not match an explicitly dated bottle.");
  }
  if (productIdentityMatches({ ...wine, name: "Réserve" }, product).valid) {
    throw new Error("A partial label name must not match.");
  }
  if (productIdentityMatches({ ...wine, format_ml: null }, product).valid) {
    throw new Error("An unknown cellar format must not be assumed to be 750 ml.");
  }
});

Deno.test("infers common bottle sizes from explicit label text", () => {
  if (expectedFormatMl({ name: "Wine Magnum", producer: "Winery", vintage: null }) !== 1500) {
    throw new Error("Magnum should map to 1500 ml.");
  }
  if (expectedFormatMl({ name: "Wine 375 ml", producer: "Winery", vintage: null }) !== 375) {
    throw new Error("An explicit 375 ml size should be retained.");
  }
  if (expectedFormatMl({ name: "Wine", producer: "Winery", vintage: null }) !== null) {
    throw new Error("An unspecified cellar bottle size must remain unknown.");
  }
});

Deno.test("parses only single-bottle in-stock EUR structured offers", () => {
  const html = `
    <div itemscope itemtype="https://schema.org/Product">
      <meta itemprop="sku" content="50">
      <meta itemprop="url" content="https://www.vinatis.it/50-wine">
      <meta itemprop="name" content="Wine Label 2020">
      <div itemprop="brand" itemscope itemtype="https://schema.org/Brand">
        <meta itemprop="name" content="Wine Producer">
      </div>
      <div itemprop="offers" itemscope itemtype="https://schema.org/AggregateOffer">
        <div itemprop="offers" itemscope itemtype="https://schema.org/Offer">
          <meta itemprop="price" content="40">
          <meta itemprop="priceCurrency" content="EUR">
          <meta itemprop="eligibleQuantity" content="6">
          <link itemprop="availability" href="https://schema.org/InStock">
        </div>
        <div itemprop="offers" itemscope itemtype="https://schema.org/Offer">
          <meta itemprop="price" content="9">
          <meta itemprop="priceCurrency" content="USD">
          <meta itemprop="eligibleQuantity" content="1">
          <link itemprop="availability" href="https://schema.org/InStock">
        </div>
        <div itemprop="offers" itemscope itemtype="https://schema.org/Offer">
          <meta itemprop="price" content="20">
          <meta itemprop="priceCurrency" content="EUR">
          <meta itemprop="eligibleQuantity" content="1">
          <link itemprop="availability" href="https://schema.org/OutOfStock">
        </div>
        <div itemprop="offers" itemscope itemtype="https://schema.org/Offer">
          <meta itemprop="price" content="19">
          <meta itemprop="priceCurrency" content="EUR">
          <link itemprop="availability" href="https://schema.org/InStock">
        </div>
        <div itemprop="offers" itemscope itemtype="https://schema.org/Offer">
          <meta itemprop="price" content="22.50">
          <meta itemprop="priceCurrency" content="EUR">
          <meta itemprop="eligibleQuantity" content="1">
          <link itemprop="availability" href="https://schema.org/InStock">
        </div>
      </div>
    </div>`;
  const result = parseProductPageOffers(html, "https://www.vinatis.it/50-wine", "50");
  if (!result.verified || result.offers.length !== 1 || result.offers[0].price_eur !== 22.5) {
    throw new Error("Only the single-bottle, in-stock EUR offer should be accepted.");
  }
  const wrongSku = parseProductPageOffers(html, "https://www.vinatis.it/50-wine", "51");
  if (wrongSku.verified || wrongSku.offers.length) throw new Error("The product URL/SKU mismatch must be rejected.");
});

Deno.test("robots policy uses the most specific rule and records crawl delay", () => {
  const policy = parseRobots(
    "User-agent: *\nDisallow: /private\nAllow: /private/public\nCrawl-delay: 4\n",
    "CantinaDePasqualePriceResearch",
  );
  if (!robotsAllows("/products/wine", policy.rules)) throw new Error("Public product pages should remain allowed.");
  if (robotsAllows("/private/account", policy.rules)) throw new Error("Disallowed paths must be blocked.");
  if (!robotsAllows("/private/public/item", policy.rules)) throw new Error("A more specific allow rule should take precedence.");
  if (policy.crawlDelay !== 4) throw new Error("The published crawl delay was not read.");
});

Deno.test("deduplicates offers by retailer and assigns single-source low confidence", () => {
  const offers: RetailerOffer[] = [
    { retailer: "Retailer A", host: "a.example", url: "https://a.example/wine", retrieved_at: "2026-10-20T00:00:00Z", price_eur: 21, currency: "EUR", vintage: 2020, format_ml: 750 },
    { retailer: "Retailer A", host: "a.example", url: "https://a.example/wine-copy", retrieved_at: "2026-10-20T00:00:00Z", price_eur: 23, currency: "EUR", vintage: 2020, format_ml: 750 },
  ];
  const result = calculateMarketAssessment(offers);
  if (result.median_eur !== 21 || result.confidence !== "low" || result.offers.length !== 1) {
    throw new Error("Multiple pages from one retailer must count as one low-confidence offer.");
  }
});

Deno.test("computes a median from independent retailers", () => {
  const offers: RetailerOffer[] = [
    { retailer: "A", host: "a.example", url: "https://a.example/wine", retrieved_at: "2026-10-20T00:00:00Z", price_eur: 10, currency: "EUR", vintage: 2020, format_ml: 750 },
    { retailer: "B", host: "b.example", url: "https://b.example/wine", retrieved_at: "2026-10-20T00:00:00Z", price_eur: 20, currency: "EUR", vintage: 2020, format_ml: 750 },
    { retailer: "C", host: "c.example", url: "https://c.example/wine", retrieved_at: "2026-10-20T00:00:00Z", price_eur: 100, currency: "EUR", vintage: 2020, format_ml: 750 },
  ];
  const result = calculateMarketAssessment(offers);
  if (result.median_eur !== 20 || result.confidence !== "medium") {
    throw new Error("Three independent retailer prices should use their median and medium confidence.");
  }
});
