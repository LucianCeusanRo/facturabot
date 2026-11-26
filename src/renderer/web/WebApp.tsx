import { useCallback, useEffect, useState } from 'react';
import type { Insight, InvoiceStatus, SpendingReport, StatusSnapshot, TaxOverview } from '../../shared/types';
import { Icon } from '../components/Icon';
import { Card, SourceLogo, StatusPill } from '../components/ui';
import { fmtDate, fmtMoney, monthLong, rangeFor, relTime, shiftMonth, thisMonth, type RangeKey } from '../format';
import { InsightsList } from '../views/Insights';
import { RangePicker, SpendingView } from '../views/SpendingView';
import { TaxView } from '../views/TaxView';
import { HttpError, web, type WebInfo, type WebInvoice } from './client';

type Tab = 'home' | 'invoices' | 'spending' | 'tax' | 'more';
type Toast = { msg: string; kind: 'ok' | 'err' } | null;

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'home', label: 'Acasă', icon: 'home' },
  { id: 'invoices', label: 'Facturi', icon: 'file' },
  { id: 'spending', label: 'Cheltuieli', icon: 'chart' },
  { id: 'tax', label: 'TVA', icon: 'tax' },
  { id: 'more', label: 'Mai mult', icon: 'settings' },
];

/** Panoul de pe telefon: aceleași vizualizări ca în aplicația desktop, servite de PC prin rețeaua locală. */
export function WebApp() {
  const [paired, setPaired] = useState<boolean | null>(null);
  const [offline, setOffline] = useState<string | null>(null);

  const check = useCallback(() => {
    web
      .session()
      .then((s) => {
        setOffline(null);
        setPaired(s.paired);
      })
      .catch((e: Error) => setOffline(e.message));
  }, []);
  useEffect(check, [check]);

  if (offline)
    return (
      <div className="m-center">
        <Brand />
        <p className="lead">{offline}</p>
        <button className="btn primary lg" onClick={check}>
          <Icon name="refresh" size={16} /> Reîncearcă
        </button>
      </div>
    );
  if (paired === null) return <div className="boot" />;
  if (!paired) return <Pair onPaired={() => setPaired(true)} />;
  return <Main onUnpaired={() => setPaired(false)} />;
}

function Brand() {
  return (
    <div className="brand">
      <div className="logo">
        <Icon name="send" size={18} />
      </div>
      <div>
        <div className="brand-name">FacturaBot</div>
        <div className="brand-sub">pe telefon</div>
      </div>
    </div>
  );
}

function Pair({ onPaired }: { onPaired: () => void }) {
  const fromHash = (location.hash.match(/pair=(\d{6})/) ?? [])[1] ?? '';
  const [code, setCode] = useState(fromHash);
  const [name, setName] = useState(/iPhone/.test(navigator.userAgent) ? 'iPhone' : /Android/.test(navigator.userAgent) ? 'Telefon Android' : 'Telefon');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = useCallback(
    async (c: string) => {
      setBusy(true);
      setErr(null);
      try {
        await web.pair(c, name);
        history.replaceState(null, '', '/');
        onPaired();
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [name, onPaired],
  );

  return (
    <div className="m-center">
      <Brand />
      <h1>Conectează telefonul</h1>
      <p className="lead">Introdu codul de 6 cifre afișat în FacturaBot pe calculator, la Setări → Acces de pe telefon.</p>
      <form
        className="stack m-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit(code);
        }}
      >
        <input
          className="pin mono"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={7}
          placeholder="000000"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          aria-label="Cod de împerechere"
        />
        <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Numele telefonului" placeholder="Numele telefonului" />
        {err && <div className="test-result err">{err}</div>}
        <button className="btn primary lg" disabled={busy || code.length !== 6}>
          {busy ? 'Se conectează…' : 'Conectează'}
        </button>
      </form>
      <p className="hint">Telefonul rămâne conectat până îl revoci din aplicația de pe calculator. Datele nu trec prin niciun server extern.</p>
    </div>
  );
}

