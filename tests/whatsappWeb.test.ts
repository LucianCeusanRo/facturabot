import fs from 'node:fs';
import path from 'node:path';
import { DisconnectReason } from 'baileys';
import { describe, expect, it } from 'vitest';
import { cleanText, decideOnClose, MAX_RECONNECTS, WhatsAppWeb } from '../src/main/delivery/whatsappWeb';
import { tmpDir } from './helpers';

describe('WhatsApp Web – decizii la deconectare', () => {
  it('515 după scanarea QR → reconectare imediată', () => {
    expect(decideOnClose(DisconnectReason.restartRequired, 'restart required', 0)).toEqual({ action: 'reconnect', delayMs: 500 });
  });
  it('401 logout de pe telefon → cere QR nou, fără buclă', () => {
    expect(decideOnClose(DisconnectReason.loggedOut, 'Connection Failure', 0).action).toBe('logged_out');
  });
  it('440 conflict (altă instanță) → stop', () => {
    expect(decideOnClose(DisconnectReason.connectionReplaced, 'Stream Errored (conflict)', 0).action).toBe('stop');
  });
  it('403 → stop', () => {
    expect(decideOnClose(DisconnectReason.forbidden, '', 0).action).toBe('stop');
  });
  it('QR nescanat → stop (nu generăm QR-uri la infinit)', () => {
    expect(decideOnClose(408, 'QR refs attempts ended', 0).action).toBe('stop');
  });
  it('rețea căzută → backoff exponențial plafonat, apoi stop', () => {
    const d1 = decideOnClose(DisconnectReason.connectionLost, 'Connection was lost', 0);
    const d3 = decideOnClose(DisconnectReason.connectionClosed, '', 3);
    expect(d1).toEqual({ action: 'reconnect', delayMs: 2000 });
    expect(d3).toEqual({ action: 'reconnect', delayMs: 16000 });
    expect((decideOnClose(500, '', 7) as any).delayMs).toBeLessThanOrEqual(60_000);
    expect(decideOnClose(500, '', MAX_RECONNECTS).action).toBe('stop');
  });
});

describe('WhatsApp Web – trimitere', () => {
  it('fără sesiune salvată eșuează imediat (fallback rapid pe email)', async () => {
    const wa = new WhatsAppWeb(path.join(tmpDir(), 'wa-session'));
    const t0 = Date.now();
    await expect(wa.sendDocument('0722123456', Buffer.from('%PDF'), 'f.pdf', 'x')).rejects.toThrow(/nu este conectat/);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('hasSession citește creds.json', () => {
    const dir = path.join(tmpDir(), 'wa');
    const wa = new WhatsAppWeb(dir);
    expect(wa.hasSession()).toBe(false);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'creds.json'), '{}');
    expect(wa.hasSession()).toBe(true);
  });

  it('cleanText păstrează diacriticele și elimină caracterele de control', () => {
    expect(cleanText('Factură\r\nX-Injected: da\u0000.pdf', 200, false)).toBe('FacturăX-Injected: da.pdf');
    expect(cleanText('rând 1\nrând 2\u0007')).toBe('rând 1\nrând 2'); // caption: păstrăm rândurile
    expect(cleanText('S\u0326')).toBe('Ș'); // NFD → NFC
    expect(cleanText('a'.repeat(50), 10)).toHaveLength(10);
  });
});
