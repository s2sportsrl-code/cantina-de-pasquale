export type MarketWine = {
  id?: string | number;
  name: string;
  producer: string | null;
  vintage: number | null;
  format_ml?: number | null;
  notes?: string | null;
};

export type RetailerOffer = {
  retailer: string;
  host: string;
  url: string;
  retrieved_at: string;
  price_eur: number;
  currency: "EUR";
  vintage: number | null;
  format_ml: number;
};

export type MarketAssessment = {
  status: "priced" | "unverifiable";
  reason: string | null;
  median_eur: number | null;
  confidence: "low" | "medium" | "high" | null;
  offers: RetailerOffer[];
};

export class RetailerMarketError extends Error {
  stage: string;
  http_status: number | null;
  category: string;
  retry_after_seconds: number | null;

  constructor(stage: string, category: string, message: string, httpStatus: number | null = null, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = "RetailerMarketError";
    this.stage = stage;
    this.category = category;
    this.http_status = httpStatus;
    this.retry_after_seconds = retryAfterSeconds;
  }
}

const retailerHost = "www.vinatis.it";
const retailerOrigin = `https://${retailerHost}`;
const userAgent = "CantinaDePasqualePriceResearch/1.0";
const maxHtmlBytes = 2_000_000;
const maxRobotsBytes = 256_000;
const minRequestIntervalSeconds = 3;
const robotsCacheMs = 6 * 60 * 60 * 1000;
const robotsCache = new Map<string, { expiresAt: number; rules: RobotsRule[]; crawlDelay: number }>();

export type RobotsRule = { allow: boolean; path: string };
type ProductRow = Record<string, any>;
type SourceRequestGuard = (host: string, minimumIntervalSeconds: number, backoffSeconds?: number) => Promise<void>;

export function normalizeMarketText(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("it-IT")
    .replace(/&/g, " e ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function median(values: number[]) {
  if (!values.length || values.some((value) => !Number.isFinite(value))) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function decodeHtml(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)));
}

