import type { ReactNode } from 'react';
import type { ReverseChargeItem, TaxOverview } from '../../shared/types';
import { Meter } from '../components/Charts';
import { Icon } from '../components/Icon';
import { Card } from '../components/ui';
import { fmtDate, fmtMoney, monthLong } from '../format';

const LEVEL_TEXT = { ok: 'Sub prag', warn: 'Aproape de prag', over: 'Prag depășit' } as const;
const COUNTRY: Record<string, string> = { IE: 'Irlanda', LU: 'Luxemburg', NL: 'Olanda', DE: 'Germania', US: 'SUA', GB: 'Regatul Unit', CN: 'China', SG: 'Singapore', RO: 'România' };

/** TVA – componentă comună desktop + telefon. Strict informativ, nu e consultanță fiscală. */
export function TaxView({
  tax,
  monthNav,
  onCheckVies,
}: {
  tax: TaxOverview | null;
  monthNav?: ReactNode;
  onCheckVies?: (item: ReverseChargeItem) => void;
}) {
  if (!tax) return <div className="skeleton" />;
  const v = tax.vatThreshold;
  const rc = tax.reverseCharge;
  return (
    <div className="stack">
      <div className="note-box">
        <Icon name="info" size={16} />
        <span>{tax.disclaimer}</span>
      </div>

      <div className="grid2 tax-grid">
        <Card title={`Plafon scutire TVA ${tax.year}`} icon="tax" actions={<span className={`pill ${v.level === 'ok' ? 'ok' : v.level === 'warn' ? 'warn' : 'err'}`}>{LEVEL_TEXT[v.level]}</span>}>
          <div className="big-num amount">{fmtMoney(v.valueRon, 'RON', 0)}</div>
          <div className="hint">din {fmtMoney(v.thresholdRon, 'RON', 0)} · {Math.round(v.percent)}%</div>
          <Meter percent={v.percent} level={v.level} warnAt={tax.warnPercent} />
          <div className="meter-legend">
            <span>{v.remainingRon > 0 ? `Mai ai ${fmtMoney(v.remainingRon, 'RON', 0)} până la prag` : 'Ai depășit plafonul. Din OG 22/2025, înregistrarea în scopuri de TVA se cere cel târziu la data depășirii (art. 310 alin. 6) – vorbește azi cu contabila.'}</span>
          </div>
          <div className="hint">
            Venituri din {v.revenueSource === 'fgo' ? `FGO${v.updatedAt ? `, actualizat ${fmtDate(v.updatedAt, true)}` : ''}` : v.revenueSource === 'local' ? 'facturile emise salvate local' : 'nicio sursă încă'} ·{' '}
            <a href={v.source} target="_blank" rel="noreferrer">
              art. 310 Cod fiscal (OG 22/2025)
            </a>
          </div>
        </Card>

        <Card title="OSS – vânzări la distanță în UE" icon="globe" actions={<span className={`pill ${tax.oss.level === 'ok' ? 'ok' : tax.oss.level === 'warn' ? 'warn' : 'err'}`}>{LEVEL_TEXT[tax.oss.level]}</span>}>
          <div className="big-num amount">{fmtMoney(tax.oss.valueEur, 'EUR', 0)}</div>
          <div className="hint">
            din {fmtMoney(tax.oss.thresholdEur, 'EUR', 0)} · anul trecut {fmtMoney(tax.oss.previousYearEur, 'EUR', 0)}
          </div>
          <Meter percent={tax.oss.percent} level={tax.oss.level} warnAt={tax.warnPercent} />
          <div className="hint">
            Vânzări B2C către persoane fizice din alte state UE. Peste prag se aplică TVA-ul țării clientului (OSS) ·{' '}
            <a href={tax.oss.source} target="_blank" rel="noreferrer">
              Comisia Europeană
            </a>
          </div>
        </Card>
      </div>

      {tax.notes.length > 0 && (
        <div className="hint notes">
          {tax.notes.map((n) => (
            <div key={n}>· {n}</div>
          ))}
        </div>
      )}

      <Card title={`Achiziții cu taxare inversă · ${monthLong(rc.month)}`} icon="globe" actions={monthNav}>
        {rc.items.length === 0 ? (
          <div className="hint">Nicio factură de la furnizori din afara României în luna asta.</div>
        ) : (
          <>
            <div className="list">
              {rc.items.map((i) => (
                <div key={i.id} className="list-row rc-row">
                  <span className="flag">{i.supplierCountry ?? '??'}</span>
                  <div className="grow">
                    <div className="row-title">{i.vendor ?? 'Furnizor'}</div>
                    <div className="hint">
                      {i.treatment === 'intra-eu' ? 'UE' : 'Non-UE'} · {COUNTRY[i.supplierCountry ?? ''] ?? i.supplierCountry ?? 'țară necunoscută'}
                      {i.supplierVatId && <span className="series"> · {i.supplierVatId}</span>} · {fmtDate(i.invoiceDate)}
                    </div>
                  </div>
                  {i.supplierVatId && (
                    <span className={`pill ${i.vies ? (i.vies.valid ? 'ok' : 'err') : 'muted'}`} title={i.vies?.name ?? ''}>
                      {i.vies ? (i.vies.valid ? 'VIES valid' : 'VIES invalid') : 'VIES ?'}
                    </span>
                  )}
                  {onCheckVies && i.supplierVatId && !i.vies && (
                    <button className="btn ghost sm" onClick={() => onCheckVies(i)}>
                      Verifică
                    </button>
                  )}
                  <div className="amount">{i.amountRon != null ? fmtMoney(i.amountRon, 'RON') : fmtMoney(i.amount, i.currency)}</div>
                </div>
              ))}
            </div>
            <div className="rc-total">
              <div>
                <div className="hint">Bază impozabilă</div>
                <div className="amount">{fmtMoney(rc.totalRon, 'RON')}</div>
              </div>
              <div>
                <div className="hint">TVA estimat ({tax.vatRatePercent}%)</div>
                <div className="amount">{fmtMoney(rc.vatDueRon, 'RON')}</div>
              </div>
            </div>
          </>
        )}
      </Card>

      {rc.obligations.length > 0 && (
        <Card title="De discutat cu contabila" icon="calendar">
          <div className="list">
            {rc.obligations.map((o) => (
              <div key={o.code} className="list-row ob-row">
                <span className="code">{o.code}</span>
                <div className="grow">
                  <div className="row-title">{o.title}</div>
                  <div className="hint">{o.detail}</div>
                </div>
                {o.deadline && <span className="pill muted">până la {fmtDate(o.deadline)}</span>}
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
