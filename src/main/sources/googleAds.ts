import { AuthExpiredError, fetchWithRetry } from '../http.js';
import { googleAdsAccessToken } from '../oauth/google.js';
import { sanitizeFileName } from './classify.js';
import { downloadPdf } from './download.js';
import type { FoundDocument, InvoiceSource, SourceContext, TestDeps, TestResult } from './types.js';

/**
 * Google Ads API – InvoiceService.ListInvoices (facturare lunară).
 * Ghid oficial: https://developers.google.com/google-ads/api/docs/billing/invoice
 *   GET https://googleads.googleapis.com/{version}/customers/{customer_id}/invoices
 *       ?billingSetup=customers/{customer_id}/billingSetups/{billing_setup_id}&issueYear=2026&issueMonth=NOVEMBER
 *   Antete: Authorization: Bearer …, developer-token, login-customer-id (dacă plătește un cont manager)
 * PDF: GET autentificat pe `pdfUrl`. Facturile dinainte de 2019 nu pot fi cerute. Versiune implicită: v26.
 */
export const GOOGLE_ADS_HOST = 'https://googleads.googleapis.com';
export const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];

/** Lunile (an, lună) dintre `since` și `now`, inclusiv – maxim 13. */
export function issueMonths(since: Date, now: Date): { year: number; month: string }[] {
  const out: { year: number; month: string }[] = [];
  let y = Math.max(2019, since.getUTCFullYear());
  let m = since.getUTCFullYear() < 2019 ? 0 : since.getUTCMonth();
  while ((y < now.getUTCFullYear() || (y === now.getUTCFullYear() && m <= now.getUTCMonth())) && out.length < 13) {
    out.push({ year: y, month: MONTHS[m] });
    if (++m > 11) {
      m = 0;
      y++;
    }
  }
  return out;
}

export function googleAdsError(status: number, j: any): Error {
  const e = j?.error ?? {};
  const detail = e.details?.[0]?.errors?.[0];
  const code = detail?.errorCode ? Object.values(detail.errorCode)[0] : undefined;
  if (status === 401) return new AuthExpiredError('googleAds', 'Sesiunea Google Ads a expirat. Reconectează Google Ads din Setări.');
  if (code === 'DEVELOPER_TOKEN_NOT_APPROVED' || code === 'DEVELOPER_TOKEN_PROHIBITED')
    return new Error('Google Ads: developer token-ul nu are acces la conturi reale (cere „Basic access” în Google Ads API Center).');
  if (code === 'USER_PERMISSION_DENIED') return new Error('Google Ads: contul conectat nu are acces la acest client. Verifică Customer ID / login-customer-id.');
  if (code === 'NOT_INVOICED_CUSTOMER' || code === 'BILLING_SETUP_NOT_ON_MONTHLY_INVOICING')
    return new Error('Google Ads: contul nu folosește facturare lunară (monthly invoicing). Chitanțele vin atunci pe email.');
  return new Error(`Google Ads ${status}${code ? ` (${String(code)})` : ''}${detail?.message || e.message ? ': ' + (detail?.message || e.message) : ''}`);
}

function headers(token: string, devToken: string, loginCustomerId: string): Record<string, string> {
  const h: Record<string, string> = { Authorization: `Bearer ${token}`, 'developer-token': devToken, Accept: 'application/json' };
  if (loginCustomerId) h['login-customer-id'] = loginCustomerId;
  return h;
}

async function listInvoices(f: typeof fetch, cfg: TestDeps['settings']['sources']['googleAds'], h: Record<string, string>, year: number, month: string, retry?: SourceContext['retry']) {
  const q = new URLSearchParams({ billingSetup: `customers/${cfg.customerId}/billingSetups/${cfg.billingSetupId}`, issueYear: String(year), issueMonth: month });
  const r = await fetchWithRetry(f, `${GOOGLE_ADS_HOST}/${cfg.apiVersion}/customers/${cfg.customerId}/invoices?${q}`, { headers: h }, retry);
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw googleAdsError(r.status, j);
  return (j.invoices ?? []) as any[];
}

const micros = (v: unknown) => (v == null || v === '' ? null : Math.round(Number(v) / 10_000) / 100);

export const googleAdsSource: InvoiceSource = {
  id: 'googleAds',
  label: 'Google Ads',
  isEnabled: (s, secrets) =>
    s.sources.googleAds.enabled && !!s.sources.googleAds.customerId && !!s.sources.googleAds.billingSetupId && secrets.has('googleAds.tokens') && secrets.has('googleAds.developerToken'),
  async fetchNew(ctx: SourceContext): Promise<FoundDocument[]> {
    const cfg = ctx.settings.sources.googleAds;
    const token = await googleAdsAccessToken(ctx.settings.oauthClients.googleClientId, ctx.secrets, ctx.fetch);
    const h = headers(token, ctx.secrets.get('googleAds.developerToken') ?? '', cfg.loginCustomerId);
    const docs: FoundDocument[] = [];
    for (const { year, month } of issueMonths(ctx.since, new Date())) {
      for (const it of await listInvoices(ctx.fetch, cfg, h, year, month, ctx.retry)) {
        const id = String(it.id ?? it.resourceName ?? '');
        if (!id) continue;
        const externalId = `inv:${id}`;
        if (ctx.isKnown(externalId)) continue;
        let data: Buffer | null = null;
        if (it.pdfUrl && /^https:\/\//.test(it.pdfUrl)) {
          try {
            data = await downloadPdf(ctx.fetch, it.pdfUrl, h, ctx.retry);
          } catch (e) {
            ctx.log('warn', `Google Ads: PDF indisponibil pentru ${id}: ${(e as Error).message}`);
          }
        }
        const total = micros(it.totalAmountMicros);
        docs.push({
          externalId,
          vendor: 'Google Ads',
          subject: `Factură Google Ads ${id}`,
          fileName: sanitizeFileName(`GoogleAds_${id}.pdf`),
          data,
          mimeType: 'application/pdf',
          seriesNumber: id,
          amount: total,
          currency: it.currencyCode ?? null,
          invoiceDate: it.issueDate ?? null,
          dueDate: it.dueDate ?? null,
          platform: 'google',
          summary: data ? null : `Factură Google Ads ${id}\nTotal: ${total ?? '-'} ${it.currencyCode ?? ''}\nEmisă: ${it.issueDate ?? '-'}`,
        });
      }
    }
    return docs;
  },
  async test({ settings, secrets, fetch: f, retry }: TestDeps): Promise<TestResult> {
    const cfg = settings.sources.googleAds;
    if (!cfg.customerId || !cfg.billingSetupId) return { ok: false, error: 'Completează Customer ID și Billing setup ID.' };
    const dev = secrets.get('googleAds.developerToken');
    if (!dev) return { ok: false, error: 'Lipsește developer token-ul (Google Ads → Tools → API Center).' };
    try {
      const token = await googleAdsAccessToken(settings.oauthClients.googleClientId, secrets, f);
      const prev = new Date();
      prev.setUTCDate(1);
      prev.setUTCMonth(prev.getUTCMonth() - 1);
      const list = await listInvoices(f, cfg, headers(token, dev, cfg.loginCustomerId), prev.getUTCFullYear(), MONTHS[prev.getUTCMonth()], retry);
      return { ok: true, info: `Conectat. ${list.length} ${list.length === 1 ? 'factură' : 'facturi'} emise în ${MONTHS[prev.getUTCMonth()].toLowerCase()} ${prev.getUTCFullYear()}.` };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
};
