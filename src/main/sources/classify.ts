/**
 * Euristici pentru a decide dacă un email/atașament este o factură/chitanță.
 * Funcții pure – testate în tests/classify.test.ts.
 */

export interface KnownBiller {
  name: string;
  domains: string[];
  /** Trimite de obicei chitanța în corpul emailului, fără PDF atașat. */
  bodyReceipt?: boolean;
}

export const KNOWN_BILLERS: KnownBiller[] = [
  { name: 'Meta (Facebook/Instagram Ads)', domains: ['facebookmail.com', 'meta.com', 'fb.com', 'support.facebook.com'], bodyReceipt: true },
  { name: 'Google', domains: ['google.com', 'payments.google.com', 'ads-noreply@google.com'], bodyReceipt: true },
  { name: 'TikTok', domains: ['tiktok.com', 'business.tiktok.com', 'tiktokglobalshop.com'], bodyReceipt: true },
  { name: 'Shopify', domains: ['shopify.com'], bodyReceipt: true },
  { name: 'Stripe', domains: ['stripe.com'] },
  { name: 'PayPal', domains: ['paypal.com', 'paypal.ro'], bodyReceipt: true },
  { name: 'eMAG', domains: ['emag.ro'] },
  { name: 'Fan Courier', domains: ['fancourier.ro'] },
  { name: 'Sameday', domains: ['sameday.ro'] },
  { name: 'Cargus', domains: ['cargus.ro', 'urgentcargus.ro'] },
  { name: 'DPD', domains: ['dpd.ro'] },
  { name: 'GLS', domains: ['gls-romania.ro', 'gls-group.eu'] },
  { name: 'Posta Romana', domains: ['posta-romana.ro'] },
  { name: 'Microsoft', domains: ['microsoft.com', 'microsoftstoreemail.com'] },
  { name: 'Apple', domains: ['apple.com', 'email.apple.com'] },
  { name: 'Amazon / AWS', domains: ['amazon.com', 'amazon.de', 'amazonaws.com', 'aws.amazon.com'] },
  { name: 'Vodafone', domains: ['vodafone.ro'] },
  { name: 'Orange', domains: ['orange.ro'] },
  { name: 'Digi', domains: ['digi.ro', 'rcs-rds.ro'] },
  { name: 'Enel / PPC / E.ON', domains: ['enel.ro', 'ppcenergy.ro', 'eon-romania.ro', 'eon.ro'] },
  { name: 'Glovo', domains: ['glovoapp.com'] },
  { name: 'Bolt', domains: ['bolt.eu'] },
  { name: 'Uber', domains: ['uber.com'] },
  { name: 'OLX', domains: ['olx.ro'] },
  { name: 'SmartBill', domains: ['smartbill.ro'] },
  { name: 'FGO', domains: ['fgo.ro'] },
  { name: 'Oblio', domains: ['oblio.eu'] },
  { name: 'Netopia', domains: ['netopia-payments.com', 'netopia.ro'] },
  { name: 'Hostinger / GoDaddy / ROTLD', domains: ['hostinger.com', 'godaddy.com', 'rotld.ro'] },
];

const POSITIVE = [
  'factura', 'facturi', 'factură', 'facturii', 'invoice', 'invoices', 'receipt', 'chitanta', 'chitanță', 'bon fiscal',
  'bonul fiscal', 'payment confirmation', 'billing', 'tax invoice', 'rechnung', 'facture', 'proforma', 'avizul',
  'confirmare plata', 'confirmare plată', 'dovada platii', 'ads receipt', 'chitanța', 'e-factura', 'efactura',
];

const NEGATIVE = [
  'newsletter', 'webinar', 'promo', 'reducere', 'oferta', 'ofertă', 'unsubscribe digest', 'cv', 'curriculum',
  'contract de munca', 'terms of service update',
];

export function extractEmail(fromHeader: string): string {
  const m = fromHeader.match(/<([^>]+)>/);
  return (m ? m[1] : fromHeader).trim().toLowerCase();
}

