import { useCallback, useEffect, useState } from 'react';
import type { TaxOverview } from '../../shared/types';
import { api } from '../api';
import type { Page, Store } from '../App';
import { Icon } from '../components/Icon';
import { shiftMonth, thisMonth } from '../format';
import { TaxView } from '../views/TaxView';

export function Tax({ store, go }: { store: Store; go: (p: Page) => void }) {
  const [month, setMonth] = useState(thisMonth());
  const [tax, setTax] = useState<TaxOverview | null>(null);
  const load = useCallback(() => api.tax({ month }).then(setTax), [month]);
  useEffect(() => {
    load();
  }, [load, store.status?.lastSync]);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>TVA</h1>
          <p className="lead">Plafonul de scutire, OSS și achizițiile cu taxare inversă – calculate pe reguli, din facturile tale.</p>
        </div>
        <button className="btn" onClick={() => go('settings')}>
          <Icon name="settings" size={15} /> Praguri și regim TVA
        </button>
      </header>
      <TaxView
        tax={tax}
        monthNav={
          <div className="row tight">
            <button className="icon-btn" aria-label="Luna anterioară" onClick={() => setMonth(shiftMonth(month, -1))}>
              <Icon name="back" size={16} />
            </button>
            <button className="icon-btn" aria-label="Luna următoare" disabled={month >= thisMonth()} onClick={() => setMonth(shiftMonth(month, 1))}>
              <Icon name="arrow" size={16} />
            </button>
          </div>
        }
        onCheckVies={async (i) => {
          const r = await api.checkVies(i.supplierVatId!);
          if (!r.ok) store.toast(r.error ?? 'VIES indisponibil', 'err');
          else store.toast(r.valid ? `Valid în VIES${r.name ? `: ${r.name}` : ''}` : 'Cod TVA invalid în VIES', r.valid ? 'ok' : 'err');
          load();
        }}
      />
    </div>
  );
}
