import {
  assessRetailerMarket,
  RetailerMarketError,
  type MarketAssessment,
  type MarketWine,
} from "./retailer-market.ts";

const json = (value: unknown) => JSON.stringify(value);
const serviceHeaders = () => {
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
  return { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
};
const baseUrl = () => {
  const url = Deno.env.get("SUPABASE_URL");
  if (!url) throw new Error("SUPABASE_URL is not configured");
  return url;
};

async function db(path: string, init: RequestInit = {}) {
  const response = await fetch(`${baseUrl()}/rest/v1/${path}`, {
    ...init,
    headers: { ...serviceHeaders(), ...(init.headers || {}) },
  });
  if (!response.ok) throw new Error(`Database request failed (${response.status}): ${await response.text()}`);
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

const textFrom = (payload: any) => payload?.candidates?.[0]?.content?.parts?.map((part: any) => part.text || "").join("").trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "");
export type GeminiDiagnostic = {
  stage: string;
  model: string;
  http_status: number | null;
  code: number | string | null;
  status: string | null;
  category: string;
  message: string;
  details: unknown[];
};

export class GeminiRequestError extends Error {
  diagnostic: GeminiDiagnostic;
  stopBatch = true;
  constructor(diagnostic: GeminiDiagnostic) {
    super(diagnostic.message);
    this.name = "GeminiRequestError";
    this.diagnostic = diagnostic;
  }
}

function safeProviderMessage(value: unknown) {
  return String(value || "Gemini request failed")
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[redacted]")
    .replace(/(key=)[^&\s]+/gi, "$1[redacted]")
    .replace(/projects\/[^/\s]+/gi, "projects/[redacted]")
    .slice(0, 600);
}

function safeProviderDetails(details: any) {
  if (!Array.isArray(details)) return [];
  const safeFields = ["reason", "domain", "quotaMetric", "quotaId", "quotaLimit", "quotaValue", "retryDelay", "quota_metric", "quota_id", "quota_limit", "quota_value", "retry_delay", "service", "method"];
  return details.slice(0, 8).map((detail: any) => {
    const safe: Record<string, unknown> = {};
    if (typeof detail?.["@type"] === "string") safe.type = detail["@type"].slice(0, 160);
    for (const field of safeFields) {
      const value = detail?.[field] ?? detail?.metadata?.[field];
      if (typeof value === "string" || typeof value === "number") safe[field] = String(value).slice(0, 200);
    }
    if (Array.isArray(detail?.violations)) safe.violations = detail.violations.slice(0, 8).map((violation: any) => Object.fromEntries(safeFields.filter((field) => typeof violation?.[field] === "string" || typeof violation?.[field] === "number").map((field) => [field, String(violation[field]).slice(0, 200)])));
    return safe;
  });
}

function providerDiagnostic(stage: string, model: string, httpStatus: number | null, error: any): GeminiDiagnostic {
  const message = safeProviderMessage(error?.message);
  const details = safeProviderDetails(error?.details);
  const quotaText = `${message} ${JSON.stringify(details)}`.toLowerCase();
  const permanentQuota = /billing.{0,100}(not enabled|must be enabled|disabled|inactive|account required|enable billing|no billing)|billing_disabled|(?:quota|limit|quotavalue|quotalimit)[^\d]{0,40}0\b|\b0\s*(?:requests?|quota)\b/i.test(quotaText);
  const code = typeof error?.code === "number" || typeof error?.code === "string" ? error.code : null;
  const category = permanentQuota ? "permanent_quota" : httpStatus === 429 || code === 429 ? "temporary_rate_limit" : "provider_error";
  return { stage, model, http_status: httpStatus, code, status: typeof error?.status === "string" ? error.status.slice(0, 80) : null, category, message, details };
}

async function geminiJson(url: string, init?: RequestInit, model = "models.list", stage = "network") {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    throw new GeminiRequestError({ stage, model, http_status: null, code: "NETWORK_ERROR", status: null, category: "network_error", message: safeProviderMessage(error), details: [] });
  }
  const payload = await response.json().catch(() => null);
  return { response, payload };
}

