import type { InvoiceRecord } from '../../shared/types.js';
import { platformLabel, platformOf } from '../analytics.js';
import { makeZip } from './zip.js';

/** Tabel pentru contabil: o linie per factură. Coloanele sunt aceleași în CSV și XLSX. */
export const COLUMNS = [
  'Data', 'Furnizor', 'Număr', 'Platformă', 'Sumă', 'Monedă', 'Curs BNR', 'Sumă RON', 'Țară furnizor', 'Cod TVA furnizor', 'Regim TVA', 'Scadență', 'Achitată', 'Sursă', 'Status', 'Fișier',
] as const;

const TREATMENT: Record<string, string> = { domestic: 'Intern (RO)', 'intra-eu': 'Intracomunitar – taxare inversă', 'extra-eu': 'Extra-UE – taxare inversă', unknown: '—' };

export type Cell = string | number | null;

export function invoiceRows(rows: InvoiceRecord[]): Cell[][] {
  return rows.map((r) => [
    r.invoiceDate ?? r.createdAt.slice(0, 10),
    r.vendor ?? r.subject ?? '',
    r.seriesNumber ?? '',
    platformLabel(platformOf(r)),
    r.amount,
    r.currency ?? (r.amount != null ? 'RON' : ''),
    r.fxRate,
    r.amountRon ?? ((r.currency ?? 'RON') === 'RON' ? r.amount : null),
    r.supplierCountry ?? '',
    r.supplierVatId ?? '',
    TREATMENT[r.vatTreatment] ?? '—',
    r.dueDate ?? '',
    r.paid == null ? '' : r.paid ? 'da' : 'nu',
    r.source,
    r.status,
    r.fileName ?? '',
  ]);
}

/** CSV pentru Excel în limba română: separator „;”, zecimale cu virgulă, BOM UTF-8 (diacritice corecte). */
export function toCsv(header: readonly string[], rows: Cell[][]): string {
  const cell = (v: Cell) => {
    if (v == null) return '';
    let s = typeof v === 'number' ? String(v).replace('.', ',') : String(v);
    // Protecție „CSV injection”: celulele care încep cu = + - @ sunt prefixate.
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '\ufeff' + [header, ...rows].map((r) => r.map(cell).join(';')).join('\r\n') + '\r\n';
}

const esc = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

function colName(i: number) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

export interface Sheet {
  name: string;
  header: readonly string[];
  rows: Cell[][];
}

/** XLSX minimal (Office Open XML) – mai multe foi, antet îngroșat, numere ca numere. */
export function toXlsx(sheets: Sheet[]): Buffer {
  const sheetXml = (sh: Sheet) => {
    const rows = [sh.header as Cell[], ...sh.rows]
      .map((r, ri) => {
        const cells = r
          .map((v, ci) => {
            const ref = `${colName(ci)}${ri + 1}`;
            const st = ri === 0 ? ' s="1"' : '';
            if (v == null || v === '') return '';
            if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${st}><v>${v}</v></c>`;
            return `<c r="${ref}" t="inlineStr"${st}><is><t xml:space="preserve">${esc(String(v))}</t></is></c>`;
          })
          .join('');
        return `<row r="${ri + 1}">${cells}</row>`;
      })
      .join('');
    const widths = sh.header.map((h, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.max(10, Math.min(40, h.length + 6))}" customWidth="1"/>`).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths}</cols><sheetData>${rows}</sheetData></worksheet>`;
  };
  const safeName = (n: string, i: number) => esc(n.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31) || `Foaie${i + 1}`);
  const files = [
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets
        .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
        .join('')}</Types>`,
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
        .map((s, i) => `<sheet name="${safeName(s.name, i)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join('')}</sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
        .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
        .join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    },
    {
      name: 'xl/styles.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf fontId="0"/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>`,
    },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) })),
  ];
  return makeZip(files);
}
