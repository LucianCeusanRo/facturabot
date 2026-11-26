import { describe, expect, it } from 'vitest';
import { extractTotal, findMoney, htmlToText, normalizeCurrency, parseAmount, parseDate, parseReceipt, platformFromSender } from '../src/main/parsers/amounts';

describe('parseAmount', () => {
  it.each([
    ['1.234,56', 1234.56],
    ['1,234.56', 1234.56],
    ['1 234,56', 1234.56],
    ['1\u00a0234,5', 1234.5],
    ['1234', 1234],
    ['1.234', 1234],
    ['1,234', 1234],
    ['12,3', 12.3],
    ['-45,10', -45.1],
    ['€99.00', 99],
    ["1'234.50", 1234.5],
    ['0,99', 0.99],
  ])('%s → %s', (raw, n) => expect(parseAmount(raw)).toBe(n));

  it.each(['', 'abc', '--', '12a4', null as unknown as string])('invalid: %s', (raw) => expect(parseAmount(raw)).toBeNull());
});

describe('normalizeCurrency', () => {
  it('simboluri și coduri ISO', () => {
    expect(normalizeCurrency('€')).toBe('EUR');
    expect(normalizeCurrency('$')).toBe('USD');
    expect(normalizeCurrency('lei')).toBe('RON');
    expect(normalizeCurrency('Lei')).toBe('RON');
    expect(normalizeCurrency('usd')).toBe('USD');
    expect(normalizeCurrency('XYZ')).toBeNull();
    expect(normalizeCurrency(null)).toBeNull();
  });
});

describe('findMoney / extractTotal', () => {
  it('alege totalul, nu subtotalul sau TVA-ul', () => {
    const t = 'Subtotal: 100,00 lei\nTVA 21%: 21,00 lei\nTotal de plată: 121,00 lei';
    expect(extractTotal(t)).toEqual({ amount: 121, currency: 'RON' });
    const hits = findMoney(t);
    expect(hits).toHaveLength(3);
    expect(hits.find((h) => h.amount === 100)!.weight).toBeLessThan(1);
  });

  it('moneda înainte de sumă (format US)', () => {
    expect(extractTotal('Amount due $1,234.50 — paid with Visa')).toEqual({ amount: 1234.5, currency: 'USD' });
    expect(extractTotal('Total charged: €49.99')).toEqual({ amount: 49.99, currency: 'EUR' });
  });

  it('la egalitate de etichetă, suma mai mare câștigă', () => {
    expect(extractTotal('Ads 10,00 EUR and 25,00 EUR')).toEqual({ amount: 25, currency: 'EUR' });
  });

  it('nu lipește anul de sumă („2026 100,00 lei”)', () => {
    expect(extractTotal('Factura noiembrie 2026 100,00 lei')).toEqual({ amount: 100, currency: 'RON' });
  });

  it('fără monedă → null; sume zero ignorate', () => {
    expect(extractTotal('Total 123,45')).toBeNull();
    expect(extractTotal('Total 0,00 RON')).toBeNull();
    expect(findMoney(undefined as unknown as string)).toEqual([]);
  });

  it('nu confundă coduri de 3 litere lipite de cuvinte', () => {
    expect(findMoney('100 EURO')).toEqual([]);
  });
});

describe('parseDate', () => {
  it.each([
    ['2026-11-18', '2026-11-18'],
    ['18.11.2026', '2026-11-18'],
    ['8/1/2026', '2026-01-08'],
    ['Nov 18, 2026', '2026-11-18'],
    ['November 5 2026', '2026-11-05'],
    ['18 nov. 2026', '2026-11-18'],
    ['3 iunie 2026', '2026-06-03'],
  ])('%s', (raw, iso) => expect(parseDate(raw)).toBe(iso));

  it.each(['31.02.2026', '2026-13-01', '1.1.1999', 'mâine', 'Foo 12, 2026'])('invalid: %s', (raw) => expect(parseDate(raw)).toBeNull());
});

describe('parseReceipt', () => {
  it('Shopify: număr factură, total, TVA, scadență', () => {
    const r = parseReceipt({
      from: 'Shopify <billing@shopify.com>',
      subject: 'Your Shopify bill #348812331',
      text: 'Bill #348812331\nSubtotal $32.23\nVAT $6.77\nTotal $39.00 USD\nDue date: Dec 1, 2026',
    });
    expect(r).toMatchObject({ platform: 'shopify', number: '348812331', amount: 39, currency: 'USD', vatAmount: 6.77, dueDate: '2026-12-01' });
  });

  it('Meta: chitanță în lei cu ID tranzacție', () => {
    const r = parseReceipt({ from: 'Meta for Business <advertise-noreply@support.facebook.com>', text: 'Transaction ID: 7342-1190-2201\nAmount paid 412,50 RON' });
    expect(r).toMatchObject({ platform: 'meta', number: '7342-1190-2201', amount: 412.5, currency: 'RON', vatAmount: null });
  });

  it('Google / TikTok / Stripe / PayPal sunt recunoscuți după expeditor', () => {
    expect(platformFromSender('payments-noreply@google.com')).toBe('google');
    expect(platformFromSender('noreply@business.tiktok.com')).toBe('tiktok');
    expect(platformFromSender('receipts@stripe.com')).toBe('stripe');
    expect(platformFromSender('service@paypal.ro')).toBe('paypal');
    expect(platformFromSender('x@firma.ro')).toBeNull();
    expect(parseReceipt({ from: 'payments-noreply@google.com', text: 'Invoice number: 5214889012\nTotal amount: 233,10 lei' })).toMatchObject({
      platform: 'google',
      number: '5214889012',
      amount: 233.1,
    });
  });

  it('expeditor necunoscut, fără sumă', () => {
    expect(parseReceipt({ from: 'a@b.ro' })).toEqual({ platform: null, amount: null, currency: null, number: null, vatAmount: null, dueDate: null });
  });
});

describe('htmlToText', () => {
  it('scoate tag-uri, stiluri și decodează entități', () => {
    const t = htmlToText('<html><head><title>x</title></head><style>.a{}</style><p>Total&nbsp;de&nbsp;plat&#259;:</p><table><tr><td>49,00</td><td>&euro;</td></tr></table><br/>A &amp; B &lt;ok&gt; &quot;q&quot; &#39;s&#39;</html>');
    expect(t).toContain('Total de plată:');
    expect(t).toContain('49,00 €');
    expect(t).toContain('A & B <ok> "q" \'s\'');
    expect(t).not.toContain('.a{}');
    expect(htmlToText(null as unknown as string)).toBe('');
  });
});
