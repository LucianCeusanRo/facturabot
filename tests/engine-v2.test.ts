import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { Db } from '../src/main/db';
import { Finance } from '../src/main/finance';
import type { InvoiceSource } from '../src/main/sources/types';
import { labelChannel, SyncEngine } from '../src/main/sync';
import { bnrXml, fakeFetch, json, makeEnv, noSleep, readZip } from './helpers';

const NOW = new Date('2026-11-26T10:00:00Z');

async function setup(docs: Parameters<SyncEngine['ingest']>[1][], patch = {}) {
  const env = makeEnv(patch);
  const db = await Db.open(null);
  const sent: string[] = [];
  const f = fakeFetch(
    (u, init) => {
      if (!u.includes('/messages/send')) return undefined;
      sent.push(Buffer.from(JSON.parse(String(init!.body)).raw, 'base64url').toString());
      return json({ id: 'x' });
    },
    (u) => (u.includes('nbrfxrates') ? new Response(bnrXml({ '2026-10-30': { EUR: '5.08', USD: '4.40' }, '2026-11-24': { EUR: '5.09', USD: '4.38' } }), { headers: { 'content-type': 'text/xml' } }) : undefined),
  );
  const waWeb = { sendDocument: vi.fn(async () => undefined) };
  const notify = vi.fn();
  const finance = new Finance({ db, settings: env.settings, secrets: env.secrets, fetch: f as any, retry: noSleep, notify, now: () => NOW, fgoClient: () => null });
  const source: InvoiceSource = { id: 'gmail', label: 'Gmail', isEnabled: () => true, fetchNew: async (ctx) => docs.filter((d) => !ctx.isKnown(d.externalId)) };
  const engine = new SyncEngine({ db, settings: env.settings, secrets: env.secrets, waWeb: waWeb as any, dataDir: env.dir, sources: [source], fetch: f as any, retry: noSleep, finance, notify, now: () => NOW, htmlToPdf: async (h) => Buffer.from('%PDF-1.4 ' + h.length) });
  return { ...env, db, f, sent, waWeb, notify, finance, engine };
}

