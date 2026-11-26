import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Insight, InvoiceRecord, InvoiceStatus, RemoteDevice, RemoteState, SpendingReport, StatusSnapshot, TaxOverview } from '../../shared/types.js';

/**
 * Panoul de pe telefon: server HTTP local (opțional, oprit implicit), doar în rețeaua locală.
 *  - Împerechere: cod de 6 cifre (și QR cu link) valabil 10 minute, de unică folosință.
 *  - După împerechere telefonul primește un cookie HttpOnly (SameSite=Strict); pe PC păstrăm doar hash-ul.
 *  - Modificările (Trimite / Ignoră / Sincronizează) cer antetul `X-FacturaBot: 1` (protecție CSRF).
 *  - Nimic nu pleacă în cloud. Pentru acces din afara casei: Tailscale sau Cloudflare Tunnel (vezi README).
 */
export interface RemoteApi {
  status(): StatusSnapshot;
  listInvoices(status: InvoiceStatus | 'all', limit: number): InvoiceRecord[];
  getInvoice(id: number): InvoiceRecord | null;
  approve(id: number): Promise<void>;
  skip(id: number): void;
  sync(): Promise<void>;
  spending(from: string, to: string): SpendingReport;
  tax(o: { year?: number; month?: string }): Promise<TaxOverview>;
  insights(): Insight[];
  exportTable(format: 'csv' | 'xlsx', from: string, to: string): { data: Buffer; fileName: string };
  packageZip(month: string): Promise<string>;
  info(): Record<string, unknown>;
}

export interface KvStore {
  getKv(k: string): string | null;
  setKv(k: string, v: string): void;
}

interface StoredDevice extends RemoteDevice {
  tokenHash: string;
}

const PAIR_TTL_MS = 10 * 60_000;
const COOKIE = 'fb_s';
const STATUSES: (InvoiceStatus | 'all')[] = ['all', 'pending', 'awaiting_confirm', 'sending', 'sent', 'failed', 'skipped', 'duplicate'];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  // Rețele private întâi (192.168.x, 10.x, 172.16–31.x), apoi restul (ex. Tailscale 100.x).
  const rank = (ip: string) => (/^192\.168\./.test(ip) ? 0 : /^10\./.test(ip) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  return out.sort((a, b) => rank(a) - rank(b));
}

export function parseCookies(h: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of (h ?? '').split(';')) {
    const part = raw.trim();
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* cookie malformat – ignorat */
    }
  }
  return out;
}

export class RemoteServer {
  private server: http.Server | null = null;
  private pairing: { code: string; expiresAt: number; failures: number } | null = null;
  private attempts = new Map<string, { n: number; reset: number }>();
  port = 0;
  error: string | undefined;

  constructor(
    private o: {
      api: RemoteApi;
      kv: KvStore;
      staticDir: string;
      log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
      now?: () => number;
      qr?: (text: string) => Promise<string>;
      publicUrl?: () => string;
    },
  ) {}

  private now() {
    return (this.o.now ?? Date.now)();
  }

  get running() {
    return !!this.server?.listening;
  }

