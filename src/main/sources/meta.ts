import { AuthExpiredError, fetchWithRetry } from '../http.js';
import { sanitizeFileName } from './classify.js';
import { downloadPdf, ymd } from './download.js';
import type { FoundDocument, InvoiceSource, SourceContext, TestDeps, TestResult } from './types.js';

/**
 * Meta Marketing API – facturile lunare ale Business Manager-ului.
 * Referință oficială: https://developers.facebook.com/docs/marketing-api/reference/business/business_invoices/
 *   GET /{version}/{business-id}/business_invoices?issue_start_date=…&issue_end_date=… (end exclusiv)
 * Câmpuri: https://developers.facebook.com/docs/marketing-api/reference/omega-customer-trx/
 *   invoice_id, invoice_date, due_date, amount (numeric string), currency, download_uri, cdn_download_uri,
 *   payment_status, entity, billing_period, advertiser_name, type
 * Disponibil doar pentru conturile cu facturare lunară (monthly invoicing). Tokenul: System User cu
 * permisiunea `business_management` și rol de „Finance” în Business Manager.
 */
export const META_GRAPH = 'https://graph.facebook.com';
export const META_FIELDS = 'id,invoice_id,invoice_date,due_date,amount,currency,billing_period,download_uri,cdn_download_uri,entity,payment_status,type,advertiser_name';

export function metaError(status: number, j: any): Error {
  const e = j?.error ?? {};
  const code = Number(e.code);
  if (status === 401 || code === 190) return new AuthExpiredError('meta', 'Tokenul Meta a expirat sau a fost revocat. Generează unul nou (System User) și salvează-l în Setări.');
  if (code === 200 || code === 10 || status === 403)
    return new Error('Meta: lipsesc permisiunile. Tokenul are nevoie de business_management, iar utilizatorul de rol Finance în Business Manager.');
  if (code === 100) return new Error(`Meta: parametru invalid (${e.message ?? 'business ID?'})`);
  return new Error(`Meta ${status}${e.message ? ': ' + e.message : ''}${e.fbtrace_id ? ` (fbtrace ${e.fbtrace_id})` : ''}`);
}

async function graph(f: typeof fetch, url: string, token: string, retry?: SourceContext['retry']) {
  if (!url.startsWith(META_GRAPH + '/')) throw new Error('URL Meta neașteptat');
  const r = await fetchWithRetry(f, url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }, retry);
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw metaError(r.status, j);
  return j;
}

export const metaSource: InvoiceSource = {
  id: 'meta',
  label: 'Meta Ads',
  isEnabled: (s, secrets) => s.sources.meta.enabled && !!s.sources.meta.businessId && secrets.has('meta.token'),
  async fetchNew(ctx: SourceContext): Promise<FoundDocument[]> {
    const cfg = ctx.settings.sources.meta;
    const token = ctx.secrets.get('meta.token');
    if (!token) throw new AuthExpiredError('meta', 'Lipsește tokenul Meta');
    const end = new Date(Date.now() + 86400_000); // issue_end_date e exclusiv
    const q = new URLSearchParams({ fields: META_FIELDS, issue_start_date: ymd(ctx.since), issue_end_date: ymd(end), limit: '50' });
    let url: string | undefined = `${META_GRAPH}/${cfg.apiVersion}/${cfg.businessId}/business_invoices?${q}`;
    const docs: FoundDocument[] = [];
    for (let page = 0; url && page < 20; page++) {
      const j: any = await graph(ctx.fetch, url, token, ctx.retry);
      for (const it of j.data ?? []) {
        const number = String(it.invoice_id ?? it.id);
        const externalId = `inv:${it.id ?? number}`;
        if (ctx.isKnown(externalId)) continue;
        let data: Buffer | null = null;
        for (const [u, auth] of [
          [it.download_uri, true],
          [it.cdn_download_uri, false],
        ] as const) {
          if (data || !u || !/^https:\/\//.test(u)) continue;
          try {
            data = await downloadPdf(ctx.fetch, u, auth ? { Authorization: `Bearer ${token}` } : {}, ctx.retry);
          } catch (e) {
            ctx.log('warn', `Meta: nu am putut descărca PDF-ul ${number}: ${(e as Error).message}`);
          }
        }
        const amount = Number(it.amount);
        const ps = String(it.payment_status ?? '').toLowerCase();
        docs.push({
          externalId,
          vendor: 'Meta (Facebook/Instagram Ads)',
          subject: `Factură Meta Ads ${number}${it.billing_period ? ` · ${String(it.billing_period).slice(0, 7)}` : ''}`,
          fileName: sanitizeFileName(`Meta_${number}.pdf`),
          data,
          mimeType: 'application/pdf',
          seriesNumber: number,
          amount: Number.isFinite(amount) ? amount : null,
          currency: it.currency ? String(it.currency).toUpperCase() : null,
          invoiceDate: it.invoice_date ? String(it.invoice_date).slice(0, 10) : null,
          dueDate: it.due_date ? String(it.due_date).slice(0, 10) : null,
          paid: ps ? ps === 'paid' : null,
          platform: 'meta',
          summary: data ? null : `Factură Meta Ads ${number}\nSumă: ${it.amount ?? '-'} ${it.currency ?? ''}\nData: ${it.invoice_date ?? '-'}\n(PDF-ul nu a putut fi descărcat – îl găsești în Meta Business → Facturare.)`,
        });
      }
      url = j.paging?.next;
    }
    return docs;
  },
  async test({ settings, secrets, fetch: f, retry }: TestDeps): Promise<TestResult> {
    const cfg = settings.sources.meta;
    const token = secrets.get('meta.token');
    if (!cfg.businessId) return { ok: false, error: 'Completează Business ID (Meta Business Settings → Business info).' };
    if (!token) return { ok: false, error: 'Lipsește tokenul de acces (System User token).' };
    try {
      const b: any = await graph(f, `${META_GRAPH}/${cfg.apiVersion}/${cfg.businessId}?fields=id,name`, token, retry);
      const inv: any = await graph(f, `${META_GRAPH}/${cfg.apiVersion}/${cfg.businessId}/business_invoices?fields=id&limit=1`, token, retry);
      const n = (inv.data ?? []).length;
      return { ok: true, info: `Business: ${b.name ?? b.id}. ${n ? 'Facturile lunare sunt accesibile.' : 'Nicio factură lunară găsită (dacă plătești cu cardul, chitanțele vin pe email și sunt preluate de acolo).'}` };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
};
