import type { FgoClient } from '../sources/fgo.js';
import { isEu } from './vat.js';

/**
 * Venituri din facturile EMISE în FGO (GET /v2/facturi, drept `facturi:citire`) – baza pentru
 * plafonul de scutire TVA (art. 310 Cod fiscal, cifra de afaceri fără TVA) și pentru pragul OSS.
 * Pentru OSS avem nevoie de țara și tipul clientului: GET /v2/clienti (drept `clienti:citire`), opțional.
 */
export const FGO_REVENUE_FIELDS = 'data_emitere,valoare_totala,valoare_fara_tva,valuta,status,id_client,cod_unic_client';
export const FGO_CLIENT_FIELDS = 'id,cod_tara,tip_persoana';

export interface RevenueSummary {
  year: number;
  totalRon: number;
  byMonth: Record<string, number>;
  count: number;
  /** Vânzări către persoane fizice (PF) din alte state UE – EUR, fără TVA. null = nu avem acces la clienți. */
  ossEur: number | null;
  ossNote?: string;
  unconverted: number;
  updatedAt: string;
}

type Rate = (currency: string, day: string) => Promise<number | null>;

const EXCLUDED = new Set(['draft', 'anulata']);

export async function fgoRevenue(client: Pick<FgoClient, 'paginate'>, year: number, rate: Rate, now = new Date()): Promise<RevenueSummary> {
  const from = `${year}-01-01`;
  const lastDay = `${year}-12-31`;
  const today = now.toISOString().slice(0, 10);
  const to = lastDay < today ? lastDay : today;

  // Clienți (opțional) – țara + tip persoană, pentru OSS.
  const clients = new Map<string, { country: string | null; type: string | null }>();
  let ossNote: string | undefined;
  try {
    for await (const c of client.paginate('/v2/clienti', { fields: FGO_CLIENT_FIELDS })) {
      clients.set(String(c.id), { country: c.cod_tara ? String(c.cod_tara).toUpperCase() : null, type: c.tip_persoana ?? null });
    }
  } catch (e) {
    ossNote = `Pragul OSS are nevoie de dreptul clienti:citire pe cheia FGO (${(e as Error).message}).`;
  }

  const byMonth: Record<string, number> = {};
  let total = 0;
  let oss = 0;
  let count = 0;
  let unconverted = 0;
  for await (const f of client.paginate('/v2/facturi', { data_emitere_de_la: from, data_emitere_pana_la: to, fields: FGO_REVENUE_FIELDS })) {
    if (EXCLUDED.has(String(f.status ?? ''))) continue;
    const day = String(f.data_emitere ?? '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const net = Number(f.valoare_fara_tva ?? f.valoare_totala);
    if (!Number.isFinite(net)) continue;
    const r = await rate(String(f.valuta || 'RON'), day);
    if (r == null) {
      unconverted++;
      continue;
    }
    const ron = net * r;
    total += ron;
    count++;
    const m = day.slice(0, 7);
    byMonth[m] = Math.round(((byMonth[m] ?? 0) + ron) * 100) / 100;
    const cl = f.id_client ? clients.get(String(f.id_client)) : undefined;
    if (cl && cl.type === 'PF' && cl.country && cl.country !== 'RO' && isEu(cl.country) && !f.cod_unic_client) {
      const eur = await rate('EUR', day);
      if (eur) oss += ron / eur;
    }
  }
  return {
    year,
    totalRon: Math.round(total * 100) / 100,
    byMonth,
    count,
    ossEur: ossNote ? null : Math.round(oss * 100) / 100,
    ossNote,
    unconverted,
    updatedAt: now.toISOString(),
  };
}
