import type { Insight, ReverseChargeItem, SpendingReport, TaxOverview } from '../shared/types.js';
import type { SettingsStore } from './config.js';
import { TAX_SOURCES } from './config.js';
import type { Db } from './db.js';
import { BnrRates } from './fx/bnr.js';
import type { RetryOptions } from './http.js';
import { buildSpending } from './analytics.js';
import { dueReminders, missingInvoices } from './insights.js';
import type { SecretStore } from './secrets.js';
import { FgoClient, normalizeCodUnic } from './sources/fgo.js';
import { fgoRevenue, type RevenueSummary } from './tax/revenue.js';
import { crossedLevels, ossProgress, round2, thresholdProgress } from './tax/thresholds.js';
import { DISCLAIMER, vatObligations } from './tax/vat.js';
import { checkVies, type ViesResult } from './tax/vies.js';

export interface FinanceDeps {
  db: Db;
  settings: SettingsStore;
  secrets: SecretStore;
  fetch?: typeof fetch;
  retry?: RetryOptions;
  notify?: (title: string, body: string) => void;
  now?: () => Date;
  /** Client FGO injectabil (teste). */
  fgoClient?: () => Pick<FgoClient, 'paginate'> | null;
}

const REVENUE_TTL_MS = 6 * 3600_000;
const VIES_TTL_MS = 30 * 86400_000;

export const monthEnd = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

/** Analiză cheltuieli, TVA, praguri și mementouri – totul local, pe reguli. */
export class Finance {
  readonly fx: BnrRates;

  constructor(private d: FinanceDeps) {
    this.fx = new BnrRates(d.db, {
      base: () => d.settings.get().tax.bnrBaseUrl,
      fetch: d.fetch ?? fetch,
      retry: d.retry,
      now: d.now,
    });
  }

  private now() {
    return (this.d.now ?? (() => new Date()))();
  }

  private rate = async (currency: string, day: string) => (await this.fx.rate(currency, day, this.d.settings.get().tax.fxRule))?.rate ?? null;

  /** Completează suma în lei (curs BNR la data facturii) pentru facturile care n-o au. */
  async convertPending(limit = 300): Promise<{ converted: number; failed: number }> {
    let converted = 0;
    let failed = 0;
    for (const inv of this.d.db.listUnconverted(limit)) {
      const day = inv.invoiceDate ?? inv.createdAt.slice(0, 10);
      try {
        const r = await this.rate(inv.currency ?? 'RON', day);
        if (r == null) {
          failed++;
          continue;
        }
        this.d.db.setConversion(inv.id, round2(inv.amount! * r), r);
        converted++;
      } catch {
        failed++;
        break; // BNR indisponibil – reîncercăm la următoarea sincronizare
      }
    }
    return { converted, failed };
  }

  private fgo(): Pick<FgoClient, 'paginate'> | null {
    if (this.d.fgoClient) return this.d.fgoClient();
    const s = this.d.settings.get().sources.fgo;
    const key = this.d.secrets.get('fgo.apiKey');
    if (!s.enabled || !key || !normalizeCodUnic(s.codUnic ?? '')) return null;
    return new FgoClient(key, s.codUnic ?? '', s.apiBase, this.d.fetch ?? fetch, this.d.retry);
  }

  cachedRevenue(year: number): RevenueSummary | null {
    const raw = this.d.db.getKv(`revenue:${year}`);
    try {
      return raw ? (JSON.parse(raw) as RevenueSummary) : null;
    } catch {
      return null;
    }
  }

  /** Recitește veniturile din FGO (cel mult o dată la 6 ore, sau forțat). */
  async refreshRevenue(force = false, year = this.now().getUTCFullYear()): Promise<RevenueSummary | null> {
    const cached = this.cachedRevenue(year);
    const fresh = cached && this.now().getTime() - Date.parse(cached.updatedAt) < (year < this.now().getUTCFullYear() ? 7 * 86400_000 : REVENUE_TTL_MS);
    if (fresh && !force) return cached;
    const client = this.fgo();
    if (!client) return cached;
    const r = await fgoRevenue(client, year, this.rate, this.now());
    this.d.db.setKv(`revenue:${year}`, JSON.stringify(r));
    return r;
  }

  /** Venituri din facturile emise salvate local (fallback când FGO nu e conectat). */
  localRevenue(year: number) {
    const rows = this.d.db.listByDate(`${year}-01-01`, `${year}-12-31`, 'out');
    return round2(rows.reduce((s, r) => s + (r.amountRon ?? ((r.currency ?? 'RON') === 'RON' ? (r.amount ?? 0) : 0)), 0));
  }

