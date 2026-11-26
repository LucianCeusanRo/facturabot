import crypto from 'node:crypto';
import type { SettingsStore } from './config.js';
import type { Db } from './db.js';
import type { SecretStore } from './secrets.js';
import type { WhatsAppWeb } from './delivery/whatsappWeb.js';
import type { VatTreatment } from '../shared/types.js';

type Row = {
  source: string;
  vendor: string;
  ser: string;
  amount: number;
  currency: string;
  status: string;
  channel: string;
  day: string;
  platform?: string;
  country?: string;
  vatId?: string;
  treatment?: VatTreatment;
  dueDate?: string;
  paid?: boolean;
};

const FX: Record<string, number> = { RON: 1, EUR: 5.0914, USD: 4.3862 };

/** Date demonstrative (FACTURABOT_DEMO=1) – folosite pentru capturi de ecran și prezentări. */
export function seedDemo(db: Db, settings: SettingsStore, secrets: SecretStore, wa: WhatsAppWeb) {
  secrets.setJson('google.tokens', { access_token: 'demo', expires_at: 0 });
  secrets.set('fgo.apiKey', 'demo');
  secrets.set('meta.token', 'demo');
  if (process.env.FACTURABOT_DEMO_QR === '1') wa.simulateQr().catch(() => undefined);
  else wa.simulateConnected('40744000111');
  const now = new Date();
  db.setKv('lastSync', new Date(now.getTime() - 6 * 60_000).toISOString());
  settings.update({
    onboardingDone: true,
    sources: {
      gmail: { enabled: true, account: 'firma.mea@gmail.com' },
      fgo: { enabled: true, codUnic: '12345678' },
      meta: { enabled: true, businessId: '104857331920' },
    },
    company: { name: 'Atelier Verde SRL', vatRegime: 'art317' },
    reports: { monthlyEnabled: true },
    remote: { enabled: process.env.FACTURABOT_DEMO_REMOTE === '1' },
    accountant: { name: 'Andreea (contabilă)', whatsappNumber: '40722123456', email: 'contabil@cabinet.ro' },
  });

  const year = now.getUTCFullYear();
  const curMonth = now.getUTCMonth(); // 0-based
  const day = (m: number, d: number) => new Date(Date.UTC(year, m, d)).toISOString().slice(0, 10);
  const ago = (days: number) => new Date(now.getTime() - days * 86400_000).toISOString().slice(0, 10);
  const plus = (days: number) => new Date(now.getTime() + days * 86400_000).toISOString().slice(0, 10);

  // Istoric pe lunile anului (pentru grafice): reclame + abonamente + furnizori locali.
  const rows: Row[] = [];
  const wave = (m: number, base: number, amp: number) => Math.round((base + amp * Math.sin(m * 0.9 + 1) + m * base * 0.05) * 100) / 100;
  for (let m = 0; m < curMonth; m++) {
    rows.push({ source: 'meta', vendor: 'Meta Platforms Ireland Ltd', ser: `FBADS-${1001 + m}-2938`, amount: wave(m, 2900, 700), currency: 'RON', status: 'sent', channel: 'whatsapp-web', day: day(m, 2), platform: 'meta', country: 'IE', vatId: 'IE9692928F', treatment: 'intra-eu' });
    rows.push({ source: 'gmail', vendor: 'Google Ireland Limited', ser: `52148${8900 + m}`, amount: wave(m, 1500, 400), currency: 'RON', status: 'sent', channel: 'whatsapp-web', day: day(m, 3), platform: 'google', country: 'IE', vatId: 'IE6388047V', treatment: 'intra-eu' });
    if (m % 2 === 0) rows.push({ source: 'gmail', vendor: 'TikTok', ser: `BDUK2026${String(m + 1).padStart(2, '0')}18`, amount: wave(m, 160, 60), currency: 'EUR', status: 'sent', channel: 'email', day: day(m, 18), platform: 'tiktok', country: 'IE', treatment: 'intra-eu' });
    rows.push({ source: 'gmail', vendor: 'Shopify', ser: `#3488${12300 + m}`, amount: 39, currency: 'USD', status: 'sent', channel: 'whatsapp-web', day: day(m, 14), platform: 'shopify', country: 'IE', treatment: 'intra-eu' });
    rows.push({ source: 'fgo', vendor: 'Fan Courier SA', ser: `FCR ${884000 + m * 17}`, amount: wave(m, 480, 140), currency: 'RON', status: 'sent', channel: 'whatsapp-web', day: day(m, 10), platform: 'courier', country: 'RO', treatment: 'domestic', paid: true });
    rows.push({ source: 'fgo', vendor: 'Digi Romania', ser: `DIGI ${77120000 + m}`, amount: 63.5, currency: 'RON', status: 'sent', channel: 'whatsapp-web', day: day(m, 5), platform: 'telecom', country: 'RO', treatment: 'domestic', paid: true });
    if (m % 3 === 1) rows.push({ source: 'gmail', vendor: 'eMAG', ser: `EMG ${4410000 + m}`, amount: wave(m, 900, 400), currency: 'RON', status: 'sent', channel: 'whatsapp-web', day: day(m, 21), platform: 'emag', country: 'RO', treatment: 'domestic' });
  }
  // Luna curentă – ce se vede pe Dashboard.
  rows.push(
    { source: 'meta', vendor: 'Meta Platforms Ireland Ltd', ser: 'FBADS-1048-29384', amount: 3412.5, currency: 'RON', status: 'sent', channel: 'whatsapp-web', day: ago(1), platform: 'meta', country: 'IE', vatId: 'IE9692928F', treatment: 'intra-eu', dueDate: plus(2), paid: false },
    { source: 'gmail', vendor: 'Google Ireland Limited', ser: '5214889012', amount: 1833.1, currency: 'RON', status: 'sent', channel: 'whatsapp-web', day: ago(3), platform: 'google', country: 'IE', vatId: 'IE6388047V', treatment: 'intra-eu' },
    { source: 'gmail', vendor: 'TikTok', ser: 'BDUK20261118', amount: 150, currency: 'EUR', status: 'sent', channel: 'email', day: ago(5), platform: 'tiktok', country: 'IE', treatment: 'intra-eu' },
    { source: 'fgo', vendor: 'Fan Courier SA', ser: 'FCR 884213', amount: 596.4, currency: 'RON', status: 'sent', channel: 'whatsapp-web', day: ago(7), platform: 'courier', country: 'RO', treatment: 'domestic', dueDate: ago(2), paid: false },
    { source: 'gmail', vendor: 'Shopify', ser: '#348812331', amount: 39, currency: 'USD', status: 'awaiting_confirm', channel: '', day: ago(8), platform: 'shopify', country: 'IE', treatment: 'intra-eu' },
    { source: 'gmail', vendor: 'eMAG', ser: 'EMG 4410022', amount: 1249.99, currency: 'RON', status: 'sent', channel: 'whatsapp-web', day: ago(10), platform: 'emag', country: 'RO', treatment: 'domestic' },
    { source: 'gmail', vendor: 'Stripe', ser: 'INV-0042', amount: 18.2, currency: 'EUR', status: 'failed', channel: '', day: ago(12), platform: 'stripe', country: 'IE', treatment: 'intra-eu' },
  );

  rows
    .sort((a, b) => a.day.localeCompare(b.day))
    .forEach((r, i) => {
      const id = db.insertInvoice({
        source: r.source,
        externalId: `demo-${i}`,
        vendor: r.vendor,
        seriesNumber: r.ser,
        amount: r.amount,
        currency: r.currency,
        invoiceDate: r.day,
        fileName: `${r.vendor.split(' ')[0]}_${r.ser.replace(/\W/g, '')}.pdf`,
        subject: `Factura ${r.ser}`,
        status: 'pending',
        direction: 'in',
        platform: r.platform ?? null,
        supplierCountry: r.country ?? null,
        supplierVatId: r.vatId ?? null,
        vatTreatment: r.treatment ?? 'unknown',
        dueDate: r.dueDate ?? null,
        paid: r.paid ?? null,
      });
      if (!id) return;
      db.setConversion(id, Math.round(r.amount * FX[r.currency] * 100) / 100, FX[r.currency]);
      db.setStatus(id, r.status as any, {
        sentAt: `${r.day}T${String(8 + (i % 10)).padStart(2, '0')}:14:00.000Z`,
        channel: (r.channel || null) as any,
        error: r.status === 'failed' ? 'WhatsApp Web nu este conectat · email: cont SMTP neconfigurat' : r.channel === 'email' ? 'Backup email (WhatsApp: timeout)' : null,
      });
    });

  // Venituri din FGO (cache) – plafon TVA la ~81% și OSS.
  const byMonth: Record<string, number> = {};
  let total = 0;
  for (let m = 0; m <= curMonth; m++) {
    const v = Math.round(20800 + m * 1700 + 3000 * Math.sin(m));
    byMonth[`${year}-${String(m + 1).padStart(2, '0')}`] = v;
    total += v;
  }
  const iso = new Date(now.getTime() - 40 * 60_000).toISOString();
  db.setKv(`revenue:${year}`, JSON.stringify({ year, totalRon: total, byMonth, count: 412, ossEur: 6240, unconverted: 0, updatedAt: iso }));
  db.setKv(`revenue:${year - 1}`, JSON.stringify({ year: year - 1, totalRon: 241000, byMonth: {}, count: 300, ossEur: 4100, unconverted: 0, updatedAt: iso }));
  db.setKv('vies:IE9692928F', JSON.stringify({ ok: true, valid: true, name: 'META PLATFORMS IRELAND LIMITED', checkedAt: iso }));
  db.setKv('vies:IE6388047V', JSON.stringify({ ok: true, valid: true, name: 'GOOGLE IRELAND LIMITED', checkedAt: iso }));

  // Telefon împerecheat (token cunoscut doar pentru capturile de ecran).
  const tok = process.env.FACTURABOT_DEMO_REMOTE_TOKEN;
  if (tok)
    db.setKv(
      'remote:devices',
      JSON.stringify([{ id: crypto.randomUUID(), name: 'iPhone Lucian', createdAt: ago(12) + 'T09:12:00.000Z', lastSeen: iso, tokenHash: crypto.createHash('sha256').update(tok).digest('hex') }]),
    );

  db.log('info', 'Am găsit 3 documente noi');
  db.log('success', 'Trimis pe WhatsApp Web: Meta Platforms Ireland Ltd · nr. FBADS-1048-29384 · 3.412,50 RON');
  db.log('warn', 'WhatsApp a eșuat (timeout) – trimit pe email');
  db.log('success', 'Trimis pe email: TikTok · nr. BDUK20261118 · 150,00 EUR');
  db.log('info', 'Curs BNR actualizat (EUR 5,0914 · USD 4,3862)');
}
