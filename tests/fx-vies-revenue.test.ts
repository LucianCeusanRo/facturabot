import { describe, expect, it, vi } from 'vitest';
import { Db } from '../src/main/db';
import { BnrRates, daysBetween, parseBnrXml } from '../src/main/fx/bnr';
import { checkVies } from '../src/main/tax/vies';
import { fgoRevenue } from '../src/main/tax/revenue';
import { bnrXml, fakeFetch, json, noSleep } from './helpers';

const xml = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'text/xml' } });

describe('BNR', () => {
  it('parseBnrXml aplică multiplicatorul și ignoră valorile invalide', () => {
    const r = parseBnrXml(bnrXml({ '2026-11-24': { EUR: '5.0914', USD: '4.3862', HUF: '1.2850' } }) + '<Cube date="2026-11-25"><Rate currency="EUR">-1</Rate></Cube>');
    expect(r).toEqual([
      { day: '2026-11-24', currency: 'EUR', rate: 5.0914 },
      { day: '2026-11-24', currency: 'USD', rate: 4.3862 },
      { day: '2026-11-24', currency: 'HUF', rate: 0.01285 },
    ]);
    expect(parseBnrXml('')).toEqual([]);
  });

  it('regula „previous” (art. 290): cursul din ziua ANTERIOARĂ facturii; „same-day”: cel din ziua facturii', async () => {
    const db = await Db.open(null);
    const f = fakeFetch((u) => (u.endsWith('/files/xml/years/nbrfxrates2026.xml') ? xml(bnrXml({ '2026-11-20': { EUR: '5.0800' }, '2026-11-23': { EUR: '5.0900' } })) : undefined));
    const bnr = new BnrRates(db, { base: 'https://curs.bnr.ro/', fetch: f as any, retry: noSleep, now: () => new Date('2026-11-23T12:00:00Z') });
    expect(await bnr.rate('EUR', '2026-11-23')).toEqual({ day: '2026-11-20', rate: 5.08 }); // luni → cursul de vineri
    expect(await bnr.rate('eur', '2026-11-23', 'same-day')).toEqual({ day: '2026-11-23', rate: 5.09 });
    expect(await bnr.rate('RON', '2026-11-23')).toEqual({ day: '2026-11-23', rate: 1 });
    expect(await bnr.rate('XYZ', '2026-11-23')).toBeNull();
    // fișierul anual e descărcat o singură dată, plus încercarea (eșuată, ignorată) a fișierului zilnic
    expect(f.mock.calls.filter(([u]) => String(u).includes('years')).length).toBe(1);
  });

  it('ianuarie: încarcă și anul precedent; erori clare când BNR răspunde cu HTML', async () => {
    const db = await Db.open(null);
    const f = fakeFetch(
      (u) => (u.endsWith('nbrfxrates2027.xml') ? xml(bnrXml({ '2027-01-05': { USD: '4.40' } })) : undefined),
      (u) => (u.endsWith('nbrfxrates2026.xml') ? xml(bnrXml({ '2026-12-31': { USD: '4.38' } })) : undefined),
    );
    const bnr = new BnrRates(db, { base: () => 'https://curs.bnr.ro', fetch: f as any, retry: noSleep, now: () => new Date('2027-03-01T00:00:00Z') });
    expect(await bnr.rate('USD', '2027-01-05')).toEqual({ day: '2026-12-31', rate: 4.38 });

    const html = fakeFetch(() => new Response('<html>BNR</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    const bad = new BnrRates(await Db.open(null), { base: 'https://www.bnr.ro', fetch: html as any, retry: noSleep });
    await expect(bad.rate('EUR', '2025-05-05')).rejects.toThrow(/Curs BNR indisponibil/);
    const empty = new BnrRates(await Db.open(null), { base: 'x', fetch: fakeFetch(() => xml('<?xml version="1.0"?><x/>')) as any, retry: noSleep });
    await expect(empty.rate('EUR', '2025-05-05')).rejects.toThrow(/nu conține/);
  });

  it('anul curent: completează cu fișierul zilnic când lipsesc zilele recente', async () => {
    const db = await Db.open(null);
    db.putRates([{ day: '2026-01-05', currency: 'EUR', rate: 5 }]);
    const f = fakeFetch((u) => (u.endsWith('/nbrfxrates.xml') ? xml(bnrXml({ '2026-11-25': { EUR: '5.1' } })) : undefined));
    const bnr = new BnrRates(db, { base: 'https://curs.bnr.ro', fetch: f as any, retry: noSleep, now: () => new Date('2026-11-26T10:00:00Z') });
    expect(await bnr.rate('EUR', '2026-11-26')).toEqual({ day: '2026-11-25', rate: 5.1 });
    expect(daysBetween('2026-11-20', '2026-11-26')).toBe(6);
  });
});

describe('VIES', () => {
  const base = 'https://ec.europa.eu/taxation_customs/vies/rest-api/';
  it('cod valid: trimite countryCode + vatNumber, curăță „---”', async () => {
    const f = fakeFetch((u, init) => {
      if (!u.endsWith('/check-vat-number')) return undefined;
      expect(JSON.parse(String(init!.body))).toEqual({ countryCode: 'IE', vatNumber: '9692928F' });
      return json({ countryCode: 'IE', vatNumber: '9692928F', requestDate: '2026-11-26T10:00:00.000Z', valid: true, name: 'META PLATFORMS IRELAND LIMITED', address: '---' });
    });
    expect(await checkVies('IE 9692928F', { base, fetch: f as any, retry: noSleep })).toEqual({
      ok: true,
      valid: true,
      name: 'META PLATFORMS IRELAND LIMITED',
      address: undefined,
      checkedAt: '2026-11-26T10:00:00.000Z',
    });
  });

  it('cod invalid / format greșit / serviciu indisponibil / rețea', async () => {
    const inv = fakeFetch(() => json({ valid: false, name: '---' }));
    expect(await checkVies('IE1234567T', { base, fetch: inv as any, retry: noSleep })).toMatchObject({ ok: true, valid: false, name: undefined });
    expect(await checkVies('XX1', { base, fetch: inv as any })).toMatchObject({ ok: false, error: expect.stringMatching(/Format/) });
    const down = fakeFetch(() => json({ actionSucceed: false, errorWrappers: [{ error: 'MS_UNAVAILABLE' }] }, 200));
    expect(await checkVies('DE123456789', { base, fetch: down as any, retry: noSleep })).toMatchObject({ ok: false, error: expect.stringMatching(/nu răspunde/) });
    const s500 = fakeFetch(() => json({}, 400));
    expect(await checkVies('DE123456789', { base, fetch: s500 as any, retry: noSleep })).toMatchObject({ ok: false, error: 'VIES 400' });
    const boom = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    expect(await checkVies('DE123456789', { base, fetch: boom as any, retry: { retries: 0, ...noSleep } })).toMatchObject({ ok: false });
  });
});

describe('venituri FGO (plafon TVA + OSS)', () => {
  const gen = (rows: any[]) =>
    (async function* () {
      for (const r of rows) yield r;
    })();
  const rate = async (c: string) => (c === 'RON' ? 1 : c === 'EUR' ? 5 : null);

  it('sumează valoarea fără TVA, exclude draft/anulate, convertește valuta, calculează OSS pentru PF din UE', async () => {
    const client = {
      paginate: vi.fn((path: string) =>
        path === '/v2/clienti'
          ? gen([
              { id: 1, cod_tara: 'RO', tip_persoana: 'PJ' },
              { id: 2, cod_tara: 'de', tip_persoana: 'PF' },
              { id: 3, cod_tara: 'US', tip_persoana: 'PF' },
            ])
          : gen([
              { data_emitere: '2026-01-10', valoare_fara_tva: '1000', valoare_totala: '1210', valuta: 'RON', status: 'emisa', id_client: 1 },
              { data_emitere: '2026-02-03', valoare_fara_tva: '100', valuta: 'EUR', status: 'emisa', id_client: 2 },
              { data_emitere: '2026-02-04', valoare_totala: '50', valuta: 'EUR', status: 'emisa', id_client: 3 },
              { data_emitere: '2026-02-05', valoare_fara_tva: '999', status: 'anulata' },
              { data_emitere: '2026-02-06', valoare_fara_tva: '999', status: 'draft' },
              { data_emitere: 'ieri', valoare_fara_tva: '1' },
              { data_emitere: '2026-02-07', valoare_fara_tva: 'x' },
              { data_emitere: '2026-02-08', valoare_fara_tva: '10', valuta: 'XYZ' },
            ]),
      ),
    };
    const r = await fgoRevenue(client as any, 2026, rate, new Date('2026-11-26T10:00:00Z'));
    expect(r).toMatchObject({ year: 2026, totalRon: 1750, count: 3, ossEur: 100, unconverted: 1, byMonth: { '2026-01': 1000, '2026-02': 750 } });
    expect(client.paginate).toHaveBeenCalledWith('/v2/facturi', expect.objectContaining({ data_emitere_de_la: '2026-01-01', data_emitere_pana_la: '2026-11-26' }));
  });

  it('fără dreptul clienti:citire → OSS necunoscut, cu explicație', async () => {
    const client = {
      paginate: (path: string) =>
        path === '/v2/clienti'
          ? (async function* () {
              yield* [];
              throw new Error('403 Forbidden');
            })()
          : gen([{ data_emitere: '2025-12-01', valoare_fara_tva: 10, status: 'emisa' }]),
    };
    const r = await fgoRevenue(client as any, 2025, rate, new Date('2026-02-01T00:00:00Z'));
    expect(r.ossEur).toBeNull();
    expect(r.ossNote).toMatch(/clienti:citire/);
    expect(r.totalRon).toBe(10);
  });
});
