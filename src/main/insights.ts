import type { Insight, InvoiceRecord } from '../shared/types.js';
import { normalizeVendor } from './db.js';
import { monthsBetween } from './analytics.js';

const fmtRo = (d: string) => new Date(d + 'T12:00:00Z').toLocaleDateString('ro-RO', { day: '2-digit', month: 'short' });
const ym = (d: Date) => d.toISOString().slice(0, 7);

/**
 * Furnizori recurenți (factură în ≥ 3 din ultimele 4 luni încheiate) care n-au trimis încă factura
 * lunii curente, deși ziua obișnuită + perioada de grație a trecut. Fără AI – doar calendar.
 */
export function missingInvoices(invoices: InvoiceRecord[], now: Date, graceDays: number): Insight[] {
  const cur = ym(now);
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 4, 1));
  const prevMonths = monthsBetween(ym(start), cur).filter((m) => m !== cur);
  const byVendor = new Map<string, { label: string; months: Map<string, number>; hasCurrent: boolean }>();
  for (const inv of invoices) {
    if (inv.direction === 'out' || inv.status === 'duplicate' || inv.status === 'skipped' || !inv.vendor) continue;
    const day = inv.invoiceDate ?? inv.createdAt.slice(0, 10);
    const key = normalizeVendor(inv.vendor);
    if (!key) continue;
    const v = byVendor.get(key) ?? { label: inv.vendor, months: new Map(), hasCurrent: false };
    const m = day.slice(0, 7);
    if (m === cur) v.hasCurrent = true;
    else if (prevMonths.includes(m)) v.months.set(m, Math.max(v.months.get(m) ?? 0, Number(day.slice(8, 10))));
    byVendor.set(key, v);
  }
  const out: Insight[] = [];
  for (const [key, v] of byVendor) {
    if (v.hasCurrent || v.months.size < 3) continue;
    const days = [...v.months.values()].sort((a, b) => a - b);
    const typical = days[Math.floor(days.length / 2)];
    if (now.getUTCDate() < typical + graceDays) continue;
    out.push({
      id: `missing:${key}:${cur}`,
      kind: 'missing',
      level: 'warn',
      title: `Lipsește factura de la ${v.label}`,
      detail: `De obicei vine în jurul zilei ${typical} a lunii. Pentru ${cur} n-am găsit-o încă — verifică în contul furnizorului.`,
    });
  }
  return out;
}

/** Scadențe apropiate sau depășite pentru facturi neachitate (date din FGO / Meta / Google Ads). */
export function dueReminders(invoices: InvoiceRecord[], now: Date, withinDays: number): Insight[] {
  const today = now.toISOString().slice(0, 10);
  const limit = new Date(now.getTime() + withinDays * 86400_000).toISOString().slice(0, 10);
  const out: Insight[] = [];
  for (const inv of invoices) {
    if (!inv.dueDate || inv.paid !== false || inv.direction === 'out') continue;
    const who = inv.vendor ?? inv.subject ?? 'Factură';
    const sum = inv.amount != null ? ` · ${inv.amount.toLocaleString('ro-RO', { minimumFractionDigits: 2 })} ${inv.currency ?? 'RON'}` : '';
    if (inv.dueDate < today) {
      out.push({ id: `overdue:${inv.id}`, kind: 'overdue', level: 'err', title: `Scadență depășită: ${who}`, detail: `Scadentă pe ${fmtRo(inv.dueDate)}${sum}.`, invoiceId: inv.id });
    } else if (inv.dueDate <= limit) {
      out.push({ id: `due:${inv.id}`, kind: 'due', level: 'warn', title: `Scadență apropiată: ${who}`, detail: `De plată până pe ${fmtRo(inv.dueDate)}${sum}.`, invoiceId: inv.id });
    }
  }
  return out.sort((a, b) => (a.level === b.level ? 0 : a.level === 'err' ? -1 : 1));
}