/** true dacă adresa se potrivește cu o regulă: adresă exactă sau domeniu (inclusiv subdomenii). */
export function senderMatches(fromHeader: string, rule: string): boolean {
  const email = extractEmail(fromHeader);
  const domain = email.split('@')[1] ?? '';
  const d = rule.trim().toLowerCase().replace(/^@/, '');
  if (!d) return false;
  return d.includes('@') ? email === d : domain === d || domain.endsWith('.' + d);
}

export function matchBiller(fromHeader: string, extraSenders: string[] = []): KnownBiller | null {
  for (const b of KNOWN_BILLERS) {
    for (const d of b.domains) if (senderMatches(fromHeader, d)) return b;
  }
  for (const d of extraSenders) {
    if (senderMatches(fromHeader, d)) return { name: d.includes('@') ? d.split('@')[1] : d, domains: [d] };
  }
  return null;
}

function norm(s: string) {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

export interface ClassifyInput {
  from: string;
  subject: string;
  fileName?: string;
  mimeType?: string;
  bodySnippet?: string;
  /** Text extras deterministic din PDF (fără OCR/AI), dacă e disponibil. */
  pdfText?: string;
}

export interface ClassifyOptions {
  extraKeywords?: string[];
  extraSenders?: string[];
  excludeSenders?: string[];
  minScore?: number;
}

export interface ClassifyResult {
  isInvoice: boolean;
  score: number;
  biller: KnownBiller | null;
  reasons: string[];
}

/** Scor ≥ 3 ⇒ considerăm documentul factură. */
export function classify(input: ClassifyInput, opts: ClassifyOptions = {}): ClassifyResult {
  const reasons: string[] = [];
  let score = 0;
  if ((opts.excludeSenders ?? []).some((r) => senderMatches(input.from || '', r))) {
    return { isInvoice: false, score: -99, biller: null, reasons: ['expeditor exclus din setări'] };
  }
  const keywords = [...POSITIVE, ...(opts.extraKeywords ?? [])].map(norm).filter(Boolean);
  const subj = norm(input.subject || '');
  const file = norm(input.fileName || '');
  const body = norm(input.bodySnippet || '');
  const pdf = norm(input.pdfText || '');
  const biller = matchBiller(input.from || '', opts.extraSenders);
  const isPdf = (input.mimeType || '').includes('pdf') || file.endsWith('.pdf');

  if (biller) {
    score += 2;
    reasons.push(`expeditor cunoscut: ${biller.name}`);
  }
  const hit = (txt: string) => keywords.some((k) => txt.includes(k));
  if (hit(subj)) {
    score += 2;
    reasons.push('subiect cu „factură/invoice/receipt”');
  }
  if (file && hit(file)) {
    score += 2;
    reasons.push('nume fișier de factură');
  }
  if (/\b(inv|fact|fct|fv|ff)[-_ ]?\d{3,}/i.test(input.fileName || '')) {
    score += 1;
    reasons.push('nume fișier tip serie/număr');
  }
  if (body && hit(body)) {
    score += 1;
    reasons.push('corp email cu cuvinte cheie');
  }
  if (pdf && hit(pdf)) {
    score += 2;
    reasons.push('text în PDF cu „factură/invoice/receipt”');
  }
  if (isPdf) score += 1;
  if (NEGATIVE.some((k) => subj.includes(norm(k)))) {
    score -= 3;
    reasons.push('pare newsletter/promoție');
  }
  return { isInvoice: score >= (opts.minScore ?? 3), score, biller, reasons };
}

/** Încearcă să extragă seria/numărul facturii din subiect sau numele fișierului. */
export function extractSeriesNumber(...texts: (string | undefined)[]): string | null {
  for (const t of texts) {
    if (!t) continue;
    const patterns = [
      /seri[ae]\s*[:.]?\s*([A-Z]{1,8})\s*(?:nr\.?|num[aă]r(?:ul)?)\s*[:.]?\s*(\d{1,12})/i,
      /\b(?:factura|factur[aă]|invoice|receipt|fact\.?)\s*(?:fiscal[aă]\s*)?(?:nr\.?|no\.?|#|number)?\s*[:.]?\s*([A-Z]{0,8}[-/ ]?\d{3,12}(?:[-/]\d+)?)/i,
      /\b(INV|FCT|FACT|FV)[-_ ]?(\d{3,12})\b/i,
    ];
    for (const p of patterns) {
      const m = t.match(p);
      if (m) {
        const val = m.slice(1).filter(Boolean).join(' ').trim();
        if (/\d{3,}/.test(val)) return val;
      }
    }
  }
  return null;
}

const WIN_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/**
 * Nume de fișier sigur pe Windows și pentru WhatsApp/email:
 * păstrează diacriticele (normalizate NFC – macOS trimite uneori NFD), elimină caracterele de control
 * (CR/LF pot injecta antete), caracterele interzise pe Windows, punctele/spațiile de la final și
 * numele rezervate (CON, PRN…). La scurtare păstrează extensia.
 */
export function sanitizeFileName(name: string, fallback = 'factura.pdf'): string {
  let n = String(name ?? '')
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e]/g, '')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  if (/^\.[^.]*$/.test(n)) return fallback; // doar extensie, ex. „.pdf”
  const dot = n.lastIndexOf('.');
  const ext = dot > 0 && n.length - dot <= 6 ? n.slice(dot) : '';
  let stem = ext ? n.slice(0, dot) : n;
  if (WIN_RESERVED.test(stem)) stem = `_${stem}`;
  if (stem.length + ext.length > 150) stem = stem.slice(0, 150 - ext.length).trim();
  n = stem + ext;
  return n && n !== ext ? n : fallback;
}


