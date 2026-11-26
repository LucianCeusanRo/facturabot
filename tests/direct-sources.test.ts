import { describe, expect, it, vi } from 'vitest';
import { AuthExpiredError } from '../src/main/http';
import { connectGoogleAds, googleAdsAccessToken } from '../src/main/oauth/google';
import { downloadPdf } from '../src/main/sources/download';
import { googleAdsError, googleAdsSource, issueMonths } from '../src/main/sources/googleAds';
import { META_FIELDS, metaError, metaSource } from '../src/main/sources/meta';
import { sourceById, SOURCES } from '../src/main/sources/registry';
import { tiktokError, tiktokInvoiceList, tiktokSource } from '../src/main/sources/tiktok';
import type { SourceContext } from '../src/main/sources/types';
import { fakeFetch, json, makeEnv, noSleep } from './helpers';

const PDF = Buffer.from('%PDF-1.7 factura');
const pdf = () => new Response(PDF, { headers: { 'content-type': 'application/pdf' } });

function ctx(env: ReturnType<typeof makeEnv>, f: any, known: string[] = []): SourceContext & { logs: string[] } {
  const logs: string[] = [];
  return {
    settings: env.settings.get(),
    secrets: env.secrets,
    since: new Date('2026-10-01T00:00:00Z'),
    log: (_l, m) => logs.push(m),
    isKnown: (id) => known.includes(id),
    fetch: f,
    retry: { retries: 0, ...noSleep },
    logs,
  };
}

describe('registry', () => {
  it('conține sursele directe opționale, fiecare cu test de conexiune', () => {
    for (const id of ['meta', 'tiktok', 'googleAds']) expect(sourceById(id)?.test).toBeTypeOf('function');
    expect(SOURCES.map((s) => s.id)).toEqual(expect.arrayContaining(['gmail', 'outlook', 'fgo', 'meta', 'tiktok', 'googleAds']));
    expect(sourceById('nope')).toBeUndefined();
  });
});

describe('downloadPdf', () => {
  it('acceptă după semnătură sau content-type, respinge HTML/erori', async () => {
    expect(await downloadPdf(fakeFetch(pdf) as any, 'https://x', {})).toEqual(PDF);
    expect(await downloadPdf(fakeFetch(() => new Response('abc', { headers: { 'content-type': 'application/pdf' } })) as any, 'https://x', {})).toEqual(Buffer.from('abc'));
    expect(await downloadPdf(fakeFetch(() => new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } })) as any, 'https://x', {})).toBeNull();
    expect(await downloadPdf(fakeFetch(() => new Response('x', { status: 403 })) as any, 'https://x', {}, { retries: 0, ...noSleep })).toBeNull();
  });
});

