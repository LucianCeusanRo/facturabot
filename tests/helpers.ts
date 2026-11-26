import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
