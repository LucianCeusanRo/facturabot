import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Db } from '../src/main/db';
import { Finance, monthEnd } from '../src/main/finance';
import { buildAccountantPackage, exportTable, isMonth, previousMonth } from '../src/main/export/package';
import { monthlyReportHtml, monthLabel } from '../src/main/export/report';
import { COLUMNS, invoiceRows, toCsv, toXlsx } from '../src/main/export/table';
import { crc32, makeZip } from '../src/main/export/zip';
import { bnrXml, fakeFetch, inv, json, makeEnv, noSleep, readZip, tmpDir } from './helpers';

const NOW = new Date('2026-11-26T10:00:00Z');
const xml = (b: string) => new Response(b, { headers: { 'content-type': 'text/xml' } });
const bnr = (u: string) => (u.includes('nbrfxrates') ? xml(bnrXml({ '2026-10-15': { EUR: '5.0900' }, '2026-11-13': { EUR: '5.0900', USD: '4.4000' }, '2026-11-20': { EUR: '5.1000', USD: '4.3800' } })) : undefined);
const vies = (u: string) => (u.endsWith('/check-vat-number') ? json({ valid: true, name: 'META PLATFORMS IRELAND LIMITED', requestDate: '2026-11-26T10:00:00Z' }) : undefined);
const gen = (rows: any[]) =>
  (async function* () {
    for (const r of rows) yield r;
  })();

async function setup(patch = {}, revenueRows: any[] = []) {
  const env = makeEnv(patch);
  const db = await Db.open(null);
  const f = fakeFetch(bnr, vies);
  const notify = vi.fn();
  const fgo = {
    paginate: vi.fn((p: string) => (p === '/v2/clienti' ? gen([{ id: 9, cod_tara: 'DE', tip_persoana: 'PF' }]) : gen(revenueRows))),
  };
  const finance = new Finance({ db, settings: env.settings, secrets: env.secrets, fetch: f as any, retry: noSleep, notify, now: () => NOW, fgoClient: () => fgo });
  return { ...env, db, f, notify, fgo, finance };
}

const add = (db: Db, p: Record<string, unknown>) => db.insertInvoice({ source: 'gmail', externalId: String(Math.random()), status: 'sent', ...p } as any);

