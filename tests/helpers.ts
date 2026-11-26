import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { vi } from 'vitest';
import { SettingsStore } from '../src/main/config';
import { SecretStore } from '../src/main/secrets';
import type { DeepPartial, Settings } from '../src/shared/types';

export const plainCipher = { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() };
export const noSleep = { sleep: async () => undefined, baseDelayMs: 1 };

export function tmpDir(prefix = 'fb-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function makeEnv(patch: DeepPartial<Settings> = {}) {
  const dir = tmpDir();
  const settings = new SettingsStore(dir);
  settings.update({
    onboardingDone: true,
    accountant: { name: 'Ana', whatsappNumber: '0722123456', email: 'ana@cabinet.ro' },
    delivery: { whatsappMode: 'web', emailFallback: true, emailProvider: 'gmail', waDelaySeconds: 0 },
    oauthClients: { googleClientId: 'cid', microsoftClientId: 'mcid' },
  });
  settings.update(patch);
  const secrets = new SecretStore(dir, plainCipher);
  secrets.setJson('google.tokens', { access_token: 'AT', refresh_token: 'RT', expires_at: Date.now() + 3600_000, account: 'eu@firma.ro' });
  return { dir, settings, secrets };
}

export type Route = (url: string, init?: RequestInit) => Response | undefined | Promise<Response | undefined>;

/** fetch fals: prima rută care răspunde câștigă; altfel 404. Înregistrează toate apelurile. */
export function fakeFetch(...routes: Route[]) {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    for (const r of routes) {
      const res = await r(u, init);
      if (res) return res;
    }
    return new Response(JSON.stringify({ error: 'not found: ' + u }), { status: 404 });
  });
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64url');

/** Cititor ZIP minimal pentru teste (director central + inflate). */
export function readZip(buf: Buffer): Record<string, Buffer> {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: Record<string, Buffer> = {};
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    const lnlen = buf.readUInt16LE(local + 26);
    const data = buf.subarray(local + 30 + lnlen, local + 30 + lnlen + csize);
    out[name] = method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data);
    p += 46 + nlen;
  }
  return out;
}

import type { InvoiceRecord } from '../src/shared/types';

let invSeq = 0;
/** InvoiceRecord complet pentru teste de calcul. */
export function inv(p: Partial<InvoiceRecord> = {}): InvoiceRecord {
  invSeq++;
  return {
    id: invSeq,
    source: 'gmail',
    externalId: `e${invSeq}`,
    fileHash: null,
    seriesNumber: null,
    vendor: 'Furnizor',
    subject: null,
    fileName: null,
    filePath: null,
    amount: 100,
    currency: 'RON',
    invoiceDate: '2026-11-10',
    direction: 'in',
    platform: null,
    supplierCountry: null,
    supplierVatId: null,
    vatTreatment: 'unknown',
    dueDate: null,
    paid: null,
    amountRon: null,
    fxRate: null,
    status: 'sent',
    channel: null,
    error: null,
    attempts: 0,
    createdAt: '2026-11-10T10:00:00.000Z',
    sentAt: null,
    ...p,
  };
}

/** XML în formatul BNR (nbrfxrates*.xml). */
export const bnrXml = (cubes: Record<string, Record<string, string>>) =>
  `<?xml version="1.0" encoding="utf-8"?><DataSet xmlns="http://www.bnr.ro/xsd"><Body><Subject>Reference rates</Subject><OrigCurrency>RON</OrigCurrency>${Object.entries(cubes)
    .map(([d, rates]) => `<Cube date="${d}">${Object.entries(rates).map(([c, v]) => (c === 'HUF' ? `<Rate currency="HUF" multiplier="100">${v}</Rate>` : `<Rate currency="${c}">${v}</Rate>`)).join('')}</Cube>`)
    .join('')}</Body></DataSet>`;
