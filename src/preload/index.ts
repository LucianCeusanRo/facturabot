import { contextBridge, ipcRenderer } from 'electron';
import type { FacturaBotApi } from '../shared/types';

const api: FacturaBotApi = {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (p) => ipcRenderer.invoke('settings:save', p),
  setSecret: (k, v) => ipcRenderer.invoke('secret:set', k, v),
  hasSecret: (k) => ipcRenderer.invoke('secret:has', k),
  clearSecret: (k) => ipcRenderer.invoke('secret:clear', k),
  connectGoogle: () => ipcRenderer.invoke('google:connect'),
  connectMicrosoft: () => ipcRenderer.invoke('microsoft:connect'),
  disconnectAccount: (w) => ipcRenderer.invoke('account:disconnect', w),
  testFgo: () => ipcRenderer.invoke('fgo:test'),
  testSource: (id) => ipcRenderer.invoke('source:test', id),
  connectGoogleAds: () => ipcRenderer.invoke('googleAds:connect'),
  spending: (o) => ipcRenderer.invoke('finance:spending', o),
  tax: (o) => ipcRenderer.invoke('finance:tax', o),
  insights: () => ipcRenderer.invoke('finance:insights'),
  checkVies: (v) => ipcRenderer.invoke('vies:check', v),
  exportData: (o) => ipcRenderer.invoke('export:data', o),
  buildPackage: (m, send) => ipcRenderer.invoke('package:build', m, send),
  remoteState: () => ipcRenderer.invoke('remote:state'),
  remoteSetEnabled: (on) => ipcRenderer.invoke('remote:enable', on),
  remoteNewPairing: () => ipcRenderer.invoke('remote:pair'),
  remoteRevoke: (id) => ipcRenderer.invoke('remote:revoke', id),
  waStart: () => ipcRenderer.invoke('wa:start'),
  waLogout: () => ipcRenderer.invoke('wa:logout'),
  waState: () => ipcRenderer.invoke('wa:state'),
  testDelivery: () => ipcRenderer.invoke('delivery:test'),
  syncNow: () => ipcRenderer.invoke('sync:now'),
  status: () => ipcRenderer.invoke('status'),
  listInvoices: (o) => ipcRenderer.invoke('invoices:list', o),
  approveInvoice: (id) => ipcRenderer.invoke('invoices:approve', id),
  skipInvoice: (id) => ipcRenderer.invoke('invoices:skip', id),
  retryInvoice: (id) => ipcRenderer.invoke('invoices:retry', id),
  openInvoiceFile: (id) => ipcRenderer.invoke('invoices:open', id),
  listLogs: (l) => ipcRenderer.invoke('logs:list', l),
  openExternal: (u) => ipcRenderer.invoke('open:external', u),
  on: ((channel: string, cb: (v: any) => void) => {
    const fn = (_e: unknown, v: any) => cb(v);
    ipcRenderer.on(channel, fn);
    return () => ipcRenderer.removeListener(channel, fn);
  }) as FacturaBotApi['on'],
};

contextBridge.exposeInMainWorld('facturabot', api);
