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
- La valorizzazione usa pagine pubbliche Vinatis, non Gemini né API AI a pagamento. La ricerca e i dettagli prodotto sono letti solo dopo verifica di robots.txt; richieste seriali distanziate, limiti di dimensione/tempo, nessun redirect esterno e stop senza retry automatico in caso di HTTP 429. Vengono accettate soltanto offerte strutturate in EUR, disponibili, per produttore, etichetta, annata e formato corrispondenti; aste, confezioni multiple e risultati ambigui sono esclusi.
- Al momento Vinatis è l'unica fonte abilitata: perciò i prezzi hanno affidabilità bassa. Le fonti sono deduplicate per rivenditore; verrà usata la mediana quando saranno abilitate più fonti indipendenti verificate. Se non c'è un'offerta valida, il prezzo precedente resta invariato. Il formato deve essere esplicito nel nome o nelle annotazioni: un formato mancante non viene presunto come 750 ml e rende l'etichetta non verificabile.
- La migration `20261020100000_free_retailer_market_pricing.sql` salva mediana, fonti con URL/prezzo/data/formato/annata, conteggio e affidabilità. Disattiva inoltre i vecchi job cron settimanali.
- Distribuire `wine-market-refresh` con verifica JWT attiva e `market-refresh-github` con `verify_jwt = false`; quest'ultimo richiede comunque un bearer token dedicato. Distribuire la funzione `market-refresh-weekly` aggiornata, che restituisce HTTP 410 e non avvia refresh.
- Configurare in Supabase Edge Secrets `MARKET_RESEARCH_CONTACT` (email di contatto per il bot), `MARKET_REFRESH_GITHUB_TOKEN` (token casuale lungo almeno 32 caratteri), `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY`. Non inserire mai la service-role key in GitHub.
- Creare l'ambiente GitHub Actions `market-pricing`, salvare lì lo stesso `MARKET_REFRESH_GITHUB_TOKEN` come secret e limitarne l'uso a `main` con approvazione dei responsabili. Il workflow `.github/workflows/market-pricing.yml` è attivabile solo con `workflow_dispatch` e rifiuta l'esecuzione nei repository pubblici, poiché report e log trattano dati della cantina. `pilot` prova cinque etichette senza aggiornare i prezzi, `initialize` valuta soltanto i vini senza prezzo e `refresh` aggiorna la collezione. Report Markdown e JSON sono conservati come artifact per 30 giorni; limitare l'accesso ai risultati.
- Il pulsante esistente in app continua a fare refresh manuale autenticato dall'utente. Un lock database protegge i run e un limite persistente per host coordina le richieste tra istanze Edge. Il pilot non aggiorna vini né crea run di refresh; registra solo il tempo di richiesta necessario a rispettare il rate limit.
- Il workflow rispetta robots.txt, ma prima di abilitarne l'uso operativo verificare anche le condizioni d'uso applicabili del rivenditore; robots.txt da solo non equivale a un'autorizzazione legale alla raccolta automatizzata.
- `GEMINI_API_KEY` resta necessaria per le funzioni AI non legate ai prezzi (Sommelier e arricchimento). Non è usata per la valorizzazione di mercato.
