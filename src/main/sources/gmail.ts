import { fetchWithRetry } from '../http.js';
import { googleAccessToken } from '../oauth/google.js';
import { classify, extractSeriesNumber, KNOWN_BILLERS, sanitizeFileName } from './classify.js';
import type { FoundDocument, InvoiceSource, SourceContext } from './types.js';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

const quote = (k: string) => (/\s/.test(k) ? `"${k.replace(/"/g, '')}"` : k);

export function buildGmailQuery(since: Date, extra?: string, opts: { extraKeywords?: string[]; excludeSenders?: string[] } = {}): string {
  const after = Math.floor(since.getTime() / 1000);
  const bodyBillers = KNOWN_BILLERS.filter((b) => b.bodyReceipt)
    .flatMap((b) => b.domains)
    .join(' OR ');
  const words = ['factura', 'factură', 'facturi', 'invoice', 'receipt', 'chitanta', 'chitanță', 'bon fiscal', 'billing', 'payment confirmation', ...(opts.extraKeywords ?? [])];
  const kw = `(${words.map(quote).join(' OR ')})`;
  const excl = (opts.excludeSenders ?? []).map((e) => ` -from:${e.replace(/[\s()"]/g, '')}`).join('');
  const q = `after:${after} -in:sent -in:drafts -in:spam${excl} ((has:attachment filename:pdf) OR (from:(${bodyBillers}) ${kw}))`;
  return extra?.trim() ? `${q} ${extra.trim()}` : q;
}

function b64urlToBuf(s: string) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

interface GPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  body?: { attachmentId?: string; data?: string; size?: number };
  parts?: GPart[];
}

function walk(p: GPart | undefined, out: GPart[] = []): GPart[] {
  if (!p) return out;
  out.push(p);
  for (const c of p.parts ?? []) walk(c, out);
  return out;
}

export const gmailSource: InvoiceSource = {
  id: 'gmail',
  label: 'Gmail',
  isEnabled: (s, secrets) => s.sources.gmail.enabled && secrets.has('google.tokens'),
  async fetchNew(ctx: SourceContext): Promise<FoundDocument[]> {
    const token = await googleAccessToken(ctx.settings.oauthClients.googleClientId, ctx.secrets, ctx.fetch);
    const get = async (path: string) => {
      const r = await fetchWithRetry(ctx.fetch, `${API}${path}`, { headers: { Authorization: `Bearer ${token}` } }, ctx.retry);
      if (!r.ok) throw new Error(`Gmail ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return r.json() as Promise<any>;
    };
    const det = ctx.settings.detection;
    const maxBytes = det.maxAttachmentMB * 1024 * 1024;
    const q = buildGmailQuery(ctx.since, ctx.settings.sources.gmail.extraQuery, det);
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const j = await get(`/messages?maxResults=100&q=${encodeURIComponent(q)}${pageToken ? `&pageToken=${pageToken}` : ''}`);
      for (const m of j.messages ?? []) ids.push(m.id);
      pageToken = j.nextPageToken;
    } while (pageToken && ids.length < 500);

    const docs: FoundDocument[] = [];
    for (const id of ids) {
      const msg = await get(`/messages/${id}?format=full`);
      const headers: Record<string, string> = {};
      for (const h of msg.payload?.headers ?? []) headers[h.name.toLowerCase()] = h.value;
      const from = headers.from ?? '';
      const subject = headers.subject ?? '';
      const date = headers.date ? new Date(headers.date) : new Date(Number(msg.internalDate));
      const parts = walk(msg.payload);
      const pdfs = parts.filter((p) => p.filename && (p.mimeType === 'application/pdf' || /\.pdf$/i.test(p.filename)));

      if (pdfs.length) {
        for (const p of pdfs) {
          const externalId = `${id}:${p.partId}:${p.filename}`;
          if (ctx.isKnown(externalId)) continue;
          const c = classify({ from, subject, fileName: p.filename, mimeType: p.mimeType, bodySnippet: msg.snippet }, det);
          if (!c.isInvoice) continue;
          if ((p.body?.size ?? 0) > maxBytes) {
            ctx.log('warn', `Atașament prea mare ignorat (${Math.round((p.body!.size ?? 0) / 1048576)} MB): ${p.filename}`);
            continue;
          }
          let data: Buffer;
          if (p.body?.attachmentId) {
            const a = await get(`/messages/${id}/attachments/${p.body.attachmentId}`);
            data = b64urlToBuf(a.data);
          } else if (p.body?.data) data = b64urlToBuf(p.body.data);
          else continue;
          docs.push({
            externalId,
            vendor: c.biller?.name ?? from.replace(/<.*>/, '').replace(/"/g, '').trim(),
            subject,
            fileName: sanitizeFileName(p.filename!),
            data,
            mimeType: 'application/pdf',
            seriesNumber: extractSeriesNumber(p.filename, subject),
            invoiceDate: date.toISOString().slice(0, 10),
          });
        }
      } else {
        // Chitanță în corpul emailului (ex. Meta Ads, PayPal) → o convertim în PDF.
        const externalId = `${id}:body`;
        if (ctx.isKnown(externalId) || !ctx.htmlToPdf) continue;
        const c = classify({ from, subject, bodySnippet: msg.snippet }, det);
        if (!c.isInvoice || !c.biller?.bodyReceipt) continue;
        const htmlPart = parts.find((p) => p.mimeType === 'text/html' && p.body?.data);
        const textPart = parts.find((p) => p.mimeType === 'text/plain' && p.body?.data);
        const html = htmlPart
          ? b64urlToBuf(htmlPart.body!.data!).toString('utf8')
          : `<pre>${b64urlToBuf(textPart?.body?.data ?? '').toString('utf8').replace(/</g, '&lt;')}</pre>`;
        const header = `<div style="font:12px sans-serif;color:#555;border-bottom:1px solid #ddd;padding:8px;margin-bottom:8px">De la: ${from.replace(/</g, '&lt;')}<br>Subiect: ${subject.replace(/</g, '&lt;')}<br>Data: ${date.toLocaleString('ro-RO')}</div>`;
        const pdf = await ctx.htmlToPdf(header + html);
        docs.push({
          externalId,
          vendor: c.biller.name,
          subject,
          fileName: sanitizeFileName(`${c.biller.name.split(' ')[0]}_chitanta_${date.toISOString().slice(0, 10)}_${id.slice(-6)}.pdf`),
          data: pdf,
          mimeType: 'application/pdf',
          seriesNumber: extractSeriesNumber(subject),
          invoiceDate: date.toISOString().slice(0, 10),
        });
      }
    }
    return docs;
  },
};
