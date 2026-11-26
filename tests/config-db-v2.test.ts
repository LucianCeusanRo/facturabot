import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, sanitizeSettings, settingsProblems, TAX_SOURCES } from '../src/main/config';
import { Db } from '../src/main/db';
import { DIRECT_SOURCES } from '../src/shared/sourcesMeta';
import type { Settings } from '../src/shared/types';

const s = (patch: (x: Settings) => void) => {
  const x = structuredClone(DEFAULT_SETTINGS);
  patch(x);
  return sanitizeSettings(x);
};

describe('setări v0.2 – validare', () => {
  it('valori implicite cu sursele oficiale', () => {
    expect(DEFAULT_SETTINGS.tax).toMatchObject({ vatThresholdRon: 395_000, ossThresholdEur: 10_000, vatRatePercent: 21, warnPercent: 80, fxRule: 'previous', bnrBaseUrl: 'https://curs.bnr.ro' });
    expect(DEFAULT_SETTINGS.tax.vatThresholdSource).toBe(TAX_SOURCES.vatThreshold);
    expect(DEFAULT_SETTINGS.sources.meta.apiVersion).toBe('v27.0');
    expect(DEFAULT_SETTINGS.sources.googleAds.apiVersion).toBe('v26');
    expect(DEFAULT_SETTINGS.remote).toMatchObject({ enabled: false, port: 8787 });
    expect(DEFAULT_SETTINGS.reports.monthlyEnabled).toBe(false);
    expect(DIRECT_SOURCES.map((d) => d.id)).toEqual(['meta', 'tiktok', 'googleAds']);
    for (const d of DIRECT_SOURCES) expect(d.docs).toMatch(/^https:\/\//);
  });

  it('ID-uri doar cifre, versiuni în format oficial, URL-uri doar https', () => {
    const x = s((x) => {
      x.sources.meta.businessId = ' 1048-573 ';
      x.sources.meta.apiVersion = 'latest';
      x.sources.tiktok.bcId = 'BC 7000';
      x.sources.tiktok.invoiceTypes = ['recon', 'bad type!', 'CREDIT'] as any;
      x.sources.tiktok.apiBase = 'http://evil';
      x.sources.googleAds.customerId = '123-456-7890';
      x.sources.googleAds.apiVersion = '26';
      x.tax.bnrBaseUrl = 'http://www.bnr.ro';
      x.tax.viesBaseUrl = 'https://vies.example/';
      x.remote.publicUrl = 'http://pc.local';
    });
    expect(x.sources.meta).toMatchObject({ businessId: '1048573', apiVersion: 'v27.0' });
    expect(x.sources.tiktok).toMatchObject({ bcId: '7000', invoiceTypes: ['RECON', 'CREDIT'], apiBase: 'https://business-api.tiktok.com/open_api/v1.3' });
    expect(x.sources.googleAds).toMatchObject({ customerId: '1234567890', apiVersion: 'v26' });
    expect(x.tax.bnrBaseUrl).toBe('https://curs.bnr.ro');
    expect(x.tax.viesBaseUrl).toBe('https://vies.example');
    expect(x.remote.publicUrl).toBe('');
    expect(s((x) => (x.remote.publicUrl = ' https://pc.ts.net/ ')).remote.publicUrl).toBe('https://pc.ts.net');
  });

  it('praguri și procente limitate; regim și regulă de curs doar din listă', () => {
    const x = s((x) => {
      x.tax.vatThresholdRon = -5;
      x.tax.ossThresholdEur = 'abc' as any;
      x.tax.extraRevenueRon = 1234.567;
      x.tax.warnPercent = 150;
      x.tax.vatRatePercent = 99;
      x.tax.fxRule = 'random' as any;
      x.company.vatRegime = 'x' as any;
      x.company.country = 'ro';
      x.company.name = 'a'.repeat(300);
      x.remote.port = 80;
      x.reports.dayOfMonth = 31;
      x.reports.dueReminderDays = -1;
    });
    expect(x.tax).toMatchObject({ vatThresholdRon: 1, ossThresholdEur: 10_000, extraRevenueRon: 1234.57, warnPercent: 99, vatRatePercent: 50, fxRule: 'previous' });
    expect(x.company).toMatchObject({ vatRegime: 'none', country: 'RO' });
    expect(x.company.name).toHaveLength(200);
    expect(x.remote.port).toBe(1024);
    expect(x.reports).toMatchObject({ dayOfMonth: 28, dueReminderDays: 0 });
    expect(s((x) => (x.company.country = '???')).company.country).toBe('RO');
  });

  it('probleme pentru sursele directe activate incomplet', () => {
    const x = s((x) => {
      x.accountant.email = 'a@b.ro';
      x.delivery.whatsappMode = 'none';
      x.sources.meta.enabled = true;
      x.sources.tiktok.enabled = true;
      x.sources.googleAds.enabled = true;
    });
    expect(settingsProblems(x)).toEqual(['Meta Ads: lipsește Business ID.', 'TikTok Ads: lipsește Business Center ID.', 'Google Ads: lipsesc Customer ID / Billing setup ID.']);
  });
});

describe('Db v0.2', () => {
  const add = (db: Db, p: Record<string, unknown>) => db.insertInvoice({ source: 'gmail', externalId: String(Math.random()), status: 'sent', ...p } as any);
  it('interval, direcție, conversii, TVA, scadențe, cursuri', async () => {
    const db = await Db.open(null);
    const a = add(db, { invoiceDate: '2026-11-01', amount: 10, currency: 'EUR', paid: false, dueDate: '2026-11-30' });
    add(db, { invoiceDate: '2026-11-02', direction: 'out', amount: 5 });
    add(db, { invoiceDate: '2026-11-03', status: 'duplicate', amount: 1 });
    add(db, { invoiceDate: '2026-11-04', paid: true, dueDate: '2026-11-05' });
    expect(db.listByDate('2026-11-01', '2026-11-30').map((r) => r.invoiceDate)).toEqual(['2026-11-01', '2026-11-04']);
    expect(db.listByDate('2026-11-01', '2026-11-30', 'out')).toHaveLength(1);
    expect(db.listByDate('2026-11-01', '2026-11-30', 'all')).toHaveLength(3);
    expect(db.listUnconverted().map((r) => r.id)).toContain(a);
    db.setConversion(a, 50.9, 5.09);
    db.setTax(a, { supplierCountry: 'IE', supplierVatId: 'IE9692928F', vatTreatment: 'intra-eu' });
    expect(db.getInvoice(a)).toMatchObject({ amountRon: 50.9, fxRate: 5.09, supplierCountry: 'IE', vatTreatment: 'intra-eu', paid: false });
    expect(db.listUnconverted().map((r) => r.id)).not.toContain(a);
    expect(db.listDue().map((r) => r.id)).toEqual([a]);
    expect(db.hasRatesFor(2026)).toBe(false);
    expect(db.latestRateDay()).toBeNull();
    db.putRates([]);
    db.putRates([
      { day: '2026-11-20', currency: 'EUR', rate: 5.1 },
      { day: '2026-11-24', currency: 'EUR', rate: 5.09 },
    ]);
    expect(db.hasRatesFor(2026)).toBe(true);
    expect(db.latestRateDay()).toBe('2026-11-24');
    expect(db.findRate('EUR', '2026-11-24', true)).toEqual({ day: '2026-11-20', rate: 5.1 });
    expect(db.findRate('EUR', '2026-11-24', false)).toEqual({ day: '2026-11-24', rate: 5.09 });
    expect(db.findRate('USD', '2026-11-24', false)).toBeNull();
  });
});