export async function listGenerateContentModels(apiKey: string) {
  const models: any[] = [];
  const seenTokens = new Set<string>();
  let pageToken = "";
  do {
    const query = new URLSearchParams({ pageSize: "100" });
    if (pageToken) query.set("pageToken", pageToken);
    const { response, payload } = await geminiJson(`https://generativelanguage.googleapis.com/v1beta/models?${query}&key=${encodeURIComponent(apiKey)}`);
    if (!response.ok) throw new GeminiRequestError(providerDiagnostic("model_discovery", "models.list", response.status, payload?.error));
    if (Array.isArray(payload?.models)) models.push(...payload.models);
    pageToken = typeof payload?.nextPageToken === "string" ? payload.nextPageToken : "";
    if (pageToken && seenTokens.has(pageToken)) break;
    if (pageToken) seenTokens.add(pageToken);
  } while (pageToken);

  const candidates = models
    .filter((model) => typeof model?.name === "string" && /^models\/gemini-/i.test(model.name) && Array.isArray(model.supportedGenerationMethods) && model.supportedGenerationMethods.includes("generateContent") && isTextSearchModel(model.name, model.displayName || ""))
    .map((model) => model.name.replace(/^models\//i, ""));
  const unique = [...new Set(candidates)];
  unique.sort((left, right) => {
    const rank = (name: string) => {
      const experimental = /(preview|experimental|exp-)/i.test(name);
      if (/flash/i.test(name)) return experimental ? 2 : 0;
      return experimental ? 3 : 1;
    };
    const version = (name: string) => {
      const match = name.match(/gemini-(\d+)\.(\d+)/i);
      return match ? Number(match[1]) * 100 + Number(match[2]) : 0;
    };
    return rank(left) - rank(right) || version(right) - version(left) || left.localeCompare(right);
  });
  if (!unique.length) throw new GeminiRequestError({ stage: "model_discovery", model: "models.list", http_status: 200, code: "NO_TEXT_SEARCH_MODELS", status: null, category: "no_compatible_models", message: "Gemini Models API non ha restituito modelli testuali idonei con generateContent.", details: [] });
  return unique;
}

export function isTextSearchModel(modelName: string, metadata = "") {
  const name = modelName.toLowerCase().replace(/^models\//, "");
  const nonTextFamily = /(?:^|[-_/\s])(image|images|vision|tts|text-to-speech|audio|native-audio|speech|voice|transcription|embedding|embed|video|veo|imagen|music|robotics|computer-use)(?:[-_/\s]|$)/i;
  return /^gemini-[a-z0-9.-]+$/i.test(name) && !nonTextFamily.test(`${name} ${metadata}`);
}

async function generateWithModel(apiKey: string, model: string, contents: any[]) {
  const { response, payload } = await geminiJson(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents, tools: [{ google_search: {} }], generationConfig: { temperature: 0.2, responseMimeType: "application/json" } }),
  }, model, "grounded_generation");
  if (!response.ok) throw new GeminiRequestError(providerDiagnostic("grounded_generation", model, response.status, payload?.error));
  return payload;
}

