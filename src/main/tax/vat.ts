/**
 * Detectare TVA pe reguli: furnizor intracomunitar / extra-UE, cod de TVA, mențiuni „taxare inversă”.
 * INFORMATIV – nu este consultanță fiscală. Decizia finală o ia contabilul.
 */
import type { VatObligation, VatRegime, VatTreatment } from '../../shared/types.js';

export const DISCLAIMER =
  'Informativ, calculat automat pe reguli din datele facturilor. Nu este consultanță fiscală — verifică întotdeauna cu contabilul.';

/** State membre UE (cod ISO; Grecia apare în VIES ca „EL”). */
export const EU_COUNTRIES = ['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'EL', 'ES', 'FI', 'FR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK'] as const;
export const isEu = (c: string | null | undefined) => !!c && (EU_COUNTRIES as readonly string[]).includes(c === 'GR' ? 'EL' : c.toUpperCase());

/** Formatele codurilor de TVA UE (sursa: VIES – „VAT number validation” / structura pe țări). */
export const VAT_PATTERNS: Record<string, RegExp> = {
  AT: /^U\d{8}$/,
  BE: /^[01]\d{9}$/,
  BG: /^\d{9,10}$/,
  CY: /^\d{8}[A-Z]$/,
  CZ: /^\d{8,10}$/,
  DE: /^\d{9}$/,
  DK: /^\d{8}$/,
  EE: /^\d{9}$/,
  EL: /^\d{9}$/,
  ES: /^[A-Z0-9]\d{7}[A-Z0-9]$/,
  FI: /^\d{8}$/,
  FR: /^[A-HJ-NP-Z0-9]{2}\d{9}$/,
  HR: /^\d{11}$/,
  HU: /^\d{8}$/,
  IE: /^\d{7}[A-W][A-I]?$|^\d[A-Z+*]\d{5}[A-W]$/,
  IT: /^\d{11}$/,
  LT: /^(\d{9}|\d{12})$/,
  LU: /^\d{8}$/,
  LV: /^\d{11}$/,
  MT: /^\d{8}$/,
  NL: /^\d{9}B\d{2}$/,
  PL: /^\d{10}$/,
  PT: /^\d{9}$/,
  RO: /^\d{2,10}$/,
  SE: /^\d{12}$/,
  SI: /^\d{8}$/,
  SK: /^\d{10}$/,
};

export interface ParsedVatId {
  country: string;
  number: string;
  id: string; // ex. IE9692928F
}

/** Normalizează „IE 9692928 F”, „ie9692928f”, „GR…” → { country: 'IE', number: '9692928F' }; null dacă formatul nu e valid. */
export function parseVatId(raw: string): ParsedVatId | null {
  const s = String(raw ?? '').toUpperCase().replace(/[\s.\-/]/g, '');
  const m = s.match(/^([A-Z]{2})([A-Z0-9+*]{2,13})$/);
  if (!m) return null;
  const country = m[1] === 'GR' ? 'EL' : m[1];
  const rx = VAT_PATTERNS[country];
  if (!rx || !rx.test(m[2])) return null;
  return { country, number: m[2], id: country + m[2] };
}

/** Caută coduri de TVA UE într-un text (ex. textul PDF-ului). Exclude CUI-ul propriu. */
export function findVatIds(text: string, ownIds: string[] = []): ParsedVatId[] {
  const own = new Set(ownIds.map((x) => x.toUpperCase().replace(/[^A-Z0-9]/g, '')).flatMap((x) => [x, x.replace(/^RO/, '')]));
  const out: ParsedVatId[] = [];
  const re = /\b(AT|BE|BG|CY|CZ|DE|DK|EE|EL|GR|ES|FI|FR|HR|HU|IE|IT|LT|LU|LV|MT|NL|PL|PT|RO|SE|SI|SK)\s?([A-Z0-9][A-Z0-9 +*]{1,14}[A-Z0-9])\b/g;
  for (const m of String(text ?? '').toUpperCase().matchAll(re)) {
    // Încercăm de la cel mai lung la cel mai scurt (textul poate continua cu alte cuvinte).
    const tail = m[2].replace(/\s/g, '');
    for (let len = Math.min(13, tail.length); len >= 2; len--) {
      const p = parseVatId(m[1] + tail.slice(0, len));
      if (p) {
        if (!own.has(p.id) && !own.has(p.number) && !out.some((o) => o.id === p.id)) out.push(p);
        break;
      }
    }
  }
  return out;
}

const REVERSE_CHARGE = [
  'reverse charge', 'reverse-charge', 'taxare inversa', 'taxare inversă', 'autoliquidation', 'autoliquidación',
  'steuerschuldnerschaft des leistungsempfängers', 'inversione contabile', 'verlegd', 'article 196', 'art. 196', 'artikel 196',
  'vat to be accounted for by the recipient', 'customer to account for vat',
];

export const mentionsReverseCharge = (text: string) => {
  const t = String(text ?? '').toLowerCase();
  return REVERSE_CHARGE.some((k) => t.includes(k));
};

/**
 * Furnizori mari cunoscuți, cu entitatea care facturează în UE.
 * Codurile de TVA de mai jos au fost verificate în VIES (ec.europa.eu) pe 26.11.2026.
 */
export const KNOWN_SUPPLIERS: { match: RegExp; country: string; vatId: string | null; entity: string }[] = [
  { match: /\bmeta\b|facebook|instagram/i, country: 'IE', vatId: 'IE9692928F', entity: 'Meta Platforms Ireland Limited' },
  { match: /\bgoogle\b/i, country: 'IE', vatId: 'IE6388047V', entity: 'Google Ireland Limited' },
  { match: /amazon europe core|\baws\b|amazon web services|amazon\b/i, country: 'LU', vatId: 'LU26375245', entity: 'Amazon Europe Core S.à r.l.' },
];

export interface VatClassifyInput {
  vendor?: string | null;
  text?: string | null; // textul PDF/email
  supplierCountry?: string | null;
  supplierVatId?: string | null;
  direction?: 'in' | 'out';
  ownCountry?: string;
  ownIds?: string[]; // CUI propriu (cu/fără RO)
}

export interface VatClassification {
  treatment: VatTreatment;
  supplierCountry: string | null;
  supplierVatId: string | null;
  reverseChargeText: boolean;
  reasons: string[];
}

/** Clasifică o factură PRIMITĂ: internă (RO), intracomunitară (UE ≠ RO), extra-UE sau necunoscută. */
export function classifyVat(i: VatClassifyInput): VatClassification {
  const reasons: string[] = [];
  const own = (i.ownCountry ?? 'RO').toUpperCase();
  const text = i.text ?? '';
  const rc = mentionsReverseCharge(text);
  if (rc) reasons.push('mențiune „taxare inversă / reverse charge”');
  let country = i.supplierCountry ? (i.supplierCountry.toUpperCase() === 'GR' ? 'EL' : i.supplierCountry.toUpperCase()) : null;
  let vatId = i.supplierVatId ? parseVatId(i.supplierVatId)?.id ?? null : null;
  if (i.direction === 'out') return { treatment: 'domestic', supplierCountry: own, supplierVatId: null, reasons: ['factură emisă'], reverseChargeText: rc };

  if (!vatId) {
    const ids = findVatIds(text, i.ownIds ?? []).filter((p) => p.country !== own);
    if (ids.length) {
      vatId = ids[0].id;
      reasons.push(`cod TVA furnizor în document: ${vatId}`);
    }
  }
  if (vatId && !country) country = vatId.slice(0, 2);
  if (!country) {
    const known = KNOWN_SUPPLIERS.find((k) => k.match.test(i.vendor ?? ''));
    if (known) {
      country = known.country;
      vatId = vatId ?? known.vatId;
      reasons.push(`furnizor cunoscut: ${known.entity}`);
    }
  }
  if (!country && /\b(CUI|C\.U\.I\.|CIF|cod fiscal)\s*:?\s*(RO)?\s?\d{2,10}\b/i.test(text)) {
    country = 'RO';
    reasons.push('CUI românesc în document');
  }
  let treatment: VatTreatment = 'unknown';
  if (country === own) treatment = 'domestic';
  else if (country && isEu(country)) treatment = 'intra-eu';
  else if (country) treatment = 'extra-eu';
  else if (rc) {
    treatment = 'intra-eu';
    reasons.push('fără țară, dar cu taxare inversă – probabil UE');
  }
  return { treatment, supplierCountry: country, supplierVatId: vatId, reasons, reverseChargeText: rc };
}

/** Termen: data de 25 a lunii următoare (D300 lunar, D301, D390). */
export function deadline25(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m, 25)); // luna următoare (index 0-based m = luna următoare)
  return d.toISOString().slice(0, 10);
}

