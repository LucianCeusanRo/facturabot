import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { StatusSnapshot } from '../shared/types.js';
import { settingsProblems, type SettingsStore } from './config.js';
import type { Db } from './db.js';
import { deliver } from './delivery/dispatcher.js';
import type { WhatsAppWeb } from './delivery/whatsappWeb.js';
import type { SecretStore } from './secrets.js';
import { AuthExpiredError, type RetryOptions } from './http.js';
import { SOURCES } from './sources/registry.js';
import { sanitizeFileName } from './sources/classify.js';
import type { FoundDocument, InvoiceSource } from './sources/types.js';

export interface EngineDeps {
  db: Db;
  settings: SettingsStore;
  secrets: SecretStore;
  waWeb: WhatsAppWeb;
  dataDir: string;
  htmlToPdf?: (html: string) => Promise<Buffer>;
  notify?: (title: string, body: string) => void;
  onChange?: () => void;
  sources?: InvoiceSource[];
  fetch?: typeof fetch;
  retry?: RetryOptions;
  sleep?: (ms: number) => Promise<void>;
}

const escapeHtml = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

export function describe(inv: { vendor?: string | null; seriesNumber?: string | null; amount?: number | null; currency?: string | null; invoiceDate?: string | null; subject?: string | null }) {
  const parts = [inv.vendor || inv.subject || 'Factură'];
  if (inv.seriesNumber) parts.push(`nr. ${inv.seriesNumber}`);
  if (inv.amount != null) parts.push(`${inv.amount.toLocaleString('ro-RO', { minimumFractionDigits: 2 })} ${inv.currency ?? 'RON'}`);
  if (inv.invoiceDate) parts.push(inv.invoiceDate);
  return parts.join(' · ');
}

