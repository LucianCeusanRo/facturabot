import { useEffect, useState } from 'react';
import type { SpendingReport } from '../../shared/types';
import { api } from '../api';
import type { Store } from '../App';
import { Icon } from '../components/Icon';
import { Card } from '../components/ui';
import { monthLong, rangeFor, shiftMonth, thisMonth, type RangeKey } from '../format';
import { RangePicker, SpendingView } from '../views/SpendingView';

export function Spending({ store }: { store: Store }) {
  const [range, setRange] = useState<RangeKey>('year');
  const [report, setReport] = useState<SpendingReport | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pkgMonth, setPkgMonth] = useState(shiftMonth(thisMonth(), -1));
  const r = rangeFor(range);

  useEffect(() => {
    api.spending({ from: r.from, to: r.to }).then(setReport);
  }, [range, store.status?.lastSync]); // eslint-disable-line react-hooks/exhaustive-deps

  const exportAs = async (format: 'csv' | 'xlsx') => {
    setBusy(format);
    const res = await api.exportData({ format, from: r.from, to: r.to });
    setBusy(null);
    if (res.ok) store.toast(`Exportat: ${res.path}`);
    else if (res.error !== 'Anulat') store.toast(res.error ?? 'Exportul a eșuat', 'err');
  };

  const pkg = async (send: boolean) => {
    setBusy(send ? 'send' : 'zip');
    const res = await api.buildPackage(pkgMonth, send);
    setBusy(null);
    if (res.ok) store.toast(send ? `Pachetul pe ${monthLong(pkgMonth)} a fost trimis${res.sentVia ? ` (${res.sentVia})` : ''}` : 'Pachetul a fost creat');
    else store.toast(res.error ?? 'Nu am putut crea pachetul', 'err');
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Cheltuieli</h1>
          <p className="lead">Pe platforme și furnizori, convertite în lei la cursul BNR din ziua facturii.</p>
        </div>
        <RangePicker value={range} onChange={setRange} />
      </header>

      <SpendingView
        report={report}
        actions={
          <div className="row tight">
            <button className="btn sm" disabled={!!busy} onClick={() => exportAs('csv')}>
              <Icon name="download" size={14} /> CSV
            </button>
            <button className="btn sm" disabled={!!busy} onClick={() => exportAs('xlsx')}>
              <Icon name="download" size={14} /> Excel
            </button>
          </div>
        }
      />

      <div style={{ marginTop: 16 }}>
        <Card title="Pachet pentru contabilă" icon="package">
          <div className="pkg">
            <div className="grow">
              <p className="hint" style={{ margin: 0 }}>
                O arhivă ZIP cu toate facturile lunii, raportul lunar (PDF), tabelul CSV și Excel. Poate fi trimisă automat în prima zi lucrătoare a lunii – vezi Setări → Rapoarte.
              </p>
            </div>
            <div className="row">
              <button className="icon-btn" aria-label="Luna anterioară" onClick={() => setPkgMonth(shiftMonth(pkgMonth, -1))}>
                <Icon name="back" size={16} />
              </button>
              <span className="month-label">{monthLong(pkgMonth)}</span>
              <button className="icon-btn" aria-label="Luna următoare" disabled={pkgMonth >= thisMonth()} onClick={() => setPkgMonth(shiftMonth(pkgMonth, 1))}>
                <Icon name="arrow" size={16} />
              </button>
              <button className="btn" disabled={!!busy} onClick={() => pkg(false)}>
                <Icon name="package" size={15} /> Creează ZIP
              </button>
              <button className="btn primary" disabled={!!busy} onClick={() => pkg(true)}>
                <Icon name="send" size={15} /> Trimite contabilei
              </button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
