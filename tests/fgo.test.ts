import { describe, expect, it, vi } from 'vitest';
import { FgoClient, fgoSource, formatFgoError, isValidFgoApiKey, normalizeFgoApiKey, parseFgoProblem } from '../src/main/sources/fgo';
import { DEFAULT_SETTINGS, deepMerge } from '../src/main/config';

describe('FGO', () => {
  it('trimite headerele corecte și paginează', async () => {
    const f = vi.fn(async (url: string, init: any) => {
      expect(init.headers.Authorization).toBe('Bearer fgo_api_v2_testkey');
      expect(init.headers['Fgo-Cod-Unic']).toBe('12345678');
      expect(init.headers['x-fapi-interaction-id']).toMatch(/^[0-9a-f-]{36}$/);
      const u = new URL(url);
      const page2 = u.searchParams.get('cursor') === 'c2';
      return new Response(JSON.stringify({ data: [{ id: page2 ? 'frn2' : 'frn1' }], meta: { pagination: { next_cursor: page2 ? null : 'c2' } } }), { status: 200 });
    });
    const c = new FgoClient('fgo_api_v2_testkey', 'RO 12345678'.replace(' ', ''), 'https://api.fgo.ro', f as any, { pageGapMs: 0, sleep: async () => undefined });
    const ids: string[] = [];
    for await (const it of c.paginate('/v2/facturi-furnizori', { fields: 'furnizor' })) ids.push(it.id);
    expect(ids).toEqual(['frn1', 'frn2']);
  });

  it('sursa FGO produce rezumat pentru facturi furnizori', async () => {
    const f = async () =>
      new Response(
        JSON.stringify({
          data: [{ id: 'doc1', furnizor: 'Fan Courier', cod_unic_furnizor: '11', numar: '884213', data_emitere: '2026-11-10', total: 96.4, valuta: 'RON', platita: false }],
          meta: { pagination: { next_cursor: null } },
        }),
      );
    const settings = deepMerge(DEFAULT_SETTINGS, { sources: { fgo: { enabled: true, codUnic: '123', includeSuppliers: true, includeIssued: false } } });
    const secrets = { get: () => 'fgo_api_v2_testkey', has: () => true } as any;
    const docs = await fgoSource.fetchNew({ settings, secrets, since: new Date('2026-11-01'), log: () => {}, isKnown: () => false, fetch: f as any, retry: { pageGapMs: 0, sleep: async () => undefined } });
    expect(docs).toHaveLength(1);
    expect(docs[0].externalId).toBe('furnizor:doc1');
    expect(docs[0].summary).toContain('Fan Courier');
    expect(docs[0].amount).toBe(96.4);
  });

  it('eroare 401 lizibilă', async () => {
    const f = async () => new Response(JSON.stringify({ title: 'Unauthorized', detail: 'Cheie invalidă' }), { status: 401 });
    await expect(new FgoClient('fgo_api_v2_x', '1', 'https://api.fgo.ro', f as any, { pageGapMs: 0, sleep: async () => undefined }).identitate()).rejects.toThrow(/expirat sau a fost revocată/);
  });
});

