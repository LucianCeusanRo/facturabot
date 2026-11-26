import type { Insight, InvoiceRecord, InvoiceStatus, SpendingReport, StatusSnapshot, TaxOverview } from '../../shared/types';

export type WebInvoice = Omit<InvoiceRecord, 'filePath'> & { hasFile: boolean };
export interface WebInfo {
  company: string;
  accountant: string;
  whatsappMode: string;
  pollMinutes: number;
  version: string;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init?.method ?? 'GET',
      credentials: 'same-origin',
      headers: { 'X-FacturaBot': '1', ...(init?.body ? { 'Content-Type': 'application/json' } : {}) },
      body: init?.body ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new HttpError(0, 'Calculatorul nu răspunde. Verifică dacă e pornit și pe aceeași rețea.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(res.status, (data as { error?: string }).error ?? `Eroare ${res.status}`);
  return data as T;
}

/** API-ul panoului de pe telefon – vorbește doar cu serverul local al aplicației desktop. */
export const web = {
  session: () => call<{ paired: boolean; device: { id: string; name: string } | null }>('/api/session'),
  pair: (code: string, name: string) => call<{ ok: boolean }>('/api/pair', { method: 'POST', body: { code, name } }),
  logout: () => call<{ ok: boolean }>('/api/logout', { method: 'POST', body: {} }),
  info: () => call<WebInfo>('/api/info'),
  status: () => call<StatusSnapshot>('/api/status'),
  insights: () => call<Insight[]>('/api/insights'),
  invoices: (status: InvoiceStatus | 'all' = 'all', limit = 60) => call<WebInvoice[]>(`/api/invoices?status=${status}&limit=${limit}`),
  approve: (id: number) => call<{ ok: boolean }>(`/api/invoices/${id}/approve`, { method: 'POST', body: {} }),
  skip: (id: number) => call<{ ok: boolean }>(`/api/invoices/${id}/skip`, { method: 'POST', body: {} }),
  sync: () => call<{ ok: boolean }>('/api/sync', { method: 'POST', body: {} }),
  spending: (from: string, to: string) => call<SpendingReport>(`/api/spending?from=${from}&to=${to}`),
  tax: (month: string) => call<TaxOverview>(`/api/tax?month=${month}`),
  fileUrl: (id: number) => `/api/invoices/${id}/file`,
  exportUrl: (format: 'csv' | 'xlsx', from: string, to: string) => `/api/export?format=${format}&from=${from}&to=${to}`,
  packageUrl: (month: string) => `/api/package?month=${month}`,
};
