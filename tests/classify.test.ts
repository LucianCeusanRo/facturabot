import { describe, expect, it } from 'vitest';
import { classify, extractPdfText, extractSeriesNumber, matchBiller, sanitizeFileName } from '../src/main/sources/classify';
import { buildGmailQuery } from '../src/main/sources/gmail';

describe('classify', () => {
  it('recunoaște factura Meta după expeditor + subiect', () => {
    const r = classify({ from: 'Meta for Business <advertise-noreply@support.facebook.com>', subject: 'Your Meta ads receipt (Account ID: 123)' });
    expect(r.biller?.name).toMatch(/Meta/);
    expect(r.isInvoice).toBe(true);
  });
  it('recunoaște PDF factura de la furnizor necunoscut', () => {
    expect(classify({ from: 'Firma SRL <office@firma.ro>', subject: 'Factura fiscala nr. 123', fileName: 'Factura_FF0123.pdf', mimeType: 'application/pdf' }).isInvoice).toBe(true);
  });
  it('ignoră newslettere cu PDF', () => {
    expect(classify({ from: 'news@shop.ro', subject: 'Newsletter: reduceri de Black Friday', fileName: 'catalog.pdf' }).isInvoice).toBe(false);
  });
  it('ignoră un CV primit pe mail', () => {
    expect(classify({ from: 'ion@gmail.com', subject: 'CV Ion Popescu', fileName: 'cv.pdf' }).isInvoice).toBe(false);
  });
  it('potrivește subdomenii', () => {
    expect(matchBiller('billing@mail.shopify.com')?.name).toBe('Shopify');
    expect(matchBiller('x@notshopify.com')).toBeNull();
  });
  it('fără diacritice / cu diacritice', () => {
    expect(classify({ from: 'a@b.ro', subject: 'Factură nouă', fileName: 'doc.pdf' }).isInvoice).toBe(true);
  });
});

describe('extractSeriesNumber', () => {
  it('serie + număr românesc', () => expect(extractSeriesNumber('Factura seria ABC nr. 00123')).toBe('ABC 00123'));
  it('invoice #', () => expect(extractSeriesNumber('Invoice #INV-20431')).toMatch(/20431/));
  it('nume fișier', () => expect(extractSeriesNumber('FCT_884213.pdf')).toMatch(/884213/));
  it('nimic', () => expect(extractSeriesNumber('Salut')).toBeNull());
});

describe('gmail query & filenames', () => {
  it('construiește query cu after: și billeri fără PDF', () => {
    const q = buildGmailQuery(new Date('2026-01-01T00:00:00Z'));
    expect(q).toContain('after:1767225600');
    expect(q).toContain('filename:pdf');
    expect(q).toContain('facebookmail.com');
  });
  it('curăță numele fișierelor', () => expect(sanitizeFileName('a/b:c?.pdf')).toBe('a_b_c_.pdf'));
});

describe('nume de fișier (diacritice, Windows, injectare)', () => {
  it('păstrează diacriticele românești și normalizează NFD → NFC', () => {
    expect(sanitizeFileName('Factura_S\u0326os\u0326oni.pdf')).toBe('Factura_Șoșoni.pdf');
    expect(sanitizeFileName('Chitanță ÎÂĂȘȚ.pdf')).toBe('Chitanță ÎÂĂȘȚ.pdf');
  });
  it('elimină CR/LF, caractere de control și bidi', () => {
    expect(sanitizeFileName('a\r\nb\u0000\u202e.pdf')).toBe('ab.pdf');
  });
  it('nume rezervate Windows și puncte finale', () => {
    expect(sanitizeFileName('CON.pdf')).toBe('_CON.pdf');
    expect(sanitizeFileName('factura. . ')).toBe('factura');
  });
  it('scurtează păstrând extensia', () => {
    const n = sanitizeFileName('x'.repeat(400) + '.pdf');
    expect(n.length).toBeLessThanOrEqual(150);
    expect(n.endsWith('.pdf')).toBe(true);
  });
  it('gol → fallback', () => {
    expect(sanitizeFileName('\r\n')).toBe('factura.pdf');
    expect(sanitizeFileName('.pdf')).toBe('factura.pdf');
  });
});

describe('reguli de detectare configurabile', () => {
  it('furnizor propriu din setări', () => {
    const r = classify({ from: 'Contabil <facturi@furnizorulmeu.ro>', subject: 'Document', fileName: 'doc.pdf' }, { extraSenders: ['furnizorulmeu.ro'] });
    expect(r.isInvoice).toBe(true);
    expect(r.biller?.name).toBe('furnizorulmeu.ro');
  });
  it('expeditor exclus', () => {
    expect(classify({ from: 'billing@stripe.com', subject: 'Invoice', fileName: 'invoice.pdf' }, { excludeSenders: ['stripe.com'] }).isInvoice).toBe(false);
  });
  it('cuvânt cheie suplimentar', () => {
    const inp = { from: 'x@y.ro', subject: 'Decont lunar', fileName: 'decont.pdf' };
    expect(classify(inp).isInvoice).toBe(false);
    expect(classify(inp, { extraKeywords: ['decont'] }).isInvoice).toBe(true);
  });
  it('prag de încredere', () => {
    const inp = { from: 'x@y.ro', subject: 'Factura', fileName: 'scan.pdf' };
    expect(classify(inp, { minScore: 3 }).isInvoice).toBe(true);
    expect(classify(inp, { minScore: 5 }).isInvoice).toBe(false);
  });
});

describe('extractPdfText (reguli, fără AI)', () => {
  it('citește șiruri literale din PDF și ajută clasificarea', () => {
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n(Factura fiscala nr. ABC 778899)\nendobj\n', 'latin1');
    const text = extractPdfText(pdf);
    expect(text).toMatch(/Factura fiscala nr\. ABC 778899/);
    const r = classify({ from: 'x@y.ro', subject: 'Document', fileName: 'scan.pdf', pdfText: text });
    expect(r.isInvoice).toBe(true);
    expect(r.reasons.join(' ')).toMatch(/PDF/);
    expect(extractSeriesNumber(text)).toMatch(/778899/);
  });
  it('întoarce gol pe non-PDF', () => {
    expect(extractPdfText(Buffer.from('not a pdf Factura'))).toBe('');
  });
});