  async start(port: number, host = '0.0.0.0'): Promise<number> {
    if (this.running) return this.port;
    this.error = undefined;
    const srv = http.createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        this.o.log?.('error', `Panou telefon: ${(e as Error).message}`);
        if (!res.headersSent) this.json(res, 500, { error: 'Eroare internă' });
        else res.end();
      });
    });
    srv.requestTimeout = 30_000;
    srv.headersTimeout = 10_000;
    await new Promise<void>((resolve, reject) => {
      srv.once('error', (e: NodeJS.ErrnoException) => {
        this.error = e.code === 'EADDRINUSE' ? `Portul ${port} e ocupat. Alege alt port în Setări.` : e.message;
        reject(new Error(this.error));
      });
      srv.listen(port, host, () => resolve());
    });
    this.server = srv;
    this.port = (srv.address() as AddressInfo).port;
    return this.port;
  }

  async stop() {
    const s = this.server;
    this.server = null;
    this.pairing = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
    s?.closeAllConnections?.();
  }

  // ---------- Dispozitive ----------
  private loadDevices(): StoredDevice[] {
    try {
      return JSON.parse(this.o.kv.getKv('remote:devices') ?? '[]');
    } catch {
      return [];
    }
  }
  private saveDevices(d: StoredDevice[]) {
    this.o.kv.setKv('remote:devices', JSON.stringify(d));
  }
  devices(): RemoteDevice[] {
    return this.loadDevices().map(({ tokenHash: _t, ...d }) => d);
  }
  revoke(id: string) {
    this.saveDevices(this.loadDevices().filter((d) => d.id !== id));
  }

  newPairing() {
    this.pairing = { code: String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'), expiresAt: this.now() + PAIR_TTL_MS, failures: 0 };
    return { ...this.pairing };
  }

  urls(): string[] {
    const pub = this.o.publicUrl?.()?.trim().replace(/\/+$/, '');
    const lan = lanAddresses().map((ip) => `http://${ip}:${this.port}`);
    if (!lan.length) lan.push(`http://127.0.0.1:${this.port}`);
    return pub ? [pub, ...lan] : lan;
  }

  async state(): Promise<RemoteState> {
    const urls = this.running ? this.urls() : [];
    let pairing: RemoteState['pairing'] = null;
    if (this.running && this.pairing && this.pairing.expiresAt > this.now() && urls[0]) {
      const url = `${urls[0]}/#pair=${this.pairing.code}`;
      pairing = { code: this.pairing.code, expiresAt: new Date(this.pairing.expiresAt).toISOString(), url, qrDataUrl: this.o.qr ? await this.o.qr(url) : '' };
    }
    return { running: this.running, port: this.port, urls, pairing, devices: this.devices(), error: this.error };
  }

  // ---------- HTTP ----------
  private json(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
    res.end(JSON.stringify(body));
  }

  private send(res: http.ServerResponse, data: Buffer, fileName: string, type: string, disposition: 'attachment' | 'inline' = 'attachment') {
    const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    // Fără CSP pe fișiere: unele vizualizatoare PDF integrate nu pornesc sub CSP; restul antetelor rămân.
    const { 'Content-Security-Policy': _csp, ...headers } = SECURITY_HEADERS;
    res.writeHead(200, {
      ...headers,
      'Content-Type': type,
      'Content-Length': String(data.length),
      'Content-Disposition': `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      'Cache-Control': 'no-store',
    });
    res.end(data);
  }

  private authed(req: http.IncomingMessage): StoredDevice | null {
    const tok = parseCookies(req.headers.cookie)[COOKIE];
    if (!tok || tok.length < 32) return null;
    const h = sha256(tok);
    const all = this.loadDevices();
    const d = all.find((x) => crypto.timingSafeEqual(Buffer.from(x.tokenHash, 'hex'), Buffer.from(h, 'hex')));
    if (d) {
      const seen = new Date(this.now()).toISOString();
      if (!d.lastSeen || Date.parse(seen) - Date.parse(d.lastSeen) > 60_000) {
        d.lastSeen = seen;
        this.saveDevices(all);
      }
    }
    return d ?? null;
  }

  private rateLimited(ip: string) {
    const now = this.now();
    const a = this.attempts.get(ip);
    if (!a || a.reset < now) {
      this.attempts.set(ip, { n: 1, reset: now + PAIR_TTL_MS });
      return false;
    }
    a.n++;
    return a.n > 10;
  }

  private async body(req: http.IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > 4096) throw Object.assign(new Error('Cerere prea mare'), { status: 413 });
      chunks.push(c as Buffer);
    }
    try {
      return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    } catch {
      throw Object.assign(new Error('JSON invalid'), { status: 400 });
    }
  }

  private serveStatic(res: http.ServerResponse, pathname: string, head: boolean) {
    const root = path.resolve(this.o.staticDir);
    const rel = pathname === '/' || pathname === '/index.html' ? 'web.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    const allowed = rel === 'web.html' || rel === 'manifest.webmanifest' || rel === 'sw.js' || /^assets\/[\w.-]+$/.test(rel) || /^icons\/[\w.-]+$/.test(rel);
    const file = path.resolve(root, rel);
    if (!allowed || !file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Nu există');
      return;
    }
    const ext = path.extname(file);
    const immutable = rel.startsWith('assets/');
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      ...(rel === 'sw.js' ? { 'Service-Worker-Allowed': '/' } : {}),
    });
    if (head) res.end();
    else fs.createReadStream(file).pipe(res);
  }

  async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://local');
    const p = url.pathname;
    const method = req.method ?? 'GET';
    const ip = req.socket.remoteAddress ?? '?';

    if (!p.startsWith('/api/')) {
      if (method !== 'GET' && method !== 'HEAD') return this.json(res, 405, { error: 'Metodă nepermisă' });
      return this.serveStatic(res, p, method === 'HEAD');
    }

    // CSRF: orice modificare cere antetul propriu (un formular străin nu-l poate trimite fără CORS).
    if (method !== 'GET' && req.headers['x-facturabot'] !== '1') return this.json(res, 403, { error: 'Antet lipsă' });

    if (p === '/api/pair' && method === 'POST') {
      if (this.rateLimited(ip)) return this.json(res, 429, { error: 'Prea multe încercări. Așteaptă 10 minute.' });
      const b = await this.body(req).catch((e) => ({ __err: e }));
      if ((b as any).__err) return this.json(res, (b as any).__err.status ?? 400, { error: (b as any).__err.message });
      const code = String(b.code ?? '').replace(/\D/g, '');
      const pr = this.pairing;
      if (!pr || pr.expiresAt < this.now()) return this.json(res, 400, { error: 'Codul a expirat. Generează unul nou din aplicația de pe PC.' });
      const ok = code.length === 6 && crypto.timingSafeEqual(Buffer.from(code), Buffer.from(pr.code));
      if (!ok) {
        pr.failures++;
        if (pr.failures >= 5) this.pairing = null;
        return this.json(res, 401, { error: pr.failures >= 5 ? 'Prea multe coduri greșite. Generează unul nou.' : 'Cod greșit.' });
      }
      this.pairing = null; // unică folosință
      const token = crypto.randomBytes(32).toString('base64url');
      const ua = String(req.headers['user-agent'] ?? '');
      const name = String(b.name ?? '').trim().slice(0, 60) || (/iPhone|iPad/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : 'Telefon');
      const dev: StoredDevice = { id: crypto.randomUUID(), name, createdAt: new Date(this.now()).toISOString(), lastSeen: null, tokenHash: sha256(token) };
      this.saveDevices([...this.loadDevices(), dev].slice(-10));
      this.o.log?.('info', `Telefon împerecheat: ${name}`);
      const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      return this.json(res, 200, { ok: true, device: { id: dev.id, name } }, { 'Set-Cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000${secure}` });
    }

    const dev = this.authed(req);
    if (p === '/api/session') return this.json(res, 200, { paired: !!dev, device: dev ? { id: dev.id, name: dev.name } : null });
    if (!dev) return this.json(res, 401, { error: 'Telefonul nu este împerecheat.' });

    const a = this.o.api;
    const inv = p.match(/^\/api\/invoices\/(\d{1,12})(?:\/(file|approve|skip))?$/);
    try {
      if (p === '/api/logout' && method === 'POST') {
        this.revoke(dev.id);
        return this.json(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
      }
      if (method === 'GET') {
        if (p === '/api/info') return this.json(res, 200, a.info());
        if (p === '/api/status') return this.json(res, 200, a.status());
        if (p === '/api/insights') return this.json(res, 200, a.insights());
        if (p === '/api/invoices') {
          const st = (url.searchParams.get('status') ?? 'all') as InvoiceStatus | 'all';
          if (!STATUSES.includes(st)) return this.json(res, 400, { error: 'Status invalid' });
          const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 100) || 100));
          return this.json(res, 200, a.listInvoices(st, limit).map(({ filePath, ...r }) => ({ ...r, hasFile: !!filePath })));
        }
        if (inv && inv[2] === 'file') {
          const r = a.getInvoice(Number(inv[1]));
          if (!r?.filePath || !fs.existsSync(r.filePath)) return this.json(res, 404, { error: 'Fișier inexistent' });
          return this.send(res, fs.readFileSync(r.filePath), r.fileName ?? path.basename(r.filePath), r.fileName?.endsWith('.txt') ? 'text/plain; charset=utf-8' : 'application/pdf', 'inline');
        }
        if (p === '/api/spending') {
          const from = url.searchParams.get('from') ?? '';
          const to = url.searchParams.get('to') ?? '';
          if (!DAY.test(from) || !DAY.test(to) || from > to) return this.json(res, 400, { error: 'Interval invalid' });
          return this.json(res, 200, a.spending(from, to));
        }
        if (p === '/api/tax') {
          const month = url.searchParams.get('month') ?? undefined;
          const year = url.searchParams.get('year') ? Number(url.searchParams.get('year')) : undefined;
          if ((month && !MONTH.test(month)) || (year != null && !(year >= 2019 && year <= 2100))) return this.json(res, 400, { error: 'Perioadă invalidă' });
          return this.json(res, 200, await a.tax({ month, year }));
        }
        if (p === '/api/export') {
          const f = url.searchParams.get('format');
          const from = url.searchParams.get('from') ?? '';
          const to = url.searchParams.get('to') ?? '';
          if ((f !== 'csv' && f !== 'xlsx') || !DAY.test(from) || !DAY.test(to)) return this.json(res, 400, { error: 'Parametri invalizi' });
          const out = a.exportTable(f, from, to);
          return this.send(res, out.data, out.fileName, f === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        }
        if (p === '/api/package') {
          const month = url.searchParams.get('month') ?? '';
          if (!MONTH.test(month)) return this.json(res, 400, { error: 'Lună invalidă' });
          const zip = await a.packageZip(month);
          return this.send(res, fs.readFileSync(zip), path.basename(zip), 'application/zip');
        }
      }
      if (method === 'POST') {
        if (p === '/api/sync') {
          a.sync().catch(() => undefined); // nu ținem telefonul în așteptare
          return this.json(res, 202, { ok: true });
        }
        if (inv && inv[2] === 'approve') {
          const cur = a.getInvoice(Number(inv[1]));
          if (!cur) return this.json(res, 404, { error: 'Factură inexistentă' });
          if (!['awaiting_confirm', 'failed', 'skipped'].includes(cur.status)) return this.json(res, 409, { error: 'Factura nu așteaptă trimitere.' });
          await a.approve(Number(inv[1]));
          return this.json(res, 200, { ok: true, status: a.getInvoice(Number(inv[1]))?.status ?? null });
        }
        if (inv && inv[2] === 'skip') {
          if (!a.getInvoice(Number(inv[1]))) return this.json(res, 404, { error: 'Factură inexistentă' });
          a.skip(Number(inv[1]));
          return this.json(res, 200, { ok: true });
        }
      }
    } catch (e) {
      return this.json(res, 500, { error: (e as Error).message });
    }
    return this.json(res, 404, { error: 'Nu există' });
  }
}
