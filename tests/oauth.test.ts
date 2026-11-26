import { describe, expect, it } from 'vitest';
import { AuthExpiredError } from '../src/main/http';
import { googleAccessToken } from '../src/main/oauth/google';
import { microsoftAccessToken } from '../src/main/oauth/microsoft';
import { fakeFetch, json, makeEnv } from './helpers';

describe('OAuth – reîmprospătare token', () => {
  it('Google: token valid → fără rețea', async () => {
    const { secrets } = makeEnv();
    const f = fakeFetch();
    expect(await googleAccessToken('cid', secrets, f as any)).toBe('AT');
    expect(f).not.toHaveBeenCalled();
  });

  it('Google: token expirat → refresh, salvează noul token', async () => {
    const { secrets } = makeEnv();
    secrets.setJson('google.tokens', { access_token: 'OLD', refresh_token: 'RT', expires_at: Date.now() - 1000 });
    const f = fakeFetch((u) => (u.includes('oauth2.googleapis.com/token') ? json({ access_token: 'NEW', expires_in: 3600 }) : undefined));
    expect(await googleAccessToken('cid', secrets, f as any)).toBe('NEW');
    const saved = secrets.getJson<any>('google.tokens');
    expect(saved.access_token).toBe('NEW');
    expect(saved.refresh_token).toBe('RT'); // Google nu trimite mereu unul nou
  });

  it('Google: cereri simultane fac un singur refresh', async () => {
    const { secrets } = makeEnv();
    secrets.setJson('google.tokens', { access_token: 'OLD', refresh_token: 'RT', expires_at: 0 });
    const f = fakeFetch(async (u) => {
      if (!u.includes('/token')) return undefined;
      await new Promise((r) => setTimeout(r, 20));
      return json({ access_token: 'NEW', expires_in: 3600 });
    });
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => googleAccessToken('cid', secrets, f as any)));
    expect([a, b, c]).toEqual(['NEW', 'NEW', 'NEW']);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('Google: invalid_grant → șterge tokenurile și cere reconectare', async () => {
    const { secrets } = makeEnv();
    secrets.setJson('google.tokens', { access_token: 'OLD', refresh_token: 'REVOKED', expires_at: 0 });
    const f = fakeFetch(() => json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400));
    const p = googleAccessToken('cid', secrets, f as any);
    await expect(p).rejects.toBeInstanceOf(AuthExpiredError);
    await expect(googleAccessToken('cid', secrets, f as any)).rejects.toThrow(/nu este conectat/);
    expect(secrets.has('google.tokens')).toBe(false);
  });

  it('Google: eroare temporară nu șterge tokenurile', async () => {
    const { secrets } = makeEnv();
    secrets.setJson('google.tokens', { access_token: 'OLD', refresh_token: 'RT', expires_at: 0 });
    const f = fakeFetch(() => json({ error: 'invalid_request' }, 400));
    await expect(googleAccessToken('cid', secrets, f as any)).rejects.toThrow(/Reîmprospătare token Gmail/);
    expect(secrets.has('google.tokens')).toBe(true);
  });

  it('Google: fără refresh token → AuthExpiredError', async () => {
    const { secrets } = makeEnv();
    secrets.setJson('google.tokens', { access_token: 'OLD', expires_at: 0 });
    await expect(googleAccessToken('cid', secrets, fakeFetch() as any)).rejects.toBeInstanceOf(AuthExpiredError);
  });

  it('Microsoft: salvează refresh token-ul rotit', async () => {
    const { secrets } = makeEnv();
    secrets.setJson('microsoft.tokens', { access_token: 'OLD', refresh_token: 'RT1', expires_at: 0 });
    const f = fakeFetch((u) => (u.includes('login.microsoftonline.com') ? json({ access_token: 'MS-NEW', refresh_token: 'RT2', expires_in: 3600 }) : undefined));
    expect(await microsoftAccessToken('mcid', secrets, f as any)).toBe('MS-NEW');
    expect(secrets.getJson<any>('microsoft.tokens').refresh_token).toBe('RT2');
  });

  it('Microsoft: invalid_grant → reconectare', async () => {
    const { secrets } = makeEnv();
    secrets.setJson('microsoft.tokens', { access_token: 'OLD', refresh_token: 'RT1', expires_at: 0 });
    const f = fakeFetch(() => json({ error: 'invalid_grant' }, 400));
    await expect(microsoftAccessToken('mcid', secrets, f as any)).rejects.toThrow(/Reconectează Outlook/);
    expect(secrets.has('microsoft.tokens')).toBe(false);
  });
});