/**
 * Extrage text dintr-un PDF prin reguli (șiruri literale PDF, fără OCR și fără model).
 * Funcționează pe PDF-uri cu text necomprimat; pe scanări întoarce șir gol — atunci rămân
 * cuvintele din subiect/nume fișier/expeditor.
 */
export function extractPdfText(data: Buffer, maxChars = 80_000): string {
  if (!data || data.length < 8) return '';
  const head = data.subarray(0, 8).toString('latin1');
  if (!head.startsWith('%PDF')) return '';
  const raw = data.toString('latin1').slice(0, Math.min(data.length, 2_000_000));
  const out: string[] = [];
  const push = (t: string) => {
    // eslint-disable-next-line no-control-regex
    const s = t.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (s.length >= 3) out.push(s);
  };
  // Șiruri între paranteze: (Factura nr. 12)
  const lit = /\((?:\\.|[^\\)]){3,400}\)/g;
  for (const m of raw.matchAll(lit)) {
    const esc: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: ' ', '(': '(', ')': ')', '\\': '\\' };
    const inner = m[0].slice(1, -1).replace(/\\([nrtb()\\])/g, (_, c: string) => esc[c] ?? c);
    // Ignoră escape-uri octale lungi fără litere (font encoding)
    if (/[A-Za-zĂÂÎȘȚăâîșț]{3,}/.test(inner)) push(inner);
    if (out.join(' ').length >= maxChars) break;
  }
  // Hex UTF-16BE: <FEFF00460061...>
  const hex = /<((?:FEFF|feff)?[0-9A-Fa-f]{8,800})>/g;
  for (const m of raw.matchAll(hex)) {
    const h = m[1];
    if (h.length % 2) continue;
    try {
      const buf = Buffer.from(h, 'hex');
      const text = buf[0] === 0xfe && buf[1] === 0xff ? Buffer.from(buf.subarray(2)).swap16().toString('utf16le') : buf.toString('latin1');
      if (/[A-Za-zĂÂÎȘȚăâîșț]{3,}/.test(text)) push(text);
    } catch { /* ignori */ }
    if (out.join(' ').length >= maxChars) break;
  }
  return out.join(' ').slice(0, maxChars);
}