export async function generateGroundedContent(apiKey: string, prompt: string | any[], selectedModel?: string, excludedModels: string[] = []) {
  const contents = typeof prompt === "string" ? [{ role: "user", parts: [{ text: prompt }] }] : prompt;
  const maxModelAttempts = 5;
  const models = selectedModel && !excludedModels.includes(selectedModel)
    ? [selectedModel]
    : (await listGenerateContentModels(apiKey)).filter((model) => !excludedModels.includes(model)).slice(0, maxModelAttempts);
  const attempted = new Set<string>();
  const diagnostics: GeminiDiagnostic[] = [];
  for (let index = 0; index < models.length && attempted.size < maxModelAttempts; index++) {
    const model = models[index];
    if (attempted.has(model) || excludedModels.includes(model)) continue;
    attempted.add(model);
    try {
      const payload = await generateWithModel(apiKey, model, contents);
      const grounding = payload?.candidates?.[0]?.groundingMetadata;
      if (!grounding || (!selectedModel && !grounding.groundingChunks?.length)) {
        diagnostics.push({ stage: "grounding_compatibility", model, http_status: 200, code: "GROUNDING_METADATA_MISSING", status: null, category: "grounding_unsupported", message: "Il modello non ha restituito metadati Google Search grounding.", details: [] });
        continue;
      }
      return { model, payload, tested_models: diagnostics, excluded_models: [...new Set(excludedModels)] };
    } catch (error) {
      if (error instanceof GeminiRequestError) {
        diagnostics.push(error.diagnostic);
        if (error.diagnostic.category === "temporary_rate_limit") throw error;
        if (error.diagnostic.category === "permanent_quota") {
          excludedModels.push(model);
          const scheduled = new Set([...attempted, ...models]);
          const remainingSlots = Math.max(0, maxModelAttempts - scheduled.size);
          const alternatives = remainingSlots ? (await listGenerateContentModels(apiKey)).filter((candidate) => !scheduled.has(candidate) && !excludedModels.includes(candidate)).slice(0, remainingSlots) : [];
          models.push(...alternatives);
          continue;
        }
        continue;
      }
      diagnostics.push({ stage: "grounded_generation", model, http_status: null, code: "UNKNOWN_ERROR", status: null, category: "provider_error", message: safeProviderMessage(error), details: [] });
    }
  }
  const last = diagnostics.at(-1);
  const allPermanentQuota = diagnostics.length > 0 && diagnostics.every((item) => item.category === "permanent_quota");
  throw new GeminiRequestError({
    stage: "grounding_diagnostic",
    model: last?.model || "models.list",
    http_status: last?.http_status ?? null,
    code: allPermanentQuota ? "ALL_TEXT_MODELS_QUOTA_EXHAUSTED" : "NO_GROUNDED_MODEL",
    status: null,
    category: allPermanentQuota ? "permanent_quota" : "no_compatible_grounding_model",
    message: allPermanentQuota ? "La quota è esaurita per tutti i modelli testuali idonei provati." : "Nessun modello disponibile ha superato il test Google Search grounding.",
    details: diagnostics.slice(0, 5),
  });
}

async function reserveRetailerRequest(host: string, intervalSeconds: number, backoffSeconds = 0) {
  const waitSeconds = Number(await db("rpc/market_refresh_reserve_source_request", {
    method: "POST",
    body: json({ p_host: host, p_interval_seconds: intervalSeconds, p_backoff_seconds: backoffSeconds }),
  }));
  if (!Number.isFinite(waitSeconds) || waitSeconds < 0) throw new Error("Retailer request guard returned an invalid delay");
  if (backoffSeconds > 0) return;
  if (waitSeconds > 60) {
    throw new RetailerMarketError("rate_limit", "rate_limited", `La prossima richiesta consentita a ${host} è tra ${Math.ceil(waitSeconds)} secondi.`);
  }
  if (waitSeconds > 0) await new Promise((resolve) => setTimeout(resolve, Math.ceil(waitSeconds * 1000)));
}

type RefreshWine = MarketWine & {
  id: string | number;
  market_value_min: number | null;
  market_value_max: number | null;
  market_value_median: number | null;
};

function isRefreshWine(value: unknown): value is RefreshWine {
  if (!value || typeof value !== "object") return false;
  const wine = value as Record<string, unknown>;
  return (typeof wine.id === "string" || typeof wine.id === "number") &&
    typeof wine.name === "string" &&
    (typeof wine.producer === "string" || wine.producer === null) &&
    (typeof wine.vintage === "number" || wine.vintage === null) &&
    (typeof wine.market_value_min === "number" || wine.market_value_min === null) &&
    (typeof wine.market_value_max === "number" || wine.market_value_max === null) &&
    (typeof wine.market_value_median === "number" || wine.market_value_median === null);
}

async function assessMarket(wine: RefreshWine): Promise<MarketAssessment> {
  return await assessRetailerMarket(
    wine,
    Deno.env.get("MARKET_RESEARCH_CONTACT") || "",
    reserveRetailerRequest,
  );
}

