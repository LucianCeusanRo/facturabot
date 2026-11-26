/** Normalizează un număr de telefon în format internațional fără „+” (ex. „0722 123 456” → „40722123456”). */
export function normalizePhone(input: string, defaultCountry = '40'): string {
  let d = (input || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = defaultCountry + d.slice(1);
  d = d.replace(/\D/g, '');
  return d;
}

export function isValidPhone(input: string): boolean {
  const n = normalizePhone(input);
  return n.length >= 10 && n.length <= 15;
}
