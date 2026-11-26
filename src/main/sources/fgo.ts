import { randomUUID } from 'node:crypto';
import { fetchWithRetry, type RetryOptions } from '../http.js';
import { sanitizeFileName } from './classify.js';
import type { FoundDocument, InvoiceSource, SourceContext } from './types.js';

/**
 * FGO API v2 — documentația oficială: https://api.fgo.ro/docs/
 * Autentificare (ghid): https://api.fgo.ro/docs/ghiduri/autentificare
 *
 *   Authorization: Bearer fgo_api_v2....
 *   Fgo-Cod-Unic: 12345678          // numai cifrele, fără RO, fără spații
 *
 * Cheia decide firma; Fgo-Cod-Unic doar confirmă (403 motiv.cod = cod_unic_neasociat dacă nu se potrivește).
 * Drepturi folosite de FacturaBot:
 *   furnizori:citire  → GET /v2/facturi-furnizori
 *   facturi:citire    → GET /v2/facturi și POST .../genereaza-link-de-descarcare
 * `GET /v2/identitate` nu cere un drept funcțional — e verificarea cheii.
 *
 * Listele cer obligatoriu `fields` (nume necunoscute = 400). Paginare prin cursor opac
 * din meta.pagination.next_cursor; fiecare pagină e un apel, la cel puțin 1 s de precedenta.
 * Erorile vin ca application/problem+json (RFC 9457).
 */
export const FGO_KEY_PREFIX = 'fgo_api_v2';
export const FGO_SUPPLIER_FIELDS = 'furnizor,cod_unic_furnizor,numar,nume_document,data_emitere,data_scadenta,creat_la,total,valuta,platita,status';
export const FGO_ISSUED_FIELDS = 'data_emitere,valoare_totala,valuta,status,client,cod_unic_client';

export function normalizeCodUnic(raw: string): string {
  return String(raw ?? '')
    .replace(/^RO/i, '')
    .replace(/\s/g, '')
    .replace(/[^\d]/g, '');
}

/** Acceptă și „Bearer fgo_api_v2…” lipit din documentație. */
export function normalizeFgoApiKey(raw: string): string {
  return String(raw ?? '')
    .trim()
    .replace(/^Bearer\s+/i, '')
    .trim();
}

export function isValidFgoApiKey(raw: string): boolean {
  const k = normalizeFgoApiKey(raw);
  return k.startsWith(FGO_KEY_PREFIX) && k.length > FGO_KEY_PREFIX.length;
}

export interface FgoProblem {
  status: number;
  typeSuffix?: string;
  title?: string;
  detail?: string;
  motivCod?: string;
  motivMesaj?: string;
  interactionId?: string;
}

export function parseFgoProblem(status: number, body: unknown, interactionId?: string): FgoProblem {
  const j = body && typeof body === 'object' ? (body as any) : {};
  const type = String(j.type ?? '');
  const typeSuffix = type.includes(':') ? type.split(':').pop() : type || undefined;
  return {
    status,
    typeSuffix,
    title: j.title,
    detail: j.detail,
    motivCod: j.motiv?.cod,
    motivMesaj: j.motiv?.mesaj,
    interactionId,
  };
}

export function formatFgoError(p: FgoProblem): string {
  if (p.status === 401 || p.typeSuffix === 'unauthenticated') {
    return 'Cheia API lipsește, a expirat sau a fost revocată. Generează o cheie nouă (începe cu fgo_api_v2) în FGO → eCommerce → API.';
  }
  if (p.motivCod === 'cod_unic_neasociat') {
    return 'CUI-ul nu corespunde firmei acestei chei (403 cod_unic_neasociat). Completează doar cifrele, fără RO.';
  }
  if (p.motivCod === 'drept_lipsa') {
    return p.motivMesaj ? `Drept lipsă: ${p.motivMesaj}` : 'Cheia n-are dreptul necesar pentru această operație (403 drept_lipsa).';
  }
  if (p.status === 429 || p.typeSuffix === 'rate-limited') {
    return 'Prea multe cereri către FGO (429). Reîncerc după intervalul din Retry-After (1 s pe operație).';
  }
  if (p.status === 503 || p.typeSuffix === 'maintenance') {
    return 'FGO este în mentenanță (503). Reîncerc după Retry-After.';
  }
  if (p.typeSuffix === 'invalid-cursor') {
    return 'Cursorul de paginare FGO a expirat. Reiau de la prima pagină.';
  }
  const msg = p.motivMesaj || p.detail || p.title || '';
  const typ = p.typeSuffix ? ` (${p.typeSuffix})` : '';
  return `FGO ${p.status}${typ}${msg ? ': ' + msg : ''}`.trim();
}

