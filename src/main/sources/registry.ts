import { fgoSource } from './fgo.js';
import { gmailSource } from './gmail.js';
import { googleAdsSource } from './googleAds.js';
import { metaSource } from './meta.js';
import { outlookSource } from './outlook.js';
import { tiktokSource } from './tiktok.js';
import type { InvoiceSource } from './types.js';

/**
 * Registrul de surse. Pentru o sursă nouă:
 *   1. creează src/main/sources/<nume>.ts care exportă un `InvoiceSource` (opțional cu `test()`)
 *   2. adaug-o în lista de mai jos și descrie pașii de configurare în src/shared/sourcesMeta.ts.
 * Shopify nu are API pentru facturile către comerciant – le luăm din email (parsers/amounts.ts).
 */
export const SOURCES: InvoiceSource[] = [gmailSource, outlookSource, fgoSource, metaSource, tiktokSource, googleAdsSource];

export const sourceById = (id: string) => SOURCES.find((s) => s.id === id);