describe('Meta business_invoices', () => {
  const env = () => {
    const e = makeEnv({ sources: { meta: { enabled: true, businessId: '1048573' } } });
    e.secrets.set('meta.token', 'META_TOKEN');
    return e;
  };

  it('listează facturile, descarcă PDF-ul (download_uri cu token, apoi CDN), paginează', async () => {
    const e = env();
    const calls: string[] = [];
    const f = fakeFetch((u, init) => {
      calls.push(u);
      const auth = (init?.headers as Record<string, string>)?.Authorization;
      if (u.includes('/business_invoices') && !u.includes('after=')) {
        expect(auth).toBe('Bearer META_TOKEN');
        const q = new URL(u).searchParams;
        expect(q.get('fields')).toBe(META_FIELDS);
        expect(q.get('issue_start_date')).toBe('2026-10-01');
        return json({
          data: [
            { id: '901', invoice_id: '4521-1190', invoice_date: '2026-11-01T00:00:00+0000', due_date: '2026-12-01', amount: '3412.50', currency: 'ron', payment_status: 'PAID', billing_period: '2026-10-01', download_uri: 'https://graph.facebook.com/v27.0/901/pdf', cdn_download_uri: 'https://cdn.fbsbx.com/901.pdf' },
            { id: '902', invoice_id: '4521-1191', amount: 'n/a', download_uri: 'http://insecure', cdn_download_uri: 'https://cdn.fbsbx.com/902.pdf', payment_status: 'unpaid' },
            { id: '903', invoice_id: 'known' },
          ],
          paging: { next: 'https://graph.facebook.com/v27.0/1048573/business_invoices?after=X' },
        });
      }
      if (u.includes('after=X')) return json({ data: [{ id: '904', invoice_id: '4521-1200', amount: '10', currency: 'EUR' }] });
      if (u.endsWith('/901/pdf')) return new Response('{"error":{}}', { status: 500 });
      if (u.endsWith('901.pdf')) return pdf();
      if (u.endsWith('902.pdf')) return pdf();
      return undefined;
    });
    const c = ctx(e, f, ['inv:903']);
    const docs = await metaSource.fetchNew(c);
    expect(docs.map((d) => d.seriesNumber)).toEqual(['4521-1190', '4521-1191', '4521-1200']);
    expect(docs[0]).toMatchObject({ externalId: 'inv:901', amount: 3412.5, currency: 'RON', invoiceDate: '2026-11-01', dueDate: '2026-12-01', paid: true, platform: 'meta', data: PDF, summary: null });
    expect(docs[0].subject).toContain('2026-10');
    expect(docs[1]).toMatchObject({ amount: null, paid: false, data: PDF });
    expect(docs[2]).toMatchObject({ data: null, paid: null });
    expect(docs[2].summary).toContain('Meta Business');
    expect(calls).not.toContain('http://insecure');
  });

  it('paginarea nu poate fi deturnată spre alt domeniu (tokenul nu pleacă din Graph API)', async () => {
    const e = env();
    const f = fakeFetch((u) => (u.includes('/business_invoices') ? json({ data: [], paging: { next: 'https://evil.example/steal' } }) : undefined));
    await expect(metaSource.fetchNew(ctx(e, f))).rejects.toThrow(/URL Meta neașteptat/);
    expect(f.mock.calls.some(([u]) => String(u).includes('evil'))).toBe(false);
  });

  it('erori: token expirat → AuthExpiredError; permisiuni; parametri', async () => {
    expect(metaError(400, { error: { code: 190 } })).toBeInstanceOf(AuthExpiredError);
    expect(metaError(403, {}).message).toMatch(/business_management/);
    expect(metaError(400, { error: { code: 100, message: 'Unsupported get request' } }).message).toMatch(/parametru invalid/);
    expect(metaError(500, { error: { message: 'x', fbtrace_id: 'T' } }).message).toBe('Meta 500: x (fbtrace T)');
    const e = env();
    e.secrets.clear('meta.token');
    await expect(metaSource.fetchNew(ctx(e, fakeFetch()))).rejects.toBeInstanceOf(AuthExpiredError);
  });

  it('Testează conexiunea: business + acces la facturi; mesaje clare pentru lipsuri', async () => {
    const e = env();
    const f = fakeFetch(
      (u) => (u.includes('/1048573?fields=id,name') ? json({ id: '1048573', name: 'Atelier Verde' }) : undefined),
      (u) => (u.includes('/business_invoices') ? json({ data: [{ id: '1' }] }) : undefined),
    );
    expect(await metaSource.test!({ settings: e.settings.get(), secrets: e.secrets, fetch: f as any })).toEqual({ ok: true, info: 'Business: Atelier Verde. Facturile lunare sunt accesibile.' });
    const none = fakeFetch((u) => (u.includes('business_invoices') ? json({ data: [] }) : json({ id: '1' })));
    expect((await metaSource.test!({ settings: e.settings.get(), secrets: e.secrets, fetch: none as any })).info).toMatch(/cardul/);
    const bad = fakeFetch(() => json({ error: { code: 190, message: 'expired' } }, 400));
    expect(await metaSource.test!({ settings: e.settings.get(), secrets: e.secrets, fetch: bad as any, retry: noSleep })).toMatchObject({ ok: false, error: expect.stringMatching(/expirat/) });
    e.secrets.clear('meta.token');
    expect((await metaSource.test!({ settings: e.settings.get(), secrets: e.secrets, fetch: f as any })).error).toMatch(/tokenul/);
    e.settings.update({ sources: { meta: { businessId: '' } } });
    expect((await metaSource.test!({ settings: e.settings.get(), secrets: e.secrets, fetch: f as any })).error).toMatch(/Business ID/);
    expect(metaSource.isEnabled(e.settings.get(), e.secrets)).toBe(false);
  });
});

