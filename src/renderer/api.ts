import type { FacturaBotApi } from '../shared/types';

declare global {
  interface Window {
    facturabot: FacturaBotApi;
  }
}

export const api = window.facturabot;

export { fmtDate, fmtMoney, relTime } from './format';
