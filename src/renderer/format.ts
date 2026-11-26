export function fmtDate(iso: string | null | undefined, withTime = false) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return withTime
    ? `${d.toLocaleDateString('ro-RO', { day: '2-digit', month: 'short' })}, ${d.toLocaleTimeString('ro-RO', { hour: '2-digit', minute: '2-digit' })}`
    : d.toLocaleDateString('ro-RO', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function fmtMoney(v: number | null | undefined, cur: string | null = 'RON', digits = 2) {
  if (v == null) return '—';
  return `${v.toLocaleString('ro-RO', { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${cur ?? 'RON'}`;
}

/** Sumă compactă pentru grafice: 12,4k / 1,2M. */
export function fmtCompact(v: number) {
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toLocaleString('ro-RO', { maximumFractionDigits: 1 })}M`;
  if (Math.abs(v) >= 1000) return `${(v / 1000).toLocaleString('ro-RO', { maximumFractionDigits: 1 })}k`;
  return v.toLocaleString('ro-RO', { maximumFractionDigits: 0 });
}

export function relTime(iso: string | null) {
  if (!iso) return 'niciodată';
  const diff = (new Date(iso).getTime() - Date.now()) / 60000;
  const rtf = new Intl.RelativeTimeFormat('ro', { numeric: 'auto' });
  if (Math.abs(diff) < 60) return rtf.format(Math.round(diff), 'minute');
  if (Math.abs(diff) < 1440) return rtf.format(Math.round(diff / 60), 'hour');
  return rtf.format(Math.round(diff / 1440), 'day');
}

const MONTHS = ['ian', 'feb', 'mar', 'apr', 'mai', 'iun', 'iul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTHS_LONG = ['ianuarie', 'februarie', 'martie', 'aprilie', 'mai', 'iunie', 'iulie', 'august', 'septembrie', 'octombrie', 'noiembrie', 'decembrie'];
export const monthShort = (m: string) => MONTHS[Number(m.slice(5, 7)) - 1] ?? m;
export const monthLong = (m: string) => `${MONTHS_LONG[Number(m.slice(5, 7)) - 1] ?? m} ${m.slice(0, 4)}`;

export const today = () => new Date().toISOString().slice(0, 10);
export const thisMonth = () => new Date().toISOString().slice(0, 7);
export function shiftMonth(m: string, delta: number) {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}
export function monthEnd(m: string) {
  const [y, mo] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
}

export type RangeKey = 'month' | 'prev' | 'quarter' | 'year';
export function rangeFor(k: RangeKey): { from: string; to: string; label: string } {
  const m = thisMonth();
  if (k === 'month') return { from: `${m}-01`, to: today(), label: 'Luna asta' };
  if (k === 'prev') {
    const p = shiftMonth(m, -1);
    return { from: `${p}-01`, to: monthEnd(p), label: 'Luna trecută' };
  }
  if (k === 'quarter') return { from: `${shiftMonth(m, -2)}-01`, to: today(), label: 'Ultimele 3 luni' };
  return { from: `${m.slice(0, 4)}-01-01`, to: today(), label: 'Anul acesta' };
}
