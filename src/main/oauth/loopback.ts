import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';

export function base64url(buf: Buffer) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function makePkce() {
  const verifier = base64url(crypto.randomBytes(48));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

const DONE_HTML = (ok: boolean, msg: string) => `<!doctype html><html lang="ro"><meta charset="utf-8"><title>FacturaBot</title>
<body style="font-family:Segoe UI,system-ui,sans-serif;background:#0b1020;color:#e8ecf8;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><div style="font-size:56px">${ok ? 'OK' : '!'}</div><h2>${msg}</h2><p style="opacity:.7">Poți închide această filă și reveni în FacturaBot.</p></div></body></html>`;

/**
 * Flux OAuth „loopback” pentru aplicații desktop (RFC 8252): pornim un server local pe 127.0.0.1,
 * deschidem browserul, primim `code` înapoi.
 */
export async function runLoopbackAuth(opts: {
  buildAuthUrl: (redirectUri: string, state: string) => string;
  openBrowser: (url: string) => void | Promise<void>;
  host?: '127.0.0.1' | 'localhost';
  timeoutMs?: number;
}): Promise<{ code: string; redirectUri: string }> {
  const state = base64url(crypto.randomBytes(16));
  const host = opts.host ?? '127.0.0.1';
  return new Promise((resolve, reject) => {
    let redirectUri = '';
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${host}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get('code');
      const err = url.searchParams.get('error');
      const ok = !!code && url.searchParams.get('state') === state;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(DONE_HTML(ok, ok ? 'Cont conectat cu succes' : 'Conectarea a eșuat'));
      clearTimeout(timer);
      server.close();
      if (ok) resolve({ code: code!, redirectUri });
      else reject(new Error(err || 'Răspuns OAuth invalid'));
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('Timpul de autentificare a expirat'));
    }, opts.timeoutMs ?? 5 * 60_000);
    server.listen(0, '127.0.0.1', async () => {
      const port = (server.address() as AddressInfo).port;
      redirectUri = `http://${host}:${port}/callback`;
      try {
        await opts.openBrowser(opts.buildAuthUrl(redirectUri, state));
      } catch (e) {
        clearTimeout(timer);
        server.close();
        reject(e);
      }
    });
  });
}
