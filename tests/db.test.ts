import path from 'node:path';
import initSqlJs from 'sql.js';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { Db, normalizeSeries, normalizeVendor } from '../src/main/db';
import { tmpDir } from './helpers';

const base = { source: 'gmail', status: 'pending' as const };

describe('Db', () => {
  it('deduplicare: același ID / același conținut / aceeași serie la același furnizor', async () => {
    const db = await Db.open(null);
    db.insertInvoice({ ...base, externalId: 'a', fileHash: 'H1', seriesNumber: 'FB-1001', vendor: 'Meta Platforms SRL' });
    expect(db.findDuplicate({ source: 'gmail', externalId: 'a' })).toBe('external_id');
    expect(db.findDuplicate({ source: 'outlook', externalId: 'z', fileHash: 'H1' })).toBe('file_hash');
    expect(db.findDuplicate({ source: 'gmail', externalId: 'b', seriesNumber: 'fb 1001', vendor: 'META PLATFORMS S.R.L.' })).toBe('series_number');
    // furnizor diferit, același număr → NU e duplicat
    expect(db.findDuplicate({ source: 'gmail', externalId: 'c', seriesNumber: 'FB1001', vendor: 'Fan Courier' })).toBeNull();
    // INSERT OR IGNORE pe același ID întoarce 0
    expect(db.insertInvoice({ ...base, externalId: 'a' })).toBe(0);
  });

  it('încercări + revenirea documentelor rămase „sending” după un crash', async () => {
    const file = path.join(tmpDir(), 'x.sqlite');
    const db = await Db.open(file);
    const id = db.insertInvoice({ ...base, externalId: 'k' });
    db.markSending(id);
    expect(db.getInvoice(id)).toMatchObject({ status: 'sending', attempts: 1 });
    const again = await Db.open(file);
    expect(again.getInvoice(id)).toMatchObject({ status: 'pending', attempts: 1 });
    again.resetAttempts(id);
    expect(again.getInvoice(id)?.attempts).toBe(0);
  });

  it('migrează o bază veche fără coloana attempts', async () => {
    const require = createRequire(import.meta.url);
    const SQL = await initSqlJs({ wasmBinary: fs.readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm')) as any } as any);
    const old = new SQL.Database();
    old.exec(`CREATE TABLE invoices (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, external_id TEXT NOT NULL, file_hash TEXT, series_number TEXT, vendor TEXT, subject TEXT, file_name TEXT, file_path TEXT, amount REAL, currency TEXT, invoice_date TEXT, status TEXT NOT NULL, channel TEXT, error TEXT, created_at TEXT NOT NULL, sent_at TEXT, UNIQUE(source, external_id));
      INSERT INTO invoices (source, external_id, status, created_at) VALUES ('gmail','old','sent','2026-01-01');`);
    const file = path.join(tmpDir(), 'old.sqlite');
    fs.writeFileSync(file, Buffer.from(old.export()));
    const db = await Db.open(file);
    expect(db.listInvoices()[0]).toMatchObject({ externalId: 'old', attempts: 0 });
  });

  it('jurnal și kv', async () => {
    const db = await Db.open(null);
    db.log('info', 'salut');
    expect(db.listLogs(1)[0].message).toBe('salut');
    db.setKv('k', '1');
    db.setKv('k', '2');
    expect(db.getKv('k')).toBe('2');
    expect(db.getKv('lipsă')).toBeNull();
  });

  it('normalizări', () => {
    expect(normalizeSeries('fb-2026/0042')).toBe('FB20260042');
    expect(normalizeVendor('Șoșoni S.R.L.')).toBe('sosoni');
  });
});