  async vies(vatId: string, force = false): Promise<ViesResult> {
    const key = `vies:${vatId.toUpperCase()}`;
    const raw = this.d.db.getKv(key);
    if (raw && !force) {
      const c = JSON.parse(raw) as ViesResult;
      if (c.checkedAt && this.now().getTime() - Date.parse(c.checkedAt) < VIES_TTL_MS) return c;
    }
    const r = await checkVies(vatId, { base: this.d.settings.get().tax.viesBaseUrl, fetch: this.d.fetch ?? fetch, retry: { retries: 1, ...this.d.retry } });
    if (r.ok) this.d.db.setKv(key, JSON.stringify(r));
    return r;
  }

  private cachedVies(vatId: string | null): ReverseChargeItem['vies'] {
    if (!vatId) return null;
    const raw = this.d.db.getKv(`vies:${vatId.toUpperCase()}`);
    if (!raw) return null;
    const c = JSON.parse(raw) as ViesResult;
    return { valid: !!c.valid, name: c.name, checkedAt: c.checkedAt ?? '' };
  }

  async tax(opts: { year?: number; month?: string; checkVies?: boolean } = {}): Promise<TaxOverview> {
    const s = this.d.settings.get();
    const now = this.now();
    const year = opts.year ?? now.getUTCFullYear();
    const month = opts.month ?? now.toISOString().slice(0, 7);

    // Plafon scutire TVA (art. 310): venituri din FGO (sau locale) + venituri declarate manual.
    const rev = this.cachedRevenue(year);
    const local = this.localRevenue(year);
    const revenueSource: 'fgo' | 'local' | 'none' = rev ? 'fgo' : local > 0 ? 'local' : 'none';
    const base = rev ? rev.totalRon : local;
    const vat = thresholdProgress(base + s.tax.extraRevenueRon, s.tax.vatThresholdRon, s.tax.warnPercent);

    // OSS – 10.000 EUR (anul curent + anul precedent)
    const prev = this.cachedRevenue(year - 1);
    const oss = ossProgress(rev?.ossEur ?? 0, prev?.ossEur ?? 0, s.tax.ossThresholdEur, s.tax.warnPercent);

    // Taxare inversă – luna selectată
    const rows = this.d.db.listByDate(`${month}-01`, monthEnd(month), 'in').filter((r) => r.vatTreatment === 'intra-eu' || r.vatTreatment === 'extra-eu');
    if (opts.checkVies) {
      const ids = [...new Set(rows.map((r) => r.supplierVatId).filter((x): x is string => !!x))].slice(0, 10);
      await Promise.all(ids.map((id) => this.vies(id).catch(() => undefined)));
    }
    const items: ReverseChargeItem[] = rows.map((r) => ({
      id: r.id,
      vendor: r.vendor,
      invoiceDate: r.invoiceDate,
      amount: r.amount,
      currency: r.currency,
      amountRon: r.amountRon ?? ((r.currency ?? 'RON') === 'RON' ? r.amount : null),
      supplierCountry: r.supplierCountry,
      supplierVatId: r.supplierVatId,
      treatment: r.vatTreatment,
      vies: this.cachedVies(r.supplierVatId),
    }));
    const totalRon = round2(items.reduce((a, i) => a + (i.amountRon ?? 0), 0));
    const counts = { intraEu: items.filter((i) => i.treatment === 'intra-eu').length, extraEu: items.filter((i) => i.treatment === 'extra-eu').length };
    const notes: string[] = [];
    if (revenueSource === 'none') notes.push('Nu am încă venituri: conectează FGO (drept facturi:citire) sau completează veniturile din alte surse.');
    if (revenueSource === 'local') notes.push('Venituri calculate din facturile emise salvate local (FGO nu a răspuns încă).');
    if (rev && rev.ossEur == null) notes.push(rev.ossNote ?? 'OSS: lipsește accesul la lista de clienți din FGO.');
    if (rev && rev.unconverted > 0) notes.push(`${rev.unconverted} facturi emise în valută nu au curs BNR și nu sunt incluse.`);
    return {
      year,
      disclaimer: DISCLAIMER,
      warnPercent: s.tax.warnPercent,
      vatRatePercent: s.tax.vatRatePercent,
      notes,
      revenueByMonth: rev?.byMonth ?? {},
      vatThreshold: { ...vat, source: s.tax.vatThresholdSource, revenueSource, updatedAt: rev?.updatedAt ?? null },
      oss: { ...oss, source: s.tax.ossThresholdSource },
      reverseCharge: {
        month,
        items,
        totalRon,
        vatDueRon: round2((totalRon * s.tax.vatRatePercent) / 100),
        obligations: vatObligations(month, s.company.vatRegime, counts, s.tax.vatRatePercent),
      },
    };
  }

