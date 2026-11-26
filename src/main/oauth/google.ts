import type { SecretStore } from '../secrets.js';
import { AuthExpiredError, fetchWithRetry } from '../http.js';
import { makePkce, runLoopbackAuth } from './loopback.js';

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'openid',
  'email',
];

export interface OAuthTokens {
  access_token: string;
  refresh_token?: string;
  expires_at: number; // ms epoch
  account?: string;
}

declare const __FB_GOOGLE_CLIENT_SECRET__: string | undefined;
const BUILD_SECRET = typeof __FB_GOOGLE_CLIENT_SECRET__ === 'string' ? __FB_GOOGLE_CLIENT_SECRET__ : '';

export function googleClientSecret(secrets: SecretStore) {
  return secrets.get('google.clientSecret') || process.env.FACTURABOT_GOOGLE_CLIENT_SECRET || BUILD_SECRET;
}

export async function connectGoogle(
  clientId: string,
  secrets: SecretStore,
  openBrowser: (u: string) => void | Promise<void>,
  f: typeof fetch = fetch,
  timeoutMs?: number,
): Promise<OAuthTokens> {
  if (!clientId) throw new Error('Lipsește Google OAuth Client ID (vezi README → „Credențiale Google”).');
  const pkce = makePkce();
  const { code, redirectUri } = await runLoopbackAuth({
    openBrowser,
    timeoutMs,
    buildAuthUrl: (redirect, state) => {
      const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      u.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirect,
        response_type: 'code',
        scope: GOOGLE_SCOPES.join(' '),
        access_type: 'offline',
        prompt: 'consent',
        code_challenge: pkce.challenge,
        code_challenge_method: 'S256',
        state,
      }).toString();
      return u.toString();
    },
  });
  const body = new URLSearchParams({
    client_id: clientId,
    code,
    code_verifier: pkce.verifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });
  const secret = googleClientSecret(secrets);
  if (secret) body.set('client_secret', secret);
  const r = await f('https://oauth2.googleapis.com/token', { method: 'POST', body });
  const j: any = await r.json();
  if (!r.ok) throw new Error(`Google token: ${j.error_description || j.error || r.status}`);
  let account: string | undefined;
  try {
    const p = await f('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { Authorization: `Bearer ${j.access_token}` } });
    account = ((await p.json()) as any).emailAddress;
  } catch {
    /* ignorăm */
  }
  const tokens: OAuthTokens = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + (j.expires_in - 60) * 1000, account };
  secrets.setJson('google.tokens', tokens);
  return tokens;
}

let refreshing: Promise<string> | null = null;

/**
 * Token de acces valid; îl reîmprospătează automat. Cereri simultane împart aceeași reîmprospătare
 * (altfel Google/Microsoft pot invalida refresh token-ul). La `invalid_grant` (token revocat, parolă
 * schimbată, aplicație în modul „Testing” > 7 zile) ștergem tokenurile și cerem reconectarea.
 */
export async function googleAccessToken(clientId: string, secrets: SecretStore, f: typeof fetch = fetch): Promise<string> {
  const t = secrets.getJson<OAuthTokens>('google.tokens');
  if (!t) throw new AuthExpiredError('gmail', 'Gmail nu este conectat');
  if (t.expires_at > Date.now()) return t.access_token;
  if (!t.refresh_token) throw new AuthExpiredError('gmail', 'Sesiunea Gmail a expirat – reconectează contul');
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const body = new URLSearchParams({ client_id: clientId, grant_type: 'refresh_token', refresh_token: t.refresh_token! });
    const secret = googleClientSecret(secrets);
    if (secret) body.set('client_secret', secret);
    const r = await fetchWithRetry(f, 'https://oauth2.googleapis.com/token', { method: 'POST', body });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (j.error === 'invalid_grant' || j.error === 'unauthorized_client') {
        secrets.clear('google.tokens');
        throw new AuthExpiredError('gmail', 'Accesul la Gmail a fost revocat sau a expirat. Reconectează Gmail din Setări.');
      }
      throw new Error(`Reîmprospătare token Gmail eșuată: ${j.error_description || j.error || r.status}`);
    }
    const nt: OAuthTokens = { ...t, access_token: j.access_token, expires_at: Date.now() + (j.expires_in - 60) * 1000 };
    if (j.refresh_token) nt.refresh_token = j.refresh_token;
    secrets.setJson('google.tokens', nt);
    return nt.access_token;
  })();
  try {
    return await refreshing;
  } finally {
    refreshing = null;
  }
}
