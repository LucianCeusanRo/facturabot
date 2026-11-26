import { AuthExpiredError, fetchWithRetry } from '../http.js';
import { sanitizeFileName } from './classify.js';
import { ymd } from './download.js';
import type { FoundDocument, InvoiceSource, SourceContext, TestDeps, TestResult } from './types.js';

/**
 * TikTok API for Business v1.3 – facturile Business Center.
 * Lista oficială de endpoint-uri: https://business-api.tiktok.com/portal/docs/api-reference/v1.3
 *   GET /bc/invoice/get/       – Finance Manager / Finance Analyst; scope „Business Center > Invoice Management”
 *   GET /bc/invoice/download/  – descărcare sincronă (răspunsul e fișierul, nu JSON)
 * Parametri (colecția Postman oficială TikTok): bc_id, invoice_types (JSON array), start_time, end_time
 * („YYYY-MM-DD HH:mm:ss”), page, page_size. Autentificare: antet `Access-Token`.
 * Răspuns: { code: 0, message, request_id, data }. Câmpurile facturii sunt citite tolerant (mai multe denumiri).
 */
const AUTH_CODES = new Set([40001, 40100, 40102, 40104, 40105]);

export function tiktokError(status: number, j: any): Error {
  const code = Number(j?.code);
  if (status === 401 || AUTH_CODES.has(code)) return new AuthExpiredError('tiktok', 'Tokenul TikTok a expirat sau nu are acces. Reautorizează aplicația în TikTok for Business.');
  if (code === 40002 || code === 40003) return new Error(`TikTok: parametru invalid (${j?.message ?? code})`);
  return new Error(`TikTok ${status}${code ? ` / ${code}` : ''}${j?.message ? ': ' + j.message : ''}`);
}

const pick = (o: any, ...keys: string[]) => {
  for (const k of keys) if (o?.[k] != null && o[k] !== '') return o[k];
  return null;
};

export function tiktokInvoiceList(data: any): any[] {
  const l = pick(data, 'invoices', 'invoice_list', 'list', 'invoice_infos');
  return Array.isArray(l) ? l : [];
}

async function api(f: typeof fetch, base: string, path: string, q: Record<string, string>, token: string, retry?: SourceContext['retry']) {
  const url = `${base}${path}?${new URLSearchParams(q)}`;
  const r = await fetchWithRetry(f, url, { headers: { 'Access-Token': token, Accept: 'application/json' } }, retry);
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || Number(j.code) !== 0) throw tiktokError(r.status, j);
  return j.data ?? {};
}

const ttTime = (d: Date) => `${ymd(d)} ${d.toISOString().slice(11, 19)}`;

export const tiktokSource: InvoiceSource = {
  id: 'tiktok',
  label: 'TikTok Ads',
  isEnabled: (s, secrets) => s.sources.tiktok.enabled && !!s.sources.tiktok.bcId && secrets.has('tiktok.token'),
  async fetchNew(ctx: SourceContext): Promise<FoundDocument[]> {
    const cfg = ctx.settings.sources.tiktok;
    const token = ctx.secrets.get('tiktok.token');
    if (!token) throw new AuthExpiredError('tiktok', 'Lipsește tokenul TikTok');
    const docs: FoundDocument[] = [];
    let totalPages = 1;
    for (let page = 1; page <= totalPages && page <= 20; page++) {
      const q: Record<string, string> = { bc_id: cfg.bcId, start_time: ttTime(ctx.since), end_time: ttTime(new Date()), page: String(page), page_size: '50' };
      if (cfg.invoiceTypes.length) q.invoice_types = JSON.stringify(cfg.invoiceTypes);
      const data = await api(ctx.fetch, cfg.apiBase, '/bc/invoice/get/', q, token, ctx.retry);
      totalPages = Number(data.page_info?.total_page ?? 1) || 1;
      for (const it of tiktokInvoiceList(data)) {
        const id = String(pick(it, 'invoice_id', 'id') ?? '');
        if (!id) continue;
        const externalId = `inv:${id}`;
        if (ctx.isKnown(externalId)) continue;
        const number = String(pick(it, 'invoice_serial_number', 'invoice_no', 'invoice_number', 'serial_number') ?? id);
        let data2: Buffer | null = null;
        try {
          const r = await fetchWithRetry(
            ctx.fetch,
            `${cfg.apiBase}/bc/invoice/download/?${new URLSearchParams({ bc_id: cfg.bcId, invoice_id: id })}`,
            { headers: { 'Access-Token': token } },
            ctx.retry,
          );
          const buf = Buffer.from(await r.arrayBuffer());
          if (r.ok && buf.subarray(0, 5).toString('latin1') === '%PDF-') data2 = buf;
          else ctx.log('warn', `TikTok: factura ${number} nu a venit ca PDF (${r.status}).`);
        } catch (e) {
          ctx.log('warn', `TikTok: descărcare eșuată pentru ${number}: ${(e as Error).message}`);
        }
        const amount = Number(pick(it, 'amount', 'total_amount', 'invoice_amount', 'amount_due'));
        const date = pick(it, 'invoice_date', 'issue_date', 'create_time', 'invoice_time');
        const due = pick(it, 'due_date', 'payment_due_date');
        const status = String(pick(it, 'payment_status', 'status') ?? '').toUpperCase();
        docs.push({
          externalId,
          vendor: 'TikTok',
          subject: `Factură TikTok Ads ${number}`,
          fileName: sanitizeFileName(`TikTok_${number}.pdf`),
          data: data2,
          mimeType: 'application/pdf',
          seriesNumber: number,
          amount: Number.isFinite(amount) ? amount : null,
          currency: pick(it, 'currency', 'currency_code') ? String(pick(it, 'currency', 'currency_code')).toUpperCase() : null,
          invoiceDate: date ? String(date).slice(0, 10) : null,
          dueDate: due ? String(due).slice(0, 10) : null,
          paid: status ? status === 'PAID' || status === 'SETTLED' : null,
          platform: 'tiktok',
          summary: data2 ? null : `Factură TikTok Ads ${number}\nSumă: ${Number.isFinite(amount) ? amount : '-'} ${pick(it, 'currency') ?? ''}\n(PDF-ul e în TikTok Business Center → Billing.)`,
        });
      }
    }
    return docs;
  },
  async test({ settings, secrets, fetch: f, retry }: TestDeps): Promise<TestResult> {
    const cfg = settings.sources.tiktok;
    const token = secrets.get('tiktok.token');
    if (!cfg.bcId) return { ok: false, error: 'Completează Business Center ID (Business Center → Business info).' };
    if (!token) return { ok: false, error: 'Lipsește tokenul de acces TikTok for Business.' };
    try {
      const bc = await api(f, cfg.apiBase, '/bc/get/', { bc_id: cfg.bcId }, token, retry);
      const name = bc.list?.[0]?.bc_info?.name ?? cfg.bcId;
      const since = new Date(Date.now() - 90 * 86400_000);
      const inv = await api(f, cfg.apiBase, '/bc/invoice/get/', { bc_id: cfg.bcId, start_time: ttTime(since), end_time: ttTime(new Date()), page: '1', page_size: '1' }, token, retry);
      const n = Number(inv.page_info?.total_number ?? tiktokInvoiceList(inv).length);
      return { ok: true, info: `Business Center: ${name}. ${n} ${n === 1 ? 'factură' : 'facturi'} în ultimele 90 de zile.` };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
};