async function loadWines(limit?: number): Promise<RefreshWine[]> {
  const rows: RefreshWine[] = [];
  for (let offset = 0; ; offset += 1000) {
    const pageLimit = limit ? Math.min(1000, limit - rows.length) : 1000;
    if (pageLimit <= 0) break;
    const page: unknown = await db(`wines?select=id,name,producer,vintage,quantity,notes,market_value_min,market_value_max,market_value_median,market_sources,market_source_count,market_confidence&quantity=gt.0&order=id.asc&limit=${pageLimit}`, { headers: { Range: `${offset}-${offset + pageLimit - 1}` } });
    if (!Array.isArray(page) || !page.every(isRefreshWine)) throw new Error("Database returned an invalid wine record for market pricing");
    rows.push(...page);
    if (!page || page.length < pageLimit) break;
  }
  return rows;
}

async function saveRun(runId: string, status: string, progress: any, summary: any) {
  await db(`rpc/market_refresh_release_lock`, {
    method: "POST",
    body: json({ p_run_id: runId, p_status: status, p_progress: progress, p_summary: summary }),
  });
}

export async function readRun(runId: string) {
  const rows = await db(`market_refresh_runs?select=*&run_id=eq.${encodeURIComponent(runId)}&limit=1`);
  return rows?.[0] || null;
}