export interface FgoIdentitate {
  drepturi: string[];
  expiraLa: string | null;
  cautareArticolDupa?: string;
}

export interface FgoProbeResult {
  ok: boolean;
  info?: string;
  error?: string;
  identitate?: FgoIdentitate;
  missing: string[];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class FgoClient {
  private apiKey: string;
  private codUnic: string;
  private lastCallAt = new Map<string, number>();

  constructor(
    apiKey: string,
    codUnic: string,
    private base = 'https://api.fgo.ro',
    private f: typeof fetch = fetch,
    private retry: RetryOptions & { pageGapMs?: number } = {},
  ) {
    this.apiKey = normalizeFgoApiKey(apiKey);
    this.codUnic = normalizeCodUnic(codUnic);
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Fgo-Cod-Unic': this.codUnic,
      Accept: 'application/json, application/problem+json',
      'x-fapi-interaction-id': randomUUID(),
    };
  }

  private opKey(method: string, path: string) {
    // Limitele FGO sunt pe operație (ex. GET /v2/facturi-furnizori), 1 s între apeluri, inclusiv pagini.
    const clean = path.replace(/\/+$/, '').split('?')[0];
    return `${method} ${clean.replace(/\/[^/]+\/[^/]+\/genereaza-link-de-descarcare$/, '/{serie}/{numar}/genereaza-link-de-descarcare')}`;
  }

  private async throttle(op: string) {
    const gap = this.retry.pageGapMs ?? 1000;
    const last = this.lastCallAt.get(op) ?? 0;
    const wait = gap - (Date.now() - last);
    if (wait > 0) await (this.retry.sleep ?? sleep)(wait);
    this.lastCallAt.set(op, Date.now());
  }

  async request(method: 'GET' | 'POST', path: string, query?: Record<string, string>): Promise<any> {
    if (!isValidFgoApiKey(this.apiKey)) {
      throw new Error('Cheia trebuie să fie o cheie API v2 (începe cu fgo_api_v2). O generezi în FGO → eCommerce → API.');
    }
    if (!this.codUnic) throw new Error('Completează CUI-ul firmei (doar cifrele, fără RO).');

    const url = new URL(path, this.base);
    if (query) for (const [k, v] of Object.entries(query)) if (v) url.searchParams.set(k, v);

    const op = this.opKey(method, path);
    await this.throttle(op);

    const headers = this.headers();
    const r = await fetchWithRetry(this.f, url.toString(), { method, headers }, this.retry);
    const interactionId = r.headers.get('x-fapi-interaction-id') ?? headers['x-fapi-interaction-id'];
    const text = await r.text();
    let j: any = {};
    try {
      j = text ? JSON.parse(text) : {};
    } catch {
      j = { detail: text.slice(0, 200) };
    }
    this.lastCallAt.set(op, Date.now());
    if (!r.ok) {
      const err = new Error(formatFgoError(parseFgoProblem(r.status, j, interactionId ?? undefined))) as Error & { problem?: FgoProblem };
      err.problem = parseFgoProblem(r.status, j, interactionId ?? undefined);
      throw err;
    }
    return j;
  }

  identitate(): Promise<{ data: { drepturi?: string[]; expira_la?: string | null; cautare_articol_dupa?: string } }> {
    return this.request('GET', '/v2/identitate');
  }

  async probe(needed: string[] = []): Promise<FgoProbeResult> {
    try {
      const j = await this.identitate();
      const d = j.data ?? {};
      const drepturi = Array.isArray(d.drepturi) ? d.drepturi.map(String) : [];
      const missing = needed.filter((n) => !drepturi.includes(n));
      const expiraLa = d.expira_la ?? null;
      const identitate: FgoIdentitate = { drepturi, expiraLa, cautareArticolDupa: d.cautare_articol_dupa };
      const parts = [
        drepturi.length ? `Drepturi: ${drepturi.join(', ')}` : 'Fără drepturi pe cheie',
        expiraLa ? `Expiră: ${new Date(expiraLa).toLocaleString('ro-RO')}` : 'Fără termen de expirare',
      ];
      if (missing.length) parts.push(`Lipsește: ${missing.join(', ')}. Adaugă dreptul când generezi cheia.`);
      return { ok: missing.length === 0, info: parts.join(' · '), identitate, missing, error: missing.length ? `Cheia e validă, dar lipsește ${missing.join(', ')}.` : undefined };
    } catch (e) {
      return { ok: false, error: (e as Error).message, missing: needed };
    }
  }