function readJsonAssignment(html: string, assignment: string): unknown {
  const marker = html.indexOf(assignment);
  if (marker < 0) return null;
  const equals = html.indexOf("=", marker + assignment.length);
  if (equals < 0) return null;
  const start = html.slice(equals + 1).search(/\S/);
  if (start < 0) return null;
  const jsonStart = equals + 1 + start;
  const opening = html[jsonStart];
  if (opening !== "{" && opening !== "[") return null;
  const closing = opening === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = jsonStart; index < html.length; index++) {
    const character = html[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === opening) depth++;
    else if (character === closing && --depth === 0) {
      try {
        return JSON.parse(html.slice(jsonStart, index + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function parseVinatisSearchResults(html: string): ProductRow[] {
  const payload = readJsonAssignment(html, "var product_elastic");
  return Array.isArray((payload as any)?.products) ? (payload as any).products : [];
}

function attribute(tag: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = tag.match(new RegExp(`\\b${escaped}\\s*=\\s*(["'])(.*?)\\1`, "i"));
  return match ? decodeHtml(match[2]) : null;
}

function findDivScope(html: string, startExpression: RegExp, fromIndex = 0) {
  const start = startExpression.exec(html.slice(fromIndex));
  if (!start) return null;
  const startIndex = fromIndex + start.index;
  const opening = start[0];
  const tagName = opening.match(/^<([a-z][a-z0-9:-]*)/i)?.[1];
  if (!tagName) return null;
  const tagPattern = new RegExp(`<\\/?${tagName}\\b[^>]*>`, "gi");
  tagPattern.lastIndex = startIndex;
  let depth = 0;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(html))) {
    if (/^<\//.test(match[0])) depth--;
    else if (!/\/\s*>$/.test(match[0])) depth++;
    if (depth === 0) return html.slice(startIndex, tagPattern.lastIndex);
  }
  return null;
}

function itemScope(html: string, itemType: string, fromIndex = 0) {
  const escapedType = itemType.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(
    `<div\\b(?=[^>]*\\bitemscope\\b)(?=[^>]*\\bitemtype\\s*=\\s*["'][^"']*schema\\.org\\/${escapedType}["'])[^>]*>`,
    "i",
  );
  return findDivScope(html, expression, fromIndex);
}

function metaContent(scope: string, property: string) {
  const tags = scope.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    if (attribute(tag, "itemprop") === property) return attribute(tag, "content");
  }
  return null;
}

function linkContent(scope: string, property: string) {
  const tags = scope.match(/<link\b[^>]*>/gi) || [];
  for (const tag of tags) {
    if (attribute(tag, "itemprop") === property) return attribute(tag, "href");
  }
  return null;
}

function pageProductScope(html: string) {
  const markup = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  return itemScope(markup, "Product");
}

function productPageState(html: string) {
  const state = readJsonAssignment(html, "var product_page_elastic");
  return state && typeof state === "object" ? state as Record<string, any> : null;
}

function productVintage(product: ProductRow, state?: Record<string, any> | null) {
  const direct = state?.features?.vintage ?? product.features?.vintage ?? product.vintage;
  if (direct !== null && direct !== undefined && direct !== "" && Number(direct) !== 0) {
    const year = Number(direct);
    return Number.isInteger(year) && year >= 1800 && year <= 2200 ? year : null;
  }
  const name = String(product.name || "");
  const match = name.match(/\b(18\d{2}|19\d{2}|20\d{2}|21\d{2})\b/);
  return match ? Number(match[1]) : null;
}

export function expectedFormatMl(wine: MarketWine): number | null {
  for (const value of [wine.format_ml]) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric >= 100 && numeric <= 18000) return Math.round(numeric);
  }
  const identity = `${wine.name} ${wine.notes || ""}`.toLowerCase();
  const explicit = identity.match(/\b(\d{1,5}(?:[.,]\d+)?)\s*(litri|ml|cl|lt|l)\b/);
  if (explicit) {
    const amount = Number(explicit[1].replace(",", "."));
    const unit = explicit[2];
    return unit === "ml" ? Math.round(amount) : unit === "cl" ? Math.round(amount * 10) : Math.round(amount * 1000);
  }
  if (/\bmagnum\b/i.test(identity)) return 1500;
  if (/\b(?:mezza bottiglia|half bottle|demi bouteille|375)\b/i.test(identity)) return 375;
  return null;
}

function normalizedProducer(value: unknown) {
  return normalizeMarketText(value).replace(/^champagne /, "").replace(/ champagne$/, "").replace(/^maison /, "");
}

export function productIdentityMatches(wine: MarketWine, product: ProductRow, state?: Record<string, any> | null) {
  if (!wine.name.trim() || !wine.producer?.trim()) return { valid: false, reason: "Produttore o nome etichetta mancante." };
  const candidateName = normalizeMarketText(product.name);
  const expectedName = normalizeMarketText(wine.name);
  const expectedProducer = normalizedProducer(wine.producer);
  const actualProducer = normalizedProducer(product.manufacturer_name);
  if (!actualProducer || actualProducer !== expectedProducer) return { valid: false, reason: "Produttore non corrispondente." };

  const vintage = productVintage(product, state);
  const expectedVintage = wine.vintage === null || wine.vintage === undefined ? null : Number(wine.vintage);
  if (vintage !== expectedVintage) return { valid: false, reason: "Annata non corrispondente o non verificabile." };

  const titleTokens = candidateName.split(" ");
  const producerTokens = actualProducer.split(" ");
  const withoutProducer = [...titleTokens];
  if (withoutProducer[0] === "champagne") withoutProducer.shift();
  if (producerTokens.every((token, index) => withoutProducer[index] === token)) {
    withoutProducer.splice(0, producerTokens.length);
  } else if (producerTokens.every((token, index) => withoutProducer[withoutProducer.length - producerTokens.length + index] === token)) {
    withoutProducer.splice(-producerTokens.length);
  }
  while (withoutProducer[0] === "champagne") withoutProducer.shift();
  if (expectedVintage !== null) {
    const yearIndex = withoutProducer.indexOf(String(expectedVintage));
    if (yearIndex >= 0) withoutProducer.splice(yearIndex, 1);
  }
  if (withoutProducer.join(" ") !== expectedName) return { valid: false, reason: "Nome etichetta non corrispondente." };

  const format = Number(state?.features?.capacity ?? product.contenance ?? product.features?.capacity);
  const expectedFormat = expectedFormatMl(wine);
  if (expectedFormat === null) return { valid: false, reason: "Formato della cantina non verificabile." };
  if (!Number.isFinite(format) || Math.round(format * 1000) !== expectedFormat) {
    return { valid: false, reason: "Formato non corrispondente o non verificabile." };
  }
  return { valid: true, reason: null };
}

export function parseProductPageOffers(html: string, requestedUrl: string, expectedSku: string) {
  const product = pageProductScope(html);
  if (!product) return { verified: false, reason: "Pagina senza dati prodotto strutturati.", offers: [] as RetailerOffer[] };

  const sku = metaContent(product, "sku");
  const name = metaContent(product, "name");
  const brandScope = itemScope(product, "Brand");
  const producer = brandScope ? metaContent(brandScope, "name") : null;
  const canonical = metaContent(product, "url");
  let canonicalUrl: URL | null = null;
  try {
    canonicalUrl = canonical ? new URL(canonical) : null;
  } catch {
    canonicalUrl = null;
  }
  if (
    !sku || sku !== expectedSku || !name || !producer || !canonicalUrl ||
    canonicalUrl.protocol !== "https:" || canonicalUrl.hostname !== retailerHost ||
    new URL(requestedUrl).pathname !== canonicalUrl.pathname
  ) {
    return { verified: false, reason: "Identità prodotto incompleta nella pagina del rivenditore.", offers: [] as RetailerOffer[] };
  }

  let offset = 0;
  const offers: RetailerOffer[] = [];
  while (offset < product.length) {
    const offerScope = itemScope(product, "Offer", offset);
    if (!offerScope) break;
    const offerIndex = product.indexOf(offerScope, offset);
    offset = offerIndex + offerScope.length;
    const price = Number(metaContent(offerScope, "price"));
    const currency = metaContent(offerScope, "priceCurrency");
    const eligibleQuantity = metaContent(offerScope, "eligibleQuantity");
    const availability = linkContent(offerScope, "availability") || "";
    if (
      !Number.isFinite(price) || price <= 0 || price > 100_000 ||
      currency !== "EUR" || eligibleQuantity === null || Number(eligibleQuantity) !== 1 ||
      !/\/InStock$/i.test(availability)
    ) continue;
    offers.push({
      retailer: "Vinatis",
      host: retailerHost,
      url: canonicalUrl.toString(),
      retrieved_at: new Date().toISOString(),
      price_eur: price,
      currency: "EUR",
      vintage: null,
      format_ml: 0,
    });
  }
  return { verified: true, reason: offers.length ? null : "Nessuna offerta singola in EUR con disponibilità verificabile.", offers, name, producer };
}

export function parseRobots(text: string, userAgentToken: string) {
  const groups: { agents: string[]; rules: RobotsRule[]; crawlDelay: number }[] = [];
  let group: { agents: string[]; rules: RobotsRule[]; crawlDelay: number } | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const directive = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (directive === "user-agent") {
      if (!group || group.rules.length || group.crawlDelay) {
        group = { agents: [], rules: [], crawlDelay: 0 };
        groups.push(group);
      }
      group.agents.push(value.toLowerCase());
    } else if (group && directive === "disallow" && value) {
      group.rules.push({ allow: false, path: value });
    } else if (group && directive === "allow" && value) {
      group.rules.push({ allow: true, path: value });
    } else if (group && directive === "crawl-delay") {
      const delay = Number(value);
      if (Number.isFinite(delay) && delay > 0) group.crawlDelay = delay;
    }
  }
  const matchingGroups = groups.filter((item) => item.agents.includes("*") || item.agents.some((agent) => userAgentToken.toLowerCase().includes(agent)));
  const rules = matchingGroups.flatMap((item) => item.rules);
  const crawlDelay = Math.max(0, ...matchingGroups.map((item) => item.crawlDelay));
  return { rules, crawlDelay };
}

