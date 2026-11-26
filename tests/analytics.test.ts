import { describe, expect, it } from 'vitest';
import { buildSpending, monthsBetween, platformLabel, platformOf } from '../src/main/analytics';
import { dueReminders, missingInvoices } from '../src/main/insights';
import { inv } from './helpers';

describe('cheltuieli', () => {
  it('platformOf: setată de sursă > sursa directă > numele furnizorului', () => {
    expect(platformOf({ platform: 'shopify', vendor: 'X', source: 'gmail' })).toBe('shopify');
    expect(platformOf({ platform: 'nope', vendor: null, source: 'meta' })).toBe('meta');
    expect(platformOf({ platform: null, vendor: null, source: 'tiktok' })).toBe('tiktok');
    expect(platformOf({ platform: null, vendor: null, source: 'googleAds' })).toBe('google');
    expect(platformOf({ platform: null, vendor: 'Facebook Ireland', source: 'gmail' })).toBe('meta');
    expect(platformOf({ platform: null, vendor: 'FAN Courier Express', source: 'fgo' })).toBe('courier');
    expect(platformOf({ platform: null, vendor: 'Brutăria Mea', source: 'fgo' })).toBe('other');
    expect(platformLabel('other')).toBe('Alți furnizori');
    expect(platformLabel('meta')).toBe('Meta Ads');
  });

  it('monthsBetween acoperă trecerea de an și e limitat', () => {
    expect(monthsBetween('2025-11-15', '2026-02-01')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    expect(monthsBetween('2000-01-01', '2026-01-01')).toHaveLength(120);
  });

  it('buildSpending: lei la curs BNR, pe platformă/furnizor/lună/monedă; exclude emise, duplicate, ignorate', () => {
    const rows = [
      inv({ vendor: 'Meta Platforms Ireland', platform: 'meta', amount: 1000, currency: 'RON', invoiceDate: '2026-10-02' }),
      inv({ vendor: 'Meta Platforms Ireland', platform: 'meta', amount: 1500, currency: 'RON', invoiceDate: '2026-11-02' }),
      inv({ vendor: 'TikTok', amount: 100, currency: 'EUR', amountRon: 509.14, fxRate: 5.0914, invoiceDate: '2026-11-05' }),
      inv({ vendor: 'Shopify', amount: 39, currency: 'USD', amountRon: null, invoiceDate: '2026-11-06' }), // fără curs
      inv({ vendor: 'Client SRL', direction: 'out', amount: 9999, invoiceDate: '2026-11-07' }),
      inv({ vendor: 'Dup', status: 'duplicate', amount: 50, invoiceDate: '2026-11-07' }),
      inv({ vendor: 'Skip', status: 'skipped', amount: 50, invoiceDate: '2026-11-07' }),
      inv({ vendor: 'Vechi', amount: 77, invoiceDate: '2025-01-01' }),
      inv({ vendor: '', amount: 10, invoiceDate: null, createdAt: '2026-11-20T00:00:00Z' }),
    ];
    const r = buildSpending(rows, '2026-10-01', '2026-11-30');
    expect(r.totalRon).toBe(3019.14);
    expect(r.count).toBe(4);
    expect(r.unconverted).toBe(1);
    expect(r.byPlatform[0]).toMatchObject({ key: 'meta', totalRon: 2500, count: 2 });
    expect(r.bySupplier.map((s) => s.label)).toContain('Necunoscut');
    expect(r.byMonth.map((m) => [m.month, m.totalRon])).toEqual([
      ['2026-10', 1000],
      ['2026-11', 2019.14],
    ]);
    expect(r.byMonth[1].byPlatform.tiktok).toBe(509.14);
    expect(r.byCurrency.find((c) => c.currency === 'USD')).toEqual({ currency: 'USD', total: 39, count: 1 });
  });
});

describe('observații (fără AI)', () => {
  const now = new Date('2026-11-26T10:00:00Z');
  it('factură lunară lipsă: furnizor recurent fără factură în luna curentă, după ziua obișnuită + grație', () => {
    const digi = ['2026-07-05', '2026-08-04', '2026-09-05', '2026-10-06'].map((d) => inv({ vendor: 'Digi Romania', invoiceDate: d }));
    const meta = ['2026-08-02', '2026-09-02', '2026-10-02', '2026-11-02'].map((d) => inv({ vendor: 'Meta', invoiceDate: d }));
    const rare = ['2026-09-05', '2026-10-05'].map((d) => inv({ vendor: 'Rar SRL', invoiceDate: d }));
    const late = ['2026-08-25', '2026-09-24', '2026-10-25'].map((d) => inv({ vendor: 'Târziu SA', invoiceDate: d }));
    const out = missingInvoices([...digi, ...meta, ...rare, ...late, inv({ vendor: null }), inv({ vendor: 'X', direction: 'out' })], now, 7);
    expect(out.map((o) => o.title)).toEqual(['Lipsește factura de la Digi Romania']);
    expect(out[0].detail).toContain('zilei 5');
  });

  it('scadențe: depășite (err) înaintea celor apropiate (warn); ignoră achitate/fără dată/emise', () => {
    const out = dueReminders(
      [
        inv({ vendor: 'A', dueDate: '2026-11-28', paid: false, amount: 10 }),
        inv({ vendor: 'B', dueDate: '2026-11-20', paid: false, amount: null }),
        inv({ vendor: 'C', dueDate: '2026-12-20', paid: false }),
        inv({ vendor: 'D', dueDate: '2026-11-27', paid: true }),
        inv({ vendor: 'E', dueDate: null, paid: false }),
        inv({ vendor: null, subject: 'Fără furnizor', dueDate: '2026-11-27', paid: false, direction: 'out' }),
      ],
      now,
      3,
    );
    expect(out.map((o) => [o.kind, o.level, o.title])).toEqual([
      ['overdue', 'err', 'Scadență depășită: B'],
      ['due', 'warn', 'Scadență apropiată: A'],
    ]);
    expect(out[1].detail).toContain('10,00 RON');
  });
});
