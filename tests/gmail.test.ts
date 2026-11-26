import { describe, expect, it, vi } from 'vitest';
import { buildGmailQuery, gmailSource } from '../src/main/sources/gmail';
import type { SourceContext } from '../src/main/sources/types';
import { b64url, fakeFetch, json, makeEnv, noSleep } from './helpers';

const PDF = Buffer.from('%PDF-1.4 factura meta');

function gmailApi(opts: { rateLimitOnce?: boolean } = {}) {
  let limited = !opts.rateLimitOnce;
  const messages: Record<string, any> = {
    m1: {
      id: 'm1',
      snippet: 'Your receipt from Meta',
      payload: {
        headers: [
          { name: 'From', value: 'Meta for Business <advertise-noreply@support.facebook.com>' },
          { name: 'Subject', value: 'Factură fiscală nr. FB-2026-0042' },
          { name: 'Date', value: 'Tue, 24 Nov 2026 10:00:00 +0200' },
        ],
        parts: [{ partId: '1', mimeType: 'application/pdf', filename: 'Factură_Șoșoni\r\n.pdf', body: { attachmentId: 'A1', size: PDF.length } }],
      },
    },
    m2: {
      id: 'm2',
      snippet: 'Newsletter noiembrie',
      payload: {
        headers: [
          { name: 'From', value: 'Magazin <newsletter@magazin.ro>' },
          { name: 'Subject', value: 'Newsletter: oferte de Black Friday' },
        ],
        parts: [{ partId: '1', mimeType: 'application/pdf', filename: 'catalog.pdf', body: { attachmentId: 'A2', size: 10 } }],
      },
    },
    m3: {
      id: 'm3',
      snippet: 'invoice attached',
      payload: {
        headers: [
          { name: 'From', value: 'Stripe <invoice@stripe.com>' },
          { name: 'Subject', value: 'Your invoice' },
        ],
        parts: [{ partId: '1', mimeType: 'application/pdf', filename: 'invoice-big.pdf', body: { attachmentId: 'A3', size: 200 * 1024 * 1024 } }],
      },
    },
  };
  return fakeFetch((u) => {
    if (!u.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/')) return undefined;
    if (!limited) {
      limited = true;
      return json({ error: { message: 'Rate Limit Exceeded' } }, 429, { 'retry-after': '0' });
    }
    if (u.includes('/messages?')) return json({ messages: [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }] });
    const att = u.match(/messages\/(\w+)\/attachments\/(\w+)/);
    if (att) return json({ data: b64url(PDF) });
    const msg = u.match(/messages\/(\w+)\?format=full/);
    if (msg) return json(messages[msg[1]]);
    return undefined;
  });
}

function ctx(f: any, patch = {}): SourceContext {
  const env = makeEnv({ sources: { gmail: { enabled: true } }, ...patch });
  return { settings: env.settings.get(), secrets: env.secrets, since: new Date('2026-11-01'), log: vi.fn(), isKnown: () => false, fetch: f, retry: noSleep };
}

describe('Gmail', () => {
  it('găsește facturile PDF, ignoră newsletterele și atașamentele prea mari', async () => {
    const f = gmailApi();
    const c = ctx(f);
    const docs = await gmailSource.fetchNew(c);
    expect(docs).toHaveLength(1);
    const d = docs[0];
    expect(d.vendor).toBe('Meta (Facebook/Instagram Ads)');
    expect(d.fileName).toBe('Factură_Șoșoni.pdf'); // diacritice păstrate, CR/LF eliminate
    expect(d.data?.equals(PDF)).toBe(true);
    expect(d.seriesNumber).toMatch(/2026/);
    expect(d.externalId).toBe('m1:1:Factură_Șoșoni\r\n.pdf');
    expect(c.log).toHaveBeenCalledWith('warn', expect.stringMatching(/prea mare/));
    // toate cererile au tokenul
    for (const call of f.mock.calls) expect((call[1] as any).headers.Authorization).toBe('Bearer AT');
  });

  it('reîncearcă după 429 (rate limit)', async () => {
    const docs = await gmailSource.fetchNew(ctx(gmailApi({ rateLimitOnce: true })));
    expect(docs).toHaveLength(1);
  });

  it('nu redescarcă documentele cunoscute', async () => {
    const f = gmailApi();
    const c = { ...ctx(f), isKnown: (id: string) => id.startsWith('m1:') };
    expect(await gmailSource.fetchNew(c)).toHaveLength(0);
    expect(f.mock.calls.some((x) => String(x[0]).includes('/attachments/'))).toBe(false);
  });

  it('respectă expeditorii excluși din setări', async () => {
    const docs = await gmailSource.fetchNew(ctx(gmailApi(), { detection: { excludeSenders: ['support.facebook.com'] } }));
    expect(docs).toHaveLength(0);
  });

  it('eroare 401 Gmail se propagă lizibil', async () => {
    const f = fakeFetch(() => json({ error: { message: 'Invalid Credentials' } }, 401));
    await expect(gmailSource.fetchNew(ctx(f))).rejects.toThrow(/Gmail 401/);
  });

  it('query: dată, excluderi, cuvinte cheie extra', () => {
    const q = buildGmailQuery(new Date(1_700_000_000_000), 'label:firma', { extraKeywords: ['aviz de plată'], excludeSenders: ['spam@x.ro'] });
    expect(q).toContain('after:1700000000');
    expect(q).toContain('-from:spam@x.ro');
    expect(q).toContain('"aviz de plată"');
    expect(q.endsWith('label:firma')).toBe(true);
    expect(q).toContain('-in:sent');
  });
});
