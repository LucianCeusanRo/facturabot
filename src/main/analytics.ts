import type { InvoiceRecord, MonthBucket, SpendBucket, SpendingReport } from '../shared/types.js';
import { normalizeVendor } from './db.js';

/** Platformele urmărite separat în rapoarte (restul intră la „furnizor”). */
export const PLATFORMS: { id: string; label: string; match: RegExp }[] = [
  { id: 'meta', label: 'Meta Ads', match: /\bmeta\b|facebook|instagram/i },
  { id: 'google', label: 'Google Ads', match: /\bgoogle\b/i },
  { id: 'tiktok', label: 'TikTok Ads', match: /tiktok/i },
  { id: 'shopify', label: 'Shopify', match: /shopify/i },
  { id: 'emag', label: 'eMAG', match: /\bemag\b/i },
  { id: 'stripe', label: 'Stripe', match: /stripe/i },
  { id: 'paypal', label: 'PayPal', match: /paypal/i },
  { id: 'courier', label: 'Curierat', match: /fan\s*courier|sameday|cargus|\bdpd\b|\bgls\b|posta\s*romana/i },
  { id: 'telecom', label: 'Telecom & utilități', match: /vodafone|orange|digi|enel|e\.?on|ppc|engie/i },
];

export const platformLabel = (id: string | null | undefined) => PLATFORMS.find((p) => p.id === id)?.label ?? 'Alți furnizori';

/** Platforma pe reguli: întâi ce a setat sursa, apoi numele furnizorului / sursa. */
export function platformOf(inv: Pick<InvoiceRecord, 'platform' | 'vendor' | 'source'>): string {
  if (inv.platform && PLATFORMS.some((p) => p.id === inv.platform)) return inv.platform;
  if (inv.source === 'meta') return 'meta';
  if (inv.source === 'tiktok') return 'tiktok';
  if (inv.source === 'googleAds') return 'google';
  const v = inv.vendor ?? '';
  return PLATFORMS.find((p) => p.match.test(v))?.id ?? 'other';
}

const add = (m: Map<string, SpendBucket>, key: string, label: string, v: number) => {
  const b = m.get(key) ?? { key, label, totalRon: 0, count: 0 };
  b.totalRon += v;
  b.count++;
  m.set(key, b);
};

const r2 = (n: number) => Math.round(n * 100) / 100;

export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.slice(0, 7).split('-').map(Number);
  const [ty, tm] = to.slice(0, 7).split('-').map(Number);
  while ((y < ty || (y === ty && m <= tm)) && out.length < 120) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

/** Cheltuieli pe platformă / furnizor / lună, în lei (cu cursul BNR deja aplicat pe fiecare factură). */
export function buildSpending(invoices: InvoiceRecord[], from: string, to: string): SpendingReport {
  const byPlatform = new Map<string, SpendBucket>();
  const bySupplier = new Map<string, SpendBucket>();
  const months = new Map<string, MonthBucket>(monthsBetween(from, to).map((m) => [m, { month: m, totalRon: 0, count: 0, byPlatform: {} }]));
  const byCurrency = new Map<string, { currency: string; total: number; count: number }>();
  let total = 0;
  let count = 0;
  let unconverted = 0;
  for (const inv of invoices) {
    if (inv.direction === 'out' || inv.status === 'duplicate' || inv.status === 'skipped') continue;
    const day = inv.invoiceDate ?? inv.createdAt.slice(0, 10);
    if (day < from || day > to) continue;
    if (inv.amount != null) {
      const cur = (inv.currency ?? 'RON').toUpperCase();
      const c = byCurrency.get(cur) ?? { currency: cur, total: 0, count: 0 };
      c.total = r2(c.total + inv.amount);
      c.count++;
      byCurrency.set(cur, c);
    }
    const ron = inv.amountRon ?? ((inv.currency ?? 'RON').toUpperCase() === 'RON' ? inv.amount : null);
    if (ron == null) {
      unconverted++;
      continue;
    }
    const p = platformOf(inv);
    add(byPlatform, p, platformLabel(p), ron);
    const vendor = inv.vendor?.trim() || 'Necunoscut';
    add(bySupplier, normalizeVendor(vendor) || vendor, vendor, ron);
    const mb = months.get(day.slice(0, 7));
    if (mb) {
      mb.totalRon += ron;
      mb.count++;
      mb.byPlatform[p] = r2((mb.byPlatform[p] ?? 0) + ron);
    }
    total += ron;
    count++;
  }
  const sorted = (m: Map<string, SpendBucket>) => [...m.values()].map((b) => ({ ...b, totalRon: r2(b.totalRon) })).sort((a, b) => b.totalRon - a.totalRon);
  return {
    from,
    to,
    totalRon: r2(total),
    count,
    unconverted,
    byPlatform: sorted(byPlatform),
    bySupplier: sorted(bySupplier).slice(0, 25),
    byMonth: [...months.values()].map((m) => ({ ...m, totalRon: r2(m.totalRon) })),
    byCurrency: [...byCurrency.values()].sort((a, b) => b.count - a.count),
  };
}
