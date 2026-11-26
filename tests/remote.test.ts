import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseCookies, RemoteServer, SECURITY_HEADERS, sha256, type RemoteApi } from '../src/main/remote/server';
import { inv, tmpDir } from './helpers';

const servers: RemoteServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

function kv() {
  const m = new Map<string, string>();
  return { getKv: (k: string) => m.get(k) ?? null, setKv: (k: string, v: string) => void m.set(k, v), m };
}

async function setup(over: Partial<RemoteApi> = {}, now = () => Date.now()) {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'web.html'), '<!doctype html><title>FacturaBot</title>');
  fs.writeFileSync(path.join(dir, 'manifest.webmanifest'), '{}');
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'nu');
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'assets', 'web-1.js'), 'console.log(1)');
  const pdf = path.join(dir, 'f.pdf');
  fs.writeFileSync(pdf, '%PDF-1.4');
  const rows = [inv({ id: 1, status: 'awaiting_confirm', filePath: pdf, fileName: 'Meta 1.pdf' }), inv({ id: 2, status: 'sent' })];
  const api: RemoteApi = {
    status: () => ({ syncing: false, lastSync: null, nextSync: null, stats: { sent: 1, pending: 1, failed: 0, thisMonth: 1 }, connections: {} as any, problems: [] }) as any,
    listInvoices: vi.fn((st) => rows.filter((r) => st === 'all' || r.status === st)),
    getInvoice: (id) => rows.find((r) => r.id === id) ?? null,
    approve: vi.fn(async (id) => {
      rows.find((r) => r.id === id)!.status = 'sent';
    }),
    skip: vi.fn(),
    sync: vi.fn(async () => undefined),
    spending: vi.fn(() => ({ totalRon: 1 }) as any),
    tax: vi.fn(async () => ({ year: 2026 }) as any),
    insights: () => [],
    exportTable: (f) => ({ data: Buffer.from(f === 'csv' ? 'a;b' : 'PK'), fileName: `Export ț.${f}` }),
    packageZip: async () => pdf,
    info: () => ({ company: 'Atelier' }),
    ...over,
  };
  const store = kv();
  const srv = new RemoteServer({ api, kv: store, staticDir: dir, now, qr: async (t) => `data:qr,${t}`, publicUrl: () => 'https://pc.tail.ts.net/' });
  servers.push(srv);
  const port = await srv.start(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  const req = (p: string, init: RequestInit & { cookie?: string } = {}) =>
    fetch(base + p, { ...init, headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers as any), ...(init.cookie ? { Cookie: init.cookie } : {}) } });
  const post = (p: string, body: unknown, cookie?: string, csrf = true) => req(p, { method: 'POST', body: JSON.stringify(body), cookie, headers: csrf ? { 'X-FacturaBot': '1' } : {} });
  const pair = async () => {
    const code = srv.newPairing().code;
    const r = await post('/api/pair', { code, name: 'iPhone Test' });
    expect(r.status).toBe(200);
    const sc = r.headers.get('set-cookie')!;
    expect(sc).toMatch(/fb_s=[\w-]{40,}; HttpOnly; SameSite=Strict; Path=\//);
    return sc.split(';')[0];
  };
  return { srv, api, store, base, req, post, pair, rows, dir };
}

