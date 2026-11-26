import fs from 'node:fs';
import path from 'node:path';
import type { Settings } from '../../shared/types.js';
import type { Db } from '../db.js';
import type { Finance } from '../finance.js';
import { monthEnd } from '../finance.js';
import { sanitizeFileName } from '../sources/classify.js';
import { monthlyReportHtml } from './report.js';
import { COLUMNS, invoiceRows, toCsv, toXlsx } from './table.js';
import { makeZip, type ZipEntry } from './zip.js';

export const isMonth = (m: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(m);

export function previousMonth(now: Date) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return d.toISOString().slice(0, 7);
}

/**
 * „Pachet pentru contabil”: un ZIP cu toate facturile lunii + raportul PDF + tabelul (CSV și XLSX).
 * Salvat în <date>/pachete/AAAA-LL.zip.
 */
export async function buildAccountantPackage(o: {
  db: Db;
  finance: Finance;
  settings: Settings;
  dataDir: string;
  month: string;
  htmlToPdf?: (html: string) => Promise<Buffer>;
  now?: Date;
}): Promise<{ zipPath: string; reportPdf: Buffer | null; reportName: string; count: number }> {
  if (!isMonth(o.month)) throw new Error('Luna trebuie să fie în formatul AAAA-LL');
  await o.finance.convertPending().catch(() => undefined);
  const from = `${o.month}-01`;
  const to = monthEnd(o.month);
  const invoices = o.db.listByDate(from, to, 'in');
  const spending = o.finance.spending(from, to);
  const tax = await o.finance.tax({ year: Number(o.month.slice(0, 4)), month: o.month });
  const html = monthlyReportHtml({
    month: o.month,
    company: o.settings.company.name,
    accountant: o.settings.accountant.name,
    invoices,
    spending,
    tax,
    generatedAt: o.now ?? new Date(),
  });
  const entries: ZipEntry[] = [];
  const reportName = `Raport_FacturaBot_${o.month}.pdf`;
  let reportPdf: Buffer | null = null;
  if (o.htmlToPdf) {
    reportPdf = await o.htmlToPdf(html);
    entries.push({ name: reportName, data: reportPdf });
  } else entries.push({ name: `Raport_FacturaBot_${o.month}.html`, data: html });
  const rows = invoiceRows(invoices);
  entries.push({ name: `Facturi_${o.month}.csv`, data: toCsv(COLUMNS, rows) });
  entries.push({ name: `Facturi_${o.month}.xlsx`, data: toXlsx([{ name: `Facturi ${o.month}`, header: COLUMNS, rows }]) });
  for (const inv of invoices) {
    if (!inv.filePath || !fs.existsSync(inv.filePath)) continue;
    const name = sanitizeFileName(`${inv.invoiceDate ?? ''}_${inv.fileName ?? path.basename(inv.filePath)}`);
    entries.push({ name: `facturi/${name}`, data: fs.readFileSync(inv.filePath) });
  }
  const dir = path.join(o.dataDir, 'pachete');
  fs.mkdirSync(dir, { recursive: true });
  const zipPath = path.join(dir, `FacturaBot_${o.month}.zip`);
  fs.writeFileSync(zipPath, makeZip(entries));
  return { zipPath, reportPdf, reportName, count: invoices.length };
}

/** Export pentru contabil pe un interval (CSV sau XLSX cu foaie de sumar). */
export function exportTable(o: { db: Db; finance: Finance; from: string; to: string; format: 'csv' | 'xlsx' }): { data: Buffer; fileName: string } {
  const rows = invoiceRows(o.db.listByDate(o.from, o.to, 'in'));
  const base = `FacturaBot_${o.from}_${o.to}`;
  if (o.format === 'csv') return { data: Buffer.from(toCsv(COLUMNS, rows), 'utf8'), fileName: `${base}.csv` };
  const sp = o.finance.spending(o.from, o.to);
  return {
    fileName: `${base}.xlsx`,
    data: toXlsx([
      { name: 'Facturi', header: COLUMNS, rows },
      { name: 'Pe platformă', header: ['Platformă', 'Facturi', 'Total RON'], rows: sp.byPlatform.map((p) => [p.label, p.count, p.totalRon]) },
      { name: 'Pe lună', header: ['Luna', 'Facturi', 'Total RON'], rows: sp.byMonth.map((m) => [m.month, m.count, m.totalRon]) },
      { name: 'Pe furnizor', header: ['Furnizor', 'Facturi', 'Total RON'], rows: sp.bySupplier.map((p) => [p.label, p.count, p.totalRon]) },
    ]),
  };
}
