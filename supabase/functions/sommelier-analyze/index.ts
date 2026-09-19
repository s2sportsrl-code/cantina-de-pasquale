import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS")
    return new Response("ok", { headers: corsHeaders });

  if (req.method !== "POST")
    return json({ error: "Metodo non consentito." }, 405);

  const apiKey = Deno.env.get("GEMINI_API_KEY");

  if (!apiKey)
    return json(
      { error: "Gemini non è ancora configurato sul server." },
      503,
    );

  try {
    const { image, price, store, cellar = [] } = await req.json();

    if (
      typeof image !== "string" ||
      !image.startsWith("data:image/") ||
      image.length > 7_000_000
    ) {
      return json({ error: "Foto mancante o troppo grande." }, 400);
    }

    const match = image.match(
      /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/,
    );

    if (!match)
      return json({ error: "Formato immagine non valido." }, 400);

    const mimeType = match[1];
    const imageData = match[2];

    const cellarText = JSON.stringify(cellar).slice(0, 30000);

    const prompt = `
Sei il Sommelier AI personale della Cantina De Pasquale.

Devi comportarti come un sommelier esperto che può anche effettuare
una ricerca Google aggiornata.

Analizza attentamente la fotografia della bottiglia.

OBIETTIVI:

1. Identifica con la massima precisione possibile:
- produttore
- nome del vino
- denominazione
- annata
- regione
- tipologia

2. Usa Google Search per cercare informazioni AGGIORNATE sul vino
e soprattutto sulla specifica annata identificata.

Cerca preferibilmente:
- sito ufficiale del produttore
- schede tecniche ufficiali
- rivenditori affidabili italiani/europei
- informazioni sull'annata
- finestra di consumo
- potenziale evolutivo
- prezzi realmente disponibili online

Non inventare recensioni, punteggi o prezzi.

3. PREZZO

Prezzo proposto dall'utente:
${price ?? "non indicato"} EUR

Venditore indicato:
${store || "non indicato"}

Confronta il prezzo proposto con i prezzi trovati online.

Non considerare un singolo prezzo anomalo come prezzo di mercato.

4. CANTINA PERSONALE

Queste sono le bottiglie attualmente presenti:

${cellarText}

Valuta se:
- il vino è già presente
- esistono vini molto simili
- aggiunge qualcosa alla collezione
- la cantina è già sufficientemente coperta
- sarebbe interessante acquistarlo

5. VALUTAZIONE

Fornisci un punteggio da 0 a 100 che rappresenti
L'INTERESSE DELL'ACQUISTO per questa cantina.

Il punteggio NON deve essere presentato come voto assoluto
alla qualità del vino.

Considera:
- qualità e reputazione del vino
- interesse dell'annata
- prezzo proposto
- prezzo di mercato
- potenziale evolutivo
- presenza di vini simili in cantina
- interesse collezionistico
- rapporto qualità/prezzo

Restituisci ESCLUSIVAMENTE JSON valido nel seguente formato:

{
  "wine_name": "",
  "producer": "",
  "vintage": null,
  "region": null,
  "verdict": "",
  "score": 0,
  "summary": "",
  "market_price": null,
  "strengths": [],
  "cautions": [],
  "buy_advice": "",
  "in_cellar_match": null
}

"in_cellar_match", se presente, deve essere:

{
  "name": "",
  "quantity": 0
}

Il testo deve essere in italiano.

Se qualche informazione non è verificabile,
dichiaralo chiaramente invece di inventarla.
`;

const models = [
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
];

let response: Response | null = null;
let payload: any = null;

const requestBody = {
  contents: [
    {
      role: "user",
      parts: [
        { text: prompt },
        {
          inlineData: {
            mimeType,
            data: imageData,
          },
        },
      ],
    },
  ],
  generationConfig: {
    temperature: 0.2,
    responseMimeType: "application/json",
  },
};

for (const model of models) {
  response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    },
  );

  payload = await response.json();

  if (response.ok) {
    console.log(`Sommelier: risposta ottenuta con ${model}`);
    break;
  }

  console.warn(
    `Sommelier: ${model} non disponibile`,
    payload?.error?.message || response.status,
  );
}

    if (!response.ok) {
      console.error("Gemini error", payload);

      return json(
        {
          error:
            payload?.error?.message ||
            "Il servizio Gemini non è disponibile in questo momento.",
        },
        502,
      );
    }

    const output =
      payload?.candidates?.[0]?.content?.parts
        ?.map((part: { text?: string }) => part.text || "")
        .join("")
        .trim();

    if (!output)
      return json(
        { error: "Gemini non ha restituito un'analisi valida." },
        502,
      );

    let analysis;

    try {
      analysis = JSON.parse(
        output
          .replace(/^```json\s*/i, "")
          .replace(/^```\s*/i, "")
          .replace(/\s*```$/i, ""),
      );
    } catch {
      console.error("Risposta Gemini non JSON:", output);

      return json(
        { error: "La risposta del Sommelier non era nel formato previsto." },
        502,
      );
    }

    const grounding =
      payload?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];

    const sources = grounding
      .map((chunk: any) => ({
        title: chunk?.web?.title || "Fonte",
        url: chunk?.web?.uri || "",
      }))
      .filter((source: any) => source.url)
      .slice(0, 8);

    return json({
      ...analysis,
      sources,
    });
  } catch (error) {
    console.error(error);

    return json(
      { error: "Non sono riuscito ad analizzare questa bottiglia." },
      500,
    );
  }
});
