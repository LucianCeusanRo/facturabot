import { fgoSource } from './fgo.js';
import { gmailSource } from './gmail.js';
import { outlookSource } from './outlook.js';
import type { InvoiceSource } from './types.js';

/**
 * Registrul de surse. Pentru o sursă nouă:
 *   1. creează src/main/sources/<nume>.ts care exportă un `InvoiceSource`
 *   2. adaug-o în lista de mai jos.
 * Idei pregătite: ANAF e-Factura (SPV, OAuth cu certificat), Meta Marketing API (business invoices),
 * TikTok Ads, Google Ads InvoiceService, Shopify Billing, SmartBill/Oblio.
 */
export const SOURCES: InvoiceSource[] = [gmailSource, outlookSource, fgoSource];
