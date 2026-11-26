import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SettingsStore } from '../src/main/config';
import { Db } from '../src/main/db';
import { SecretStore } from '../src/main/secrets';
import { SyncEngine } from '../src/main/sync';
import type { InvoiceSource } from '../src/main/sources/types';

const plainCipher = { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() };

function setup(opts: { waFails?: boolean; confirm?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-test-'));
  const settings = new SettingsStore(dir);
  settings.update({
    onboardingDone: true,
    confirmBeforeSend: !!opts.confirm,
    accountant: { name: 'Ana', whatsappNumber: '0722123456', email: 'ana@cabinet.ro' },
    delivery: { whatsappMode: 'web', emailFallback: true, emailProvider: 'gmail' },
    oauthClients: { googleClientId: 'cid' },
  });
  const secrets = new SecretStore(dir, plainCipher);
  secrets.setJson('google.tokens', { access_token: 'AT', refresh_token: 'RT', expires_at: Date.now() + 3600_000 });
  const waWeb = {
    sendDocument: vi.fn(async () => {
      if (opts.waFails) throw new Error('WhatsApp Web nu este conectat');
    }),
  };
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.includes('/messages/send')) return new Response('{"id":"x"}', { status: 200 });
    return new Response('{}', { status: 404 });
  });
  const pdf = Buffer.from('%PDF-1.4 test invoice');
  const source: InvoiceSource = {
    id: 'fake',
    label: 'Fake',
    isEnabled: () => true,
    fetchNew: async (ctx) =>
      [
        { externalId: 'm1:a', vendor: 'Meta', fileName: 'Meta.pdf', data: pdf, seriesNumber: 'FB-1001', amount: 10, currency: 'RON' },
        { externalId: 'm2:a', vendor: 'Meta', fileName: 'Meta-copy.pdf', data: pdf }, // același conținut → duplicat (hash)
        { externalId: 'm3:a', vendor: 'META',  fileName: 'g.pdf', data: Buffer.from('%PDF other'), seriesNumber: 'fb 1001' }, // aceeași serie → duplicat
      ].filter((d) => !ctx.isKnown(d.externalId)),
  };
  return { dir, settings, secrets, waWeb, fetchMock, source };
}

describe('SyncEngine', () => {
  let s: ReturnType<typeof setup>;

  it('trimite pe WhatsApp și deduplică (hash + serie)', async () => {
    s = setup();
    const db = await Db.open(path.join(s.dir, 'db.sqlite'));
    const engine = new SyncEngine({ db, settings: s.settings, secrets: s.secrets, waWeb: s.waWeb as any, dataDir: s.dir, sources: [s.source], fetch: s.fetchMock as any });
    await engine.runOnce();
    const all = db.listInvoices();
    expect(all.filter((i) => i.status === 'sent')).toHaveLength(1);
    expect(all.filter((i) => i.status === 'duplicate')).toHaveLength(2);
    expect(s.waWeb.sendDocument).toHaveBeenCalledTimes(1);
    expect((s.waWeb.sendDocument.mock.calls[0] as any[])[0]).toBe('0722123456');
    // a doua rulare nu mai trimite nimic
    await engine.runOnce();
    expect(s.waWeb.sendDocument).toHaveBeenCalledTimes(1);
    // persistență: redeschidem DB-ul
    const db2 = await Db.open(path.join(s.dir, 'db.sqlite'));
    expect(db2.stats().sent).toBe(1);
  });

  it('cade pe email (Gmail API) când WhatsApp eșuează', async () => {
    s = setup({ waFails: true });
    const db = await Db.open(null);
    const engine = new SyncEngine({ db, settings: s.settings, secrets: s.secrets, waWeb: s.waWeb as any, dataDir: s.dir, sources: [s.source], fetch: s.fetchMock as any });
    await engine.runOnce();
    const sent = db.listInvoices('sent');
    expect(sent).toHaveLength(1);
    expect(sent[0].channel).toBe('email');
    expect(sent[0].error).toMatch(/Backup email/);
    const call = s.fetchMock.mock.calls.find((c) => String(c[0]).includes('/messages/send'))!;
    const raw = Buffer.from(JSON.parse((call[1] as any).body).raw, 'base64url').toString();
    expect(raw).toContain('To: ana@cabinet.ro');
    expect(raw).toContain('Meta.pdf');
  });

  it('cu „confirmă înainte” așteaptă aprobarea', async () => {
    s = setup({ confirm: true });
    const db = await Db.open(null);
    const engine = new SyncEngine({ db, settings: s.settings, secrets: s.secrets, waWeb: s.waWeb as any, dataDir: s.dir, sources: [s.source], fetch: s.fetchMock as any });
    await engine.runOnce();
    const waiting = db.listInvoices('awaiting_confirm');
    expect(waiting).toHaveLength(1);
    expect(s.waWeb.sendDocument).not.toHaveBeenCalled();
    await engine.approve(waiting[0].id);
    expect(s.waWeb.sendDocument).toHaveBeenCalledTimes(1);
    expect(db.getInvoice(waiting[0].id)?.status).toBe('sent');
  });
});

describe('SecretStore', () => {
  it('criptează cu cipher-ul furnizat', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-sec-'));
    const enc = { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s.split('').reverse().join('')), decryptString: (b: Buffer) => b.toString().split('').reverse().join('') };
    const st = new SecretStore(dir, enc);
    st.set('fgo.apiKey', 'secret-123');
    expect(fs.readFileSync(path.join(dir, 'secrets.bin.json'), 'utf8')).not.toContain('secret-123');
    expect(new SecretStore(dir, enc).get('fgo.apiKey')).toBe('secret-123');
  });
});
