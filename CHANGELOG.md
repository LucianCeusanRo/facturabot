# Changelog

## 0.2.0 – 2026-11-26

### Adăugat / Added
- **Acces de pe telefon (opțional):** server local cu panou web responsive și PWA instalabilă, împerechere prin QR sau cod de 6 cifre, dispozitive revocabile, „Trimite” / „Ignoră” și „Sincronizează” de pe telefon. Instrucțiuni pentru Tailscale și Cloudflare Tunnel (+ Access). Fără server în cloud.
  *Phone access (opt-in): local server with a responsive, installable PWA dashboard, QR / 6-digit pairing, revocable devices, approve/skip/sync from the phone.*
- **Surse directe opționale:** Meta Ads (Marketing API v27.0 `business_invoices`), TikTok Ads (API for Business v1.3), Google Ads (API v26 InvoiceService + PDF, conectare OAuth separată). Fiecare are pași de configurare și „Testează conexiunea”.
- **Extragere pe reguli** a sumei, monedei, datei, scadenței și codului de TVA din PDF-uri și din chitanțele din corpul emailului (Shopify, Stripe, PayPal, Meta etc.). Fără AI.
- **Cheltuieli:** grafice pe lună, platformă și furnizor, convertite în lei la cursul BNR (regula art. 290), export CSV și Excel.
- **TVA (informativ):** taxare inversă + validare VIES, remindere D390/D301/D300/D700, plafon de scutire 395.000 lei (OG 22/2025) cu alerte la 80% și 100%, prag OSS 10.000 EUR, raport lunar PDF și pachet ZIP pentru contabilă (automat sau la cerere). Praguri configurabile, cu link spre sursa oficială.
- **Extra:** detector de facturi lipsă, remindere de scadență, cardul „De urmărit” pe pagina Acasă.
- **Interfață:** paginile Cheltuieli și TVA, secțiuni noi în Setări, fereastră responsive (rail de iconițe sub 900 px, bară de tab-uri jos sub 640 px), scurtături Ctrl+1…5.

### Modificat / Changed
- Baza de date primește coloane noi (direcție, platformă, țară și cod TVA furnizor, tratament TVA, scadență, plătit, sumă în lei, curs) prin migrare automată; datele existente rămân.
- Pragurile de acoperire a testelor au crescut la 90% linii / funcții / instrucțiuni și 75% ramuri.

### Reparat / Fixed
- Sumele precedate de un an („2026 100,00 lei”) nu mai sunt citite greșit.
