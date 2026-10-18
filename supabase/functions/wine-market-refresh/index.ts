import { authenticatedUser, runMarketRefreshBatch } from "../_shared/market-refresh.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Metodo non consentito." }, 405);
  if (!(await authenticatedUser(req))) return json({ error: "Autenticazione richiesta." }, 401);
  try {
    const body = await req.json();
    const runId = typeof body.run_id === "string" && uuidPattern.test(body.run_id) ? body.run_id : crypto.randomUUID();
    const result = await runMarketRefreshBatch(runId, "manual");
    if (result.busy) return json({ error: "Un aggiornamento valori è già in corso.", status: "busy" }, 409);
    return json({ run_id: runId, ...result });
  } catch (error) {
    console.error("manual market refresh", error);
    return json({ error: "Aggiornamento valori non riuscito.", details: String(error).slice(0, 300) }, 500);
  }
});
