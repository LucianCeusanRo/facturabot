import { fetchWithRetry, type RetryOptions } from '../http.js';

/** Descarcă un PDF; întoarce null dacă răspunsul nu e PDF (ex. pagină de login sau JSON de eroare). */
export async function downloadPdf(f: typeof fetch, url: string, headers: Record<string, string>, retry?: RetryOptions): Promise<Buffer | null> {
  const r = await fetchWithRetry(f, url, { headers, redirect: 'follow' }, retry);
  if (!r.ok) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  const ct = r.headers.get('content-type') ?? '';
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return buf;
  return ct.includes('application/pdf') && buf.length > 0 ? buf : null;
}

export const ymd = (d: Date) => d.toISOString().slice(0, 10);