export async function runMarketRefreshBatch(runId: string, trigger: "manual" | "weekly", requestedMode: "initialize" | "refresh" = "refresh") {
  const locked = await db("rpc/market_refresh_try_lock", { method: "POST", body: json({ p_run_id: runId, p_trigger: trigger }) });
  if (locked !== true) return { busy: true, done: false };
  try {
    const [allWines, run] = await Promise.all([loadWines(), readRun(runId)]);
    const progress = run?.progress || { next_index: 0 };
    const resumed = progress.market_mode === "initialize" || progress.market_mode === "refresh";
    const mode = resumed ? progress.market_mode : requestedMode;
    const savedIds: string[] | null = Array.isArray(progress.wine_ids) ? progress.wine_ids.map((id: unknown) => String(id)) : null;
    const initialRows = mode === "initialize"
      ? allWines.filter((wine) => wine.market_value_min == null && wine.market_value_max == null && wine.market_value_median == null)
      : allWines;
    const initialIds = initialRows.map((wine) => String(wine.id));
    const wineIds: string[] = savedIds || initialIds;
    const currentRows = new Map(allWines.map((wine) => [String(wine.id), wine]));
    const wineRows = wineIds.map((id: string) => currentRows.get(id)).filter((wine): wine is RefreshWine => !!wine);
    const start = resumed ? Math.max(0, Number(progress.next_index) || 0) : 0;
    const batch = wineRows.slice(start, start + 1);
    const outcomes: any[] = [];
    for (const [batchIndex, wine] of batch.entries()) {
      try {
        const assessment = await assessMarket(wine);
        if (assessment.status !== "priced" || assessment.median_eur === null) {
          outcomes.push({ wine_id: String(wine.id), status: "unverifiable", details: { reason: assessment.reason, offers: assessment.offers } });
          continue;
        }
        const same = Number(wine.market_value_min) === assessment.median_eur &&
          Number(wine.market_value_max) === assessment.median_eur &&
          Number(wine.market_value_median) === assessment.median_eur;
        const status = same ? "unchanged" : "updated";
        const updates = {
          market_value_min: assessment.median_eur,
          market_value_max: assessment.median_eur,
          market_value_median: assessment.median_eur,
          market_sources: assessment.offers,
          market_source_count: assessment.offers.length,
          market_confidence: assessment.confidence,
          last_market_check: new Date().toISOString(),
        };
        const patched = await db(`wines?id=eq.${encodeURIComponent(String(wine.id))}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: json(updates) });
        if (!patched?.length) throw new Error("Wine record was not updated");
        outcomes.push({ wine_id: String(wine.id), status, details: updates });
      } catch (error) {
        if (error instanceof RetailerMarketError) {
          const failedOutcome = {
            wine_id: String(wine.id),
            status: "error",
            details: { stage: error.stage, http_status: error.http_status, category: error.category, message: error.message },
          };
          outcomes.push(failedOutcome);
          await db("market_refresh_items?on_conflict=run_id,wine_id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: json(outcomes.map((item) => ({ run_id: runId, ...item }))) });
          const logged = await db(`market_refresh_items?select=status&run_id=eq.${encodeURIComponent(runId)}`);
          const totals = { updated: 0, unchanged: 0, unverifiable: 0, errors: 0 };
          for (const item of logged || []) {
            const status = item.status === "error" ? "errors" : item.status;
            if (status in totals) totals[status as keyof typeof totals]++;
          }
          const stopped = error.category === "rate_limited";
          const failedProgress = { next_index: start + (stopped ? 0 : batchIndex + 1), total: wineRows.length, batch_size: 1, market_mode: mode, wine_ids: wineIds };
          await saveRun(runId, "failed", failedProgress, totals);
          return { busy: false, done: true, failed: true, stopped, progress: failedProgress, summary: totals, diagnostic: { category: error.category, message: error.message }, outcomes };
        }
        outcomes.push({ wine_id: String(wine.id), status: "error", details: { message: safeProviderMessage(error) } });
      }
    }
    if (outcomes.length) {
      await db("market_refresh_items?on_conflict=run_id,wine_id", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: json(outcomes.map((item) => ({ run_id: runId, ...item }))),
      });
    }
    const logged = await db(`market_refresh_items?select=status&run_id=eq.${encodeURIComponent(runId)}`);
    const totals = { updated: 0, unchanged: 0, unverifiable: 0, errors: 0 };
    for (const item of logged || []) {
      const status = item.status === "error" ? "errors" : item.status;
      if (status in totals) totals[status as keyof typeof totals]++;
    }
    const nextIndex = start + batch.length;
    const done = nextIndex >= wineRows.length;
    const failed = done && wineRows.length > 0 && totals.errors === wineRows.length;
    const nextProgress = { next_index: nextIndex, total: wineRows.length, batch_size: 1, market_mode: mode, wine_ids: wineIds };
    await saveRun(runId, failed ? "failed" : done ? "completed" : "in_progress", nextProgress, totals);
    return { busy: false, done, failed, progress: nextProgress, summary: totals, outcomes };
  } catch (error) {
    try {
      await saveRun(runId, "failed", null, null);
    } catch (saveError) {
      console.error("failed to persist market refresh failure", saveError);
    }
    throw error;
  }
}

export async function runRetailerMarketPilot(limit = 5) {
  const wines = await loadWines(Math.min(5, Math.max(1, limit)));
  const results: any[] = [];
  for (const wine of wines) {
    try {
      results.push({ wine_id: String(wine.id), name: wine.name, producer: wine.producer, vintage: wine.vintage, ...(await assessMarket(wine)) });
    } catch (error) {
      if (error instanceof RetailerMarketError) {
        results.push({
          wine_id: String(wine.id),
          name: wine.name,
          producer: wine.producer,
          vintage: wine.vintage,
          status: "error",
          reason: error.message,
          diagnostic: { stage: error.stage, category: error.category, http_status: error.http_status },
        });
        if (error.category === "rate_limited") break;
      } else {
        throw error;
      }
    }
  }
  return {
    dry_run: true,
    saved_prices: false,
    checked_at: new Date().toISOString(),
    requested: Math.min(5, Math.max(1, limit)),
    tested: results.length,
    results,
  };
}

export async function authenticatedUser(req: Request) {
  const authorization = req.headers.get("Authorization") || "";
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  const url = Deno.env.get("SUPABASE_URL");
  const key = req.headers.get("apikey") || Deno.env.get("SUPABASE_ANON_KEY");
  if (!token || !url || !key) return false;
  const response = await fetch(`${url}/auth/v1/user`, { headers: { apikey: key, Authorization: `Bearer ${token}` } });
  return response.ok;
}