describe('TikTok /bc/invoice/get/', () => {
  const env = () => {
    const e = makeEnv({ sources: { tiktok: { enabled: true, bcId: '7000123', invoiceTypes: ['RECON'] } } });
    e.secrets.set('tiktok.token', 'TT');
    return e;
  };

  it('pagini, antet Access-Token, invoice_types JSON, descărcare PDF, câmpuri tolerante', async () => {
    const e = env();
    const f = fakeFetch((u, init) => {
      const h = init?.headers as Record<string, string>;
      expect(h['Access-Token']).toBe('TT');
      const q = new URL(u).searchParams;
      if (u.includes('/bc/invoice/get/')) {
        expect(q.get('bc_id')).toBe('7000123');
        expect(q.get('invoice_types')).toBe('["RECON"]');
        expect(q.get('start_time')).toBe('2026-10-01 00:00:00');
        if (q.get('page') === '1')
          return json({ code: 0, message: 'OK', data: { invoices: [{ invoice_id: 'A1', invoice_serial_number: 'BDUK001', amount: '150.00', currency: 'eur', invoice_date: '2026-10-31', due_date: '2026-11-30', payment_status: 'paid' }, { invoice_id: '' }], page_info: { total_page: 2 } } });
        return json({ code: 0, data: { list: [{ id: 'A2', total_amount: 'x', status: 'UNPAID' }, { id: 'K' }], page_info: { total_page: 2 } } });
      }
      if (u.includes('/bc/invoice/download/')) return q.get('invoice_id') === 'A1' ? pdf() : json({ code: 40002, message: 'no file' });
      return undefined;
    });
    const c = ctx(e, f, ['inv:K']);
    const docs = await tiktokSource.fetchNew(c);
    expect(docs).toHaveLength(2);
    expect(docs[0]).toMatchObject({ externalId: 'inv:A1', seriesNumber: 'BDUK001', amount: 150, currency: 'EUR', invoiceDate: '2026-10-31', dueDate: '2026-11-30', paid: true, data: PDF, platform: 'tiktok' });
    expect(docs[1]).toMatchObject({ seriesNumber: 'A2', amount: null, paid: false, data: null });
    expect(c.logs.join()).toMatch(/nu a venit ca PDF/);
  });

  it('erori și test conexiune', async () => {
    expect(tiktokError(200, { code: 40105 })).toBeInstanceOf(AuthExpiredError);
    expect(tiktokError(200, { code: 40002, message: 'bad bc_id' }).message).toMatch(/parametru invalid/);
    expect(tiktokError(500, { code: 51000, message: 'busy' }).message).toBe('TikTok 500 / 51000: busy');
    expect(tiktokInvoiceList({ invoice_list: [1] })).toEqual([1]);
    expect(tiktokInvoiceList(null)).toEqual([]);
    const e = env();
    const f = fakeFetch(
      (u) => (u.includes('/bc/get/') ? json({ code: 0, data: { list: [{ bc_info: { name: 'Atelier BC' } }] } }) : undefined),
      (u) => (u.includes('/bc/invoice/get/') ? json({ code: 0, data: { invoices: [], page_info: { total_number: 3 } } }) : undefined),
    );
    expect(await tiktokSource.test!({ settings: e.settings.get(), secrets: e.secrets, fetch: f as any })).toEqual({ ok: true, info: 'Business Center: Atelier BC. 3 facturi în ultimele 90 de zile.' });
    const bad = fakeFetch(() => json({ code: 40100, message: 'Access token is incorrect' }));
    expect(await tiktokSource.test!({ settings: e.settings.get(), secrets: e.secrets, fetch: bad as any })).toMatchObject({ ok: false });
    e.secrets.clear('tiktok.token');
    expect((await tiktokSource.test!({ settings: e.settings.get(), secrets: e.secrets, fetch: f as any })).error).toMatch(/tokenul/);
    await expect(tiktokSource.fetchNew(ctx(e, f))).rejects.toBeInstanceOf(AuthExpiredError);
    e.settings.update({ sources: { tiktok: { bcId: '' } } });
    expect((await tiktokSource.test!({ settings: e.settings.get(), secrets: e.secrets, fetch: f as any })).error).toMatch(/Business Center ID/);
  });
});

