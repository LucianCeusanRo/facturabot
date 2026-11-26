import { describe, expect, it, vi } from 'vitest';
import { FgoClient, fgoSource } from '../src/main/sources/fgo';
import { DEFAULT_SETTINGS, deepMerge } from '../src/main/config';

describe('FGO', () => {
  it('trimite headerele corecte și paginează', async () => {
    const f = vi.fn(async (url: string, init: any) => {
      expect(init.headers.Authorization).toBe('Bearer KEY');
      expect(init.headers['Fgo-Cod-Unic']).toBe('12345678');
      const u = new URL(url);
      const page2 = u.searchParams.get('cursor') === 'c2';
      return new Response(JSON.stringify({ data: [{ id: page2 ? 'frn2' : 'frn1' }], meta: { pagination: { next_cursor: page2 ? null : 'c2' } } }), { status: 200 });
    });
    const c = new FgoClient('KEY', 'RO 12345678'.replace(' ', ''), 'https://api.fgo.ro', f as any);
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
    const secrets = { get: () => 'KEY', has: () => true } as any;
    const docs = await fgoSource.fetchNew({ settings, secrets, since: new Date('2026-11-01'), log: () => {}, isKnown: () => false, fetch: f as any });
    expect(docs).toHaveLength(1);
    expect(docs[0].externalId).toBe('furnizor:doc1');
    expect(docs[0].summary).toContain('Fan Courier');
    expect(docs[0].amount).toBe(96.4);
  });

  it('eroare 401 lizibilă', async () => {
    const f = async () => new Response(JSON.stringify({ title: 'Unauthorized', detail: 'Cheie invalidă' }), { status: 401 });
    await expect(new FgoClient('x', '1', 'https://api.fgo.ro', f as any).identitate()).rejects.toThrow(/401: Cheie invalidă/);
  });
});

describe('FGO – facturi emise și erori', () => {
  const base = () => {
    const s = deepMerge(DEFAULT_SETTINGS, { sources: { fgo: { enabled: true, codUnic: '123', includeIssued: true, includeSuppliers: false } } });
    const secrets = { get: () => 'KEY', has: () => true } as any;
    return { settings: s, secrets, since: new Date('2026-11-01'), log: vi.fn(), isKnown: () => false, retry: { sleep: async () => undefined, baseDelayMs: 1 } };
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
    await expect(new FgoClient('K', '1', 'https://api.fgo.ro', r429 as any, { sleep: async () => undefined }).identitate()).rejects.toThrow(/prea multe cereri/);
    const html = vi.fn(async () => new Response('<html>Bad gateway</html>', { status: 400 }));
    await expect(new FgoClient('K', '1', 'https://api.fgo.ro', html as any).identitate()).rejects.toThrow(/FGO 400: <html>Bad gateway/);
  });
});
