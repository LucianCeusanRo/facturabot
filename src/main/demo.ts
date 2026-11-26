import type { SettingsStore } from './config.js';
import type { Db } from './db.js';
import type { SecretStore } from './secrets.js';
import type { WhatsAppWeb } from './delivery/whatsappWeb.js';

/** Date demonstrative (FACTURABOT_DEMO=1) – folosite pentru capturi de ecran și prezentări. */
export function seedDemo(db: Db, settings: SettingsStore, secrets: SecretStore, wa: WhatsAppWeb) {
  secrets.setJson('google.tokens', { access_token: 'demo', expires_at: 0 });
  secrets.set('fgo.apiKey', 'demo');
  if (process.env.FACTURABOT_DEMO_QR === '1') wa.simulateQr().catch(() => undefined);
  else wa.simulateConnected('40744000111');
  db.setKv('lastSync', new Date(Date.now() - 6 * 60_000).toISOString());
  settings.update({
    onboardingDone: true,
    sources: { gmail: { enabled: true, account: 'firma.mea@gmail.com' }, fgo: { enabled: true, codUnic: '12345678' } },
    accountant: { name: 'Andreea (contabilă)', whatsappNumber: '40722123456', email: 'contabil@cabinet.ro' },
  });
  const rows: [string, string, string, number, string, string, string][] = [
    ['gmail', 'Meta (Facebook/Instagram Ads)', 'FBADS-1048-29384', 412.5, 'RON', 'sent', 'whatsapp-web'],
    ['gmail', 'Google', '5214889012', 233.1, 'RON', 'sent', 'whatsapp-web'],
    ['gmail', 'TikTok', 'BDUK20261118', 150, 'EUR', 'sent', 'email'],
    ['fgo', 'Fan Courier SA', 'FCR 884213', 96.4, 'RON', 'sent', 'whatsapp-web'],
    ['gmail', 'Shopify', '#348812331', 39, 'USD', 'awaiting_confirm', ''],
    ['gmail', 'eMAG', 'EMG 4410022', 1249.99, 'RON', 'sent', 'whatsapp-web'],
    ['gmail', 'Stripe', 'INV-0042', 18.2, 'EUR', 'failed', ''],
    ['fgo', 'Digi Romania', 'DIGI 77120931', 63.5, 'RON', 'sent', 'whatsapp-web'],
  ];
  rows.forEach(([source, vendor, ser, amount, currency, status, channel], i) => {
    const day = new Date(Date.now() - i * 86400_000 * 1.7).toISOString().slice(0, 10);
    const id = db.insertInvoice({
      source,
      externalId: `demo-${i}`,
      vendor,
      seriesNumber: ser,
      amount,
      currency,
      invoiceDate: day,
      fileName: `${vendor.split(' ')[0]}_${ser.replace(/\W/g, '')}.pdf`,
      subject: `Factura ${ser}`,
      status: 'pending',
    });
    db.setStatus(id, status as any, {
      channel: (channel || null) as any,
      error: status === 'failed' ? 'WhatsApp Web nu este conectat · email: cont SMTP neconfigurat' : channel === 'email' ? 'Backup email (WhatsApp: timeout)' : null,
    });
  });
  db.log('info', 'Am găsit 3 documente noi');
  db.log('success', 'Trimis pe WhatsApp Web: Meta (Facebook/Instagram Ads) · nr. FBADS-1048-29384 · 412,50 RON');
  db.log('warn', 'WhatsApp a eșuat (timeout) – trimit pe email');
  db.log('success', 'Trimis pe email: TikTok · nr. BDUK20261118 · 150,00 EUR');
}
