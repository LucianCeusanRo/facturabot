import type { InvoiceRecord, SpendingReport, TaxOverview } from '../../shared/types.js';
import { platformLabel, platformOf } from '../analytics.js';

const e = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const money = (n: number | null | undefined, cur = 'RON') => (n == null ? '—' : `${n.toLocaleString('ro-RO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur}`);
const MONTHS = ['ianuarie', 'februarie', 'martie', 'aprilie', 'mai', 'iunie', 'iulie', 'august', 'septembrie', 'octombrie', 'noiembrie', 'decembrie'];
export const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1] ?? m.slice(5, 7)} ${m.slice(0, 4)}`;

export interface ReportData {
  month: string;
  company: string;
  accountant: string;
  invoices: InvoiceRecord[];
  spending: SpendingReport;
  tax: TaxOverview;
  generatedAt: Date;
}

/** Raport lunar pentru contabil (HTML → PDF prin Electron). Design sobru, alb-negru, tipăribil A4. */
export function monthlyReportHtml(d: ReportData): string {
  const rc = d.tax.reverseCharge;
  const v = d.tax.vatThreshold;
  const rows = d.invoices
    .map(
      (i) => `<tr><td>${e(i.invoiceDate ?? '')}</td><td>${e(i.vendor ?? i.subject ?? '')}</td><td class="m">${e(i.seriesNumber ?? '')}</td><td>${e(platformLabel(platformOf(i)))}</td>
<td class="r m">${e(money(i.amount, i.currency ?? 'RON'))}</td><td class="r m">${e(money(i.amountRon ?? ((i.currency ?? 'RON') === 'RON' ? i.amount : null)))}</td><td>${e(
        i.vatTreatment === 'intra-eu' ? 'UE – taxare inversă' : i.vatTreatment === 'extra-eu' ? 'Extra-UE – taxare inversă' : i.vatTreatment === 'domestic' ? 'RO' : '—',
      )}</td></tr>`,
    )
    .join('');
  const platforms = d.spending.byPlatform.map((p) => `<tr><td>${e(p.label)}</td><td class="r">${p.count}</td><td class="r m">${e(money(p.totalRon))}</td></tr>`).join('');
  const obligations = rc.obligations
    .map((o) => `<li><b>${e(o.code)}</b> – ${e(o.title)}${o.deadline ? ` · termen ${e(o.deadline)}` : ''}<br><span class="muted">${e(o.detail)}</span></li>`)
    .join('');
  return `<!doctype html><html lang="ro"><head><meta charset="utf-8"><title>Raport ${e(d.month)}</title>
<style>
*{box-sizing:border-box}body{font:11px/1.5 'Segoe UI',system-ui,sans-serif;color:#0a0a0a;margin:0;padding:28px 32px}
h1{font-size:20px;font-weight:600;margin:0 0 2px;letter-spacing:-.02em}h2{font-size:13px;font-weight:600;margin:22px 0 8px}
.muted{color:#6b6b6b}.m{font-family:Consolas,'Geist Mono',monospace;font-variant-numeric:tabular-nums}.r{text-align:right}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid #e6e6e6;border-radius:6px;margin-top:16px}
.kpis div{padding:10px 12px;border-left:1px solid #e6e6e6}.kpis div:first-child{border-left:0}.kpis b{display:block;font-size:16px;font-weight:600}
table{width:100%;border-collapse:collapse}th{text-align:left;font-weight:500;color:#6b6b6b;border-bottom:1px solid #d4d4d4;padding:5px 6px}
td{padding:5px 6px;border-bottom:1px solid #eee;vertical-align:top}ul{margin:0;padding-left:16px}li{margin-bottom:6px}
.bar{height:6px;background:#eee;border-radius:3px;overflow:hidden;margin:6px 0}.bar i{display:block;height:100%;background:#0a0a0a}
.note{margin-top:22px;padding:8px 10px;border:1px solid #e6e6e6;border-radius:6px;color:#6b6b6b}
</style></head><body>
<h1>Raport ${e(monthLabel(d.month))}</h1>
<div class="muted">${e(d.company || 'Firma mea')} · pentru ${e(d.accountant || 'contabil')} · generat ${e(d.generatedAt.toLocaleString('ro-RO'))} de FacturaBot</div>
<div class="kpis">
<div><span class="muted">Facturi primite</span><b>${d.spending.count}</b></div>
<div><span class="muted">Total cheltuieli</span><b class="m">${e(money(d.spending.totalRon))}</b></div>
<div><span class="muted">Taxare inversă</span><b class="m">${e(money(rc.totalRon))}</b></div>
<div><span class="muted">TVA de calculat (${e(rc.items.length ? 'estimare' : '—')})</span><b class="m">${e(money(rc.vatDueRon))}</b></div>
</div>
<h2>Cheltuieli pe platformă</h2>
<table><thead><tr><th>Platformă</th><th class="r">Facturi</th><th class="r">Total (lei, curs BNR)</th></tr></thead><tbody>${platforms || '<tr><td colspan="3" class="muted">Nicio cheltuială</td></tr>'}</tbody></table>
<h2>Declarații de verificat</h2>
${obligations ? `<ul>${obligations}</ul>` : '<div class="muted">Nicio achiziție de la furnizori străini detectată luna aceasta.</div>'}
<h2>Plafon scutire TVA ${d.tax.year}</h2>
<div class="m">${e(money(v.valueRon))} din ${e(money(v.thresholdRon))} (${v.percent}%)</div><div class="bar"><i style="width:${Math.min(100, v.percent)}%"></i></div>
<h2>Facturi (${d.invoices.length})</h2>
<table><thead><tr><th>Data</th><th>Furnizor</th><th>Număr</th><th>Platformă</th><th class="r">Sumă</th><th class="r">RON</th><th>TVA</th></tr></thead><tbody>${rows || '<tr><td colspan="7" class="muted">Nicio factură</td></tr>'}</tbody></table>
${d.spending.unconverted ? `<p class="muted">${d.spending.unconverted} facturi fără sumă sau fără curs BNR nu sunt incluse în totaluri.</p>` : ''}
<div class="note">${e(d.tax.disclaimer)} Cursurile sunt cele de referință BNR (ultimul curs publicat înaintea datei facturii, art. 290 Cod fiscal).</div>
</body></html>`;
}
