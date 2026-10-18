Cantina De Pasquale PWA V3.5
- Inventario cloud Supabase
- Card e filtri cliccabili
- Scheda vino
- Aggiungi bottiglia / foto
- Valutazioni degustazione
- Sommelier UI
- Cosa apro? con consiglio dalla cantina disponibile
- Analizza / Acquista con foto, prezzo proposto e confronto cantina
- Scouting vini AI con ricerca web, budget, confronto cantina, offerte e fonti
- Backend AI protetto tramite Supabase Edge Function (OPENAI_API_KEY solo nei secrets)
- Modalità offline: riapertura dell'ultimo inventario sincronizzato senza espellere l'utente
- Immagini bottiglie da database con normalizzazione visiva: sfondo bianco neutralizzato, proporzioni e centratura uniformi
Nota: le immagini reali sono lette dagli URL verificati presenti in Supabase; dove manca una foto resta il placeholder.

Operazioni acquisti e valori di mercato
- Applicare la migration in supabase/migrations prima di distribuire il nuovo app.js.
- Distribuire wine-enrich e wine-market-refresh con verifica JWT attiva; market-refresh-weekly usa un token cron dedicato verificato dalla funzione.
- Configurare GEMINI_API_KEY e MARKET_REFRESH_CRON_TOKEN nei secrets Edge; SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY devono essere disponibili al runtime. I modelli sono letti dal Gemini Models API e la compatibilità Google Search viene provata con una bottiglia prima di avviare i batch. Gli endpoint manuali convalidano il JWT utente tramite Auth.
- Salvare in Supabase Vault i secrets project_url e market_refresh_cron_token; il token deve coincidere con MARKET_REFRESH_CRON_TOKEN. Eseguire quindi select public.configure_weekly_market_refresh(); dalla console SQL.
- Il Cron avvia il refresh ogni lunedi alle 06:00 UTC; un secondo job ogni 10 minuti riprende esclusivamente i batch dello stesso ciclo. Senza entrambi i secrets Vault i job non vengono registrati e il refresh automatico non è attivo.
- Il refresh manuale e quello settimanale condividono lock, audit per etichetta e aggiornamenti verificati. Prezzi con identità o fonti incerte non sostituiscono quelli presenti.
- Le risposte Gemini di errore registrano modello, HTTP status, codice, categoria e dettagli quota consentiti; chiavi e identificativi consumer non vengono salvati. Un 429 o quota/billing zero ferma subito il run; la categoria distingue quota permanente da limite temporaneo.