function retryAfterSeconds(header: string | null) {
  if (!header) return 60;
  if (/^\d+(?:\.\d+)?$/.test(header)) return Math.max(0, Math.ceil(Number(header)));
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1000)) : 60;
}

async function readLimitedResponseText(response: Response, maxBytes: number, stage: string, description: string) {
  const declaredLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new RetailerMarketError(stage, "response_too_large", description);
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new RetailerMarketError(stage, "response_too_large", description);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export function robotsAllows(pathAndQuery: string, rules: RobotsRule[]) {
  const matching = rules
    .filter((rule) => {
      const expression = `^${rule.path.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}${rule.path.endsWith("$") ? "" : ""}`;
      const anchored = rule.path.endsWith("$") ? expression.slice(0, -2) + "$" : expression;
      return new RegExp(anchored).test(pathAndQuery);
    })
    .sort((left, right) => right.path.replace(/\*|\$/g, "").length - left.path.replace(/\*|\$/g, "").length);
  if (!matching.length) return true;
  const mostSpecificLength = matching[0].path.replace(/\*|\$/g, "").length;
  const mostSpecific = matching.filter((rule) => rule.path.replace(/\*|\$/g, "").length === mostSpecificLength);
  return mostSpecific.some((rule) => rule.allow);
}

async function readRobots(guard: SourceRequestGuard, contact: string) {
  const cached = robotsCache.get(retailerHost);
  if (cached && cached.expiresAt > Date.now()) return cached;
  let robotsUrl = new URL("/robots.txt", retailerOrigin);
  let response: Response | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    await guard(retailerHost, minRequestIntervalSeconds);
    try {
      response = await fetch(robotsUrl, {
        headers: { "User-Agent": `${userAgent} (+mailto:${contact})` },
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new RetailerMarketError("robots", "network_error", `Impossibile verificare robots.txt: ${String(error).slice(0, 180)}`);
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("Location");
    if (!location) throw new RetailerMarketError("robots", "redirect_blocked", "robots.txt ha restituito un redirect senza destinazione.", response.status);
    const nextUrl = new URL(location, robotsUrl);
    if (nextUrl.protocol !== "https:" || nextUrl.hostname !== retailerHost) {
      throw new RetailerMarketError("robots", "redirect_blocked", "Il redirect di robots.txt esce dal dominio autorizzato.", response.status);
    }
    robotsUrl = nextUrl;
  }
  if (!response) throw new RetailerMarketError("robots", "network_error", "robots.txt non ha restituito una risposta.");
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    throw new RetailerMarketError("robots", "redirect_limit", "robots.txt ha superato il limite di redirect.");
  }
  if (response.status === 429) {
    const retryAfter = retryAfterSeconds(response.headers.get("Retry-After"));
    await guard(retailerHost, minRequestIntervalSeconds, Math.min(604_800, retryAfter));
    throw new RetailerMarketError("robots", "rate_limited", "Il rivenditore ha limitato la lettura di robots.txt.", 429, retryAfter);
  }
  if (!response.ok) throw new RetailerMarketError("robots", "http_error", `robots.txt ha risposto HTTP ${response.status}.`, response.status);
  const policy = parseRobots(
    await readLimitedResponseText(response, maxRobotsBytes, "robots", "robots.txt supera il limite di dimensione."),
    "CantinaDePasqualePriceResearch",
  );
  const value = { expiresAt: Date.now() + robotsCacheMs, rules: policy.rules, crawlDelay: policy.crawlDelay };
  robotsCache.set(retailerHost, value);
  return value;
}

async function fetchPublicPage(url: URL, guard: SourceRequestGuard, stage: string, contact: string) {
  if (url.protocol !== "https:" || url.hostname !== retailerHost || url.username || url.password) {
    throw new RetailerMarketError(stage, "blocked_host", "La richiesta è fuori dal dominio pubblico autorizzato.");
  }
  const robots = await readRobots(guard, contact);
  if (!robotsAllows(`${url.pathname}${url.search}`, robots.rules)) {
    throw new RetailerMarketError(stage, "robots_disallowed", "La URL è esclusa dalle regole robots.txt.");
  }
  await guard(retailerHost, Math.max(minRequestIntervalSeconds, robots.crawlDelay));
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        "User-Agent": `${userAgent} (+mailto:${contact})`,
        "Accept": "text/html,application/xhtml+xml",
      },
      redirect: "error",
      signal: AbortSignal.timeout(12_000),
    });
  } catch (error) {
    throw new RetailerMarketError(stage, "network_error", `Richiesta al rivenditore non riuscita: ${String(error).slice(0, 180)}`);
  }
  if (!response.ok) {
    if (response.status === 429) {
      const retryAfter = retryAfterSeconds(response.headers.get("Retry-After"));
      await guard(retailerHost, minRequestIntervalSeconds, Math.min(604_800, retryAfter));
      throw new RetailerMarketError(
        stage,
        "rate_limited",
        "Il rivenditore ha richiesto di rallentare. Il refresh si è fermato senza riprovare.",
        response.status,
        retryAfter,
      );
    }
    throw new RetailerMarketError(stage, "http_error", `Il rivenditore ha risposto HTTP ${response.status}.`, response.status);
  }
  if (new URL(response.url).hostname !== retailerHost) {
    throw new RetailerMarketError(stage, "redirect_blocked", "Il rivenditore ha rediretto fuori dal dominio autorizzato.");
  }
  if (!/text\/html|application\/xhtml\+xml/i.test(response.headers.get("Content-Type") || "")) {
    throw new RetailerMarketError(stage, "unexpected_content_type", "La risposta del rivenditore non è una pagina HTML.");
  }
  return await readLimitedResponseText(response, maxHtmlBytes, stage, "La pagina del rivenditore supera il limite di dimensione.");
}

