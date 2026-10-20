import {
  runMarketRefreshBatch,
  runRetailerMarketPilot,
} from "../_shared/market-refresh.ts";
import { RetailerMarketError } from "../_shared/retailer-market.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function constantTimeEqual(left: string, right: string) {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Metodo non consentito." }, 405);

  const expected = Deno.env.get("MARKET_REFRESH_GITHUB_TOKEN") || "";
  const supplied = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!expected || !constantTimeEqual(supplied, expected)) return json({ error: "Autenticazione workflow non valida o non configurata." }, 401);

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return json({ error: "Richiesta JSON non valida." }, 400);

  try {
    if (body.action === "pilot") {
      return json(await runRetailerMarketPilot(5));
    }
    if (body.action !== "initialize" && body.action !== "refresh") {
      return json({ error: "Azione non valida.", allowed_actions: ["pilot", "initialize", "refresh"] }, 400);
    }
    const runId = typeof body.run_id === "string" && uuidPattern.test(body.run_id) ? body.run_id : crypto.randomUUID();
    const mode = body.action;
    const result = await runMarketRefreshBatch(runId, "manual", mode);
    if (result.busy) return json({ error: "Un aggiornamento valori è già in corso.", status: "busy" }, 409);
    return json({ run_id: runId, action: mode, ...result });
  } catch (error) {
    if (error instanceof RetailerMarketError) {
      const diagnostic = { stage: error.stage, category: error.category, http_status: error.http_status, retry_after_seconds: error.retry_after_seconds, message: error.message };
      console.error("GitHub retailer market refresh", diagnostic);
      return json({ error: "Aggiornamento prezzi non riuscito.", failed: true, status: "failed", diagnostic }, error.http_status === 429 ? 429 : 502);
    }
    console.error("GitHub market refresh", error);
    return json({ error: "Aggiornamento prezzi non riuscito.", failed: true, status: "failed" }, 500);
  }
});
