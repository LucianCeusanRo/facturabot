import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import initSqlJs, { type Database, type SqlValue } from 'sql.js';
import type { DeliveryChannel, InvoiceRecord, InvoiceStatus, LogEntry } from '../shared/types.js';

const require = createRequire(import.meta.url);

export interface NewInvoice {
  source: string;
  externalId: string;
  fileHash?: string | null;
  seriesNumber?: string | null;
  vendor?: string | null;
  subject?: string | null;
  fileName?: string | null;
  filePath?: string | null;
  amount?: number | null;
  currency?: string | null;
  invoiceDate?: string | null;
  status: InvoiceStatus;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  file_hash TEXT,
  series_number TEXT,
  vendor TEXT,
  subject TEXT,
  file_name TEXT,
  file_path TEXT,
  amount REAL,
  currency TEXT,
  invoice_date TEXT,
  status TEXT NOT NULL,
  channel TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  UNIQUE(source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_inv_hash ON invoices(file_hash);
CREATE INDEX IF NOT EXISTS idx_inv_series ON invoices(series_number);
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
`;

/** Baza de date locală (SQLite compilat în WebAssembly – fără module native, ușor de împachetat). */
export class Db {
  private constructor(private db: Database, private file: string | null) {}

  static async open(file: string | null): Promise<Db> {
    const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
    const wasmBinary = fs.readFileSync(wasmPath);
    const SQL = await initSqlJs({ wasmBinary: wasmBinary.buffer.slice(wasmBinary.byteOffset, wasmBinary.byteOffset + wasmBinary.byteLength) as ArrayBuffer } as any);
    let db: Database;
    if (file && fs.existsSync(file)) db = new SQL.Database(fs.readFileSync(file));
    else db = new SQL.Database();
    db.exec(SCHEMA);
    // Migrare pentru baze create de versiuni mai vechi.
    const cols = db.exec('PRAGMA table_info(invoices)')[0]?.values.map((v) => String(v[1])) ?? [];
    if (!cols.includes('attempts')) db.exec('ALTER TABLE invoices ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
    // Dacă aplicația s-a oprit în timpul unei trimiteri, documentul revine în coadă.
    db.exec("UPDATE invoices SET status='pending' WHERE status='sending'");
    const inst = new Db(db, file);
    inst.save();
    return inst;
  }

  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, Buffer.from(this.db.export()));
    fs.renameSync(tmp, this.file);
  }

  private all(sql: string, params: SqlValue[] = []): Record<string, SqlValue>[] {
    const st = this.db.prepare(sql);
    try {
      st.bind(params);
      const rows: Record<string, SqlValue>[] = [];
      while (st.step()) rows.push(st.getAsObject());
      return rows;
    } finally {
      st.free();
    }
  }

  private run(sql: string, params: SqlValue[] = []) {
    this.db.run(sql, params);
    this.save();
  }

  // ---------- Deduplicare ----------
  /** Returnează motivul pentru care documentul e duplicat, sau null dacă e nou. */
  findDuplicate(inv: { source: string; externalId: string; fileHash?: string | null; seriesNumber?: string | null; vendor?: string | null }): string | null {
    if (this.all('SELECT id FROM invoices WHERE source=? AND external_id=?', [inv.source, inv.externalId]).length) return 'external_id';
    if (inv.fileHash && this.all("SELECT id FROM invoices WHERE file_hash=? AND status!='duplicate'", [inv.fileHash]).length) return 'file_hash';
    // Aceeași serie+număr de la ACELAȘI furnizor (furnizori diferiți pot avea aceleași numere).
    if (inv.seriesNumber) {
      const series = normalizeSeries(inv.seriesNumber);
      const rows = this.all("SELECT vendor FROM invoices WHERE series_number=? AND status!='duplicate'", [series]);
      const v = normalizeVendor(inv.vendor);
      if (rows.some((r) => !v || !r.vendor || normalizeVendor(String(r.vendor)) === v)) return 'series_number';
    }
    return null;
  }

  insertInvoice(inv: NewInvoice): number {
    this.db.run(
      `INSERT OR IGNORE INTO invoices (source, external_id, file_hash, series_number, vendor, subject, file_name, file_path, amount, currency, invoice_date, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        inv.source,
        inv.externalId,
        inv.fileHash ?? null,
        inv.seriesNumber ? normalizeSeries(inv.seriesNumber) : null,
        inv.vendor ?? null,
        inv.subject ?? null,
        inv.fileName ?? null,
        inv.filePath ?? null,
        inv.amount ?? null,
        inv.currency ?? null,
        inv.invoiceDate ?? null,
        inv.status,
        new Date().toISOString(),
      ],
    );
    if (this.db.getRowsModified() === 0) return 0; // INSERT OR IGNORE a ignorat (deja există)
    const id = Number(this.all('SELECT last_insert_rowid() AS id')[0].id);
    this.save();
    return id;
  }

  setStatus(id: number, status: InvoiceStatus, extra: { channel?: DeliveryChannel | null; error?: string | null } = {}) {
    this.run('UPDATE invoices SET status=?, channel=COALESCE(?, channel), error=?, sent_at=? WHERE id=?', [
      status,
      extra.channel ?? null,
      extra.error ?? null,
      status === 'sent' ? new Date().toISOString() : null,
      id,
    ]);
  }

  /** Marchează documentul „în trimitere” și crește numărul de încercări. */
  markSending(id: number) {
    this.run("UPDATE invoices SET status='sending', attempts=attempts+1 WHERE id=?", [id]);
  }

  resetAttempts(id: number) {
    this.run('UPDATE invoices SET attempts=0 WHERE id=?', [id]);
  }

  getInvoice(id: number): InvoiceRecord | null {
    const r = this.all('SELECT * FROM invoices WHERE id=?', [id])[0];
    return r ? mapInvoice(r) : null;
  }

  listInvoices(status: InvoiceStatus | 'all' = 'all', limit = 200): InvoiceRecord[] {
    const rows =
      status === 'all'
        ? this.all('SELECT * FROM invoices ORDER BY id DESC LIMIT ?', [limit])
        : this.all('SELECT * FROM invoices WHERE status=? ORDER BY id DESC LIMIT ?', [status, limit]);
    return rows.map(mapInvoice);
  }

  stats() {
    const one = (sql: string, p: SqlValue[] = []) => Number(this.all(sql, p)[0]?.c ?? 0);
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    return {
      total: one("SELECT COUNT(*) c FROM invoices WHERE status!='duplicate'"),
      sent: one("SELECT COUNT(*) c FROM invoices WHERE status='sent'"),
      failed: one("SELECT COUNT(*) c FROM invoices WHERE status='failed'"),
      pending: one("SELECT COUNT(*) c FROM invoices WHERE status IN ('pending','awaiting_confirm')"),
      thisMonth: one("SELECT COUNT(*) c FROM invoices WHERE status='sent' AND sent_at>=?", [monthStart.toISOString()]),
    };
  }

  // ---------- Jurnal ----------
  log(level: LogEntry['level'], message: string) {
    this.db.run('INSERT INTO logs (ts, level, message) VALUES (?,?,?)', [new Date().toISOString(), level, message]);
    this.db.run('DELETE FROM logs WHERE id < (SELECT MAX(id) - 2000 FROM logs)');
    this.save();
  }

  listLogs(limit = 200): LogEntry[] {
    return this.all('SELECT * FROM logs ORDER BY id DESC LIMIT ?', [limit]).map((r) => ({
      id: Number(r.id),
      ts: String(r.ts),
      level: r.level as LogEntry['level'],
      message: String(r.message),
    }));
  }

  // ---------- Stare (cursor de sincronizare per sursă) ----------
  getKv(k: string): string | null {
    const r = this.all('SELECT v FROM kv WHERE k=?', [k])[0];
    return r ? String(r.v) : null;
  }

  setKv(k: string, v: string) {
    this.run('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', [k, v]);
  }
}

export function normalizeVendor(v: string | null | undefined): string {
  return (v ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(s\.?r\.?l|s\.?a|ltd|inc|gmbh|llc|limited)\b\.?/g, '')
    .replace(/[^a-z0-9]/g, '');
}

export function normalizeSeries(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function mapInvoice(r: Record<string, SqlValue>): InvoiceRecord {
  const s = (v: SqlValue) => (v === null || v === undefined ? null : String(v));
  return {
    id: Number(r.id),
    source: String(r.source),
    externalId: String(r.external_id),
    fileHash: s(r.file_hash),
    seriesNumber: s(r.series_number),
    vendor: s(r.vendor),
    subject: s(r.subject),
    fileName: s(r.file_name),
    filePath: s(r.file_path),
    amount: r.amount === null ? null : Number(r.amount),
    currency: s(r.currency),
    invoiceDate: s(r.invoice_date),
    status: r.status as InvoiceStatus,
    channel: s(r.channel) as DeliveryChannel | null,
    error: s(r.error),
    attempts: Number(r.attempts ?? 0),
    createdAt: String(r.created_at),
    sentAt: s(r.sent_at),
  };
}
