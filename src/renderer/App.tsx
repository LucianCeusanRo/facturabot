import { useCallback, useEffect, useState } from 'react';
import type { DeepPartial, Settings, StatusSnapshot, WhatsAppWebState } from '../shared/types';
import { api } from './api';
import { Icon } from './components/Icon';
import { Dashboard } from './pages/Dashboard';
import { History } from './pages/History';
import { Onboarding } from './pages/Onboarding';
import { SettingsPage } from './pages/Settings';
import { Spending } from './pages/Spending';
import { Tax } from './pages/Tax';

export type Page = 'dashboard' | 'history' | 'spending' | 'tax' | 'settings';

export interface Store {
  settings: Settings;
  status: StatusSnapshot | null;
  wa: WhatsAppWebState;
  save: (p: DeepPartial<Settings>) => Promise<Settings>;
  refresh: () => Promise<void>;
  toast: (msg: string, kind?: 'ok' | 'err') => void;
}

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [status, setStatus] = useState<StatusSnapshot | null>(null);
  const [wa, setWa] = useState<WhatsAppWebState>({ status: 'disconnected' });
  const [page, setPage] = useState<Page>('dashboard');
  const [forcedStep, setForcedStep] = useState<number | null>(null);
  const [toasts, setToasts] = useState<{ id: number; msg: string; kind: 'ok' | 'err' }[]>([]);

  const refresh = useCallback(async () => {
    const [s, st, w] = await Promise.all([api.getSettings(), api.status(), api.waState()]);
    setSettings(s);
    setStatus(st);
    setWa(w);
  }, []);

  useEffect(() => {
    refresh();
    const offs = [
      api.on('status', setStatus),
      api.on('wa-state', setWa),
      api.on('navigate', (p: string) => {
        if (p.startsWith('onboarding')) setForcedStep(Number(p.split('-')[1] ?? 1));
        else {
          setForcedStep(null);
          setPage(p as Page);
        }
      }),
    ];
    return () => offs.forEach((o) => o());
  }, [refresh]);

  const save = useCallback(async (p: DeepPartial<Settings>) => {
    const s = await api.saveSettings(p);
    setSettings(s);
    return s;
  }, []);

  const toast = useCallback((msg: string, kind: 'ok' | 'err' = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);

  if (!settings) return <div className="boot" />;
  const store: Store = { settings, status, wa, save, refresh, toast };

  const toastLayer = (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <Icon name={t.kind === 'ok' ? 'check' : 'alert'} size={16} /> {t.msg}
        </div>
      ))}
    </div>
  );

  if (!settings.onboardingDone || forcedStep !== null)
    return (
      <>
        <div className="titlebar" />
        <Onboarding store={store} initialStep={forcedStep ?? 1} onDone={() => setForcedStep(null)} />
        {toastLayer}
      </>
    );

  const nav: { id: Page; label: string; icon: string }[] = [
    { id: 'dashboard', label: 'Facturi', icon: 'home' },
    { id: 'history', label: 'Istoric', icon: 'history' },
    { id: 'spending', label: 'Cheltuieli', icon: 'chart' },
    { id: 'tax', label: 'TVA', icon: 'tax' },
    { id: 'settings', label: 'Setări', icon: 'settings' },
  ];

  return (
    <div className="shell">
      <div className="titlebar" />
      <aside className="sidebar">
        <div className="brand">
          <div className="logo">
            <Icon name="send" size={18} />
          </div>
          <div className="brand-text">
            <div className="brand-name">FacturaBot</div>
            <div className="brand-sub">către contabilă</div>
          </div>
        </div>
        <nav>
          {nav.map((n) => (
            <button key={n.id} className={`nav-item ${page === n.id ? 'active' : ''}`} onClick={() => setPage(n.id)} title={n.label} aria-label={n.label}>
              <Icon name={n.icon} />
              <span className="nav-label">{n.label}</span>
              {n.id === 'history' && (status?.stats.pending ?? 0) > 0 && <span className="badge">{status!.stats.pending}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className={`pulse ${status?.syncing ? 'busy' : 'idle'}`} />
          <div className="foot-text">
            <div className="foot-title">{status?.syncing ? 'Sincronizez…' : 'Rulează în fundal'}</div>
            <div className="foot-sub">
              {status?.nextSync ? `Următoarea verificare ${relTimeShort(status.nextSync)}` : `La fiecare ${settings.pollMinutes} min`}
            </div>
          </div>
        </div>
      </aside>
      <main className="content">
        {page === 'dashboard' && <Dashboard store={store} go={setPage} />}
        {page === 'history' && <History store={store} />}
        {page === 'spending' && <Spending store={store} />}
        {page === 'tax' && <Tax store={store} go={setPage} />}
        {page === 'settings' && <SettingsPage store={store} />}
      </main>
      {toastLayer}
    </div>
  );
}

function relTimeShort(iso: string) {
  const m = Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60000));
  return m <= 0 ? 'acum' : `în ${m} min`;
}
