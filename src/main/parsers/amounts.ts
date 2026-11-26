/**
 * Extragere de sume din chitanțe/facturi – 100% pe reguli (expresii regulate), fără AI.
 * Folosit pentru emailurile de la Shopify, Meta, TikTok, Google etc., unde nu există API
 * pentru facturile comerciantului (Shopify) sau când sursa directă nu e configurată.
 */

export const CURRENCY_SYMBOLS: Record<string, string> = { '€': 'EUR', $: 'USD', '£': 'GBP', lei: 'RON', ron: 'RON' };
const ISO = ['RON', 'EUR', 'USD', 'GBP', 'CHF', 'HUF', 'PLN', 'CZK', 'BGN', 'SEK', 'DKK', 'NOK', 'CAD', 'AUD', 'JPY'];

/**
 * Transformă un număr scris în stil RO/EU („1.234,56”) sau US („1,234.56”) în number.
 * Regula: ultimul separator urmat de exact 1–2 cifre e separatorul zecimal; restul sunt de mii.
 */
export function parseAmount(raw: string): number | null {
  const s = String(raw ?? '')
    .replace(/[\s\u00a0\u202f']/g, '')
    .replace(/^[^\d-]+|[^\d]+$/g, '');
  if (!s || !/\d/.test(s)) return null;
  const neg = s.startsWith('-');
  const body = s.replace(/^-/, '');
  if (!/^[\d.,]+$/.test(body)) return null;
  const lastSep = Math.max(body.lastIndexOf(','), body.lastIndexOf('.'));
  let n: number;
  if (lastSep >= 0 && body.length - lastSep - 1 >= 1 && body.length - lastSep - 1 <= 2) {
    const int = body.slice(0, lastSep).replace(/[.,]/g, '');
    n = Number(`${int || '0'}.${body.slice(lastSep + 1)}`);
  } else {
    // „1.234” sau „1,234” fără zecimale → separator de mii
    n = Number(body.replace(/[.,]/g, ''));
  }
  if (!Number.isFinite(n)) return null;
  return Math.round((neg ? -n : n) * 100) / 100;
}

export function normalizeCurrency(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim();
  const sym = CURRENCY_SYMBOLS[t] ?? CURRENCY_SYMBOLS[t.toLowerCase()];
  if (sym) return sym;
  const up = t.toUpperCase();
  return ISO.includes(up) ? up : null;
}

const NUM = String.raw`-?\d{1,3}(?:[.,\s\u00a0]\d{3})*(?:[.,]\d{1,2})?|-?\d+(?:[.,]\d{1,2})?`;
const CUR = String.raw`RON|LEI|Lei|lei|EUR|USD|GBP|CHF|HUF|PLN|CZK|BGN|SEK|DKK|NOK|CAD|AUD|€|\$|£`;

export interface MoneyHit {
  amount: number;
  currency: string | null;
  /** Prioritate: „total de plată” > „total” > „amount” > orice sumă cu monedă. */
  weight: number;
  index: number;
}

/** Cuvinte care marchează totalul (RO/EN/DE/FR), în ordinea importanței. */
const TOTAL_LABELS: [RegExp, number][] = [
  [/(total\s+de\s+plat[aă]|total\s+plat[aă]|amount\s+due|total\s+due|total\s+charged|amount\s+charged|amount\s+billed|amount\s+paid|suma\s+pl[aă]tit[aă]|gesamtbetrag|montant\s+total)/i, 5],
  [/(total\s+\(?incl|total\s+cu\s+tva|grand\s+total|total\s+amount|total\s+general|invoice\s+total|totalul)/i, 4],
  [/\b(total)\b/i, 3],
  [/\b(amount|sum[aă]|valoare|payment)\b/i, 2],
];

/** Găsește toate sumele însoțite de monedă din text. */
export function findMoney(text: string): MoneyHit[] {
  const t = String(text ?? '');
  const hits: MoneyHit[] = [];
  // (?<![\d.,]) – nu începem un număr în mijlocul altuia („2026 100,00 lei” ≠ 26.100).
  const re = new RegExp(String.raw`(?:(${CUR})\s?(${NUM}))|(?:(?<![\d.,])(${NUM})\s?(${CUR})(?![A-Za-z]))`, 'g');
  for (const m of t.matchAll(re)) {
    const cur = normalizeCurrency(m[1] ?? m[4]);
    const amount = parseAmount(m[2] ?? m[3]);
    if (amount == null || cur == null) continue;
    const before = t.slice(Math.max(0, m.index! - 60), m.index!);
    let weight = 1;
    for (const [rx, w] of TOTAL_LABELS) {
      if (rx.test(before)) {
        weight = Math.max(weight, w);
      }
    }
    // „Subtotal” și „TVA/VAT/tax” nu sunt totalul.
    if (/(subtotal|sub-total|\btva\b|\bvat\b|\btax\b|discount|reducere)[^\d]{0,25}$/i.test(before)) weight = Math.min(weight, 0.5);
    hits.push({ amount, currency: cur, weight, index: m.index! });
  }
  return hits;
}

/** Alege totalul documentului: cel mai „etichetat” hit; la egalitate, cea mai mare sumă (totalul ≥ componentele). */
export function extractTotal(text: string, defaultCurrency: string | null = null): { amount: number; currency: string } | null {
  const hits = findMoney(text).filter((h) => h.amount > 0);
  if (!hits.length) return null;
  hits.sort((a, b) => b.weight - a.weight || b.amount - a.amount || a.index - b.index);
  const h = hits[0];
  const currency = h.currency ?? defaultCurrency;
  return currency ? { amount: h.amount, currency } : null;
}

export interface ReceiptFacts {
  platform: string | null;
  amount: number | null;
  currency: string | null;
  number: string | null;
  vatAmount: number | null;
  dueDate: string | null;
}

/** Reguli specifice pe platformă (emailuri de facturare reale au formate stabile). */
const PLATFORM_RULES: { platform: string; from: RegExp; number?: RegExp }[] = [
  { platform: 'shopify', from: /shopify\.com/i, number: /\b(?:bill|invoice|factura)\s*(?:#|nr\.?|no\.?)\s*([A-Z0-9-]{5,})/i },
  { platform: 'meta', from: /(facebookmail\.com|meta\.com|fb\.com|facebook\.com)/i, number: /\b(?:transaction\s+id|reference\s+number|id\s+tranzac[tț]ie|num[aă]r\s+de\s+referin[tț][aă])\s*[:#]?\s*([A-Z0-9-]{6,})/i },
  { platform: 'tiktok', from: /tiktok/i, number: /\b(?:invoice|receipt|bill)\s*(?:no\.?|number|#)\s*[:#]?\s*([A-Z0-9-]{5,})/i },
  { platform: 'google', from: /google\.com/i, number: /\b(?:invoice\s+number|num[aă]r\s+factur[aă]|document\s+number)\s*[:#]?\s*([0-9]{6,})/i },
  { platform: 'stripe', from: /stripe\.com/i, number: /\b(?:invoice|receipt)\s*(?:number|#)\s*[:#]?\s*([A-Z0-9-]{5,})/i },
  { platform: 'paypal', from: /paypal\./i, number: /\b(?:transaction\s+id|id\s+tranzac[tț]ie)\s*[:#]?\s*([A-Z0-9]{8,})/i },
];

const MONTHS: Record<string, number> = {
  jan: 1, ian: 1, feb: 2, mar: 3, apr: 4, may: 5, mai: 5, jun: 6, iun: 6, jul: 7, iul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** Data în formate uzuale: 2026-11-18, 18.11.2026, 18/11/2026, Nov 18, 2026, 18 nov. 2026. */
export function parseDate(raw: string): string | null {
  const t = String(raw ?? '').trim();
  let m = t.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = t.match(/(\d{1,2})[./](\d{1,2})[./](\d{4})/);
  if (m) return valid(+m[3], +m[2], +m[1]);
  m = t.match(/([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (m && MONTHS[m[1].toLowerCase()]) return valid(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
  m = t.match(/(\d{1,2})\s+([A-Za-z]{3})[a-zăâîșț]*\.?\s+(\d{4})/i);
  if (m && MONTHS[m[2].toLowerCase()]) return valid(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  return null;
}

function valid(y: number, mo: number, d: number): string | null {
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1) return null;
  return dt.toISOString().slice(0, 10);
}

export function platformFromSender(from: string): string | null {
  return PLATFORM_RULES.find((r) => r.from.test(from ?? ''))?.platform ?? null;
}

/** Fapte dintr-o chitanță/factură primită pe email (subiect + corp + text PDF). */
export function parseReceipt(input: { from: string; subject?: string; text?: string }): ReceiptFacts {
  const rule = PLATFORM_RULES.find((r) => r.from.test(input.from ?? ''));
  const text = `${input.subject ?? ''}\n${input.text ?? ''}`;
  const total = extractTotal(text);
  const vat = findMoney(text).find((h) => /(\btva\b|\bvat\b|\btax\b)[^\d]{0,25}$/i.test(text.slice(Math.max(0, h.index - 40), h.index)));
  const numberMatch = rule?.number ? text.match(rule.number) : null;
  const due = text.match(/(?:due\s+date|scaden[tț][aă]|data\s+scaden[tț]ei|pay\s+by|payment\s+due)\s*[:]?\s*([^\n]{6,30})/i);
  return {
    platform: rule?.platform ?? null,
    amount: total?.amount ?? null,
    currency: total?.currency ?? null,
    number: numberMatch?.[1] ?? null,
    vatAmount: vat && total && vat.amount < total.amount ? vat.amount : null,
    dueDate: due ? parseDate(due[1]) : null,
  };
}

/** Text simplu dintr-un HTML de email (fără DOM): scoate stiluri/scripturi/tag-uri, decodează entități uzuale. */
export function htmlToText(html: string): string {
  return String(html ?? '')
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d|table)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&euro;/g, '€')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}