function Main({ onUnpaired }: { onUnpaired: () => void }) {
  const [tab, setTab] = useState<Tab>((location.hash.replace('#', '') as Tab) || 'home');
  const [status, setStatus] = useState<StatusSnapshot | null>(null);
  const [toast, setToast] = useState<Toast>(null);

  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof HttpError && e.status === 401) onUnpaired();
      else setToast({ msg: (e as Error).message, kind: 'err' });
    },
    [onUnpaired],
  );
  const loadStatus = useCallback(() => web.status().then(setStatus).catch(fail), [fail]);

  useEffect(() => {
    loadStatus();
    const t = setInterval(loadStatus, 30_000);
    const vis = () => document.visibilityState === 'visible' && loadStatus();
    document.addEventListener('visibilitychange', vis);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', vis);
    };
  }, [loadStatus]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const go = (t: Tab) => {
    setTab(t);
    history.replaceState(null, '', t === 'home' ? '/' : `#${t}`);
    window.scrollTo({ top: 0 });
  };
  const ctx = { status, reload: loadStatus, fail, say: (msg: string) => setToast({ msg, kind: 'ok' }), go };

  return (
    <div className="m-app">
      <main className="m-content">
        {tab === 'home' && <Home {...ctx} />}
        {tab === 'invoices' && <Invoices {...ctx} />}
        {tab === 'spending' && <SpendingTab {...ctx} />}
        {tab === 'tax' && <TaxTab {...ctx} />}
        {tab === 'more' && <More {...ctx} onUnpaired={onUnpaired} />}
      </main>
      <nav className="m-tabs">
        {TABS.map((t) => (
          <button key={t.id} className={`nav-item ${tab === t.id ? 'active' : ''}`} onClick={() => go(t.id)} aria-label={t.label}>
            <Icon name={t.icon} size={20} />
            <span className="nav-label">{t.label}</span>
            {t.id === 'invoices' && (status?.stats.pending ?? 0) > 0 && <span className="m-badge">{status!.stats.pending}</span>}
          </button>
        ))}
      </nav>
      {toast && (
        <div className="toasts">
          <div className={`toast ${toast.kind}`}>
            <Icon name={toast.kind === 'ok' ? 'check' : 'alert'} size={16} /> {toast.msg}
          </div>
        </div>
      )}
    </div>
  );
}

interface Ctx {
  status: StatusSnapshot | null;
  reload: () => void;
  fail: (e: unknown) => void;
  say: (m: string) => void;
  go: (t: Tab) => void;
}

function Head({ title, sub, action }: { title: string; sub?: string; action?: React.ReactNode }) {
  return (
    <header className="m-head">
      <div className="grow">
        <h1>{title}</h1>
        {sub && <p className="lead">{sub}</p>}
      </div>
      {action}
    </header>
  );
}

function Home({ status, reload, fail, say, go }: Ctx) {
  const [waiting, setWaiting] = useState<WebInvoice[]>([]);
  const [recent, setRecent] = useState<WebInvoice[]>([]);
  const [insights, setInsights] = useState<Insight[]>([]);
  const load = useCallback(() => {
    web.invoices('awaiting_confirm', 20).then(setWaiting).catch(fail);
    web.invoices('all', 6).then(setRecent).catch(fail);
    web.insights().then(setInsights).catch(fail);
  }, [fail]);
  useEffect(load, [load, status?.lastSync]);

  const problems = status?.problems ?? [];
  return (
    <>
      <Head
        title="FacturaBot"
        sub={status ? `Ultima verificare ${relTime(status.lastSync)}` : '…'}
        action={
          <button
            className="icon-btn m-sync"
            aria-label="Sincronizează acum"
            disabled={status?.syncing}
            onClick={() =>
              web
                .sync()
                .then(() => {
                  say('Sincronizare pornită pe calculator');
                  setTimeout(reload, 1500);
                })
                .catch(fail)
            }
          >
            <Icon name="refresh" size={20} className={status?.syncing ? 'spin' : ''} />
          </button>
        }
      />
      <div className={`status-line ${problems.length ? 'warn' : 'ok'}`}>
        <Icon name={problems.length ? 'alert' : 'check'} size={16} />
        <span className="status-msg">{problems.length ? 'Are nevoie de atenție' : 'Totul funcționează'}</span>
        {problems.length > 0 && <span>{problems.join(' ')}</span>}
      </div>
      <div className="stats">
        <div className="stat accent">
          <div className="stat-value">{status?.stats.thisMonth ?? 0}</div>
          <div className="stat-label">Trimise luna asta</div>
        </div>
        <div className="stat">
          <div className="stat-value">{status?.stats.pending ?? 0}</div>
          <div className="stat-label">De confirmat</div>
        </div>
        <div className="stat">
          <div className="stat-value">{status?.stats.sent ?? 0}</div>
          <div className="stat-label">Total trimise</div>
        </div>
        <div className={`stat ${(status?.stats.failed ?? 0) > 0 ? 'danger' : ''}`}>
          <div className="stat-value">{status?.stats.failed ?? 0}</div>
          <div className="stat-label">Eșuate</div>
        </div>
      </div>
      <div className="stack">
        {waiting.length > 0 && (
          <Card title={`Așteaptă confirmarea ta (${waiting.length})`}>
            <InvoiceList rows={waiting} onChange={() => (load(), reload())} fail={fail} say={say} />
          </Card>
        )}
        {insights.length > 0 && (
          <Card title="De urmărit" icon="calendar">
            <InsightsList items={insights.slice(0, 4)} />
          </Card>
        )}
        <Card
          title="Activitate recentă"
          actions={
            <button className="link-btn" onClick={() => go('invoices')}>
              Toate <Icon name="arrow" size={14} />
            </button>
          }
        >
          {recent.length ? <InvoiceList rows={recent} onChange={load} fail={fail} say={say} /> : <div className="hint">Nicio factură încă.</div>}
        </Card>
      </div>
    </>
  );
}

