import { useEffect, useMemo, useState } from 'react';
import type { InvoiceRecord, InvoiceStatus } from '../../shared/types';
import { api, fmtDate, fmtMoney } from '../api';
import type { Store } from '../App';
import { Icon } from '../components/Icon';
import { ChannelBadge, SourceLogo, StatusPill } from '../components/ui';

const FILTERS: [InvoiceStatus | 'all', string][] = [
  ['all', 'Toate'],
  ['sent', 'Trimise'],
  ['awaiting_confirm', 'De confirmat'],
  ['failed', 'Eșuate'],
  ['duplicate', 'Duplicate'],
];

export function History({ store }: { store: Store }) {
  const [filter, setFilter] = useState<InvoiceStatus | 'all'>('all');
  const [rows, setRows] = useState<InvoiceRecord[]>([]);
  const [q, setQ] = useState('');

  useEffect(() => {
    api.listInvoices({ status: filter, limit: 500 }).then(setRows);
  }, [filter, store.status]);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? rows.filter((r) => [r.vendor, r.subject, r.seriesNumber, r.fileName].some((v) => v?.toLowerCase().includes(t))) : rows;
  }, [rows, q]);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Istoric</h1>
          <p className="lead">Tot ce a găsit și a trimis FacturaBot.</p>
        </div>
        <div className="search">
          <Icon name="search" size={16} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Caută furnizor, număr…" />
        </div>
      </header>
      <div className="seg filters">
        {FILTERS.map(([id, label]) => (
          <button key={id} className={filter === id ? 'on' : ''} onClick={() => setFilter(id)}>
            {label}
          </button>
        ))}
      </div>
      <div className="table card">
        <div className="tr th">
          <span>Document</span>
          <span>Data</span>
          <span className="right">Sumă</span>
          <span>Canal</span>
          <span>Status</span>
          <span />
        </div>
        {shown.length === 0 && <div className="empty">Niciun document aici.</div>}
        {shown.map((r) => (
          <div key={r.id} className="tr">
            <span className="doc">
              <SourceLogo source={r.source} />
              <span>
                <div className="row-title">{r.vendor ?? r.subject}</div>
                <div className="hint" title={r.error ?? ''}>
                  {r.error ? <span className={r.status === 'failed' ? 'error-text' : 'warn-text'}>{r.error}</span> : r.seriesNumber ? `nr. ${r.seriesNumber}` : r.fileName}
                </div>
              </span>
            </span>
            <span className="hint">
              {fmtDate(r.invoiceDate)}
              {r.sentAt && <div className="sent-at">trimis {fmtDate(r.sentAt, true)}</div>}
            </span>
            <span className="amount right">{fmtMoney(r.amount, r.currency)}</span>
            <ChannelBadge c={r.channel} />
            <StatusPill s={r.status} />
            <span className="actions">
              {r.filePath && (
                <button className="icon-btn" title="Deschide fișierul" onClick={() => api.openInvoiceFile(r.id)}>
                  <Icon name="open" size={16} />
                </button>
              )}
              {(r.status === 'failed' || r.status === 'awaiting_confirm' || r.status === 'skipped') && (
                <button className="icon-btn" title={r.status === 'failed' ? 'Reîncearcă' : 'Trimite'} onClick={() => api.retryInvoice(r.id)}>
                  <Icon name={r.status === 'failed' ? 'refresh' : 'send'} size={16} />
                </button>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
