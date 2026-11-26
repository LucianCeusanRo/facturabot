import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tmpDir } from './helpers';

// Baileys simulat: fiecare makeWASocket întoarce un socket fals controlat din test.
const sockets: any[] = [];
vi.mock('baileys', () => {
  const DisconnectReason = { connectionClosed: 428, connectionLost: 408, connectionReplaced: 440, timedOut: 408, loggedOut: 401, badSession: 500, restartRequired: 515, multideviceMismatch: 411, forbidden: 403, unavailableService: 503 };
  const makeWASocket = vi.fn(() => {
    const ev = new EventEmitter();
    const sock = {
      ev,
      user: { id: '40744000111:3@s.whatsapp.net' },
      onWhatsApp: vi.fn(async (n: string) => (n === '40700000000' ? [{ exists: false, jid: '' }] : [{ exists: true, jid: `${n}@s.whatsapp.net` }])),
      sendMessage: vi.fn(async () => ({ key: { id: 'MSG' } })),
      logout: vi.fn(async () => undefined),
      end: vi.fn(),
    };
    sockets.push(sock);
    return sock;
  });
  return {
    default: makeWASocket,
    DisconnectReason,
    Browsers: { windows: (n: string) => ['Windows', n, '10'] },
    fetchLatestBaileysVersion: vi.fn(async () => ({ version: [2, 3000, 1] })),
    useMultiFileAuthState: vi.fn(async (dir: string) => {
      fs.mkdirSync(dir, { recursive: true });
      return { state: {}, saveCreds: () => fs.writeFileSync(path.join(dir, 'creds.json'), '{}') };
    }),
  };
});

const { WhatsAppWeb } = await import('../src/main/delivery/whatsappWeb');
const close = (code: number, message = '') => ({ connection: 'close', lastDisconnect: { error: Object.assign(new Error(message), { output: { statusCode: code } }) } });
const last = () => sockets[sockets.length - 1];

describe('WhatsApp Web cu Baileys simulat', () => {
  afterEach(() => {
    sockets.length = 0;
    vi.useRealTimers();
  });

  it('QR → conectat → trimite document cu nume curățat', async () => {
    const wa = new WhatsAppWeb(path.join(tmpDir(), 'wa'));
    const states: string[] = [];
    wa.on('state', (s) => states.push(s.status));
    await wa.start();
    last().ev.emit('connection.update', { qr: '2@abc,def' });
    await vi.waitFor(() => expect(wa.getState().status).toBe('qr'));
    expect(wa.getState().qrDataUrl).toMatch(/^data:image\/png;base64,/);
    last().ev.emit('creds.update');
    last().ev.emit('connection.update', { connection: 'open' });
    expect(wa.getState()).toMatchObject({ status: 'connected', me: '40744000111' });
    await wa.sendDocument('0722 123 456', Buffer.from('%PDF'), 'Factură\r\n.pdf', 'Meta · 10 RON');
    expect(last().sendMessage).toHaveBeenCalledWith('40722123456@s.whatsapp.net', expect.objectContaining({ fileName: 'Factură.pdf', mimetype: 'application/pdf', caption: 'Meta · 10 RON' }));
    expect(states).toEqual(['connecting', 'qr', 'connected']);
    expect(wa.hasSession()).toBe(true);
  });

  it('număr fără WhatsApp → eroare clară', async () => {
    const wa = new WhatsAppWeb(path.join(tmpDir(), 'wa'));
    await wa.start();
    last().ev.emit('connection.update', { connection: 'open' });
    await expect(wa.sendDocument('0700000000', Buffer.from('x'), 'a.pdf', 'c')).rejects.toThrow(/nu are cont WhatsApp/);
  });

  it('pornirile simultane creează un singur socket (evită „conflict”)', async () => {
    const wa = new WhatsAppWeb(path.join(tmpDir(), 'wa'));
    await Promise.all([wa.start(), wa.start(), wa.start()]);
    expect(sockets).toHaveLength(1);
  });

  it('515 după QR → reconectare; 401 → sesiune ștearsă, fără buclă', async () => {
    vi.useFakeTimers();
    const dir = path.join(tmpDir(), 'wa');
    const wa = new WhatsAppWeb(dir);
    await wa.start();
    last().ev.emit('creds.update');
    last().ev.emit('connection.update', close(515, 'restart required'));
    await vi.advanceTimersByTimeAsync(600);
    expect(sockets).toHaveLength(2);
    last().ev.emit('connection.update', close(401, 'Connection Failure'));
    expect(wa.getState().status).toBe('logged_out');
    expect(fs.existsSync(dir)).toBe(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sockets).toHaveLength(2); // nu s-a reconectat
  });

  it('rețea instabilă → backoff, apoi „error” după MAX_RECONNECTS', async () => {
    vi.useFakeTimers();
    const wa = new WhatsAppWeb(path.join(tmpDir(), 'wa'));
    await wa.start();
    for (let i = 0; i < 12 && wa.getState().status !== 'error'; i++) {
      last().ev.emit('connection.update', close(428, 'Connection Closed'));
      await vi.advanceTimersByTimeAsync(61_000);
    }
    expect(wa.getState().status).toBe('error');
    expect(sockets.length).toBe(9); // 1 + 8 reîncercări
  });

  it('conflict 440 → stop cu mesaj', async () => {
    const wa = new WhatsAppWeb(path.join(tmpDir(), 'wa'));
    await wa.start();
    last().ev.emit('connection.update', close(440, 'Stream Errored (conflict)'));
    expect(wa.getState()).toMatchObject({ status: 'error' });
    expect(wa.getState().error).toMatch(/altă instanță/);
  });

  it('logout manual șterge sesiunea; stop nu reconectează', async () => {
    const dir = path.join(tmpDir(), 'wa');
    const wa = new WhatsAppWeb(dir);
    await wa.start();
    const s = last();
    await wa.logout();
    expect(s.logout).toHaveBeenCalled();
    expect(fs.existsSync(dir)).toBe(false);
    await wa.start();
    await wa.stop();
    last().ev.emit('connection.update', close(428));
    expect(wa.getState().status).toBe('disconnected');
  });
});
