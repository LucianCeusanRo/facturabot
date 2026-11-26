import type { DeliveryChannel, Settings } from '../../shared/types.js';
import type { SecretStore } from '../secrets.js';
import { sendEmail } from './email.js';
import { WhatsAppCloud } from './whatsappCloud.js';
import type { WhatsAppWeb } from './whatsappWeb.js';

export interface Deliverable {
  fileName: string;
  data: Buffer;
  mimeType?: string;
  /** Text scurt: „Factură Meta – 123,45 RON – 2026-11-18” */
  description: string;
}

export interface DeliveryDeps {
  settings: Settings;
  secrets: SecretStore;
  waWeb: Pick<WhatsAppWeb, 'sendDocument'>;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
  fetch?: typeof fetch;
}

export interface DeliveryResult {
  channel: DeliveryChannel;
  fallbackReason?: string;
}

/** Trimite la contabilă pe canalul ales; dacă WhatsApp eșuează și e activat backup-ul, trimite pe email. */
export async function deliver(d: Deliverable, deps: DeliveryDeps): Promise<DeliveryResult> {
  const { settings, secrets } = deps;
  const acc = settings.accountant;
  const mode = settings.delivery.whatsappMode;
  let waError: string | undefined;

  if (mode !== 'none' && acc.whatsappNumber) {
    try {
      if (mode === 'web') {
        await deps.waWeb.sendDocument(acc.whatsappNumber, d.data, d.fileName, d.description, d.mimeType);
        return { channel: 'whatsapp-web' };
      }
      const token = secrets.get('whatsapp.cloudToken');
      if (!token) throw new Error('Lipsește tokenul WhatsApp Cloud API');
      const c = settings.delivery.cloud;
      await new WhatsAppCloud({ token, ...c }, deps.fetch).sendDocument(acc.whatsappNumber, d.data, d.fileName, d.description);
      return { channel: 'whatsapp-cloud' };
    } catch (e) {
      waError = (e as Error).message;
      deps.log('warn', `WhatsApp a eșuat (${waError})${settings.delivery.emailFallback ? ' – trimit pe email' : ''}`);
      if (!settings.delivery.emailFallback || !acc.email) throw new Error(`WhatsApp: ${waError}`);
    }
  }

  if (!acc.email) throw new Error('Nu există niciun canal configurat (WhatsApp sau email contabilă).');
  await sendEmail(
    settings,
    secrets,
    {
      to: acc.email,
      subject: `[FacturaBot] ${d.description}`,
      text: `Bună ziua${acc.name ? ' ' + acc.name : ''},\n\nVă trimit atașat documentul: ${d.description}.\n\nMesaj trimis automat de FacturaBot.`,
      attachment: { fileName: d.fileName, data: d.data, mimeType: d.mimeType },
    },
    deps.fetch,
  );
  return { channel: 'email', fallbackReason: waError };
}