describe('FGO – facturi emise și erori', () => {
  const base = () => {
    const s = deepMerge(DEFAULT_SETTINGS, { sources: { fgo: { enabled: true, codUnic: '123', includeIssued: true, includeSuppliers: false } } });
    const secrets = { get: () => 'fgo_api_v2_testkey', has: () => true } as any;
    return { settings: s, secrets, since: new Date('2026-11-01'), log: vi.fn(), isKnown: () => false, retry: { sleep: async () => undefined, baseDelayMs: 1, pageGapMs: 0 } };
  };

  it('descarcă PDF-ul facturilor emise; client ca obiect; sare peste ciorne', async () => {
    const f = vi.fn(async (url: string) => {
      if (url.includes('/v2/facturi?')) return new Response(JSON.stringify({ data: [{ serie: 'FB', numar: '7', client: { denumire: 'Ion SRL' }, valoare_totala: 100, valuta: 'RON' }, { serie: 'FB', numar: '8', status: 'draft' }], meta: {} }));
      if (url.includes('genereaza-link-de-descarcare')) return new Response(JSON.stringify({ data: { link: 'https://cdn.fgo.ro/f.pdf' } }));
      if (url === 'https://cdn.fgo.ro/f.pdf') return new Response('%PDF-fgo', { headers: { 'content-type': 'application/pdf' } });
      return new Response('{}', { status: 404 });
    });
    const docs = await fgoSource.fetchNew({ ...base(), fetch: f as any });
    expect(docs).toHaveLength(1);
    expect(docs[0].vendor).toBe('Emisă către Ion SRL');
    expect(docs[0].data?.toString()).toBe('%PDF-fgo');
    expect(docs[0].fileName).toBe('Factura_FB_7.pdf');
  });

  it('PDF indisponibil → rezumat cu link, plus avertisment', async () => {
    const c = base();
    const f = vi.fn(async (url: string) => {
      if (url.includes('/v2/facturi?')) return new Response(JSON.stringify({ data: [{ serie: 'FB', numar: '9', client: 'Ana' }] }));
      return new Response('<html>eroare</html>', { status: 500 });
    });
    const docs = await fgoSource.fetchNew({ ...c, fetch: f as any });
    expect(docs[0].data).toBeNull();
    expect(docs[0].summary).toMatch(/FB 9 către Ana/);
    expect(c.log).toHaveBeenCalledWith('warn', expect.stringMatching(/nu am putut descărca/));
  });

  it('429 persistent → mesaj clar; răspuns non-JSON nu aruncă SyntaxError', async () => {
    const r429 = vi.fn(async () => new Response('', { status: 429, headers: { 'retry-after': '0' } }));
    await expect(new FgoClient('fgo_api_v2_k', '1', 'https://api.fgo.ro', r429 as any, { pageGapMs: 0, sleep: async () => undefined }).identitate()).rejects.toThrow(/prea multe cereri/i);
    const html = vi.fn(async () => new Response('<html>Bad gateway</html>', { status: 400 }));
    await expect(new FgoClient('fgo_api_v2_k', '1', 'https://api.fgo.ro', html as any, { pageGapMs: 0 }).identitate()).rejects.toThrow(/FGO 400: <html>Bad gateway/);
  });
});

describe('FGO v2 – cheie, erori și probe', () => {
  const none = { pageGapMs: 0, sleep: async () => undefined };
  it('normalizează și validează cheia fgo_api_v2', () => {
    expect(normalizeFgoApiKey('  Bearer fgo_api_v2_abc  ')).toBe('fgo_api_v2_abc');
    expect(isValidFgoApiKey('fgo_api_v2_abc')).toBe(true);
    expect(isValidFgoApiKey('fgo_live_old')).toBe(false);
    expect(isValidFgoApiKey('')).toBe(false);
  });
  it('refuză o cheie v1 înainte de a apela rețeaua', async () => {
    const f = vi.fn();
    await expect(new FgoClient('cheie-veche', '123', 'https://api.fgo.ro', f as any, none).identitate()).rejects.toThrow(/fgo_api_v2/);
    expect(f).not.toHaveBeenCalled();
  });
  it('403 drept_lipsa și cod_unic_neasociat', () => {
    expect(formatFgoError(parseFgoProblem(403, { type: 'urn:fgo:api:v2:problem:forbidden', motiv: { cod: 'drept_lipsa', mesaj: 'Cheia API nu are dreptul de a face aceasta operatie.' } }))).toMatch(/Drept lipsă/);
    expect(formatFgoError(parseFgoProblem(403, { type: 'urn:fgo:api:v2:problem:forbidden', motiv: { cod: 'cod_unic_neasociat' } }))).toMatch(/cod_unic_neasociat/);
  });
  it('probe: cheie validă, anunță drepturile lipsă', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ data: { drepturi: ['facturi:citire'], expira_la: null, cautare_articol_dupa: 'cod_articol' } })));
    const r = await new FgoClient('fgo_api_v2_x', '123', 'https://api.fgo.ro', f as any, none).probe(['furnizori:citire', 'facturi:citire']);
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['furnizori:citire']);
    expect(r.info).toMatch(/facturi:citire/);
    expect(r.identitate?.expiraLa).toBeNull();
  });
  it('probe reușit când drepturile acoperă sursele alese', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ data: { drepturi: ['furnizori:citire', 'facturi:citire'], expira_la: '2027-01-01T00:00:00+02:00' } })));
    const r = await new FgoClient('Bearer fgo_api_v2_ok', 'RO 99', 'https://api.fgo.ro', f as any, none).probe(['furnizori:citire']);
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
  });
});
