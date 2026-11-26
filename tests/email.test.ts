import { describe, expect, it, vi } from 'vitest';
import { buildRawMime, sendEmail } from '../src/main/delivery/email';
import { fakeFetch, json, makeEnv } from './helpers';

vi.mock('nodemailer', () => {
  const sendMail = vi.fn(async () => ({ messageId: 'smtp-1' }));
  const createTransport = vi.fn(() => ({ sendMail }));
  return { default: { createTransport }, createTransport, __sendMail: sendMail };
});

const att = { fileName: 'Factură Șoșoni – nr. 12.pdf', data: Buffer.from('%PDF-1.4'), mimeType: 'application/pdf' };

describe('email', () => {
  it('MIME: subiect și nume fișier cu diacritice codate corect (RFC 2047/2231)', async () => {
    const raw = (await buildRawMime('eu@firma.ro', { to: 'ana@cabinet.ro', subject: '[FacturaBot] Factură eMAG – 1.249,99 RON', text: 'Bună ziua', attachment: att })).toString();
    expect(raw).toMatch(/^Subject: =\?UTF-8\?/m); // nu bytes brute
    expect(raw).toMatch(/filename\*0\*=utf-8''|filename="=\?UTF-8\?/i);
    expect(raw).toContain('Content-Type: application/pdf');
    // eslint-disable-next-line no-control-regex
    expect(/[^\x00-\x7F]/.test(raw)).toBe(false); // mesaj 7-bit sigur
  });

  it('Gmail API: trimite raw base64url', async () => {
    const { settings, secrets } = makeEnv();
    const f = fakeFetch((u) => (u.endsWith('/messages/send') ? json({ id: 'g1' }) : undefined));
    await sendEmail(settings.get(), secrets, { to: 'ana@cabinet.ro', subject: 's', text: 't', attachment: att }, f as any);
    const body = JSON.parse((f.mock.calls[0][1] as any).body);
    expect(Buffer.from(body.raw, 'base64url').toString()).toContain('To: ana@cabinet.ro');
  });

  it('Gmail API: eroare 403 (scope lipsă) se propagă', async () => {
    const { settings, secrets } = makeEnv();
    const f = fakeFetch(() => json({ error: { message: 'Insufficient Permission' } }, 403));
    await expect(sendEmail(settings.get(), secrets, { to: 'a@b.ro', subject: 's', text: 't' }, f as any)).rejects.toThrow(/Gmail send 403/);
  });

  it('Outlook: sendMail cu atașament base64 și nume cu diacritice', async () => {
    const { settings, secrets } = makeEnv({ delivery: { emailProvider: 'outlook' } });
    secrets.setJson('microsoft.tokens', { access_token: 'MS', refresh_token: 'R', expires_at: Date.now() + 3600_000 });
    const f = fakeFetch((u) => (u.endsWith('/me/sendMail') ? new Response(null, { status: 202 }) : undefined));
    await sendEmail(settings.get(), secrets, { to: 'ana@cabinet.ro', subject: 'Factură', text: 't', attachment: att }, f as any);
    const body = JSON.parse((f.mock.calls[0][1] as any).body);
    expect(body.message.attachments[0].name).toBe(att.fileName);
    expect(Buffer.from(body.message.attachments[0].contentBytes, 'base64').toString()).toBe('%PDF-1.4');
    expect((f.mock.calls[0][1] as any).headers.Authorization).toBe('Bearer MS');
  });

  it('SMTP: folosește setările și parola din seif', async () => {
    const nm: any = await import('nodemailer');
    const { settings, secrets } = makeEnv({ delivery: { emailProvider: 'smtp', smtp: { host: 'smtp.firma.ro', port: 587, secure: false, user: 'eu@firma.ro', from: '' } } });
    secrets.set('smtp.password', 'p@ss');
    await sendEmail(settings.get(), secrets, { to: 'ana@cabinet.ro', subject: 's', text: 't', attachment: att });
    expect(nm.createTransport).toHaveBeenCalledWith(expect.objectContaining({ host: 'smtp.firma.ro', port: 587, auth: { user: 'eu@firma.ro', pass: 'p@ss' } }));
    expect(nm.__sendMail).toHaveBeenCalledWith(expect.objectContaining({ from: 'eu@firma.ro', to: 'ana@cabinet.ro' }));
  });
});