describe('panou telefon – server local', () => {
  it('servește doar fișierele interfeței, cu antete de securitate', async () => {
    const { req } = await setup();
    const home = await req('/');
    expect(home.status).toBe(200);
    expect(await home.text()).toContain('FacturaBot');
    expect(home.headers.get('content-security-policy')).toBe(SECURITY_HEADERS['Content-Security-Policy']);
    expect(home.headers.get('x-frame-options')).toBe('DENY');
    expect((await req('/assets/web-1.js')).headers.get('cache-control')).toContain('immutable');
    expect((await req('/manifest.webmanifest')).headers.get('content-type')).toBe('application/manifest+json');
    expect((await req('/secret.txt')).status).toBe(404);
    expect((await req('/assets/../secret.txt')).status).toBe(404);
    expect((await req('/assets/%2e%2e%2fsecret.txt')).status).toBe(404);
    expect((await req('/', { method: 'POST' })).status).toBe(405);
    expect((await req('/', { method: 'HEAD' })).status).toBe(200);
  });

  it('fără împerechere: doar /api/session; restul 401', async () => {
    const { req } = await setup();
    expect(await (await req('/api/session')).json()).toEqual({ paired: false, device: null });
    expect((await req('/api/status')).status).toBe(401);
    expect((await req('/api/invoices', { cookie: 'fb_s=' + 'x'.repeat(43) })).status).toBe(401);
    expect((await req('/api/invoices', { cookie: 'fb_s=scurt' })).status).toBe(401);
  });

  it('împerechere: cod unic, cookie HttpOnly, doar hash-ul tokenului e salvat', async () => {
    const { pair, req, store, srv, post } = await setup();
    const cookie = await pair();
    const token = cookie.split('=')[1];
    const saved = JSON.parse(store.m.get('remote:devices')!);
    expect(saved[0]).toMatchObject({ name: 'iPhone Test', tokenHash: sha256(token) });
    expect(JSON.stringify(saved)).not.toContain(token);
    expect(await (await req('/api/session', { cookie })).json()).toMatchObject({ paired: true, device: { name: 'iPhone Test' } });
    expect(srv.devices()[0]).not.toHaveProperty('tokenHash');
    // codul nu poate fi refolosit
    expect((await post('/api/pair', { code: '000000' })).status).toBe(400);
  });

  it('cod greșit: 5 încercări invalidează codul; rate-limit pe IP; cod expirat', async () => {
    let t = 1_000_000;
    const { srv, post } = await setup({}, () => t);
    const { code } = srv.newPairing();
    const wrong = code === '111111' ? '222222' : '111111';
    for (let i = 0; i < 4; i++) expect((await post('/api/pair', { code: wrong })).status).toBe(401);
    const fifth = await post('/api/pair', { code: wrong });
    expect((await fifth.json()).error).toMatch(/Prea multe/);
    expect((await post('/api/pair', { code })).status).toBe(400); // codul corect nu mai merge
    srv.newPairing();
    for (let i = 0; i < 4; i++) await post('/api/pair', { code: wrong });
    expect((await post('/api/pair', { code: wrong })).status).toBe(429);
    t += 11 * 60_000;
    const c2 = srv.newPairing().code;
    t += 11 * 60_000;
    expect((await post('/api/pair', { code: c2 })).status).toBe(400);
  });

  it('CSRF: modificările cer antetul X-FacturaBot; JSON invalid / prea mare', async () => {
    const { post, pair, req, srv } = await setup();
    const cookie = await pair();
    expect((await post('/api/invoices/1/approve', {}, cookie, false)).status).toBe(403);
    expect((await req('/api/pair', { method: 'POST', body: '{', headers: { 'X-FacturaBot': '1' } })).status).toBe(400);
    srv.newPairing();
    expect((await req('/api/pair', { method: 'POST', body: JSON.stringify({ code: 'x'.repeat(5000) }), headers: { 'X-FacturaBot': '1' } })).status).toBe(413);
  });

  it('API: status, facturi fără căi locale, PDF inline, aprobare/ignorare, sync, cheltuieli, TVA, export, pachet', async () => {
    const { pair, req, post, api } = await setup();
    const cookie = await pair();
    expect((await (await req('/api/status', { cookie })).json()).stats.pending).toBe(1);
    const list = await (await req('/api/invoices?status=awaiting_confirm&limit=5', { cookie })).json();
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty('filePath');
    expect(list[0].hasFile).toBe(true);
    expect((await req('/api/invoices?status=hack', { cookie })).status).toBe(400);
    const file = await req('/api/invoices/1/file', { cookie });
    expect(file.headers.get('content-disposition')).toMatch(/^inline; filename="Meta 1.pdf"/);
    expect(file.headers.get('content-security-policy')).toBeNull();
    expect((await req('/api/invoices/2/file', { cookie })).status).toBe(404);
    expect(await (await post('/api/invoices/1/approve', {}, cookie)).json()).toEqual({ ok: true, status: 'sent' });
    expect((await post('/api/invoices/1/approve', {}, cookie)).status).toBe(409); // deja trimisă
    expect((await post('/api/invoices/99/approve', {}, cookie)).status).toBe(404);
    expect((await post('/api/invoices/2/skip', {}, cookie)).status).toBe(200);
    expect(api.skip).toHaveBeenCalledWith(2);
    expect((await post('/api/invoices/99/skip', {}, cookie)).status).toBe(404);
    expect((await post('/api/sync', {}, cookie)).status).toBe(202);
    expect(api.sync).toHaveBeenCalled();
    expect((await req('/api/spending?from=2026-01-01&to=2026-11-26', { cookie })).status).toBe(200);
    expect((await req('/api/spending?from=2026-12-01&to=2026-11-26', { cookie })).status).toBe(400);
    expect((await req('/api/tax?month=2026-11', { cookie })).status).toBe(200);
    expect((await req('/api/tax?month=2026-13', { cookie })).status).toBe(400);
    expect((await req('/api/tax?year=1990', { cookie })).status).toBe(400);
    const csv = await req('/api/export?format=csv&from=2026-01-01&to=2026-11-26', { cookie });
    expect(csv.headers.get('content-disposition')).toContain("filename*=UTF-8''Export%20%C8%9B.csv");
    expect((await req('/api/export?format=pdf&from=2026-01-01&to=2026-11-26', { cookie })).status).toBe(400);
    expect((await req('/api/package?month=2026-10', { cookie })).headers.get('content-type')).toBe('application/zip');
    expect((await req('/api/package?month=bad', { cookie })).status).toBe(400);
    expect(await (await req('/api/info', { cookie })).json()).toEqual({ company: 'Atelier' });
    expect(await (await req('/api/insights', { cookie })).json()).toEqual([]);
    expect((await req('/api/nimic', { cookie })).status).toBe(404);
  });

  it('erorile din API devin 500 fără a opri serverul; logout revocă dispozitivul', async () => {
    const { pair, req, post, srv } = await setup({
      spending: () => {
        throw new Error('db închisă');
      },
    });
    const cookie = await pair();
    expect((await req('/api/spending?from=2026-01-01&to=2026-01-02', { cookie })).status).toBe(500);
    const out = await post('/api/logout', {}, cookie);
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(srv.devices()).toEqual([]);
    expect((await req('/api/status', { cookie })).status).toBe(401);
  });

  it('stare pentru desktop: URL public + LAN, QR cu codul, revocare, port ocupat', async () => {
    const { srv } = await setup();
    srv.newPairing();
    const st = await srv.state();
    expect(st.running).toBe(true);
    expect(st.urls[0]).toBe('https://pc.tail.ts.net');
    expect(st.pairing!.url).toMatch(/^https:\/\/pc\.tail\.ts\.net\/#pair=\d{6}$/);
    expect(st.pairing!.qrDataUrl).toBe(`data:qr,${st.pairing!.url}`);
    const other = new RemoteServer({ api: {} as any, kv: kv(), staticDir: '/nu' });
    servers.push(other);
    await expect(other.start(srv.port, '127.0.0.1')).rejects.toThrow(/ocupat/);
    expect((await other.state()).error).toMatch(/ocupat/);
    expect(await srv.start(0)).toBe(srv.port); // deja pornit
    await srv.stop();
    expect((await srv.state()).urls).toEqual([]);
  });

  it('parseCookies', () => {
    expect(parseCookies('a=1; fb_s=x%3Dy; bad; =z; c=%E0')).toEqual({ a: '1', fb_s: 'x=y' });
    expect(parseCookies(undefined)).toEqual({});
  });
});
