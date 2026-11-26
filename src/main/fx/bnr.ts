import type { FxRule } from '../../shared/types.js';
import { fetchWithRetry, type RetryOptions } from '../http.js';

/**
 * Cursul de referință BNR.
 *  - zilnic:  {base}/nbrfxrates.xml
 *  - anual:   {base}/files/xml/years/nbrfxrates{YYYY}.xml
 * Din 2026 fișierele XML sunt servite de https://curs.bnr.ro (www.bnr.ro/nbrfxrates.xml redirecționează
 * acum spre pagina principală). Ambele bazele sunt configurabile.
 *
 * Regula pentru facturi în valută (art. 290 Cod fiscal): se folosește ultimul curs comunicat de BNR
 * ANTERIOR datei facturii → `fxRule: 'previous'` (implicit). `same-day` = cursul publicat în ziua facturii.
 */
export interface Rate {
  day: string;
  currency: string;
  rate: number; // lei pentru 1 unitate de valută (multiplicatorul e aplicat)
}

export function parseBnrXml(xml: string): Rate[] {
  const out: Rate[] = [];
  const cubes = String(xml ?? '').matchAll(/<Cube\s+date="(\d{4}-\d{2}-\d{2})"\s*>([\s\S]*?)<\/Cube>/g);
  for (const c of cubes) {
    for (const r of c[2].matchAll(/<Rate\s+currency="([A-Z]{3})"(?:\s+multiplier="(\d+)")?\s*>([\d.]+)<\/Rate>/g)) {
      const mult = r[2] ? Number(r[2]) : 1;
      const v = Number(r[3]);
      if (!Number.isFinite(v) || v <= 0 || !mult) continue;
      out.push({ day: c[1], currency: r[1], rate: Math.round((v / mult) * 1e8) / 1e8 });
    }
  }
  return out;
}

export interface RateStore {
  putRates(rows: Rate[]): void;
  findRate(currency: string, day: string, strictlyBefore: boolean): { day: string; rate: number } | null;
  hasRatesFor(year: number): boolean;
  latestRateDay(): string | null;
}

export class BnrRates {
  private loading = new Map<string, Promise<void>>();

  constructor(
    private store: RateStore,
    private opts: { base: string | (() => string); fetch: typeof fetch; retry?: RetryOptions; now?: () => Date },
  ) {}

  private async load(url: string) {
    const r = await fetchWithRetry(this.opts.fetch, url, { headers: { Accept: 'application/xml,text/xml' } }, this.opts.retry);
    const ct = r.headers.get('content-type') ?? '';
    const body = await r.text();
    if (!r.ok || (!ct.includes('xml') && !body.trimStart().startsWith('<?xml'))) throw new Error(`Curs BNR indisponibil (${r.status}) la ${url}`);
    const rates = parseBnrXml(body);
    if (!rates.length) throw new Error('Fișierul BNR nu conține cursuri');
    this.store.putRates(rates);
  }

  private once(key: string, url: string) {
    let p = this.loading.get(key);
    if (!p) {
      p = this.load(url).finally(() => this.loading.delete(key));
      this.loading.set(key, p);
    }
    return p;
  }

  /** Asigură cursurile pentru anul dat (fișierul anual) și cele mai recente (fișierul zilnic). */
  async ensure(day: string) {
    const base = (typeof this.opts.base === 'function' ? this.opts.base() : this.opts.base).replace(/\/+$/, '');
    const year = Number(day.slice(0, 4));
    const now = (this.opts.now ?? (() => new Date()))();
    const latest = this.store.latestRateDay();
    if (!this.store.hasRatesFor(year)) await this.once(`y${year}`, `${base}/files/xml/years/nbrfxrates${year}.xml`);
    // Prima zi lucrătoare din an are nevoie de cursul din decembrie anul trecut.
    if (day.slice(5) <= '01-07' && !this.store.hasRatesFor(year - 1)) await this.once(`y${year - 1}`, `${base}/files/xml/years/nbrfxrates${year - 1}.xml`);
    if (year === now.getUTCFullYear() && (!latest || latest < day)) await this.once('today', `${base}/nbrfxrates.xml`).catch(() => undefined);
  }

  /** Curs lei/valută pentru data facturii; null dacă nu există (ex. valută necotată de BNR). */
  async rate(currency: string, day: string, rule: FxRule = 'previous'): Promise<{ rate: number; day: string } | null> {
    const cur = currency.toUpperCase();
    if (cur === 'RON' || cur === 'LEI') return { rate: 1, day };
    const strict = rule === 'previous';
    let hit = this.store.findRate(cur, day, strict);
    // Cursul găsit trebuie să fie „recent” (max. 7 zile – weekenduri/sărbători); altfel descărcăm.
    if (!hit || daysBetween(hit.day, day) > 7) {
      await this.ensure(day);
      hit = this.store.findRate(cur, day, strict);
    }
    return hit && daysBetween(hit.day, day) <= 10 ? hit : null;
  }
}

export function daysBetween(a: string, b: string) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400_000);
}
