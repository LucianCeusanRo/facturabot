import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import QRCode from 'qrcode';
import pino from 'pino';
import makeWASocket, { Browsers, DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState, type WASocket } from 'baileys';
import type { WhatsAppWebState } from '../../shared/types.js';
import { normalizePhone } from './phone.js';

export type CloseDecision =
  | { action: 'reconnect'; delayMs: number }
  | { action: 'logged_out'; message: string }
  | { action: 'stop'; message: string };

export const MAX_RECONNECTS = 8;

/**
 * Ce facem când Baileys închide conexiunea (coduri din DisconnectReason):
 * - 515 restartRequired: normal imediat după scanarea QR → reconectare imediată;
 * - 401 loggedOut: sesiune ștearsă de pe telefon → ștergem sesiunea, cerem QR nou (fără buclă);
 * - 440 connectionReplaced („conflict”): altă instanță folosește sesiunea → oprim, nu ne „batem” cu ea;
 * - 403 forbidden: număr restricționat de WhatsApp → oprim;
 * - 408 „QR refs attempts ended”: nimeni n-a scanat codul → oprim, nu generăm QR-uri la nesfârșit;
 * - restul (428, 408, 500, 503…): reconectare cu backoff exponențial, maxim MAX_RECONNECTS încercări.
 */
export function decideOnClose(code: number | undefined, message: string | undefined, retries: number): CloseDecision {
  if (code === DisconnectReason.restartRequired) return { action: 'reconnect', delayMs: 500 };
  if (code === DisconnectReason.loggedOut) return { action: 'logged_out', message: 'Sesiunea WhatsApp a fost deconectată de pe telefon. Scanează din nou codul QR.' };
  if (code === DisconnectReason.connectionReplaced)
    return { action: 'stop', message: 'WhatsApp e deschis în altă instanță FacturaBot/alt program cu aceeași sesiune. Închide-o și apasă „Reconectează”.' };
  if (code === DisconnectReason.forbidden) return { action: 'stop', message: 'WhatsApp a refuzat conexiunea (403). Numărul poate fi restricționat – folosește emailul sau API-ul oficial.' };
  if (/QR refs attempts ended/i.test(message ?? '')) return { action: 'stop', message: 'Codul QR a expirat fără să fie scanat. Apasă din nou „Generează cod QR”.' };
  if (retries >= MAX_RECONNECTS) return { action: 'stop', message: 'Nu mă pot conecta la WhatsApp (rețea?). Reîncerc la următoarea trimitere.' };
  return { action: 'reconnect', delayMs: Math.min(60_000, 2000 * 2 ** retries) };
}

