import { describe, expect, it, vi } from 'vitest';
import { normalizePhone, isValidPhone } from '../src/main/delivery/phone';
import { buildTemplatePayload, WhatsAppCloud } from '../src/main/delivery/whatsappCloud';
import { buildRawMime } from '../src/main/delivery/email';

describe('phone', () => {
  it.each([
    ['0722 123 456', '40722123456'],
    ['+40 722-123-456', '40722123456'],
    ['0040722123456', '40722123456'],
    ['40722123456', '40722123456'],
  ])('%s → %s', (i, o) => expect(normalizePhone(i)).toBe(o));
  it('validare', () => {
    expect(isValidPhone('0722123456')).toBe(true);
    expect(isValidPhone('123')).toBe(false);
  });
});

describe('WhatsApp Cloud API', () => {
  const cfg = { token: 't', phoneNumberId: '111', templateName: 'factura_noua', templateLang: 'ro', bodyParam: true, apiVersion: 'v21.0' };
  it('payload șablon cu document în header', () => {
    const p = buildTemplatePayload(cfg, '0722123456', 'MEDIA1', 'f.pdf', 'Meta · 10 RON');
    expect(p.to).toBe('40722123456');
    expect(p.template.components[0]).toEqual({ type: 'header', parameters: [{ type: 'document', document: { id: 'MEDIA1', filename: 'f.pdf' } }] });
    expect(p.template.components[1].parameters[0].text).toBe('Meta · 10 RON');
  });
  it('upload + send', async () => {
    const f = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith('/media')) return new Response(JSON.stringify({ id: 'M9' }), { status: 200 });
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.1' }] }), { status: 200 });
    });
    const id = await new WhatsAppCloud(cfg, f as any).sendDocument('0722123456', Buffer.from('%PDF'), 'a.pdf', 'x');
    expect(id).toBe('wamid.1');
    expect(f.mock.calls[0][0]).toBe('https://graph.facebook.com/v21.0/111/media');
    expect(JSON.parse((f.mock.calls[1][1] as any).body).template.components[0].parameters[0].document.id).toBe('M9');
  });
  it('propagă eroarea Meta', async () => {
    const f = async () => new Response(JSON.stringify({ error: { message: 'Template name does not exist' } }), { status: 400 });
    await expect(new WhatsAppCloud(cfg, f as any).sendTemplate('40722123456', null, 'a.pdf', 'x')).rejects.toThrow(/Template name/);
  });
});

describe('email MIME', () => {
  it('conține atașamentul PDF', async () => {
    const raw = (await buildRawMime('eu@firma.ro', { to: 'c@cabinet.ro', subject: 'Factură', text: 'Bună', attachment: { fileName: 'f.pdf', data: Buffer.from('%PDF-1.4') } })).toString();
    expect(raw).toContain('To: c@cabinet.ro');
    expect(raw).toContain('filename=f.pdf');
    expect(raw).toContain('application/pdf');
  });
});
