import type { DirectSourceId } from './types';

/** Pașii de configurare pentru sursele directe – afișați în Setări. Fiecare sursă e opțională. */
export interface SourceMeta {
  id: DirectSourceId;
  title: string;
  short: string;
  docs: string;
  steps: string[];
  note: string;
}

export const DIRECT_SOURCES: SourceMeta[] = [
  {
    id: 'meta',
    title: 'Meta Ads (Facebook / Instagram)',
    short: 'Facturile lunare din Business Manager, direct prin Marketing API.',
    docs: 'https://developers.facebook.com/docs/marketing-api/reference/business/business_invoices/',
    steps: [
      'Meta Business Settings → Business info: copiază Business ID.',
      'Users → System users → Add (Admin) → Generate token cu permisiunea business_management.',
      'Dă utilizatorului de sistem rolul Finance (Analyst sau Editor) în Billing.',
      'Lipește tokenul aici și apasă „Testează conexiunea”.',
    ],
    note: 'Merge pentru conturile cu facturare lunară. Dacă plătești cu cardul, chitanțele Meta vin pe email și FacturaBot le ia de acolo.',
  },
  {
    id: 'tiktok',
    title: 'TikTok Ads',
    short: 'Facturile Business Center, prin TikTok API for Business v1.3.',
    docs: 'https://business-api.tiktok.com/portal/docs/api-reference/v1.3',
    steps: [
      'Creează o aplicație în TikTok API for Business (Developer portal) cu scope-ul Business Center → Invoice Management.',
      'Autorizează aplicația cu un cont Finance Manager sau Finance Analyst al Business Center-ului.',
      'Copiază Access Token și Business Center ID (Business Center → Business info).',
      'Lipește-le aici și apasă „Testează conexiunea”.',
    ],
    note: 'Dacă nu vrei să creezi aplicația, chitanțele TikTok primite pe email sunt detectate automat.',
  },
  {
    id: 'googleAds',
    title: 'Google Ads',
    short: 'Facturile lunare prin Google Ads API (InvoiceService) + PDF.',
    docs: 'https://developers.google.com/google-ads/api/docs/billing/invoice',
    steps: [
      'Google Ads → Tools → API Center: cere un developer token (nivel Basic pentru conturi reale).',
      'Customer ID: numărul contului (fără liniuțe). Billing setup ID: Billing → Settings sau prin API (billing_setup).',
      'Dacă plătește un cont manager (MCC), completează și login-customer-id.',
      'Apasă „Conectează Google Ads” (login în browser, scope adwords), apoi „Testează conexiunea”.',
    ],
    note: 'Doar pentru conturile cu facturare lunară. Plățile automate cu cardul generează chitanțe pe email, preluate din Gmail.',
  },
];

/** Surse oficiale pentru pragurile fiscale (afișate lângă fiecare valoare). */
export const TAX_SOURCES = {
  vatThreshold: 'https://static.anaf.ro/static/10/Anaf/legislatie/OG_22_2025.pdf',
  vatThresholdNote: 'Art. 310 alin. (1) Cod fiscal, modificat prin OG nr. 22/2025 (MO nr. 806/29.08.2025): 395.000 lei din 1 septembrie 2025.',
  oss: 'https://vat-one-stop-shop.ec.europa.eu/one-stop-shop_en',
  ossNote: 'Art. 59c Directiva 2006/112/CE: 10.000 EUR/an pentru vânzări la distanță intracomunitare + servicii TBE către persoane fizice din alte state UE.',
  vatRate: 'https://legislatie.just.ro/Public/DetaliiDocumentAfis/300022',
  fx: 'https://chat.anaf.ro/ANAFI.nsf/0/3198C617658CFACCC225761C0033C4F0?OpenDocument=',
} as const;
