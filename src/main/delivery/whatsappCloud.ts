import { normalizePhone } from './phone.js';

/**
 * WhatsApp Business Cloud API (oficial, Meta).
 * Pentru a scrie primul unei persoane (în afara ferestrei de 24h) trebuie un șablon aprobat.
 * Șablonul recomandat: categoria „Utility”, header de tip DOCUMENT, corp cu o variabilă {{1}}, ex.:
 *   „Bună ziua! Vă trimit o factură nouă: {{1}}.”
 */
export interface CloudConfig {
  token: string;
  phoneNumberId: string;
  templateName: string;
  templateLang: string;
  bodyParam: boolean;
  apiVersion: string;
}

export function buildTemplatePayload(cfg: CloudConfig, to: string, mediaId: string | null, fileName: string, description: string) {
  const components: any[] = [];
  if (mediaId) components.push({ type: 'header', parameters: [{ type: 'document', document: { id: mediaId, filename: fileName } }] });
  if (cfg.bodyParam) components.push({ type: 'body', parameters: [{ type: 'text', text: description.slice(0, 900) }] });
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: normalizePhone(to),
    type: 'template',
    template: { name: cfg.templateName, language: { code: cfg.templateLang || 'ro' }, components },
  };
}

export class WhatsAppCloud {
  constructor(private cfg: CloudConfig, private f: typeof fetch = fetch) {}

  private url(p: string) {
    return `https://graph.facebook.com/${this.cfg.apiVersion || 'v21.0'}/${p}`;
  }

  async uploadPdf(data: Buffer, fileName: string): Promise<string> {
    const fd = new FormData();
    fd.append('messaging_product', 'whatsapp');
    fd.append('type', 'application/pdf');
    fd.append('file', new Blob([new Uint8Array(data)], { type: 'application/pdf' }), fileName);
    const r = await this.f(this.url(`${this.cfg.phoneNumberId}/media`), {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.cfg.token}` },
      body: fd,
    });
    const j: any = await r.json();
    if (!r.ok || !j.id) throw new Error(`WhatsApp Cloud upload: ${j.error?.message ?? r.status}`);
    return j.id;
  }

  async sendTemplate(to: string, mediaId: string | null, fileName: string, description: string) {
    const r = await this.f(this.url(`${this.cfg.phoneNumberId}/messages`), {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.cfg.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildTemplatePayload(this.cfg, to, mediaId, fileName, description)),
    });
    const j: any = await r.json();
    if (!r.ok) throw new Error(`WhatsApp Cloud: ${j.error?.message ?? r.status}${j.error?.error_data?.details ? ' – ' + j.error.error_data.details : ''}`);
    return j.messages?.[0]?.id as string | undefined;
  }

  async sendDocument(to: string, data: Buffer, fileName: string, description: string) {
    const id = await this.uploadPdf(data, fileName);
    return this.sendTemplate(to, id, fileName, description);
  }

  async verify(): Promise<string> {
    const r = await this.f(this.url(`${this.cfg.phoneNumberId}?fields=display_phone_number,verified_name`), {
      headers: { Authorization: `Bearer ${this.cfg.token}` },
    });
    const j: any = await r.json();
    if (!r.ok) throw new Error(j.error?.message ?? `HTTP ${r.status}`);
    return `${j.verified_name ?? ''} ${j.display_phone_number ?? ''}`.trim();
  }
}
