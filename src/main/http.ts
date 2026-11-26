/**
 * fetch cu reîncercări pentru erori temporare (rețea căzută, 429 rate limit, 5xx).
 * Respectă antetul Retry-After. Erorile permanente (4xx) sunt returnate imediat apelantului.
 */
export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function isRetryableStatus(status: number) {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

export function retryAfterMs(h: string | null | undefined): number | null {
  if (!h) return null;
  const n = Number(h);
  if (Number.isFinite(n)) return Math.max(0, n * 1000);
  const d = Date.parse(h);
  return Number.isFinite(d) ? Math.max(0, d - Date.now()) : null;
}

export async function fetchWithRetry(f: typeof fetch, url: string, init: RequestInit = {}, o: RetryOptions = {}): Promise<Response> {
  const retries = o.retries ?? 3;
  const base = o.baseDelayMs ?? 1000;
  const max = o.maxDelayMs ?? 30_000;
  const sleep = o.sleep ?? defaultSleep;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await f(url, init);
      if (!isRetryableStatus(r.status) || attempt === retries) return r;
      const wait = retryAfterMs(r.headers.get('retry-after')) ?? base * 2 ** attempt;
      await sleep(Math.min(max, wait));
    } catch (e) {
      // Eroare de rețea (DNS, conexiune resetată, offline) – reîncercăm.
      lastErr = e;
      if (attempt === retries) break;
      await sleep(Math.min(max, base * 2 ** attempt));
    }
  }
  throw new Error(`Rețea indisponibilă: ${(lastErr as Error)?.message ?? 'eroare necunoscută'}`);
}

/** Eroare: contul trebuie reconectat (token revocat / expirat definitiv). */
export class AuthExpiredError extends Error {
  constructor(
    public provider: 'gmail' | 'outlook',
    message: string,
  ) {
    super(message);
    this.name = 'AuthExpiredError';
  }
}
