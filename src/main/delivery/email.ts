import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type { Settings } from '../../shared/types.js';
import type { SecretStore } from '../secrets.js';
import { googleAccessToken } from '../oauth/google.js';
import { microsoftAccessToken } from '../oauth/microsoft.js';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  attachment?: { fileName: string; data: Buffer; mimeType?: string } | null;
}

export async function buildRawMime(from: string | undefined, m: EmailMessage): Promise<Buffer> {
  const mail = new MailComposer({
    from,
    to: m.to,
    subject: m.subject,
    text: m.text,
    attachments: m.attachment ? [{ filename: m.attachment.fileName, content: m.attachment.data, contentType: m.attachment.mimeType ?? 'application/pdf' }] : [],
  });
  return mail.compile().build();
}

export async function sendEmail(settings: Settings, secrets: SecretStore, m: EmailMessage, f: typeof fetch = fetch): Promise<void> {
  const provider = settings.delivery.emailProvider;
  if (provider === 'gmail') {
    const token = await googleAccessToken(settings.oauthClients.googleClientId, secrets, f);
    const raw = (await buildRawMime(settings.sources.gmail.account, m)).toString('base64url');
    const r = await f('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw }),
    });
    if (!r.ok) throw new Error(`Gmail send ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return;
  }
  if (provider === 'outlook') {
    const token = await microsoftAccessToken(settings.oauthClients.microsoftClientId, secrets, f);
    const r = await f('https://graph.microsoft.com/v1.0/me/sendMail', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          subject: m.subject,
          body: { contentType: 'Text', content: m.text },
          toRecipients: [{ emailAddress: { address: m.to } }],
          attachments: m.attachment
            ? [{ '@odata.type': '#microsoft.graph.fileAttachment', name: m.attachment.fileName, contentType: m.attachment.mimeType ?? 'application/pdf', contentBytes: m.attachment.data.toString('base64') }]
            : [],
        },
        saveToSentItems: true,
      }),
    });
    if (!r.ok) throw new Error(`Outlook send ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return;
  }
  const s = settings.delivery.smtp;
  const transport = nodemailer.createTransport({ host: s.host, port: s.port, secure: s.secure, connectionTimeout: 20_000, greetingTimeout: 15_000, socketTimeout: 60_000, auth: { user: s.user, pass: secrets.get('smtp.password') ?? '' } });
  await transport.sendMail({
    from: s.from || s.user,
    to: m.to,
    subject: m.subject,
    text: m.text,
    attachments: m.attachment ? [{ filename: m.attachment.fileName, content: m.attachment.data }] : [],
  });
}