/** Elimină caracterele de control (CR/LF pot injecta metadate) și păstrează diacriticele. */
export function cleanText(s: string, max = 1000, allowNewlines = true) {
  // eslint-disable-next-line no-control-regex
  const re = allowNewlines ? /[\u0000-\u0008\u000b-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g;
  return String(s ?? '').normalize('NFC').replace(re, '').trim().slice(0, max);
}

/**
 * WhatsApp Web (multi-device) prin Baileys.
 * Sesiunea se salvează local (folderul `wa-session` din datele aplicației), deci QR-ul se scanează o singură dată.
 * Telefonul NU trebuie să fie pe același Wi-Fi și nici pornit permanent (multi-device),
 * dar WhatsApp deconectează dispozitivele legate dacă telefonul nu e folosit ~14 zile.
 */
export class WhatsAppWeb extends EventEmitter {
  private sock: WASocket | null = null;
  private state: WhatsAppWebState = { status: 'disconnected' };
  private retries = 0;
  private stopped = true;
  private starting: Promise<void> | null = null;
  private readonly logger = pino({ level: 'silent' });

  constructor(private sessionDir: string) {
    super();
  }

  hasSession(): boolean {
    return fs.existsSync(path.join(this.sessionDir, 'creds.json'));
  }

  getState(): WhatsAppWebState {
    return this.state;
  }

  private setState(s: WhatsAppWebState) {
    this.state = s;
    this.emit('state', s);
  }

  /** Doar pentru modul demo: afișează un cod QR fictiv, fără conexiune la WhatsApp. */
  async simulateQr() {
    const qrDataUrl = await QRCode.toDataURL('2@FacturaBot-demo,' + Math.random().toString(36).slice(2), { margin: 1, width: 320, color: { dark: '#0b1020', light: '#ffffff' } });
    this.setState({ status: 'qr', qrDataUrl });
  }

  /** Doar pentru modul demo / capturi de ecran. */
  simulateConnected(me: string) {
    this.setState({ status: 'connected', me });
  }

  /** Pornește conexiunea. Apeluri simultane împart aceeași pornire (două socket-uri pe aceeași sesiune = „conflict”). */
  start(): Promise<void> {
    if (this.sock && this.state.status !== 'logged_out' && this.state.status !== 'error') return Promise.resolve();
    if (!this.starting) this.starting = this.doStart().finally(() => (this.starting = null));
    return this.starting;
  }

  private async doStart(): Promise<void> {
    this.stopped = false;
    this.setState({ status: 'connecting' });
    fs.mkdirSync(this.sessionDir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir);
    let version: [number, number, number] | undefined;
    try {
      version = (await fetchLatestBaileysVersion()).version as [number, number, number];
    } catch {
      version = undefined;
    }
    const sock = makeWASocket({
      auth: state,
      version,
      logger: this.logger as any,
      browser: Browsers.windows('FacturaBot'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });
    this.sock = sock;
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (u) => {
      if (u.qr) {
        const qrDataUrl = await QRCode.toDataURL(u.qr, { margin: 1, width: 320, color: { dark: '#0b1020', light: '#ffffff' } });
        this.setState({ status: 'qr', qrDataUrl });
      }
      if (u.connection === 'open') {
        this.retries = 0;
        this.stopped = false;
        this.setState({ status: 'connected', me: sock.user?.id?.split(':')[0]?.split('@')[0] });
      }
      if (u.connection === 'close') {
        const err = u.lastDisconnect?.error as any;
        const code: number | undefined = err?.output?.statusCode;
        if (this.sock && this.sock !== sock) return; // eveniment întârziat de la un socket vechi
        this.sock = null;
        if (this.stopped) {
          this.setState({ status: 'disconnected' });
          return;
        }
        const d = decideOnClose(code, err?.message, this.retries);
        if (d.action === 'logged_out') {
          fs.rmSync(this.sessionDir, { recursive: true, force: true });
          this.retries = 0;
          this.setState({ status: 'logged_out', error: d.message });
          return;
        }
        if (d.action === 'stop') {
          this.retries = 0;
          this.stopped = true;
          this.setState({ status: 'error', error: d.message });
          return;
        }
        if (code !== DisconnectReason.restartRequired) this.retries++;
        this.setState({ status: 'connecting' });
        setTimeout(() => this.start().catch((e) => this.setState({ status: 'error', error: String(e) })), d.delayMs);
      }
    });
  }

  async stop() {
    this.stopped = true;
    try {
      this.sock?.end(undefined);
    } catch {
      /* ignorăm */
    }
    this.sock = null;
    this.setState({ status: 'disconnected' });
  }

  async logout() {
    this.stopped = true;
    try {
      await this.sock?.logout();
    } catch {
      /* ignorăm */
    }
    this.sock = null;
    fs.rmSync(this.sessionDir, { recursive: true, force: true });
    this.setState({ status: 'disconnected' });
  }

  /** Așteaptă conexiunea (după pornirea aplicației) cel mult `ms`. */
  async waitConnected(ms = 20_000): Promise<boolean> {
    if (this.state.status === 'connected') return true;
    if (!this.sock) {
      // Fără sesiune salvată nu are rost să așteptăm: trebuie scanat codul QR.
      if (!this.hasSession()) return false;
      await this.start();
    }
    if (this.getState().status === 'connected') return true;
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.off('state', onState);
        resolve(false);
      }, ms);
      const onState = (s: WhatsAppWebState) => {
        if (s.status === 'connected' || s.status === 'logged_out' || s.status === 'qr' || s.status === 'error') {
          clearTimeout(t);
          this.off('state', onState);
          resolve(s.status === 'connected');
        }
      };
      this.on('state', onState);
    });
  }

  private async jidFor(phone: string): Promise<string> {
    const n = normalizePhone(phone);
    const res = await this.sock!.onWhatsApp(n);
    const hit = res?.[0];
    if (!hit?.exists) throw new Error(`Numărul ${n} nu are cont WhatsApp`);
    return hit.jid;
  }

  async sendDocument(phone: string, data: Buffer, fileName: string, caption: string, mimetype = 'application/pdf') {
    if (!(await this.waitConnected())) throw new Error(this.state.error || 'WhatsApp Web nu este conectat');
    const jid = await this.jidFor(phone);
    await this.sock!.sendMessage(jid, { document: data, mimetype, fileName: cleanText(fileName, 200, false) || 'factura.pdf', caption: cleanText(caption) });
  }

  async sendText(phone: string, text: string) {
    if (!(await this.waitConnected())) throw new Error('WhatsApp Web nu este conectat');
    const jid = await this.jidFor(phone);
    await this.sock!.sendMessage(jid, { text });
  }
}