function InvoiceList({ rows, onChange, fail, say }: { rows: WebInvoice[]; onChange: () => void; fail: (e: unknown) => void; say: (m: string) => void }) {
  const [busy, setBusy] = useState<number | null>(null);
  const act = async (id: number, kind: 'approve' | 'skip') => {
    setBusy(id);
    try {
      await (kind === 'approve' ? web.approve(id) : web.skip(id));
      say(kind === 'approve' ? 'Trimiterea a pornit' : 'Ignorată');
      onChange();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="m-list">
      {rows.map((i) => {
        const actionable = i.status === 'awaiting_confirm' || i.status === 'failed';
        return (
          <div key={i.id} className="m-inv">
            <div className="m-inv-top">
              <SourceLogo source={i.source} />
              <div className="grow">
                <div className="row-title">{i.vendor ?? i.subject ?? i.fileName}</div>
                <div className="hint">
                  {i.seriesNumber ? <span className="series">nr. {i.seriesNumber} · </span> : null}
                  {fmtDate(i.invoiceDate)}
                </div>
              </div>
              <div className={`amount ${i.amount == null ? 'zero' : ''}`}>{fmtMoney(i.amount, i.currency)}</div>
            </div>
            {i.error && i.status === 'failed' && <div className="hint error-text">{i.error}</div>}
            <div className="m-inv-actions">
              <StatusPill s={i.status} />
              <div className="grow" />
              {i.hasFile && (
                <a className="btn ghost sm" href={web.fileUrl(i.id)} target="_blank" rel="noreferrer">
                  <Icon name="open" size={14} /> PDF
                </a>
              )}
              {i.status === 'awaiting_confirm' && (
                <button className="btn ghost sm" disabled={busy === i.id} onClick={() => act(i.id, 'skip')}>
                  Ignoră
                </button>
              )}
              {actionable && (
                <button className="btn primary sm" disabled={busy === i.id} onClick={() => act(i.id, 'approve')}>
                  <Icon name="send" size={14} /> {i.status === 'failed' ? 'Reîncearcă' : 'Trimite'}
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const FILTERS: [InvoiceStatus | 'all', string][] = [
  ['all', 'Toate'],
  ['awaiting_confirm', 'De confirmat'],
  ['failed', 'Eșuate'],
  ['sent', 'Trimise'],
];

function Invoices({ status, fail, say, reload }: Ctx) {
  const [filter, setFilter] = useState<InvoiceStatus | 'all'>('all');
  const [rows, setRows] = useState<WebInvoice[] | null>(null);
  const load = useCallback(() => web.invoices(filter, 100).then(setRows).catch(fail), [filter, fail]);
  useEffect(() => {
    load();
  }, [load, status?.lastSync]);
  return (
    <>
      <Head title="Facturi" sub={rows ? `${rows.length} documente` : '…'} />
      <div className="seg m-filters">
        {FILTERS.map(([id, label]) => (
          <button key={id} className={filter === id ? 'on' : ''} onClick={() => setFilter(id)}>
            {label}
          </button>
        ))}
      </div>
      <Card>{rows && rows.length === 0 ? <div className="hint">Nimic aici.</div> : <InvoiceList rows={rows ?? []} onChange={() => (load(), reload())} fail={fail} say={say} />}</Card>
    </>
  );
}

function SpendingTab({ fail, status }: Ctx) {
  const [range, setRange] = useState<RangeKey>('year');
  const [report, setReport] = useState<SpendingReport | null>(null);
  const r = rangeFor(range);
  useEffect(() => {
    setReport(null);
    web.spending(r.from, r.to).then(setReport).catch(fail);
  }, [range, status?.lastSync]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <Head title="Cheltuieli" sub="În lei, la cursul BNR din ziua facturii." />
      <div className="m-filters">
        <RangePicker value={range} onChange={setRange} />
      </div>
      <SpendingView
        report={report}
        actions={
          <div className="row tight">
            <a className="btn sm" href={web.exportUrl('csv', r.from, r.to)}>
              <Icon name="download" size={14} /> CSV
            </a>
            <a className="btn sm" href={web.exportUrl('xlsx', r.from, r.to)}>
              <Icon name="download" size={14} /> Excel
            </a>
          </div>
        }
      />
    </>
  );
}

function TaxTab({ fail, status }: Ctx) {
  const [month, setMonth] = useState(thisMonth());
  const [tax, setTax] = useState<TaxOverview | null>(null);
  useEffect(() => {
    web.tax(month).then(setTax).catch(fail);
  }, [month, status?.lastSync, fail]);
  return (
    <>
      <Head title="TVA" sub="Plafon, OSS și taxare inversă – informativ." />
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
      />
    </>
  );
}

function More({ fail, onUnpaired, status }: Ctx & { onUnpaired: () => void }) {
  const [info, setInfo] = useState<WebInfo | null>(null);
  const prev = shiftMonth(thisMonth(), -1);
  useEffect(() => {
    web.info().then(setInfo).catch(fail);
  }, [fail]);
  const c = status?.connections;
  return (
    <>
      <Head title="Mai mult" sub={info ? `${info.company || 'Firma ta'} · FacturaBot ${info.version}` : '…'} />
      <div className="stack">
        <Card title="Pachet pentru contabilă" icon="package">
          <p className="hint" style={{ marginTop: 0 }}>
            Facturile din {monthLong(prev)} + raportul lunar, CSV și Excel, într-o arhivă ZIP.
          </p>
          <a className="btn primary" href={web.packageUrl(prev)}>
            <Icon name="download" size={15} /> Descarcă ZIP – {monthLong(prev)}
          </a>
        </Card>
        <Card title="Conexiuni">
          <div className="conn-list">
            {(
              [
                ['Gmail', c?.gmail],
                ['Outlook', c?.outlook],
                ['FGO', c?.fgo],
                ['Meta Ads', c?.meta],
                ['TikTok Ads', c?.tiktok],
                ['Google Ads', c?.googleAds],
                ['WhatsApp', c?.whatsappWeb === 'connected' || c?.whatsappCloud],
              ] as [string, boolean | undefined][]
            ).map(([l, ok]) => (
              <div key={l} className="conn">
                <span className={`dot ${ok ? 'ok' : 'off'}`} />
                <div className="grow row-title">{l}</div>
                <span className={`hint ${ok ? 'ok-text' : ''}`}>{ok ? 'activ' : '—'}</span>
              </div>
            ))}
          </div>
          <p className="hint">Conturile și setările se schimbă doar din aplicația de pe calculator.</p>
        </Card>
        <Card title="Contabila">
          <div className="row-title">{info?.accountant || '—'}</div>
          <div className="hint">Verificare automată la fiecare {info?.pollMinutes ?? '…'} minute.</div>
        </Card>
        <button
          className="btn danger"
          onClick={async () => {
            if (!confirm('Deconectezi acest telefon? Va trebui împerecheat din nou.')) return;
            await web.logout().catch(() => undefined);
            onUnpaired();
          }}
        >
          <Icon name="logout" size={15} /> Deconectează telefonul
        </button>
      </div>
    </>
  );
}
