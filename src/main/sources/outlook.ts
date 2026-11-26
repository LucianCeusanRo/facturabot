import { fetchWithRetry } from '../http.js';
import { microsoftAccessToken } from '../oauth/microsoft.js';
import { classify, extractPdfText, extractSeriesNumber, sanitizeFileName } from './classify.js';
import type { FoundDocument, InvoiceSource, SourceContext } from './types.js';

const GRAPH = 'https://graph.microsoft.com/v1.0/me';

export const outlookSource: InvoiceSource = {
  id: 'outlook',
  label: 'Outlook / Microsoft 365',
  isEnabled: (s, secrets) => s.sources.outlook.enabled && secrets.has('microsoft.tokens'),
  async fetchNew(ctx: SourceContext): Promise<FoundDocument[]> {
    const token = await microsoftAccessToken(ctx.settings.oauthClients.microsoftClientId, ctx.secrets, ctx.fetch);
    const det = ctx.settings.detection;
    const maxBytes = det.maxAttachmentMB * 1024 * 1024;
    const get = async (url: string) => {
      const r = await fetchWithRetry(ctx.fetch, url, { headers: { Authorization: `Bearer ${token}` } }, ctx.retry);
      if (!r.ok) throw new Error(`Outlook ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return r.json() as Promise<any>;
    };
    const filter = `receivedDateTime ge ${ctx.since.toISOString()} and hasAttachments eq true`;
    let url: string | undefined =
      `${GRAPH}/messages?$filter=${encodeURIComponent(filter)}&$select=id,subject,from,receivedDateTime,bodyPreview&$top=50&$orderby=receivedDateTime desc`;
    const docs: FoundDocument[] = [];
    let pages = 0;
    while (url && pages++ < 10) {
      const j: any = await get(url);
      for (const m of j.value ?? []) {
        const from = m.from?.emailAddress ? `${m.from.emailAddress.name} <${m.from.emailAddress.address}>` : '';
        const atts: any = await get(`${GRAPH}/messages/${m.id}/attachments?$select=id,name,contentType,size`);
        for (const a of atts.value ?? []) {
          if (!(a.contentType === 'application/pdf' || /\.pdf$/i.test(a.name ?? ''))) continue;
          const externalId = `${m.id}:${a.id}`;
          if (ctx.isKnown(externalId)) continue;
          const c = classify({ from, subject: m.subject ?? '', fileName: a.name, mimeType: a.contentType, bodySnippet: m.bodyPreview }, det);
          if (!c.isInvoice) continue;
          if ((a.size ?? 0) > maxBytes) {
            ctx.log('warn', `Atașament prea mare ignorat (${Math.round(a.size / 1048576)} MB): ${a.name}`);
            continue;
          }
          const full: any = await get(`${GRAPH}/messages/${m.id}/attachments/${a.id}`);
          if (!full.contentBytes) continue;
          const data = Buffer.from(full.contentBytes, 'base64');
          const pdfText = extractPdfText(data);
          const c2 = classify({ from, subject: m.subject ?? '', fileName: a.name, mimeType: a.contentType, bodySnippet: m.bodyPreview, pdfText }, det);
          if (!c2.isInvoice) continue;
          docs.push({
            externalId,
            vendor: c2.biller?.name ?? m.from?.emailAddress?.name ?? null,
            subject: m.subject,
            fileName: sanitizeFileName(a.name),
            data,
            mimeType: 'application/pdf',
            seriesNumber: extractSeriesNumber(a.name, m.subject, pdfText),
            invoiceDate: String(m.receivedDateTime).slice(0, 10),
          });
        }
      }
      url = j['@odata.nextLink'];
    }
    return docs;
  },
};