describe('Finance', () => {
  it('convertPending: lei la cursul BNR anterior datei facturii', async () => {
    const { db, finance } = await setup();
    const a = add(db, { vendor: 'TikTok', amount: 100, currency: 'EUR', invoiceDate: '2026-11-16' });
    const b = add(db, { vendor: 'Shopify', amount: 39, currency: 'USD', invoiceDate: '2026-11-21' });
    const c = add(db, { vendor: 'Local', amount: 50, currency: 'RON', invoiceDate: '2026-11-21' });
    const d = add(db, { vendor: 'Ciudat', amount: 5, currency: 'XYZ', invoiceDate: '2026-11-21' });
    expect(await finance.convertPending()).toEqual({ converted: 3, failed: 1 });
    expect(db.getInvoice(a)).toMatchObject({ amountRon: 509, fxRate: 5.09 });
    expect(db.getInvoice(b)).toMatchObject({ amountRon: 170.82, fxRate: 4.38 });
    expect(db.getInvoice(c)).toMatchObject({ amountRon: 50, fxRate: 1 });
    expect(db.getInvoice(d)!.amountRon).toBeNull();
  });

  it('convertPending se oprește la prima eroare BNR (reîncearcă la următoarea sincronizare)', async () => {
    const env = makeEnv();
    const db = await Db.open(null);
    add(db, { amount: 1, currency: 'EUR', invoiceDate: '2026-11-16' });
    add(db, { amount: 2, currency: 'EUR', invoiceDate: '2026-11-17' });
    const down = fakeFetch(() => new Response('x', { status: 503 }));
    const fin = new Finance({ db, settings: env.settings, secrets: env.secrets, fetch: down as any, retry: { retries: 0, ...noSleep }, now: () => NOW });
    expect(await fin.convertPending()).toEqual({ converted: 0, failed: 1 });
  });

  it('venituri FGO: cache 6h, plafon TVA + OSS + alerte unice la 80% și 100%', async () => {
    const rows = [
      { data_emitere: '2026-03-01', valoare_fara_tva: 300_000, status: 'emisa', valuta: 'RON' },
      { data_emitere: '2026-11-16', valoare_fara_tva: 1000, status: 'emisa', valuta: 'EUR', id_client: 9 },
    ];
    const { finance, fgo, notify, settings } = await setup({ tax: { extraRevenueRon: 20_000 } }, rows);
    const r = await finance.refreshRevenue();
    expect(r).toMatchObject({ totalRon: 305_090, ossEur: 1000 });
    await finance.refreshRevenue();
    expect(fgo.paginate).toHaveBeenCalledTimes(2); // clienti + facturi, o singură dată (cache)
    const t = await finance.tax({ month: '2026-11' });
    expect(t.vatThreshold).toMatchObject({ valueRon: 325_090, level: 'warn', revenueSource: 'fgo' });
    expect(t.oss).toMatchObject({ valueEur: 1000, level: 'ok' });
    expect(t.notes).toEqual([]);
    finance.checkAlerts();
    finance.checkAlerts();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toBe('Plafon TVA: 82,3%');
    expect(finance.insights()[0]).toMatchObject({ kind: 'threshold', level: 'warn' });
    settings.update({ tax: { extraRevenueRon: 100_000 } });
    finance.checkAlerts();
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1][0]).toBe('Plafon TVA depășit');
    expect(finance.insights()[0]).toMatchObject({ level: 'err', title: expect.stringMatching(/depășit/) });
    settings.update({ company: { vatRegime: 'art316' } });
    expect(finance.insights().some((i) => i.kind === 'threshold')).toBe(false);
  });

  it('fără FGO: venituri din facturile emise locale, apoi „none” cu explicație', async () => {
    const env = makeEnv();
    const db = await Db.open(null);
    const fin = new Finance({ db, settings: env.settings, secrets: env.secrets, fetch: fakeFetch() as any, now: () => NOW });
    expect(await fin.refreshRevenue()).toBeNull();
    let t = await fin.tax();
    expect(t.vatThreshold.revenueSource).toBe('none');
    expect(t.notes[0]).toMatch(/conectează FGO/);
    add(db, { direction: 'out', amount: 1000, currency: 'RON', invoiceDate: '2026-05-05' });
    t = await fin.tax();
    expect(t.vatThreshold).toMatchObject({ revenueSource: 'local', valueRon: 1000 });
    expect(t.reverseCharge.month).toBe('2026-11');
  });

  it('TVA: taxare inversă pe lună + VIES (cache 30 zile) + obligații', async () => {
    const { db, finance, f } = await setup({ company: { vatRegime: 'none' } });
    add(db, { vendor: 'Meta Platforms Ireland', amount: 1000, currency: 'RON', invoiceDate: '2026-11-03', supplierCountry: 'IE', supplierVatId: 'IE9692928F', vatTreatment: 'intra-eu' });
    add(db, { vendor: 'OpenAI', amount: 20, currency: 'USD', invoiceDate: '2026-11-16', supplierCountry: 'US', vatTreatment: 'extra-eu' });
    add(db, { vendor: 'Fan Courier', amount: 50, currency: 'RON', invoiceDate: '2026-11-05', supplierCountry: 'RO', vatTreatment: 'domestic' });
    await finance.convertPending();
    const t = await finance.tax({ month: '2026-11', checkVies: true });
    expect(t.reverseCharge.items).toHaveLength(2);
    expect(t.reverseCharge.items[0].vies).toMatchObject({ valid: true, name: 'META PLATFORMS IRELAND LIMITED' });
    expect(t.reverseCharge.totalRon).toBe(1088);
    expect(t.reverseCharge.vatDueRon).toBe(228.48);
    expect(t.reverseCharge.obligations.map((o) => o.code)).toEqual(['D700', 'D390', 'D301']);
    await finance.tax({ month: '2026-11', checkVies: true });
    expect(f.mock.calls.filter(([u]) => String(u).includes('check-vat')).length).toBe(1);
    expect((await finance.vies('IE9692928F', true)).valid).toBe(true);
    expect(f.mock.calls.filter(([u]) => String(u).includes('check-vat')).length).toBe(2);
  });

  it('insights: scadențe + facturi lipsă, alertele de scadență trimise o singură dată', async () => {
    const { db, finance, notify } = await setup();
    add(db, { vendor: 'Furnizor', amount: 10, dueDate: '2026-11-27', paid: false, invoiceDate: '2026-11-01' });
    for (const d of ['2026-07-05', '2026-08-05', '2026-09-05', '2026-10-05']) add(db, { vendor: 'Digi', amount: 60, invoiceDate: d });
    const kinds = finance.insights().map((i) => i.kind);
    expect(kinds).toEqual(expect.arrayContaining(['due', 'missing']));
    finance.checkAlerts();
    finance.checkAlerts();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('monthEnd', () => {
    expect(monthEnd('2026-02')).toBe('2026-02-28');
    expect(monthEnd('2024-02')).toBe('2024-02-29');
    expect(monthEnd('2026-12')).toBe('2026-12-31');
  });
});

