import type { SecretStore } from '../secrets.js';
import { AuthExpiredError, fetchWithRetry } from '../http.js';
import type { OAuthTokens } from './google.js';
import { makePkce, runLoopbackAuth } from './loopback.js';

const AUTHORITY = 'https://login.microsoftonline.com/common/oauth2/v2.0';
export const MS_SCOPES = ['offline_access', 'User.Read', 'Mail.Read', 'Mail.Send'];

export async function connectMicrosoft(
  clientId: string,
  secrets: SecretStore,
  openBrowser: (u: string) => void | Promise<void>,
  f: typeof fetch = fetch,
  timeoutMs?: number,
): Promise<OAuthTokens> {
  if (!clientId) throw new Error('Lipsește Microsoft (Azure) Client ID (vezi README → „Outlook”).');
  const pkce = makePkce();
  const { code, redirectUri } = await runLoopbackAuth({
    host: 'localhost',
    openBrowser,
    timeoutMs,
    buildAuthUrl: (redirect, state) =>
      `${AUTHORITY}/authorize?` +
      new URLSearchParams({
        client_id: clientId,
        response_type: 'code',
        redirect_uri: redirect,
        response_mode: 'query',
        scope: MS_SCOPES.join(' '),
        code_challenge: pkce.challenge,
        code_challenge_method: 'S256',
        state,
        prompt: 'select_account',
      }).toString(),
  });
  const r = await f(`${AUTHORITY}/token`, {
    method: 'POST',
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: pkce.verifier,
      scope: MS_SCOPES.join(' '),
    }),
  });
  const j: any = await r.json();
  if (!r.ok) throw new Error(`Microsoft token: ${j.error_description || j.error}`);
  let account: string | undefined;
  try {
    const me: any = await (await f('https://graph.microsoft.com/v1.0/me', { headers: { Authorization: `Bearer ${j.access_token}` } })).json();
    account = me.mail || me.userPrincipalName;
  } catch {
    /* ignorăm */
  }
  const t: OAuthTokens = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + (j.expires_in - 60) * 1000, account };
  secrets.setJson('microsoft.tokens', t);
  return t;
}

let refreshing: Promise<string> | null = null;

export async function microsoftAccessToken(clientId: string, secrets: SecretStore, f: typeof fetch = fetch): Promise<string> {
  const t = secrets.getJson<OAuthTokens>('microsoft.tokens');
  if (!t) throw new AuthExpiredError('outlook', 'Outlook nu este conectat');
  if (t.expires_at > Date.now()) return t.access_token;
  if (!t.refresh_token) throw new AuthExpiredError('outlook', 'Sesiunea Outlook a expirat – reconectează contul');
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const r = await fetchWithRetry(f, `${AUTHORITY}/token`, {
      method: 'POST',
      body: new URLSearchParams({ client_id: clientId, grant_type: 'refresh_token', refresh_token: t.refresh_token!, scope: MS_SCOPES.join(' ') }),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (j.error === 'invalid_grant' || j.error === 'interaction_required') {
        secrets.clear('microsoft.tokens');
        throw new AuthExpiredError('outlook', 'Accesul la Outlook a fost revocat sau a expirat. Reconectează Outlook din Setări.');
      }
      throw new Error(`Reîmprospătare token Outlook eșuată: ${j.error_description || j.error || r.status}`);
    }
    // Microsoft rotește refresh token-ul: îl salvăm pe cel nou imediat.
    const nt: OAuthTokens = { ...t, access_token: j.access_token, refresh_token: j.refresh_token ?? t.refresh_token, expires_at: Date.now() + (j.expires_in - 60) * 1000 };
    secrets.setJson('microsoft.tokens', nt);
    return nt.access_token;
  })();
  try {
    return await refreshing;
  } finally {
    refreshing = null;
  }
}
