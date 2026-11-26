import { describe, expect, it, vi } from 'vitest';
import { outlookSource } from '../src/main/sources/outlook';
import { fakeFetch, json, makeEnv, noSleep } from './helpers';

const PDF = Buffer.from('%PDF-1.4 emag');

function ctx(f: any) {
  const env = makeEnv({ sources: { outlook: { enabled: true } } });
  env.secrets.setJson('microsoft.tokens', { access_token: 'MS', refresh_token: 'R', expires_at: Date.now() + 3600_000 });
  return { settings: env.settings.get(), secrets: env.secrets, since: new Date('2026-11-01'), log: vi.fn(), isKnown: () => false, fetch: f, retry: noSleep };
}

describe('Outlook (Microsoft Graph)', () => {
  it('paginează, filtrează PDF-urile de factură și decodează atașamentele', async () => {
    const f = fakeFetch((u) => {
      if (u.includes('/messages?$filter')) {
        expect(decodeURIComponent(u)).toContain('receivedDateTime ge 2026-11-01');
        return json({
          value: [{ id: 'X1', subject: 'Factura EMG 4410022', from: { emailAddress: { name: 'eMAG', address: 'facturi@emag.ro' } }, receivedDateTime: '2026-11-20T08:00:00Z', bodyPreview: '' }],
          '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/messages?page=2',
        });
      }
      if (u.includes('page=2'))
        return json({ value: [{ id: 'X2', subject: 'Poze vacanță', from: { emailAddress: { name: 'Ion', address: 'ion@gmail.com' } }, receivedDateTime: '2026-11-21T08:00:00Z' }] });
      if (u.endsWith('/messages/X1/attachments?$select=id,name,contentType,size')) return json({ value: [{ id: 'A', name: 'factura.pdf', contentType: 'application/pdf', size: 100 }, { id: 'B', name: 'logo.png', contentType: 'image/png', size: 5 }] });
      if (u.endsWith('/messages/X2/attachments?$select=id,name,contentType,size')) return json({ value: [{ id: 'C', name: 'IMG_001.jpg', contentType: 'image/jpeg', size: 5 }] });
      if (u.endsWith('/messages/X1/attachments/A')) return json({ contentBytes: PDF.toString('base64') });
      return undefined;
    });
    const docs = await outlookSource.fetchNew(ctx(f) as any);
    expect(docs).toHaveLength(1);
    expect(docs[0].vendor).toBe('eMAG');
    expect(docs[0].data?.equals(PDF)).toBe(true);
    expect(docs[0].invoiceDate).toBe('2026-11-20');
    expect(docs[0].externalId).toBe('X1:A');
  });

  it('Graph 5xx temporar → reîncearcă', async () => {
    let n = 0;
    const f = fakeFetch((u) => {
      if (u.includes('/messages?$filter')) return n++ === 0 ? json({}, 503) : json({ value: [] });
      return undefined;
    });
    expect(await outlookSource.fetchNew(ctx(f) as any)).toEqual([]);
    expect(n).toBe(2);
  });
});
