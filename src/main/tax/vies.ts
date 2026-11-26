import { fetchWithRetry, type RetryOptions } from '../http.js';
import { parseVatId } from './vat.js';

/**
 * VIES – serviciul oficial al Comisiei Europene pentru validarea codurilor de TVA.
 * REST: POST {base}/check-vat-number  { countryCode, vatNumber } → { valid, name, address, requestDate }
 * Documentație: https://ec.europa.eu/taxation_customs/vies/#/technical-information
 */
export interface ViesResult {
  ok: boolean;
  valid?: boolean;
  name?: string;
  address?: string;
  checkedAt?: string;
  error?: string;
}

const VIES_ERRORS: Record<string, string> = {
  MS_UNAVAILABLE: 'Serviciul VIES al țării respective nu răspunde acum. Reîncearcă mai târziu.',
  MS_MAX_CONCURRENT_REQ: 'VIES e aglomerat pentru țara respectivă. Reîncearcă mai târziu.',
  SERVICE_UNAVAILABLE: 'VIES indisponibil temporar.',
  TIMEOUT: 'VIES nu a răspuns la timp.',
  INVALID_INPUT: 'Cod de TVA invalid.',
  GLOBAL_MAX_CONCURRENT_REQ: 'VIES e aglomerat. Reîncearcă mai târziu.',
};

const clean = (v: unknown) => {
  const s = String(v ?? '').trim();
  return s && s !== '---' ? s : undefined;
};

export async function checkVies(vatId: string, opts: { base: string; fetch: typeof fetch; retry?: RetryOptions }): Promise<ViesResult> {
  const p = parseVatId(vatId);
  if (!p) return { ok: false, error: 'Format de cod TVA UE invalid (ex. IE9692928F).' };
  try {
    const r = await fetchWithRetry(
      opts.fetch,
      `${opts.base.replace(/\/+$/, '')}/check-vat-number`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ countryCode: p.country, vatNumber: p.number }) },
      opts.retry,
    );
    const j: any = await r.json().catch(() => ({}));
    const code = j?.errorWrappers?.[0]?.error ?? j?.userError;
    if (!r.ok || (code && code !== 'VALID' && code !== 'INVALID' && typeof j.valid !== 'boolean')) {
      return { ok: false, error: VIES_ERRORS[code] ?? `VIES ${r.status}${code ? ': ' + code : ''}` };
    }
    return { ok: true, valid: !!j.valid, name: clean(j.name), address: clean(j.address), checkedAt: j.requestDate ?? new Date().toISOString() };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
