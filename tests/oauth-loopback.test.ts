import { describe, expect, it } from 'vitest';
import { connectGoogle } from '../src/main/oauth/google';
import { connectMicrosoft } from '../src/main/oauth/microsoft';
import { makePkce, runLoopbackAuth } from '../src/main/oauth/loopback';
import { fakeFetch, json, makeEnv } from './helpers';

/** Simulează browserul: urmează redirect-ul către serverul local cu code + state. */
const browser = (code = 'CODE', tamperState = false) => async (authUrl: string) => {
  const u = new URL(authUrl);
  const redirect = u.searchParams.get('redirect_uri')!;
  const state = tamperState ? 'atac' : u.searchParams.get('state')!;
  setTimeout(() => fetch(`${redirect}?code=${code}&state=${state}`).catch(() => undefined), 5);
};

describe('OAuth loopback (desktop, PKCE)', () => {
  it('PKCE: challenge diferit de verifier, base64url', () => {
    const p = makePkce();
    expect(p.verifier).not.toBe(p.challenge);
    expect(p.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('Google: flux complet + salvează tokenurile și contul', async () => {
    const { secrets } = makeEnv();
    secrets.clear('google.tokens');
    let authUrl = '';
    const f = fakeFetch(
      (u, init) => {
        if (!u.includes('oauth2.googleapis.com/token')) return undefined;
        const b = init!.body as URLSearchParams;
        expect(b.get('code')).toBe('CODE');
        expect(b.get('code_verifier')).toBeTruthy();
        expect(b.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
        return json({ access_token: 'AT1', refresh_token: 'RT1', expires_in: 3600 });
      },
      (u) => (u.includes('/profile') ? json({ emailAddress: 'firma@gmail.com' }) : undefined),
    );
    const t = await connectGoogle(
      'cid.apps.googleusercontent.com',
      secrets,
      async (url) => {
        authUrl = url;
        await browser()(url);
      },
      f as any,
      5000,
    );
    expect(t.account).toBe('firma@gmail.com');
    expect(secrets.getJson<any>('google.tokens').refresh_token).toBe('RT1');
    const q = new URL(authUrl).searchParams;
    expect(q.get('scope')).toContain('gmail.readonly');
    expect(q.get('scope')).toContain('gmail.send');
    expect(q.get('access_type')).toBe('offline');
    expect(q.get('code_challenge_method')).toBe('S256');
  });

  it('Microsoft: flux complet', async () => {
    const { secrets } = makeEnv();
    const f = fakeFetch(
      (u) => (u.includes('login.microsoftonline.com') ? json({ access_token: 'MS', refresh_token: 'R', expires_in: 3600 }) : undefined),
      (u) => (u.endsWith('/v1.0/me') ? json({ mail: 'eu@firma.onmicrosoft.com' }) : undefined),
    );
    const t = await connectMicrosoft('mcid', secrets, browser(), f as any, 5000);
    expect(t.account).toBe('eu@firma.onmicrosoft.com');
  });

  it('state falsificat → refuzat (CSRF)', async () => {
    await expect(
      runLoopbackAuth({ buildAuthUrl: (r, s) => `https://auth?redirect_uri=${encodeURIComponent(r)}&state=${s}`, openBrowser: browser('X', true), timeoutMs: 5000 }),
    ).rejects.toThrow(/invalid/);
  });

  it('expiră dacă utilizatorul nu termină logarea', async () => {
    await expect(runLoopbackAuth({ buildAuthUrl: () => 'https://auth', openBrowser: () => undefined, timeoutMs: 50 })).rejects.toThrow(/expirat/);
  });

  it('fără Client ID → mesaj care trimite la README', async () => {
    const { secrets } = makeEnv();
    await expect(connectGoogle('', secrets, () => undefined)).rejects.toThrow(/README/);
    await expect(connectMicrosoft('', secrets, () => undefined)).rejects.toThrow(/README/);
  });
});
