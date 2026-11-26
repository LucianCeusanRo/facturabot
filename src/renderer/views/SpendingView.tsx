import type { ReactNode } from 'react';
import type { SpendingReport } from '../../shared/types';
import { HBars, MonthBars } from '../components/Charts';
import { Card } from '../components/ui';
import { fmtMoney, type RangeKey } from '../format';

export const RANGES: { id: RangeKey; label: string }[] = [
  { id: 'month', label: 'Luna asta' },
  { id: 'prev', label: 'Luna trecută' },
  { id: 'quarter', label: '3 luni' },
  { id: 'year', label: 'Anul' },
];

export function RangePicker({ value, onChange }: { value: RangeKey; onChange: (k: RangeKey) => void }) {
  return (
    <div className="seg" role="tablist">
      {RANGES.map((r) => (
        <button key={r.id} role="tab" aria-selected={value === r.id} className={value === r.id ? 'on' : ''} onClick={() => onChange(r.id)}>
          {r.label}
        </button>
      ))}
    </div>
  );
}

/** Cheltuieli – componentă comună pentru aplicația desktop și panoul de pe telefon. */
export function SpendingView({ report, actions }: { report: SpendingReport | null; actions?: ReactNode }) {
  if (!report) return <div className="skeleton" />;
  const months = report.byMonth.filter((m) => m.totalRon > 0).length || 1;
  const top = report.byPlatform[0];
  const foreign = report.byCurrency.filter((c) => c.currency !== 'RON');
  return (
    <div className="stack">
      <div className="stats">
        <div className="stat accent">
          <div className="stat-value amount">{fmtMoney(report.totalRon, 'RON', 0)}</div>
          <div className="stat-label">Cheltuit (în lei, curs BNR)</div>
        </div>
        <div className="stat">
          <div className="stat-value">{report.count}</div>
          <div className="stat-label">Facturi primite</div>
        </div>
        <div className="stat">
          <div className="stat-value amount">{fmtMoney(report.totalRon / months, 'RON', 0)}</div>
          <div className="stat-label">Medie pe lună</div>
        </div>
        <div className="stat">
          <div className="stat-value stat-text">{top ? top.label : '—'}</div>
          <div className="stat-label">{top ? `Cea mai mare: ${fmtMoney(top.totalRon, 'RON', 0)}` : 'Cea mai mare platformă'}</div>
        </div>
      </div>

      {report.unconverted > 0 && (
        <div className="status-line warn">
          <span className="status-msg">{report.unconverted} facturi fără sumă sau curs</span>
          <span>nu sunt incluse în totaluri. Deschide-le din Istoric sau resincronizează când BNR e disponibil.</span>
        </div>
      )}

      <Card title="Pe lună" icon="chart" actions={actions}>
        <MonthBars months={report.byMonth} />
      </Card>

      <div className="grid2">
        <Card title="Pe platformă">
          <HBars items={report.byPlatform} total={report.totalRon} />
        </Card>
        <Card title="Pe furnizor">
          <HBars items={report.bySupplier} total={report.totalRon} limit={6} />
        </Card>
      </div>

      {foreign.length > 0 && (
        <Card title="În moneda facturii">
          <div className="cur-list">
            {report.byCurrency.map((c) => (
              <div key={c.currency} className="cur">
                <span className="cur-code">{c.currency}</span>
                <span className="amount">{fmtMoney(c.total, c.currency)}</span>
                <span className="hint">{c.count} facturi</span>
              </div>
            ))}
          </div>
          <p className="hint">Conversia în lei folosește cursul BNR al zilei bancare anterioare datei facturii (art. 290 Cod fiscal), configurabil în Setări.</p>
        </Card>
      )}
    </div>
  );
}