/**
 * Declarațiile de reamintit pentru o lună, în funcție de regimul firmei și de achizițiile detectate.
 *  - achiziții intracomunitare de servicii (UE): D390 (VIES, simbol „S”) + D301 (art. 317) / D300 (art. 316)
 *  - servicii de la furnizori extra-UE: D301 / D300 (fără D390)
 *  - firmă fără niciun cod de TVA + furnizori UE: D700 pentru cod special art. 317 ÎNAINTE de achiziție
 */
export function vatObligations(month: string, regime: VatRegime, counts: { intraEu: number; extraEu: number }, vatRatePercent = 21): VatObligation[] {
  const out: VatObligation[] = [];
  const dl = deadline25(month);
  const any = counts.intraEu + counts.extraEu > 0;
  if (!any) return out;
  if (regime === 'none') {
    out.push({
      code: 'D700',
      title: 'Cod special de TVA (art. 317)',
      detail: 'Pentru servicii cumpărate de la furnizori din UE (Meta, Google, TikTok…) ai nevoie de cod de TVA art. 317, obținut cu D700 înainte de achiziție. Discută cu contabilul.',
      deadline: null,
    });
  }
  if (counts.intraEu > 0) {
    out.push({
      code: 'D390',
      title: 'Declarația recapitulativă VIES (D390)',
      detail: `${counts.intraEu} ${counts.intraEu === 1 ? 'achiziție intracomunitară' : 'achiziții intracomunitare'} de servicii (simbol „S”).`,
      deadline: dl,
    });
  }
  const code = regime === 'art316' ? 'D300' : 'D301';
  out.push({
    code,
    title: regime === 'art316' ? 'Decontul de TVA (D300)' : 'Decontul special de TVA (D301)',
    detail: `Taxare inversă: TVA ${vatRatePercent}% se calculează de tine pe facturile furnizorilor străini${regime === 'art316' ? ' (colectat și dedus în același decont)' : ' și se plătește'}.`,
    deadline: dl,
  });
  return out;
}
