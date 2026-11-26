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
import { extractPdfText, sanitizeFileName } from './sources/classify.js';
import type { FoundDocument, InvoiceSource } from './sources/types.js';
import { platformOf } from './analytics.js';
import { sendEmail } from './delivery/email.js';
import { buildAccountantPackage, isMonth, previousMonth } from './export/package.js';
import { monthLabel } from './export/report.js';
import type { Finance } from './finance.js';
import { parseReceipt } from './parsers/amounts.js';
import { classifyVat } from './tax/vat.js';

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
  finance?: Finance;
  now?: () => Date;
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
      await this.afterSync();
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
    // Îmbogățire pe reguli: sumă (dacă sursa n-a dat-o), platformă, tratament TVA.
    let text = doc.text ?? null;
    if (!text && data && (doc.mimeType ?? fileName ?? '').toLowerCase().includes('pdf')) text = extractPdfText(data);
    let amount = doc.amount ?? null;
    let currency = doc.currency ?? null;
    if (amount == null && (text || doc.summary)) {
      const f = parseReceipt({ from: doc.vendor ?? '', subject: doc.subject ?? '', text: `${text ?? ''}\n${doc.summary ?? ''}` });
      amount = f.amount;
      currency = f.currency;
    }
    const vat = classifyVat({
      vendor: doc.vendor,
      text: `${text ?? ''}\n${doc.summary ?? ''}`,
      supplierCountry: doc.supplierCountry,
      supplierVatId: doc.supplierVatId,
      direction: doc.direction ?? 'in',
      ownCountry: settings.company.country,
      ownIds: [settings.sources.fgo.codUnic ?? ''].filter(Boolean),
    });
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
      amount,
      currency: amount != null ? (currency ?? 'RON') : currency,
      invoiceDate: doc.invoiceDate,
      direction: doc.direction ?? 'in',
      platform: doc.platform ?? platformOf({ platform: null, vendor: doc.vendor ?? null, source: sourceId }),
      supplierCountry: vat.supplierCountry,
      supplierVatId: vat.supplierVatId,
      vatTreatment: vat.treatment,
      dueDate: doc.dueDate ?? null,
      paid: doc.paid ?? null,
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

  /** După fiecare sincronizare: curs BNR, venituri FGO, alerte, raport lunar. Erorile nu opresc trimiterea. */
  async afterSync() {
    const f = this.d.finance;
    if (!f) return;
    await f.convertPending().catch((e) => this.log('warn', `Curs BNR indisponibil: ${(e as Error).message}`));
    await f.refreshRevenue().catch((e) => this.log('warn', `Venituri FGO: ${(e as Error).message}`));
    try {
      f.checkAlerts();
    } catch {
      /* alertele nu sunt critice */
    }
    const s = this.d.settings.get();
    const now = (this.d.now ?? (() => new Date()))();
    if (s.reports.monthlyEnabled && now.getDate() >= s.reports.dayOfMonth) {
      const month = previousMonth(now);
      if (!this.d.db.getKv(`report:${month}`)) {
        try {
          const r = await this.sendMonthlyPackage(month);
          this.d.db.setKv(`report:${month}`, now.toISOString());
          this.log('success', `Raportul lunar ${monthLabel(month)} a fost trimis (${r.sentVia}).`);
        } catch (e) {
          this.log('error', `Raportul lunar ${month}: ${(e as Error).message}`);
        }
      }
    }
  }

  /** Construiește „pachetul pentru contabil” și trimite raportul PDF (+ ZIP pe email, dacă e configurat). */
  async sendMonthlyPackage(month: string, send = true): Promise<{ zipPath: string; sentVia: string }> {
    if (!this.d.finance) throw new Error('Modulul financiar nu e disponibil');
    if (!isMonth(month)) throw new Error('Lună invalidă');
    const settings = this.d.settings.get();
    const pkg = await buildAccountantPackage({ db: this.d.db, finance: this.d.finance, settings, dataDir: this.d.dataDir, month, htmlToPdf: this.d.htmlToPdf });
    if (!send) return { zipPath: pkg.zipPath, sentVia: 'local' };
    const label = `Raport lunar ${monthLabel(month)} (${pkg.count} facturi)`;
    const via: string[] = [];
    if (pkg.reportPdf) {
      const r = await deliver(
        { data: pkg.reportPdf, fileName: pkg.reportName, mimeType: 'application/pdf', description: label },
        { settings, secrets: this.d.secrets, waWeb: this.d.waWeb, log: (l, m) => this.log(l, m), fetch: this.d.fetch },
      );
      via.push(labelChannel(r.channel));
    }
    const zip = fs.readFileSync(pkg.zipPath);
    if (settings.accountant.email && zip.length <= 20 * 1024 * 1024) {
      try {
        await sendEmail(
          settings,
          this.d.secrets,
          {
            to: settings.accountant.email,
            subject: `[FacturaBot] Pachet ${monthLabel(month)}`,
            text: `Bună ziua${settings.accountant.name ? ' ' + settings.accountant.name : ''},\n\nAtașat găsiți pachetul pentru ${monthLabel(month)}: toate facturile, raportul PDF și tabelul (CSV + Excel).\n\nMesaj trimis automat de FacturaBot.`,
            attachment: { fileName: path.basename(pkg.zipPath), data: zip, mimeType: 'application/zip' },
          },
          this.d.fetch,
        );
        via.push('email (ZIP)');
      } catch (e) {
        this.log('warn', `Pachetul ZIP nu a plecat pe email: ${(e as Error).message}`);
      }
    }
    if (!via.length) throw new Error('Nu am putut trimite raportul pe niciun canal');
    return { zipPath: pkg.zipPath, sentVia: via.join(' + ') };
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
        meta: s.sources.meta.enabled && !!s.sources.meta.businessId && sec.has('meta.token'),
        tiktok: s.sources.tiktok.enabled && !!s.sources.tiktok.bcId && sec.has('tiktok.token'),
        googleAds: s.sources.googleAds.enabled && !!s.sources.googleAds.customerId && sec.has('googleAds.tokens') && sec.has('googleAds.developerToken'),
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
