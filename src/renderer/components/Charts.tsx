import type { MonthBucket, SpendBucket } from '../../shared/types';
import { fmtCompact, fmtMoney, monthShort } from '../format';

/** Bare lunare în SVG – fără bibliotecă de grafice. Scalează pe lățimea containerului. */
export function MonthBars({ months, height = 180 }: { months: MonthBucket[]; height?: number }) {
  const max = Math.max(1, ...months.map((m) => m.totalRon));
  const nice = niceMax(max);
  const w = 100 / Math.max(1, months.length);
  const ticks = [0, 0.5, 1].map((t) => t * nice);
  return (
    <figure className="chart" aria-label="Cheltuieli pe lună">
      <div className="chart-plot" style={{ height }}>
        <div className="chart-grid">
          {ticks
            .slice()
            .reverse()
            .map((t) => (
              <div key={t} className="chart-tick">
                <span>{fmtCompact(t)}</span>
              </div>
            ))}
        </div>
        <div className="chart-bars" role="img">
          {months.map((m) => (
            <div key={m.month} className="chart-col" title={`${m.month}: ${fmtMoney(m.totalRon, 'RON')} · ${m.count} facturi`}>
              <div className="bar" style={{ height: `${(m.totalRon / nice) * 100}%`, minHeight: m.totalRon > 0 ? 2 : 0 }} />
            </div>
          ))}
        </div>
      </div>
      <div className="chart-x">
        {months.map((m) => (
          <span key={m.month} style={{ width: `${w}%` }}>
            {monthShort(m.month)}
          </span>
        ))}
      </div>
    </figure>
  );
}

function niceMax(v: number) {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/** Listă cu bare orizontale (platforme / furnizori). */
export function HBars({ items, total, limit = 8 }: { items: SpendBucket[]; total: number; limit?: number }) {
  if (!items.length) return <div className="hint">Nicio cheltuială în perioada aleasă.</div>;
  const max = Math.max(...items.map((i) => i.totalRon), 1);
  return (
    <div className="hbars">
      {items.slice(0, limit).map((i) => (
        <div key={i.key} className="hbar">
          <div className="hbar-top">
            <span className="hbar-label">{i.label}</span>
            <span className="amount">{fmtMoney(i.totalRon, 'RON', 0)}</span>
          </div>
          <div className="hbar-track">
            <div className="hbar-fill" style={{ width: `${(i.totalRon / max) * 100}%` }} />
          </div>
          <div className="hint">
            {i.count} {i.count === 1 ? 'factură' : 'facturi'} · {total > 0 ? Math.round((i.totalRon / total) * 100) : 0}%
          </div>
        </div>
      ))}
    </div>
  );
}

/** Bară de progres către un prag, cu marcaj la pragul de avertizare. */
export function Meter({ percent, level, warnAt }: { percent: number; level: 'ok' | 'warn' | 'over'; warnAt: number }) {
  const p = Math.min(100, Math.max(0, percent));
  return (
    <div className={`meter ${level}`} role="progressbar" aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100}>
      <div className="meter-fill" style={{ width: `${p}%` }} />
      <div className="meter-mark" style={{ left: `${warnAt}%` }} title={`Avertizare la ${warnAt}%`} />
    </div>
  );
}
