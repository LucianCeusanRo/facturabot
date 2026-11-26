import { describe, expect, it } from 'vitest';
import { classifyVat, deadline25, findVatIds, isEu, mentionsReverseCharge, parseVatId, vatObligations } from '../src/main/tax/vat';
import { crossedLevels, ossProgress, thresholdProgress } from '../src/main/tax/thresholds';

describe('coduri de TVA', () => {
  it('parseVatId normalizează și validează formatul pe țări', () => {
    expect(parseVatId('IE 9692928 F')).toEqual({ country: 'IE', number: '9692928F', id: 'IE9692928F' });
    expect(parseVatId('ie6388047v')!.id).toBe('IE6388047V');
    expect(parseVatId('LU-26375245')!.id).toBe('LU26375245');
    expect(parseVatId('GR094014201')!.country).toBe('EL');
    expect(parseVatId('NL859048139B01')!.id).toBe('NL859048139B01');
    expect(parseVatId('RO12345678')!.number).toBe('12345678');
    expect(parseVatId('DE12345')).toBeNull();
    expect(parseVatId('US123456789')).toBeNull();
    expect(parseVatId('')).toBeNull();
  });

  it('findVatIds găsește codurile furnizorului și exclude CUI-ul propriu', () => {
    const text = 'Meta Platforms Ireland Ltd. VAT Reg. No. IE9692928F\nBill to: Atelier Verde SRL, VAT RO12345678';
    expect(findVatIds(text, ['12345678']).map((x) => x.id)).toEqual(['IE9692928F']);
    expect(findVatIds(text).map((x) => x.id)).toEqual(['IE9692928F', 'RO12345678']);
    expect(findVatIds('nimic aici')).toEqual([]);
  });

  it('isEu + reverse charge în mai multe limbi', () => {
    expect(isEu('IE')).toBe(true);
    expect(isEu('gr')).toBe(false); // doar „GR” exact e mapat la EL
    expect(isEu('GR')).toBe(true);
    expect(isEu('US')).toBe(false);
    expect(isEu(null)).toBe(false);
    expect(mentionsReverseCharge('VAT: Reverse charge – Article 196 of Council Directive')).toBe(true);
    expect(mentionsReverseCharge('Taxare inversă')).toBe(true);
    expect(mentionsReverseCharge('Steuerschuldnerschaft des Leistungsempfängers')).toBe(true);
    expect(mentionsReverseCharge('TVA 21%')).toBe(false);
  });
});

describe('classifyVat', () => {
  it('cod de TVA din document → intracomunitar', () => {
    const c = classifyVat({ vendor: 'Some Vendor', text: 'Supplier VAT DE123456789 – reverse charge', ownIds: ['RO12345678'] });
    expect(c).toMatchObject({ treatment: 'intra-eu', supplierCountry: 'DE', supplierVatId: 'DE123456789', reverseChargeText: true });
    expect(c.reasons.length).toBeGreaterThan(1);
  });

  it('furnizor cunoscut (Meta, Google, Amazon) fără text', () => {
    expect(classifyVat({ vendor: 'Facebook Ads' })).toMatchObject({ treatment: 'intra-eu', supplierCountry: 'IE', supplierVatId: 'IE9692928F' });
    expect(classifyVat({ vendor: 'Google Ireland' })).toMatchObject({ supplierVatId: 'IE6388047V' });
    expect(classifyVat({ vendor: 'AWS EMEA' })).toMatchObject({ supplierCountry: 'LU' });
  });

  it('țară dată de sursă: RO → intern, US → extra-UE', () => {
    expect(classifyVat({ vendor: 'Fan Courier', supplierCountry: 'RO' }).treatment).toBe('domestic');
    expect(classifyVat({ vendor: 'OpenAI', supplierCountry: 'us' }).treatment).toBe('extra-eu');
    expect(classifyVat({ supplierVatId: 'IE9692928F' })).toMatchObject({ treatment: 'intra-eu', supplierCountry: 'IE' });
  });

  it('CUI românesc în document → intern; doar „reverse charge” → probabil UE; nimic → necunoscut', () => {
    expect(classifyVat({ vendor: 'Furnizor', text: 'CUI: RO 1234567' }).treatment).toBe('domestic');
    expect(classifyVat({ vendor: 'X', text: 'Reverse charge applies' }).treatment).toBe('intra-eu');
    expect(classifyVat({ vendor: 'X' }).treatment).toBe('unknown');
    expect(classifyVat({ vendor: 'X', direction: 'out' })).toMatchObject({ treatment: 'domestic', supplierCountry: 'RO' });
  });
});

describe('obligații și termene', () => {
  it('deadline25 = 25 a lunii următoare (și peste an)', () => {
    expect(deadline25('2026-11')).toBe('2026-12-25');
    expect(deadline25('2026-12')).toBe('2027-01-25');
  });

  it('neplătitor (fără cod) cu achiziții UE: D700 + D390 + D301', () => {
    const o = vatObligations('2026-11', 'none', { intraEu: 2, extraEu: 0 });
    expect(o.map((x) => x.code)).toEqual(['D700', 'D390', 'D301']);
    expect(o[1].detail).toContain('2 achiziții');
    expect(o[2].deadline).toBe('2026-12-25');
  });

  it('art. 317 doar extra-UE: D301 fără D390; plătitor art. 316: D300', () => {
    expect(vatObligations('2026-11', 'art317', { intraEu: 0, extraEu: 1 }).map((x) => x.code)).toEqual(['D301']);
    const p = vatObligations('2026-11', 'art316', { intraEu: 1, extraEu: 0 }, 19);
    expect(p.map((x) => x.code)).toEqual(['D390', 'D300']);
    expect(p[0].detail).toContain('1 achiziție');
    expect(p[1].detail).toContain('19%');
  });

  it('fără achiziții externe → nimic', () => {
    expect(vatObligations('2026-11', 'none', { intraEu: 0, extraEu: 0 })).toEqual([]);
  });
});

describe('praguri', () => {
  it('plafon TVA: ok / warn (80%) / over', () => {
    expect(thresholdProgress(100_000, 395_000, 80)).toMatchObject({ level: 'ok', percent: 25.3, remainingRon: 295_000 });
    expect(thresholdProgress(316_000, 395_000, 80)).toMatchObject({ level: 'warn', percent: 80 });
    expect(thresholdProgress(395_000, 395_000, 80).level).toBe('warn'); // egal cu plafonul = încă nedepășit
    expect(thresholdProgress(395_000.01, 395_000, 80)).toMatchObject({ level: 'over', remainingRon: 0 });
    expect(thresholdProgress(NaN, 0, 80)).toMatchObject({ valueRon: 0, thresholdRon: 1 });
  });

  it('OSS: depășit anul trecut → „over” chiar dacă anul ăsta e sub prag', () => {
    expect(ossProgress(2000, 12_000, 10_000, 80)).toMatchObject({ level: 'over', valueEur: 2000, previousYearEur: 12_000 });
    expect(ossProgress(8500, 0, 10_000, 80)).toMatchObject({ level: 'warn', percent: 85 });
  });

  it('crossedLevels pentru notificări unice', () => {
    expect(crossedLevels(50, 80)).toEqual([]);
    expect(crossedLevels(80, 80)).toEqual(['warn']);
    expect(crossedLevels(100.1, 80)).toEqual(['warn', 'over']);
  });
});