describe('Google Ads InvoiceService', () => {
  const env = () => {
    const e = makeEnv({ sources: { googleAds: { enabled: true, customerId: '1234567890', billingSetupId: '555', loginCustomerId: '999' } } });
    e.secrets.setJson('googleAds.tokens', { access_token: 'GA', refresh_token: 'R', expires_at: Date.now() + 3600_000 });
    e.secrets.set('googleAds.developerToken', 'DEV');
    return e;
  };

  it('issueMonths: lunile de la `since` până azi, nu înainte de 2019, max 13', () => {
    expect(issueMonths(new Date('2026-10-15Z'), new Date('2026-11-26Z'))).toEqual([
      { year: 2026, month: 'OCTOBER' },
      { year: 2026, month: 'NOVEMBER' },
    ]);
    expect(issueMonths(new Date('2025-12-01Z'), new Date('2026-01-02Z')).map((x) => x.month)).toEqual(['DECEMBER', 'JANUARY']);
    expect(issueMonths(new Date('2010-01-01Z'), new Date('2026-01-01Z'))[0]).toEqual({ year: 2019, month: 'JANUARY' });
    expect(issueMonths(new Date('2019-01-01Z'), new Date('2026-01-01Z'))).toHaveLength(13);
  });

  it('listează pe luni, antete developer-token + login-customer-id, PDF autentificat, micros → sumă', async () => {
    const e = env();
    const f = fakeFetch((u, init) => {
      const h = init?.headers as Record<string, string>;
      if (u.includes('/v26/customers/1234567890/invoices')) {
        expect(h).toMatchObject({ Authorization: 'Bearer GA', 'developer-token': 'DEV', 'login-customer-id': '999' });
        const q = new URL(u).searchParams;
        expect(q.get('billingSetup')).toBe('customers/1234567890/billingSetups/555');
        if (q.get('issueMonth') === 'OCTOBER')
          return json({ invoices: [{ id: '5214889012', totalAmountMicros: '1833100000', currencyCode: 'RON', issueDate: '2026-10-01', dueDate: '2026-10-31', pdfUrl: 'https://ads.google.com/pdf/1' }, { resourceName: '' }] });
        return json({ invoices: [{ id: 'KNOWN' }, { id: '777', pdfUrl: 'https://ads.google.com/pdf/bad' }] });
      }
      if (u.endsWith('/pdf/1')) {
        expect(h.Authorization).toBe('Bearer GA');
        return pdf();
      }
      if (u.endsWith('/pdf/bad')) return new Response('<html/>', { headers: { 'content-type': 'text/html' } });
      return undefined;
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-26T10:00:00Z'));
    try {
      const docs = await googleAdsSource.fetchNew(ctx(e, f, ['inv:KNOWN']));
      expect(docs).toHaveLength(2);
      expect(docs[0]).toMatchObject({ externalId: 'inv:5214889012', amount: 1833.1, currency: 'RON', invoiceDate: '2026-10-01', dueDate: '2026-10-31', data: PDF, platform: 'google' });
      expect(docs[1]).toMatchObject({ amount: null, data: null });
      expect(docs[1].summary).toContain('777');
    } finally {
      vi.useRealTimers();
    }
  });

  it('erori explicite + test conexiune', async () => {
    const err = (code: string) => ({ error: { message: 'm', details: [{ errors: [{ errorCode: { authorizationError: code }, message: 'd' }] }] } });
    expect(googleAdsError(401, {})).toBeInstanceOf(AuthExpiredError);
    expect(googleAdsError(403, err('DEVELOPER_TOKEN_NOT_APPROVED')).message).toMatch(/Basic access/);
    expect(googleAdsError(403, err('USER_PERMISSION_DENIED')).message).toMatch(/login-customer-id/);
    expect(googleAdsError(400, err('NOT_INVOICED_CUSTOMER')).message).toMatch(/facturare lunară/);
    expect(googleAdsError(500, { error: { message: 'boom' } }).message).toBe('Google Ads 500: boom');
    const e = env();
    const ok = fakeFetch((u) => (u.includes('/invoices') ? json({ invoices: [{ id: '1' }] }) : undefined));
    expect(await googleAdsSource.test!({ settings: e.settings.get(), secrets: e.secrets, fetch: ok as any })).toMatchObject({ ok: true, info: expect.stringMatching(/^Conectat\. 1 factură emise/) });
    const denied = fakeFetch(() => json(err('USER_PERMISSION_DENIED'), 403));
    expect(await googleAdsSource.test!({ settings: e.settings.get(), secrets: e.secrets, fetch: denied as any, retry: noSleep })).toMatchObject({ ok: false });
    e.secrets.clear('googleAds.developerToken');
    expect((await googleAdsSource.test!({ settings: e.settings.get(), secrets: e.secrets, fetch: ok as any })).error).toMatch(/developer token/);
    expect(googleAdsSource.isEnabled(e.settings.get(), e.secrets)).toBe(false);
    e.settings.update({ sources: { googleAds: { billingSetupId: '' } } });
    expect((await googleAdsSource.test!({ settings: e.settings.get(), secrets: e.secrets, fetch: ok as any })).error).toMatch(/Billing setup/);
  });

  it('OAuth Google Ads: scope adwords separat de Gmail + reîmprospătare token', async () => {
    const { secrets } = makeEnv();
    let authUrl = '';
    const f = fakeFetch(
      (u) => (u.includes('oauth2.googleapis.com/token') ? json({ access_token: 'GA1', refresh_token: 'GR', expires_in: 3600 }) : undefined),
      (u) => (u.includes('openidconnect.googleapis.com/v1/userinfo') ? json({ email: 'ads@firma.ro' }) : undefined),
    );
    const t = await connectGoogleAds(
      'cid',
      secrets,
      async (url) => {
        authUrl = url;
        const q = new URL(url).searchParams;
        setTimeout(() => fetch(`${q.get('redirect_uri')}?code=C&state=${q.get('state')}`).catch(() => undefined), 5);
      },
      f as any,
      5000,
    );
    expect(t.account).toBe('ads@firma.ro');
    expect(new URL(authUrl).searchParams.get('scope')).toContain('https://www.googleapis.com/auth/adwords');
    expect(secrets.getJson<any>('googleAds.tokens').access_token).toBe('GA1');
    expect(secrets.getJson<any>('google.tokens').access_token).toBe('AT'); // Gmail neatins

    secrets.setJson('googleAds.tokens', { access_token: 'OLD', refresh_token: 'GR', expires_at: 0 });
    const r = fakeFetch((u) => (u.includes('oauth2.googleapis.com/token') ? json({ access_token: 'NEW', expires_in: 3600 }) : undefined));
    const [a, b] = await Promise.all([googleAdsAccessToken('cid', secrets, r as any), googleAdsAccessToken('cid', secrets, r as any)]);
    expect([a, b]).toEqual(['NEW', 'NEW']);
    expect(r).toHaveBeenCalledTimes(1);
    secrets.clear('googleAds.tokens');
    await expect(googleAdsAccessToken('cid', secrets, r as any)).rejects.toBeInstanceOf(AuthExpiredError);
  });
});