export class SyncEngine {
  syncing = false;
  lastSync: Date | null = null;
  nextSync: Date | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private d: EngineDeps) {
    const ls = d.db.getKv('lastSync');
    this.lastSync = ls ? new Date(ls) : null;
  }

  private log(level: 'info' | 'warn' | 'error' | 'success', msg: string) {
    this.d.db.log(level, msg);
    this.d.onChange?.();
  }

  schedule() {
    if (this.timer) clearTimeout(this.timer);
    const ms = this.d.settings.get().pollMinutes * 60_000;
    this.nextSync = new Date(Date.now() + ms);
    this.timer = setTimeout(async () => {
      await this.runOnce().catch(() => undefined);
      this.schedule();
    }, ms);
    this.d.onChange?.();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<void> {
    if (this.syncing) return;
    const settings = this.d.settings.get();
    this.syncing = true;
    this.d.onChange?.();
    let found = 0;
    try {
      for (const src of this.d.sources ?? SOURCES) {
        if (!src.isEnabled(settings, this.d.secrets)) continue;
        const key = `cursor:${src.id}`;
        const prev = this.d.db.getKv(key);
        // Suprapunere de 2 zile – deduplicarea elimină ce am văzut deja.
        const since = prev ? new Date(new Date(prev).getTime() - 2 * 86400_000) : new Date(Date.now() - settings.lookbackDays * 86400_000);
        const started = new Date();
        try {
          const docs = await src.fetchNew({
            settings,
            secrets: this.d.secrets,
            since,
            log: (l, m) => this.log(l, m),
            isKnown: (id) => this.d.db.findDuplicate({ source: src.id, externalId: id }) !== null,
            htmlToPdf: this.d.htmlToPdf,
            fetch: this.d.fetch ?? fetch,
            retry: this.d.retry,
          });
          for (const doc of docs) if (await this.ingest(src.id, doc)) found++;
          this.d.db.setKv(key, started.toISOString());
        } catch (e) {
          this.log('error', `${src.label}: ${(e as Error).message}`);
          if (e instanceof AuthExpiredError) {
            this.d.notify?.(`Reconectează ${src.label}`, e.message);
            this.d.onChange?.();
          }
        }
      }
      if (found) this.log('info', `Am găsit ${found} documente noi`);
      await this.processQueue();
      this.lastSync = new Date();
      this.d.db.setKv('lastSync', this.lastSync.toISOString());
    } finally {
      this.syncing = false;
      this.d.onChange?.();
    }
  }

  /** Salvează documentul local și îl pune în coadă. Returnează false dacă e duplicat. */
  async ingest(sourceId: string, doc: FoundDocument): Promise<boolean> {
    const settings = this.d.settings.get();
    let data = doc.data ?? null;
    let fileName = doc.fileName ?? null;
    if (!data && doc.summary) {
      if (this.d.htmlToPdf) {
        data = await this.d.htmlToPdf(
          `<div style="font:15px/1.6 Segoe UI,sans-serif;padding:32px;white-space:pre-wrap">${escapeHtml(doc.summary)}</div>`,
        );
        fileName = sanitizeFileName(`${(doc.vendor ?? 'document').slice(0, 40)}_${doc.seriesNumber ?? doc.externalId}.pdf`);
      } else {
        data = Buffer.from(doc.summary, 'utf8');
        fileName = sanitizeFileName(`${doc.externalId}.txt`);
      }
    }
    const fileHash = data ? crypto.createHash('sha256').update(data).digest('hex') : null;
    const dup = this.d.db.findDuplicate({ source: sourceId, externalId: doc.externalId, fileHash, seriesNumber: doc.seriesNumber, vendor: doc.vendor });
    if (dup) {
      if (dup !== 'external_id') {
        this.d.db.insertInvoice({ ...doc, source: sourceId, fileHash, fileName, filePath: null, status: 'duplicate' });
        this.log('info', `Duplicat ignorat (${dup}): ${doc.fileName ?? doc.subject}`);
      }
      return false;
    }
    let filePath: string | null = null;
    if (data && fileName) {
      const month = new Date().toISOString().slice(0, 7);
      const dir = path.join(this.d.dataDir, 'facturi', month);
      fs.mkdirSync(dir, { recursive: true });
      filePath = path.join(dir, `${fileHash!.slice(0, 8)}_${fileName}`);
      fs.writeFileSync(filePath, data);
    }
    const id = this.d.db.insertInvoice({
      source: sourceId,
      externalId: doc.externalId,
      fileHash,
      seriesNumber: doc.seriesNumber,
      vendor: doc.vendor,
      subject: doc.subject,
      fileName,
      filePath,
      amount: doc.amount,
      currency: doc.currency,
      invoiceDate: doc.invoiceDate,
      status: settings.confirmBeforeSend ? 'awaiting_confirm' : 'pending',
    });
    if (settings.confirmBeforeSend) this.d.notify?.('Factură nouă de confirmat', describe(doc));
    return id > 0;
  }

  private queueLock: Promise<void> = Promise.resolve();

  /**
   * Trimite tot ce e „pending” (+ reîncearcă eșuatele recente, cu limită de încercări).
   * Rulează serializat: sincronizarea automată, „Trimite” și „Reîncearcă” nu pot trimite
   * aceeași factură de două ori în paralel.
   */
  processQueue(): Promise<void> {
    const run = this.queueLock.then(() => this.processQueueInner());
    this.queueLock = run.catch(() => undefined);
    return run;
  }

  private async processQueueInner() {
    const settings = this.d.settings.get();
    const { maxAttempts, retryWindowDays, waDelaySeconds } = settings.delivery;
    const cutoff = Date.now() - retryWindowDays * 86400_000;
    const queue = [
      ...this.d.db.listInvoices('pending', 100),
      ...this.d.db.listInvoices('failed', 100).filter((i) => new Date(i.createdAt).getTime() > cutoff && i.attempts < maxAttempts),
    ].sort((a, b) => a.id - b.id);
    const sleep = this.d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let sent = 0;
    let usedWhatsApp = false;
    for (const inv of queue) {
      // Recitim starea: între timp utilizatorul poate fi apăsat „Ignoră”.
      const cur = this.d.db.getInvoice(inv.id);
      if (!cur || (cur.status !== 'pending' && cur.status !== 'failed')) continue;
      if (!inv.filePath || !fs.existsSync(inv.filePath)) {
        this.d.db.setStatus(inv.id, 'failed', { error: 'Fișierul local lipsește' });
        continue;
      }
      // Pauză între mesaje WhatsApp – trimiterile în rafală cresc riscul de restricționare.
      if (usedWhatsApp && settings.delivery.whatsappMode !== 'none' && waDelaySeconds > 0) await sleep(waDelaySeconds * 1000);
      this.d.db.markSending(inv.id);
      try {
        const data = fs.readFileSync(inv.filePath);
        const res = await deliver(
          {
            data,
            fileName: inv.fileName ?? path.basename(inv.filePath),
            mimeType: inv.fileName?.endsWith('.txt') ? 'text/plain' : 'application/pdf',
            description: describe(inv),
          },
          { settings, secrets: this.d.secrets, waWeb: this.d.waWeb, log: (l, m) => this.log(l, m), fetch: this.d.fetch },
        );
        usedWhatsApp = res.channel !== 'email';
        this.d.db.setStatus(inv.id, 'sent', { channel: res.channel, error: res.fallbackReason ? `Backup email (WhatsApp: ${res.fallbackReason})` : null });
        this.log('success', `Trimis pe ${labelChannel(res.channel)}: ${describe(inv)}`);
        sent++;
      } catch (e) {
        const attempts = (this.d.db.getInvoice(inv.id)?.attempts ?? 0);
        const final = attempts >= maxAttempts;
        this.d.db.setStatus(inv.id, 'failed', { error: (e as Error).message });
        this.log('error', `Nu am putut trimite ${describe(inv)}: ${(e as Error).message}${final ? ' (am renunțat după ' + attempts + ' încercări)' : ''}`);
        if (final) this.d.notify?.('Factură netrimisă', `${describe(inv)} – ${(e as Error).message}`);
      }
      this.d.onChange?.();
    }
    if (sent) this.d.notify?.('FacturaBot', `${sent} ${sent === 1 ? 'factură trimisă' : 'facturi trimise'} la contabilă`);
  }

  async approve(id: number) {
    this.d.db.resetAttempts(id);
    this.d.db.setStatus(id, 'pending');
    await this.processQueue();
    this.d.onChange?.();
  }

  snapshot(waStatus: StatusSnapshot['connections']['whatsappWeb']): StatusSnapshot {
    const s = this.d.settings.get();
    const sec = this.d.secrets;
    return {
      syncing: this.syncing,
      lastSync: this.lastSync?.toISOString() ?? null,
      nextSync: this.nextSync?.toISOString() ?? null,
      connections: {
        gmail: sec.has('google.tokens'),
        outlook: sec.has('microsoft.tokens'),
        fgo: !!s.sources.fgo.codUnic && sec.has('fgo.apiKey'),
        whatsappWeb: waStatus,
        whatsappCloud: !!s.delivery.cloud.phoneNumberId && sec.has('whatsapp.cloudToken'),
        smtp: !!s.delivery.smtp.host && sec.has('smtp.password'),
      },
      stats: this.d.db.stats(),
      problems: settingsProblems(s),
    };
  }
}

export function labelChannel(c: string) {
  return c === 'whatsapp-web' ? 'WhatsApp Web' : c === 'whatsapp-cloud' ? 'WhatsApp Business API' : 'email';
}
