import { GeminiRequestError, runMarketRefreshBatch } from "../_shared/market-refresh.ts";

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const baseUrl = () => Deno.env.get("SUPABASE_URL") || "";
const serviceKey = () => Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const serviceHeaders = () => ({ apikey: serviceKey(), Authorization: `Bearer ${serviceKey()}` });

function constantTimeEqual(left: string, right: string) {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  return difference === 0;
}

async function rows(query: string) {
  const response = await fetch(`${baseUrl()}/rest/v1/market_refresh_runs?${query}`, { headers: serviceHeaders() });
  if (!response.ok) throw new Error(`Refresh log unavailable (${response.status})`);
  return await response.json();
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Metodo non consentito." }, 405);
  const expected = Deno.env.get("MARKET_REFRESH_CRON_TOKEN") || "";
  const supplied = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!expected || !serviceKey() || !baseUrl() || !constantTimeEqual(supplied, expected)) return json({ error: "Autenticazione cron non valida o non configurata." }, 401);
  try {
    const body = await req.json().catch(() => ({}));
    const active = await rows("select=run_id&trigger=eq.weekly&status=eq.in_progress&order=started_at.asc&limit=1");
    const now = new Date();
    const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - ((now.getUTCDay() + 6) % 7)));
    const weekStart = monday.toISOString();
    let runId = active?.[0]?.run_id;
    if (!runId) {
      if (body.action !== "start" || now.getUTCDay() !== 1) return json({ status: "idle", reason: "Nessun ciclo settimanale da avviare o riprendere." });
      const completed = await rows(`select=run_id&trigger=eq.weekly&status=eq.completed&started_at=gte.${encodeURIComponent(weekStart)}&limit=1`);
      if (completed?.length) return json({ status: "idle", reason: "Refresh settimanale gia completato questa settimana." });
      runId = crypto.randomUUID();
    }
    const result = await runMarketRefreshBatch(runId, "weekly");
    if (result.busy) return json({ status: "busy" }, 409);
    return json({ run_id: runId, ...result });
  } catch (error) {
    if (error instanceof GeminiRequestError) {
      console.error("weekly market refresh Gemini diagnostic", error.diagnostic);
      return json({ error: "Refresh Gemini settimanale non riuscito.", failed: true, status: "failed", diagnostic: error.diagnostic }, error.diagnostic.http_status === 429 ? 429 : 502);
    }
    console.error("weekly market refresh", error);
    return json({ error: "Refresh settimanale non riuscito.", failed: true, status: "failed" }, 500);
  }
});
