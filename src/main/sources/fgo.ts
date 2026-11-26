import { fetchWithRetry, type RetryOptions } from '../http.js';
import { sanitizeFileName } from './classify.js';
import type { FoundDocument, InvoiceSource, SourceContext } from './types.js';

/**
 * FGO API v2 (https://api.fgo.ro/docs/). Autentificare: `Authorization: Bearer <cheie>` + `Fgo-Cod-Unic: <CUI fără RO>`.
 * - GET /v2/facturi-furnizori  → documente primite de la furnizori (API-ul nu oferă PDF → trimitem un rezumat text)
 * - GET /v2/facturi            → facturi emise; PDF prin POST /v2/facturi/{serie}/{numar}/genereaza-link-de-descarcare
 */
export class FgoClient {
  constructor(
    private apiKey: string,
    private codUnic: string,
    private base = 'https://api.fgo.ro',
    private f: typeof fetch = fetch,
    private retry: RetryOptions = {},
  ) {}

  private headers() {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Fgo-Cod-Unic': this.codUnic.replace(/^RO/i, '').replace(/\s/g, ''),
      Accept: 'application/json',
    };
  }

  async request(method: 'GET' | 'POST', path: string, query?: Record<string, string>): Promise<any> {
    const url = new URL(path, this.base);
    if (query) for (const [k, v] of Object.entries(query)) if (v) url.searchParams.set(k, v);
    const r = await fetchWithRetry(this.f, url.toString(), { method, headers: this.headers() }, this.retry);
    const text = await r.text();
    let j: any = {};
    try {
      j = text ? JSON.parse(text) : {};
    } catch {
      j = { detail: text.slice(0, 200) };
    }
    if (r.status === 429) throw new Error('FGO: prea multe cereri (429) – reîncerc la următoarea sincronizare');
    if (r.status === 401 || r.status === 403) throw new Error(`FGO ${r.status}: ${j.detail || j.title || 'acces refuzat'} – verifică cheia API și CUI-ul`);
    if (!r.ok) throw new Error(`FGO ${r.status}: ${j.detail || j.title || text.slice(0, 200)}`);
    return j;
  }

  identitate() {
    return this.request('GET', '/v2/identitate');
  }

  async *paginate(path: string, query: Record<string, string>) {
    let cursor: string | undefined;
    let pages = 0;
    do {
      const j = await this.request('GET', path, { ...query, ...(cursor ? { cursor } : {}) });
      for (const item of j.data ?? []) yield item;
      cursor = j.meta?.pagination?.next_cursor ?? undefined;
    } while (cursor && ++pages < 50);
  }

  async downloadLink(serie: string, numar: string): Promise<string> {
    const j = await this.request('POST', `/v2/facturi/${encodeURIComponent(serie)}/${encodeURIComponent(numar)}/genereaza-link-de-descarcare`);
    return j.data.link;
  }
}

/** Câmpul „client” poate fi text sau obiect (în funcție de `fields`). */
const clientName = (c: any): string => (c && typeof c === 'object' ? (c.denumire ?? c.nume ?? c.name ?? '-') : (c ?? '-'));

const ymd = (d: Date) => d.toISOString().slice(0, 10);

export const fgoSource: InvoiceSource = {
  id: 'fgo',
  label: 'FGO',
  isEnabled: (s, secrets) => s.sources.fgo.enabled && !!s.sources.fgo.codUnic && secrets.has('fgo.apiKey'),
  async fetchNew(ctx: SourceContext): Promise<FoundDocument[]> {
    const cfg = ctx.settings.sources.fgo;
    const client = new FgoClient(ctx.secrets.get('fgo.apiKey')!, cfg.codUnic!, cfg.apiBase || 'https://api.fgo.ro', ctx.fetch, ctx.retry);
    const docs: FoundDocument[] = [];
    // Interval maxim permis de API: 1 an.
    const since = new Date(Math.max(ctx.since.getTime(), Date.now() - 360 * 86400_000));

    if (cfg.includeSuppliers) {
      for await (const it of client.paginate('/v2/facturi-furnizori', {
        data_primire_de_la: ymd(since),
        data_primire_pana_la: ymd(new Date()),
        fields: 'furnizor,cod_unic_furnizor,numar,nume_document,data_emitere,data_scadenta,total,valuta,platita',
        limit: '100',
      })) {
        const externalId = `furnizor:${it.id}`;
        if (ctx.isKnown(externalId)) continue;
        docs.push({
          externalId,
          vendor: it.furnizor,
          subject: `${it.nume_document ?? 'Factură furnizor'} ${it.numar ?? ''}`.trim(),
          seriesNumber: it.numar ? `${it.cod_unic_furnizor ?? ''}-${it.numar}` : null,
          amount: it.total ?? null,
          currency: it.valuta ?? 'RON',
          invoiceDate: it.data_emitere ?? null,
          summary:
            `📄 Factură furnizor (din FGO)\n` +
            `Furnizor: ${it.furnizor ?? '-'}${it.cod_unic_furnizor ? ` (CUI ${it.cod_unic_furnizor})` : ''}\n` +
            `Număr: ${it.numar ?? '-'}\nData: ${it.data_emitere ?? '-'} · Scadență: ${it.data_scadenta ?? '-'}\n` +
            `Total: ${it.total ?? '-'} ${it.valuta ?? 'RON'} · ${it.platita ? 'achitată' : 'neachitată'}\n` +
            `(Documentul complet este în FGO → Furnizori → Documente primite.)`,
        });
      }
    }

    if (cfg.includeIssued) {
      for await (const it of client.paginate('/v2/facturi', {
        data_emitere_de_la: ymd(since),
        data_emitere_pana_la: ymd(new Date()),
        fields: 'data_emitere,valoare_totala,valuta,status,client',
        limit: '100',
      })) {
        if (it.status === 'draft') continue;
        const externalId = `emisa:${it.serie}-${it.numar}`;
        if (ctx.isKnown(externalId)) continue;
        let data: Buffer | null = null;
        let link: string | null = null;
        try {
          link = await client.downloadLink(it.serie, it.numar);
          const r = await fetchWithRetry(ctx.fetch, link, { redirect: 'follow' }, ctx.retry);
          const ct = r.headers.get('content-type') ?? '';
          if (r.ok && ct.includes('pdf')) data = Buffer.from(await r.arrayBuffer());
        } catch (e) {
          ctx.log('warn', `FGO: nu am putut descărca PDF-ul ${it.serie}-${it.numar}: ${(e as Error).message}`);
        }
        docs.push({
          externalId,
          vendor: `Emisă către ${clientName(it.client)}`,
          subject: `Factura emisă ${it.serie} ${it.numar}`,
          fileName: sanitizeFileName(`Factura_${it.serie}_${it.numar}.pdf`),
          data,
          mimeType: 'application/pdf',
          seriesNumber: `${it.serie}${it.numar}`,
          amount: it.valoare_totala ?? null,
          currency: it.valuta ?? 'RON',
          invoiceDate: it.data_emitere ?? null,
          summary: data ? null : `📄 Factura emisă ${it.serie} ${it.numar} către ${clientName(it.client)} – ${it.valoare_totala ?? ''} ${it.valuta ?? ''}\n${link ?? ''}`,
        });
      }
    }
    return docs;
  },
};