  async *paginate(path: string, query: Record<string, string>) {
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      try {
        const j = await this.request('GET', path, { ...query, ...(cursor ? { cursor } : {}) });
        for (const item of j.data ?? []) yield item;
        cursor = j.meta?.pagination?.next_cursor || undefined;
        if (!cursor || ++pages >= 50) return;
      } catch (e) {
        const problem = (e as any).problem as FgoProblem | undefined;
        if (problem?.typeSuffix === 'invalid-cursor' && cursor) {
          cursor = undefined; // reiau de la capăt o dată
          continue;
        }
        throw e;
      }
    }
  }

  async downloadLink(serie: string, numar: string): Promise<string> {
    const j = await this.request('POST', `/v2/facturi/${encodeURIComponent(serie)}/${encodeURIComponent(numar)}/genereaza-link-de-descarcare`);
    const link = j.data?.link;
    if (!link) throw new Error('FGO nu a întors un link de descărcare');
    return link;
  }
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const clientName = (c: unknown): string => (c && typeof c === 'object' ? String((c as any).denumire ?? (c as any).nume ?? (c as any).name ?? '-') : String(c ?? '-'));

function neededRights(cfg: { includeSuppliers: boolean; includeIssued: boolean }) {
  const n: string[] = [];
  if (cfg.includeSuppliers) n.push('furnizori:citire');
  if (cfg.includeIssued) n.push('facturi:citire');
  return n;
}

export const fgoSource: InvoiceSource = {
  id: 'fgo',
  label: 'FGO',
  isEnabled: (s, secrets) => s.sources.fgo.enabled && !!normalizeCodUnic(s.sources.fgo.codUnic ?? '') && secrets.has('fgo.apiKey'),
  async fetchNew(ctx: SourceContext): Promise<FoundDocument[]> {
    const cfg = ctx.settings.sources.fgo;
    const client = new FgoClient(ctx.secrets.get('fgo.apiKey')!, cfg.codUnic ?? '', cfg.apiBase || 'https://api.fgo.ro', ctx.fetch, ctx.retry);
    const docs: FoundDocument[] = [];
    // Interval maxim permis de API la facturi emise: 1 an.
    const since = new Date(Math.max(ctx.since.getTime(), Date.now() - 360 * 86400_000));

    if (cfg.includeSuppliers) {
      for await (const it of client.paginate('/v2/facturi-furnizori', {
        data_primire_de_la: ymd(since),
        data_primire_pana_la: ymd(new Date()),
        fields: FGO_SUPPLIER_FIELDS,
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
            `Factură furnizor (din FGO)\n` +
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
        fields: FGO_ISSUED_FIELDS,
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
          if (r.ok && (ct.includes('pdf') || ct.includes('octet-stream'))) data = Buffer.from(await r.arrayBuffer());
        } catch (e) {
          ctx.log('warn', `FGO: nu am putut descărca PDF-ul ${it.serie}-${it.numar}: ${(e as Error).message}`);
        }
        const who = clientName(it.client);
        docs.push({
          externalId,
          vendor: `Emisă către ${who}`,
          subject: `Factura emisă ${it.serie} ${it.numar}`,
          fileName: sanitizeFileName(`Factura_${it.serie}_${it.numar}.pdf`),
          data,
          mimeType: 'application/pdf',
          seriesNumber: `${it.serie}${it.numar}`,
          amount: it.valoare_totala ?? null,
          currency: it.valuta ?? 'RON',
          invoiceDate: it.data_emitere ?? null,
          summary: data ? null : `Factura emisă ${it.serie} ${it.numar} către ${who} – ${it.valoare_totala ?? ''} ${it.valuta ?? ''}\n${link ?? ''}`,
        });
      }
    }
    return docs;
  },
};

export { neededRights as fgoNeededRights };