function sourceProductUrl(product: ProductRow) {
  const id = Number(product.id);
  const slug = String(product.link_rewrite || "");
  if (!Number.isSafeInteger(id) || id <= 0 || !/^[a-z0-9-]+$/i.test(slug)) return null;
  return new URL(`/${id}-${slug}`, retailerOrigin);
}

function matchedSearchProduct(wine: MarketWine, results: ProductRow[]) {
  const candidates = results
    .filter((product) => {
      if (!product || typeof product !== "object") return false;
      const title = normalizeMarketText(`${product.name || ""} ${product.link_rewrite || ""}`);
      const multipack = /\b(pack|multipack|multi pack|lot|caisse|coffret|carton de \d+|x ?\d+)\b/.test(title);
      return product.cache_is_pack !== true && product.buy_by_multiple !== true && !multipack;
    })
    .map((product) => ({ product, match: productIdentityMatches(wine, product) }))
    .filter((item) => item.match.valid);
  return candidates[0]?.product || null;
}

export function calculateMarketAssessment(offers: RetailerOffer[]): MarketAssessment {
  const uniqueByHost = new Map<string, RetailerOffer>();
  for (const offer of offers) {
    if (!uniqueByHost.has(offer.host)) uniqueByHost.set(offer.host, offer);
  }
  const independent = [...uniqueByHost.values()].slice(0, 5);
  if (!independent.length) return { status: "unverifiable", reason: "Nessuna offerta verificabile.", median_eur: null, confidence: null, offers: [] };
  const confidence = independent.length === 1 ? "low" : independent.length < 4 ? "medium" : "high";
  return {
    status: "priced",
    reason: null,
    median_eur: median(independent.map((offer) => offer.price_eur)),
    confidence,
    offers: independent,
  };
}

