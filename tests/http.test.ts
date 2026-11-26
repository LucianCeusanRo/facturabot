import { describe, expect, it, vi } from 'vitest';
import { fetchWithRetry, isRetryableStatus, retryAfterMs } from '../src/main/http';

describe('fetchWithRetry', () => {
  const sleep = vi.fn(async () => undefined);

  it('reîncearcă la 429 și respectă Retry-After', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '3' } }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const r = await fetchWithRetry(f, 'https://x', {}, { sleep });
    expect(r.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(3000);
  });

  it('reîncearcă la 5xx și la erori de rețea', async () => {
    const f = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const r = await fetchWithRetry(f, 'https://x', {}, { sleep, baseDelayMs: 1 });
    expect(r.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('nu reîncearcă erorile permanente (400/401/404)', async () => {
    const f = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
    const r = await fetchWithRetry(f, 'https://x', {}, { sleep });
    expect(r.status).toBe(401);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('după ultima încercare returnează răspunsul 5xx', async () => {
    const f = vi.fn().mockResolvedValue(new Response('', { status: 500 }));
    const r = await fetchWithRetry(f, 'https://x', {}, { sleep, retries: 2 });
    expect(r.status).toBe(500);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('rețea căzută permanent → eroare clară', async () => {
    const f = vi.fn().mockRejectedValue(new TypeError('getaddrinfo ENOTFOUND'));
    await expect(fetchWithRetry(f, 'https://x', {}, { sleep, retries: 1 })).rejects.toThrow(/Rețea indisponibilă: getaddrinfo/);
  });

  it('helpers', () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(502)).toBe(true);
    expect(isRetryableStatus(404)).toBe(false);
    expect(retryAfterMs('2')).toBe(2000);
    expect(retryAfterMs(null)).toBeNull();
    expect(retryAfterMs('garbage')).toBeNull();
    expect(retryAfterMs(new Date(Date.now() + 5000).toUTCString())).toBeGreaterThan(0);
  });
});