describe('SyncEngine v0.2 – îmbogățire, curs BNR, raport lunar', () => {
  it('ingest: sumă din chitanță (reguli), platformă, TVA intracomunitar + conversie BNR după sincronizare', async () => {
    const pdfWithText = Buffer.from('%PDF-1.4\nBT (Shopify International Limited  VAT IE 3462541PH  Reverse charge) Tj ET\n%%EOF');
    const s = await setup([
      { externalId: 'sh1', vendor: 'Shopify <billing@shopify.com>', subject: 'Your Shopify bill', fileName: 'bill.pdf', data: pdfWithText, mimeType: 'application/pdf', text: 'Bill #348812331\nTotal $39.00 USD\nVAT IE3462541PH reverse charge', invoiceDate: '2026-11-25' },
      { externalId: 'fb1', vendor: 'Meta Platforms Ireland', summary: 'Chitanță Meta\nAmount paid 412,50 RON', invoiceDate: '2026-11-20' },
      { externalId: 'loc', vendor: 'Fan Courier SA', data: Buffer.from('%PDF-1.4 x'), fileName: 'fc.pdf', amount: 96.4, currency: 'RON', supplierCountry: 'RO', invoiceDate: '2026-11-21', dueDate: '2026-11-28', paid: false },
    ]);
    await s.engine.runOnce();
    const rows = s.db.listInvoices();
    const sh = rows.find((r) => r.externalId === 'sh1')!;
    expect(sh).toMatchObject({ amount: 39, currency: 'USD', platform: 'shopify', vatTreatment: 'intra-eu', supplierCountry: 'IE', supplierVatId: 'IE3462541PH', amountRon: 170.82, fxRate: 4.38 });
    const fb = rows.find((r) => r.externalId === 'fb1')!;
    expect(fb).toMatchObject({ amount: 412.5, currency: 'RON', platform: 'meta', vatTreatment: 'intra-eu', supplierVatId: 'IE9692928F', amountRon: 412.5 });
    expect(fb.fileName).toMatch(/\.pdf$/);
    const fc = rows.find((r) => r.externalId === 'loc')!;
    expect(fc).toMatchObject({ vatTreatment: 'domestic', platform: 'courier', dueDate: '2026-11-28', paid: false });
    // alertă de scadență trimisă o dată
    expect(s.notify.mock.calls.some((c) => String(c[0]).startsWith('Scadență apropiată'))).toBe(true);
  });

  it('raport lunar automat: o singură dată pe lună, PDF pe canalul principal + ZIP pe email', async () => {
    const s = await setup([{ externalId: 'a', vendor: 'Meta', data: Buffer.from('%PDF-1.4 a'), fileName: 'a.pdf', amount: 100, currency: 'EUR', invoiceDate: '2026-10-31' }], { reports: { monthlyEnabled: true, dayOfMonth: 3 } });
    await s.engine.runOnce();
    expect(s.waWeb.sendDocument).toHaveBeenCalledTimes(2); // factura + raportul lunar
    const zipMail = s.sent.find((m) => m.includes('Pachet octombrie 2026'));
    expect(zipMail).toBeTruthy();
    expect(zipMail).toContain('FacturaBot_2026-10.zip');
    expect(s.db.getKv('report:2026-10')).toBeTruthy();
    await s.engine.runOnce();
    expect(s.waWeb.sendDocument).toHaveBeenCalledTimes(2);
    const z = readZip(fs.readFileSync(`${s.dir}/pachete/FacturaBot_2026-10.zip`));
    expect(Object.keys(z)).toEqual(expect.arrayContaining(['Raport_FacturaBot_2026-10.pdf', 'Facturi_2026-10.csv', 'Facturi_2026-10.xlsx']));
    expect(Object.keys(z).some((k) => k.startsWith('facturi/'))).toBe(true);
  });

  it('pachet manual: local fără trimitere; erori clare', async () => {
    const s = await setup([]);
    const r = await s.engine.sendMonthlyPackage('2026-10', false);
    expect(r.sentVia).toBe('local');
    await expect(s.engine.sendMonthlyPackage('2026-1', true)).rejects.toThrow(/Lună invalidă/);
    const noFin = new SyncEngine({ db: s.db, settings: s.settings, secrets: s.secrets, waWeb: s.waWeb as any, dataDir: s.dir, sources: [] });
    await expect(noFin.sendMonthlyPackage('2026-10')).rejects.toThrow(/financiar/);
    await noFin.afterSync(); // fără finance: nimic
    // fără PDF (fără htmlToPdf) și fără email → eroare
    s.settings.update({ accountant: { email: '' } });
    const bare = new SyncEngine({ db: s.db, settings: s.settings, secrets: s.secrets, waWeb: s.waWeb as any, dataDir: s.dir, sources: [], finance: s.finance });
    await expect(bare.sendMonthlyPackage('2026-10')).rejects.toThrow(/niciun canal/);
    expect(labelChannel('whatsapp-cloud')).toBe('WhatsApp Business API');
    expect(labelChannel('email')).toBe('email');
  });

  it('snapshot: conexiunile surselor directe', async () => {
    const s = await setup([], { sources: { meta: { enabled: true, businessId: '1' }, tiktok: { enabled: true, bcId: '2' }, googleAds: { enabled: true, customerId: '3', billingSetupId: '4' } } });
    s.secrets.set('meta.token', 'x');
    s.secrets.set('tiktok.token', 'y');
    s.secrets.setJson('googleAds.tokens', { access_token: 'a', expires_at: 0 });
    s.secrets.set('googleAds.developerToken', 'd');
    const c = s.engine.snapshot('connected').connections;
    expect(c).toMatchObject({ meta: true, tiktok: true, googleAds: true });
  });
});