export async function assessRetailerMarket(
  wine: MarketWine,
  contact: string,
  guard: SourceRequestGuard,
): Promise<MarketAssessment> {
  const normalizedContact = contact.trim();
  if (!/^([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})$/i.test(normalizedContact)) {
    throw new RetailerMarketError("configuration", "configuration_error", "MARKET_RESEARCH_CONTACT deve essere un indirizzo email di contatto valido.");
  }
  if (!wine.name?.trim() || !wine.producer?.trim()) {
    return { status: "unverifiable", reason: "Produttore o nome etichetta mancante.", median_eur: null, confidence: null, offers: [] };
  }
  if (expectedFormatMl(wine) === null) {
    return { status: "unverifiable", reason: "Formato della cantina non verificabile.", median_eur: null, confidence: null, offers: [] };
  }

  const searchUrl = new URL("/cerca", retailerOrigin);
  searchUrl.searchParams.set("search_query", `${wine.producer} ${wine.name} ${wine.vintage ?? ""}`.trim());
  const searchHtml = await fetchPublicPage(searchUrl, guard, "product_search", normalizedContact);
  const results = parseVinatisSearchResults(searchHtml);
  const product = matchedSearchProduct(wine, results);
  if (!product) {
    return { status: "unverifiable", reason: "Nessun risultato esatto per produttore, etichetta, annata e formato.", median_eur: null, confidence: null, offers: [] };
  }

  const productUrl = sourceProductUrl(product);
  if (!productUrl) {
    return { status: "unverifiable", reason: "URL prodotto non valida.", median_eur: null, confidence: null, offers: [] };
  }
  const productHtml = await fetchPublicPage(productUrl, guard, "product_page", normalizedContact);
  const detail = parseProductPageOffers(productHtml, productUrl.toString(), String(product.id));
  if (!detail.verified) {
    return { status: "unverifiable", reason: detail.reason, median_eur: null, confidence: null, offers: [] };
  }

  const detailMatch = productIdentityMatches(wine, {
    ...product,
    name: detail.name,
    manufacturer_name: detail.producer,
  }, productPageState(productHtml));
  if (!detailMatch.valid) {
    return { status: "unverifiable", reason: detailMatch.reason, median_eur: null, confidence: null, offers: [] };
  }
  const vintage = productVintage(product, productPageState(productHtml));
  const formatMl = Math.round(Number(productPageState(productHtml)?.features?.capacity ?? product.contenance ?? product.features?.capacity) * 1000);
  const offers = detail.offers.map((offer) => ({ ...offer, vintage, format_ml: formatMl }));
  return calculateMarketAssessment(offers);
}
