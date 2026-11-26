import { useEffect, useState } from 'react';
import type { InvoiceRecord } from '../../shared/types';
import { api, fmtDate, fmtMoney, relTime } from '../api';
import type { Page, Store } from '../App';
import { Icon } from '../components/Icon';
import { Card, ChannelBadge, Dot, SourceLogo, StatusPill } from '../components/ui';

export function Dashboard({ store, go }: { store: Store; go: (p: Page) => void }) {
  const { status, settings, wa } = store;
  const [recent, setRecent] = useState<InvoiceRecord[]>([]);
  const [waiting, setWaiting] = useState<InvoiceRecord[]>([]);

  useEffect(() => {
    api.listInvoices({ limit: 8 }).then(setRecent);
    api.listInvoices({ status: 'awaiting_confirm', limit: 20 }).then(setWaiting);
  }, [status]);

  const c = status?.connections;
  const mode = settings.delivery.whatsappMode;
  const waOk = mode === 'web' ? c?.whatsappWeb === 'connected' : mode === 'cloud' ? !!c?.whatsappCloud : true;
  const anySource = !!(c?.gmail || c?.outlook || c?.fgo);
  const problems = status?.problems ?? [];
  const healthy = anySource && problems.length === 0 && (waOk || (settings.delivery.emailFallback && !!settings.accountant.email));
  const who = settings.accountant.name || 'contabilă';
  const mainChannel = mode === 'web' ? 'WhatsApp' : mode === 'cloud' ? 'WhatsApp Business' : 'email';
  const failed = status?.stats.failed ?? 0;
  const thisMonth = status?.stats.thisMonth ?? 0;

  const statusText = healthy
    ? `Facturile noi pleacă automat pe ${mainChannel} la ${who}${settings.delivery.emailFallback && mode !== 'none' ? ', cu backup pe email' : ''}.`
    : !anySource
      ? 'Conectează cel puțin o sursă (Gmail, Outlook sau FGO).'
      : problems.length
        ? problems.join(' ')
        : mode === 'web' && c?.whatsappWeb !== 'connected'
          ? 'WhatsApp nu este conectat. Scanează codul QR din Setări.'
          : 'Verifică setările de trimitere.';

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Facturi</h1>
          <p className="lead">Ultima verificare: {relTime(status?.lastSync ?? null)}</p>
        </div>
        <button className="btn primary lg" onClick={() => api.syncNow()} disabled={status?.syncing}>
          <Icon name="refresh" className={status?.syncing ? 'spin' : ''} /> {status?.syncing ? 'Sincronizez…' : 'Sincronizează acum'}
        </button>
      </header>

      <div className={`status-line ${healthy ? 'ok' : 'warn'}`}>
        <Icon name={healthy ? 'check' : 'alert'} size={16} />
        <span className="status-msg">{healthy ? 'Totul funcționează' : 'Are nevoie de atenție'}</span>
        <span>{statusText}</span>
        {!healthy && (
          <button className="link-btn" onClick={() => go('settings')}>
            Rezolvă <Icon name="arrow" size={14} />
          </button>
        )}
      </div>

      <div className="stats">
        <div className="stat accent">
          <div className="stat-value">{thisMonth}</div>
          <div className="stat-label">Trimise luna asta</div>
        </div>
        <div className="stat">
          <div className="stat-value">{status?.stats.sent ?? 0}</div>
          <div className="stat-label">Total trimise</div>
        </div>
        <div className="stat">
          <div className="stat-value">{status?.stats.pending ?? 0}</div>
          <div className="stat-label">De confirmat / în coadă</div>
        </div>
        <div className={`stat ${failed > 0 ? 'danger' : ''}`}>
          <div className="stat-value">{failed}</div>
          <div className="stat-label">Eșuate</div>
        </div>
      </div>

      <div className="dash-layout">
        <div className="dash-side">
          <Card title="Conexiuni">
            <div className="conn-list">
              <Conn label="Gmail" sub={settings.sources.gmail.account} ok={!!c?.gmail} />
              <Conn label="Outlook" sub={settings.sources.outlook.account} ok={!!c?.outlook} optional />
              <Conn label="FGO" sub={settings.sources.fgo.codUnic ? `CUI ${settings.sources.fgo.codUnic}` : undefined} ok={!!c?.fgo} optional />
              {mode === 'web' && (
                <Conn
                  label="WhatsApp Web"
                  sub={wa.me ? `+${wa.me}` : c?.whatsappWeb === 'connected' ? 'conectat' : c?.whatsappWeb === 'logged_out' ? 'deconectat – scanează QR' : 'neconectat'}
                  ok={c?.whatsappWeb === 'connected'}
                />
              )}
              {mode === 'cloud' && <Conn label="WhatsApp Business API" ok={!!c?.whatsappCloud} />}
              <Conn
                label={mode === 'none' ? 'Email (principal)' : 'Email (backup)'}
                sub={settings.accountant.email || 'lipsește emailul contabilei'}
                ok={!!settings.accountant.email && (mode === 'none' || settings.delivery.emailFallback)}
                optional={mode !== 'none'}
              />
            </div>
            <div className="contact-chip">
              <div className="avatar">{(settings.accountant.name || 'C').slice(0, 1).toUpperCase()}</div>
              <div>
                <div className="row-title">{settings.accountant.name || 'Contabilă'}</div>
                <div className="hint">
                  {[settings.accountant.whatsappNumber, settings.accountant.email].filter(Boolean).join(' · ') || 'necompletat'}
                </div>
              </div>
            </div>
          </Card>
        </div>

        <div className="stack">
          {waiting.length > 0 && (
            <Card title={`Așteaptă confirmarea ta (${waiting.length})`} className="attention">
              <div className="list">
                {waiting.map((i) => (
                  <div key={i.id} className="list-row">
                    <SourceLogo source={i.source} />
                    <div className="grow">
                      <div className="row-title">{i.vendor ?? i.subject}</div>
                      <div className="hint">
                        {i.seriesNumber ? <span className="series">nr. {i.seriesNumber}</span> : i.fileName} · {fmtDate(i.invoiceDate)}
                      </div>
                    </div>
                    <div className={`amount ${i.amount == null ? 'zero' : ''}`}>{fmtMoney(i.amount, i.currency)}</div>
                    <button className="icon-btn" title="Deschide" onClick={() => api.openInvoiceFile(i.id)}>
                      <Icon name="open" size={16} />
                    </button>
                    <button className="btn ghost sm" onClick={() => api.skipInvoice(i.id).then(store.refresh)}>
                      Ignoră
                    </button>
                    <button className="btn primary sm" onClick={() => api.approveInvoice(i.id).then(store.refresh)}>
                      Trimite
                    </button>
                  </div>
                ))}
              </div>
            </Card>
          )}

          <Card title="Activitate recentă" actions={<button className="link-btn" onClick={() => go('history')}>Vezi tot <Icon name="arrow" size={14} /></button>}>
            {recent.length === 0 ? (
              <Empty />
            ) : (
              <div className="list">
                {recent.map((i) => (
                  <div key={i.id} className="list-row">
                    <SourceLogo source={i.source} />
                    <div className="grow">
                      <div className="row-title">{i.vendor ?? i.subject}</div>
                      <div className="hint">
                        {i.seriesNumber ? <span className="series">nr. {i.seriesNumber} · </span> : ''}
                        {fmtDate(i.invoiceDate)}
                      </div>
                    </div>
                    <div className={`amount ${i.amount == null ? 'zero' : ''}`}>{fmtMoney(i.amount, i.currency)}</div>
                    <ChannelBadge c={i.channel} />
                    <StatusPill s={i.status} />
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function Conn({ label, sub, ok, optional }: { label: string; sub?: string; ok: boolean; optional?: boolean }) {
  return (
    <div className="conn">
      <Dot ok={ok} warn={!ok && !optional} />
      <div className="grow">
        <div className="row-title">{label}</div>
        {sub && <div className="hint">{sub}</div>}
      </div>
      <span className={`hint ${ok ? 'ok-text' : ''}`}>{ok ? 'activ' : optional ? 'opțional' : 'necesar'}</span>
    </div>
  );
}

function Empty() {
  return (
    <div className="empty">
      <Icon name="file" size={22} />
      <strong>Nicio factură încă</strong>
      <div>Apasă „Sincronizează acum” sau lasă FacturaBot să verifice sursele în fundal. Detectarea e pe reguli, fără AI, 100% local.</div>
    </div>
  );
}
