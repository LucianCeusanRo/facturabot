import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, deepMerge, isValidEmail, sanitizeSettings, SettingsStore, settingsProblems } from '../src/main/config';
import { tmpDir } from './helpers';

describe('setări', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('valori implicite sănătoase', () => {
    const s = new SettingsStore(tmpDir()).get();
    expect(s.pollMinutes).toBe(20);
    expect(s.delivery.maxAttempts).toBe(5);
    expect(s.detection.minScore).toBe(3);
    expect(s.delivery.whatsappMode).toBe('web');
    expect(s.delivery.emailFallback).toBe(true);
  });

  it('limitează valorile numerice și curăță listele', () => {
    const st = new SettingsStore(tmpDir());
    const s = st.update({
      pollMinutes: 1,
      lookbackDays: 9999,
      detection: { minScore: 50, extraSenders: [' Furnizor.RO ', 'furnizor.ro', ''], maxAttachmentMB: -3 },
      delivery: { waDelaySeconds: Number.NaN, maxAttempts: 0, smtp: { port: 99999 } },
      sources: { fgo: { codUnic: 'RO 123 456', apiBase: 'http://insecure' } },
    });
    expect(s.pollMinutes).toBe(5);
    expect(s.lookbackDays).toBe(365);
    expect(s.detection.minScore).toBe(8);
    expect(s.detection.maxAttachmentMB).toBe(1);
    expect(s.detection.extraSenders).toEqual(['furnizor.ro']);
    expect(s.delivery.waDelaySeconds).toBe(DEFAULT_SETTINGS.delivery.waDelaySeconds);
    expect(s.delivery.maxAttempts).toBe(1);
    expect(s.delivery.smtp.port).toBe(65535);
    expect(s.sources.fgo.codUnic).toBe('123456');
    expect(s.sources.fgo.apiBase).toBe('https://api.fgo.ro');
  });

  it('enum-uri necunoscute revin la implicit', () => {
    const s = sanitizeSettings(deepMerge(DEFAULT_SETTINGS, { theme: 'neon' as any, delivery: { whatsappMode: 'sms' as any, emailProvider: 'yahoo' as any } }));
    expect(s.theme).toBe('system');
    expect(s.delivery.whatsappMode).toBe('web');
    expect(s.delivery.emailProvider).toBe('gmail');
  });

  it('persistă atomic și reîncarcă; fișier corupt → implicit', () => {
    const dir = tmpDir();
    new SettingsStore(dir).update({ accountant: { email: 'a@b.ro' } });
    expect(new SettingsStore(dir).get().accountant.email).toBe('a@b.ro');
    expect(fs.existsSync(path.join(dir, 'settings.json.tmp'))).toBe(false);
    fs.writeFileSync(path.join(dir, 'settings.json'), '{ nu e json');
    expect(new SettingsStore(dir).get().accountant.email).toBe('');
  });

  it('variabile de mediu pentru build (client ID, interval)', async () => {
    vi.stubEnv('FACTURABOT_GOOGLE_CLIENT_ID', 'env-client.apps.googleusercontent.com');
    vi.stubEnv('FACTURABOT_POLL_MINUTES', '25');
    vi.resetModules();
    const m = await import('../src/main/config');
    const s = new m.SettingsStore(tmpDir()).get();
    expect(s.oauthClients.googleClientId).toBe('env-client.apps.googleusercontent.com');
    expect(s.pollMinutes).toBe(25);
  });

  it('probleme de configurare', () => {
    const base = structuredClone(DEFAULT_SETTINGS);
    expect(settingsProblems(base)).toContain('Adaugă WhatsApp-ul sau emailul contabilei.');
    base.accountant.email = 'nu-e-email';
    base.accountant.whatsappNumber = '12';
    const p = settingsProblems(base);
    expect(p.join(' ')).toMatch(/Emailul contabilei/);
    expect(p.join(' ')).toMatch(/Numărul de WhatsApp/);
    base.accountant = { name: '', email: 'ana@cabinet.ro', whatsappNumber: '0722123456' };
    expect(settingsProblems(base)).toEqual([]);
    expect(isValidEmail('ana@cabinet.ro')).toBe(true);
  });
});
