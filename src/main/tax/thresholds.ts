import type { ThresholdProgress } from '../../shared/types.js';

/** Progresul față de un plafon (ex. 395.000 lei pentru scutirea de TVA). */
export function thresholdProgress(value: number, threshold: number, warnPercent: number): ThresholdProgress {
  const v = Math.max(0, Number.isFinite(value) ? value : 0);
  const t = Math.max(1, threshold);
  const percent = Math.round((v / t) * 1000) / 10;
  const level = v > t ? 'over' : percent >= warnPercent ? 'warn' : 'ok';
  return { valueRon: round2(v), thresholdRon: t, percent, level, remainingRon: round2(Math.max(0, t - v)) };
}

/**
 * OSS (art. 59c Directiva TVA): pragul de 10.000 EUR se aplică dacă NU a fost depășit nici în anul
 * precedent, nici în anul curent. Dacă anul precedent l-a depășit, regula destinației se aplică deja.
 */
export function ossProgress(currentEur: number, previousEur: number, thresholdEur: number, warnPercent: number) {
  const p = thresholdProgress(currentEur, thresholdEur, warnPercent);
  const level: 'ok' | 'warn' | 'over' = previousEur > thresholdEur ? 'over' : p.level;
  return { valueEur: p.valueRon, previousYearEur: round2(previousEur), thresholdEur, percent: p.percent, level };
}

/** Niveluri de alertă atinse (pentru notificări unice: 80% și 100%). */
export function crossedLevels(percent: number, warnPercent: number): ('warn' | 'over')[] {
  const out: ('warn' | 'over')[] = [];
  if (percent >= warnPercent) out.push('warn');
  if (percent > 100) out.push('over');
  return out;
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
