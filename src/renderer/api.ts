import type { FacturaBotApi } from '../shared/types';

declare global {
  interface Window {
    facturabot: FacturaBotApi;
  }
}

export const api = window.facturabot;

export function fmtDate(iso: string | null | undefined, withTime = false) {
  if (!iso) return '—';
  const d = new Date(iso);
  return withTime
    ? `${d.toLocaleDateString('ro-RO', { day: '2-digit', month: 'short' })}, ${d.toLocaleTimeString('ro-RO', { hour: '2-digit', minute: '2-digit' })}`
    : d.toLocaleDateString('ro-RO', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function fmtMoney(v: number | null, cur: string | null) {
  if (v == null) return '—';
  return `${v.toLocaleString('ro-RO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur ?? 'RON'}`;
}

export function relTime(iso: string | null) {
  if (!iso) return 'niciodată';
  const diff = (new Date(iso).getTime() - Date.now()) / 60000;
  const rtf = new Intl.RelativeTimeFormat('ro', { numeric: 'auto' });
  if (Math.abs(diff) < 60) return rtf.format(Math.round(diff), 'minute');
  if (Math.abs(diff) < 1440) return rtf.format(Math.round(diff / 60), 'hour');
  return rtf.format(Math.round(diff / 1440), 'day');
}