  spending(from: string, to: string): SpendingReport {
    return buildSpending(this.d.db.listByDate(from, to, 'in'), from, to);
  }

  insights(): Insight[] {
    const now = this.now();
    const s = this.d.settings.get();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1)).toISOString().slice(0, 10);
    const recent = this.d.db.listByDate(start, now.toISOString().slice(0, 10), 'in');
    const out = [...dueReminders(this.d.db.listDue(), now, s.reports.dueReminderDays), ...missingInvoices(recent, now, s.reports.missingGraceDays)];
    const t = this.thresholdInsight();
    if (t) out.unshift(t);
    return out;
  }

  private thresholdInsight(): Insight | null {
    const s = this.d.settings.get();
    if (s.company.vatRegime === 'art316') return null; // deja plătitor de TVA
    const year = this.now().getUTCFullYear();
    const rev = this.cachedRevenue(year);
    const base = (rev ? rev.totalRon : this.localRevenue(year)) + s.tax.extraRevenueRon;
    const p = thresholdProgress(base, s.tax.vatThresholdRon, s.tax.warnPercent);
    if (p.level === 'ok') return null;
    return {
      id: `threshold:${year}:${p.level}`,
      kind: 'threshold',
      level: p.level === 'over' ? 'err' : 'warn',
      title: p.level === 'over' ? 'Ai depășit plafonul de scutire de TVA' : `Ai atins ${p.percent.toLocaleString('ro-RO')}% din plafonul de TVA`,
      detail:
        p.level === 'over'
          ? `Cifra de afaceri ${fmt(p.valueRon)} lei > ${fmt(p.thresholdRon)} lei. Înregistrarea în scopuri de TVA se cere cel târziu la data depășirii (art. 310 alin. 6). Vorbește azi cu contabilul.`
          : `Mai ai ${fmt(p.remainingRon)} lei până la ${fmt(p.thresholdRon)} lei (art. 310 Cod fiscal). Anunță contabilul din timp.`,
    };
  }

  /** Notificări unice: plafon TVA 80% / 100%, OSS, scadențe. */
  checkAlerts() {
    const notify = this.d.notify;
    if (!notify) return;
    const s = this.d.settings.get();
    const year = this.now().getUTCFullYear();
    const once = (key: string, title: string, body: string) => {
      if (this.d.db.getKv(`alert:${key}`)) return;
      this.d.db.setKv(`alert:${key}`, this.now().toISOString());
      notify(title, body);
    };
    if (s.company.vatRegime !== 'art316') {
      const rev = this.cachedRevenue(year);
      const base = (rev ? rev.totalRon : this.localRevenue(year)) + s.tax.extraRevenueRon;
      const p = thresholdProgress(base, s.tax.vatThresholdRon, s.tax.warnPercent);
      for (const lvl of crossedLevels(p.percent, s.tax.warnPercent)) {
        once(
          `vat:${year}:${lvl}`,
          lvl === 'over' ? 'Plafon TVA depășit' : `Plafon TVA: ${p.percent.toLocaleString('ro-RO')}%`,
          `Cifra de afaceri ${year}: ${fmt(p.valueRon)} din ${fmt(p.thresholdRon)} lei. Informativ – verifică cu contabilul.`,
        );
      }
      const o = ossProgress(rev?.ossEur ?? 0, this.cachedRevenue(year - 1)?.ossEur ?? 0, s.tax.ossThresholdEur, s.tax.warnPercent);
      if (o.level !== 'ok') once(`oss:${year}:${o.level}`, 'Prag OSS (vânzări UE)', `Vânzări la distanță în UE: ${fmt(o.valueEur)} din ${fmt(o.thresholdEur)} EUR.`);
    }
    for (const i of dueReminders(this.d.db.listDue(), this.now(), s.reports.dueReminderDays)) once(i.id, i.title, i.detail);
  }
}

const fmt = (n: number) => n.toLocaleString('ro-RO', { maximumFractionDigits: 0 });

export { TAX_SOURCES };
