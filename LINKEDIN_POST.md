# LinkedIn – draft (NU este publicat)

> Draft scris în numele lui Lucian Ceușan. Înainte de publicare: înlocuiește `[link GitHub]` cu linkul real și atașează 2–3 capturi din `screenshots/`: `dashboard-dark.png`, `onboarding-4-scroll400-dark.png` și `settings-light.png`.

---

## 🇷🇴 Varianta în română

Lună de lună, aceeași poveste: factura de la Meta Ads e în mail, cea de la TikTok în alt mail, cea de la curier e în FGO, iar contabila îmi scrie pe WhatsApp: „Mai am nevoie de facturile de luna trecută…” 📎

Lucrez în IT & Telecom Support și am și un business de e-commerce, așa că am făcut ce face orice om de IT obosit: am automatizat. 🙂

Vă prezint **FacturaBot**, o aplicație Windows care stă lângă ceas și face un singur lucru, dar îl face bine: **trimite singură facturile la contabilă.**

🔹 Se conectează la Gmail, Outlook și FGO. Doar te loghezi, fără configurări complicate.
🔹 Recunoaște facturile de la Meta, Google, TikTok, Shopify, Stripe, PayPal, eMAG și de la curieri, plus orice PDF cu „factură / invoice / chitanță”.
🔹 Le trimite contabilei pe **WhatsApp**: scanezi o singură dată codul QR sau folosești API-ul oficial WhatsApp Business. Dacă WhatsApp nu merge, factura pleacă automat pe **email**.
🔹 Nu trimite nimic de două ori, rulează în fundal, pornește odată cu Windows și, dacă vrei, îți cere confirmarea înainte de fiecare trimitere.
🔹 Totul rămâne pe calculatorul tău, cu parolele criptate de Windows. Nu există niciun server la mijloc.

Când l-am construit am pus accent pe fiabilitate: reconectare corectă la WhatsApp, reîmprospătarea automată a conturilor de email, reîncercări când pică internetul și peste 100 de teste automate.

Am căutat înainte să mă apuc. Există bucăți (Keez, SmartBill, Dext, câteva proiecte pe GitHub), dar n-am găsit nimic care să-ți păstreze contabila pe care o ai deja și să-i trimită documentele acolo unde chiar se uită: pe WhatsApp.

Urmează integrarea cu ANAF e-Factura și cu facturile direct din platformele de ads.

Dacă ai un magazin online, un mic business sau ești contabil(ă) și vrei să-l încerci, scrie-mi un mesaj sau un comentariu. Caut primii 10 testeri. 🙌

👉 [link GitHub]

#automatizare #ecommerce #contabilitate #antreprenoriat #romania #whatsapp #productivitate #opensource

---

## 🇬🇧 English version (optional)

Every month, same story: the Meta Ads invoice is in one inbox, TikTok's in another, the courier's is in our invoicing app, and my accountant pings me on WhatsApp: "I still need last month's invoices…" 📎

I work in IT & Telecom Support and run an e-commerce business, so I did what any tired IT person does: I automated it. 🙂

Meet **FacturaBot**, a small Windows tray app that does one job well: **it sends your invoices to your accountant automatically.**

🔹 Connects to Gmail, Outlook and FGO. You just sign in, no complicated setup.
🔹 Recognises invoices from Meta, Google, TikTok, Shopify, Stripe, PayPal, eMAG and couriers, plus any "invoice / receipt" PDF.
🔹 Delivers them to your accountant on **WhatsApp**: scan a QR code once, or use the official WhatsApp Business API. If WhatsApp fails, the invoice goes out by **email** automatically.
🔹 Never sends anything twice, runs in the background, starts with Windows and can ask for your approval before each send.
🔹 Everything stays on your PC, with credentials encrypted by Windows. There's no middleman server.

I built it with reliability in mind: proper WhatsApp reconnects, automatic token refresh for your email accounts, retries when the internet drops, and 100+ automated tests.

Next up: Romania's ANAF e-Factura and invoices pulled straight from the ad platforms.

If you run a small business or you're an accountant and want to try it, drop a comment or DM me. I'm looking for the first 10 testers. 🙌

👉 [GitHub link]

#automation #ecommerce #accounting #smallbusiness #whatsapp #productivity