describe('export', () => {
  it('ZIP: CRC corect, nume unice, fără zip-slip', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    const z = readZip(makeZip([
      { name: 'a.txt', data: 'x'.repeat(500) },
      { name: 'a.txt', data: 'y' },
      { name: 'a.txt', data: 'z' },
      { name: '../../etc/passwd', data: 'p' },
      { name: '\\win\\f.pdf', data: Buffer.from([1, 2, 3]) },
      { name: 'README', data: 'r' },
      { name: 'README', data: 's' },
    ]));
    expect(Object.keys(z)).toEqual(['a.txt', 'a (2).txt', 'a (3).txt', '_/_/etc/passwd', 'win/f.pdf', 'README', 'README (2)']);
    expect(z['a.txt'].toString()).toBe('x'.repeat(500));
  });

  it('CSV pentru Excel RO: BOM, „;”, virgulă zecimală, protecție la formule', () => {
    const csv = toCsv(['A', 'B', 'C'], [[1.5, '=HYPERLINK("x")', 'a;b'], [null, '-2', 'rând\nnou']]);
    expect(csv.startsWith('\ufeffA;B;C\r\n')).toBe(true);
    expect(csv).toContain('1,5;"\'=HYPERLINK(""x"")";"a;b"');
    expect(csv).toContain(";'-2;");
  });

  it('XLSX: foi multiple, numere ca numere, text scăpat, nume de foaie curățat', () => {
    const z = readZip(toXlsx([
      { name: 'Facturi: 2026/11', header: ['Sumă', 'Furnizor'], rows: [[12.5, 'A & <B>'], [null, '']] },
      { name: '', header: ['x'], rows: [] },
    ]));
    expect(Object.keys(z)).toEqual(expect.arrayContaining(['[Content_Types].xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml', 'xl/styles.xml']));
    expect(z['xl/workbook.xml'].toString()).toContain('name="Facturi  2026 11"');
    expect(z['xl/workbook.xml'].toString()).toContain('name="Foaie2"');
    const s1 = z['xl/worksheets/sheet1.xml'].toString();
    expect(s1).toContain('<c r="A2"><v>12.5</v></c>');
    expect(s1).toContain('A &amp; &lt;B&gt;');
  });

  it('invoiceRows: o linie per factură, cu regim TVA și suma în lei', () => {
    const [r] = invoiceRows([inv({ vendor: 'Meta', amount: 10, currency: 'EUR', amountRon: 50.9, fxRate: 5.09, vatTreatment: 'intra-eu', paid: false, supplierVatId: 'IE9692928F' })]);
    expect(r).toHaveLength(COLUMNS.length);
    expect(r).toEqual(expect.arrayContaining(['Meta', 10, 'EUR', 5.09, 50.9, 'IE9692928F', 'Intracomunitar – taxare inversă', 'nu']));
    const [r2] = invoiceRows([inv({ amount: null, currency: null, paid: true, invoiceDate: null, vendor: null, subject: 'S' })]);
    expect(r2[0]).toBe('2026-11-10');
    expect(r2[1]).toBe('S');
    expect(r2[12]).toBe('da');
  });

  it('raport lunar HTML: escapare, totaluri, disclaimer', () => {
    const html = monthlyReportHtml({
      month: '2026-11',
      company: 'Firma <script>',
      accountant: 'Ana',
      invoices: [inv({ vendor: 'Meta & Co', vatTreatment: 'intra-eu' }), inv({ vendor: 'X', vatTreatment: 'extra-eu' }), inv({ vendor: 'Y', vatTreatment: 'domestic' }), inv({ vendor: 'Z' })],
      spending: { from: '2026-11-01', to: '2026-11-30', totalRon: 400, count: 4, unconverted: 0, byPlatform: [{ key: 'meta', label: 'Meta Ads', totalRon: 400, count: 4 }], bySupplier: [], byMonth: [], byCurrency: [] },
      tax: {
        year: 2026, disclaimer: 'Informativ', warnPercent: 80, vatRatePercent: 21, notes: [], revenueByMonth: {},
        vatThreshold: { valueRon: 1, thresholdRon: 395000, percent: 0, level: 'ok', remainingRon: 394999, source: 'u', revenueSource: 'fgo', updatedAt: null },
        oss: { valueEur: 0, previousYearEur: 0, thresholdEur: 10000, percent: 0, level: 'ok', source: 'u' },
        reverseCharge: { month: '2026-11', items: [], totalRon: 100, vatDueRon: 21, obligations: [{ code: 'D390', title: 'VIES', detail: 'd', deadline: '2026-12-25' }] },
      },
      generatedAt: NOW,
    });
    expect(html).toContain('Firma &lt;script&gt;');
    expect(html).toContain('Meta &amp; Co');
    expect(html).toContain('noiembrie 2026');
    expect(html).toContain('D390');
    expect(html).toContain('Informativ');
    expect(monthLabel('2026-01')).toBe('ianuarie 2026');
  });

  it('pachet pentru contabil: ZIP cu raport PDF, CSV, XLSX și fișierele facturilor', async () => {
    const { db, finance, settings, f } = await setup({ company: { name: 'Atelier Verde SRL' } });
    const dir = tmpDir();
    const pdf = path.join(dir, 'meta.pdf');
    fs.writeFileSync(pdf, '%PDF-1.4 demo');
    add(db, { vendor: 'Meta', amount: 100, currency: 'EUR', invoiceDate: '2026-10-16', filePath: pdf, fileName: 'meta.pdf' });
    add(db, { vendor: 'Lipsă', amount: 1, invoiceDate: '2026-10-17', filePath: path.join(dir, 'nu-exista.pdf') });
    add(db, { vendor: 'Altă lună', amount: 1, invoiceDate: '2026-11-01' });
    const htmlToPdf = vi.fn(async (h: string) => Buffer.from('%PDF ' + h.length));
    const r = await buildAccountantPackage({ db, finance, settings: settings.get(), dataDir: dir, month: '2026-10', htmlToPdf, now: NOW });
    expect(r.count).toBe(2);
    expect(r.zipPath).toBe(path.join(dir, 'pachete', 'FacturaBot_2026-10.zip'));
    const z = readZip(fs.readFileSync(r.zipPath));
    expect(Object.keys(z).sort()).toEqual(['Facturi_2026-10.csv', 'Facturi_2026-10.xlsx', 'Raport_FacturaBot_2026-10.pdf', 'facturi/2026-10-16_meta.pdf']);
    expect(z['facturi/2026-10-16_meta.pdf'].toString()).toBe('%PDF-1.4 demo');
    expect(z['Facturi_2026-10.csv'].toString()).toContain('509');
    expect(f).toHaveBeenCalled(); // conversie BNR înainte de export
    const html = await buildAccountantPackage({ db, finance, settings: settings.get(), dataDir: dir, month: '2026-10' });
    expect(html.reportPdf).toBeNull();
    expect(Object.keys(readZip(fs.readFileSync(html.zipPath)))).toContain('Raport_FacturaBot_2026-10.html');
    await expect(buildAccountantPackage({ db, finance, settings: settings.get(), dataDir: dir, month: '2026-13' })).rejects.toThrow(/AAAA-LL/);
  });

  it('exportTable CSV/XLSX + utilitare de lună', async () => {
    const { db, finance } = await setup();
    add(db, { vendor: 'Meta', platform: 'meta', amount: 100, currency: 'RON', invoiceDate: '2026-11-03' });
    const csv = exportTable({ db, finance, from: '2026-11-01', to: '2026-11-30', format: 'csv' });
    expect(csv.fileName).toBe('FacturaBot_2026-11-01_2026-11-30.csv');
    expect(csv.data.toString()).toContain('Meta Ads');
    const x = exportTable({ db, finance, from: '2026-11-01', to: '2026-11-30', format: 'xlsx' });
    const z = readZip(x.data);
    expect(z['xl/workbook.xml'].toString()).toContain('Pe platformă');
    expect(isMonth('2026-11')).toBe(true);
    expect(isMonth('2026-00')).toBe(false);
    expect(previousMonth(new Date('2026-01-15T00:00:00Z'))).toBe('2025-12');
  });
});
