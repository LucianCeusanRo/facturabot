import { useEffect, useState } from 'react';
import type { LogEntry, Theme } from '../../shared/types';
import { api, fmtDate } from '../api';
import type { Store } from '../App';
import { Icon } from '../components/Icon';
import { WhatsAppSetup } from '../components/WhatsAppSetup';
import { Field, Toggle } from '../components/ui';
import { AccountantForm, FgoForm } from './Onboarding';
import { CompanyTax, DirectSources, PhoneAccess, ReportsSettings } from './SettingsExtra';

export function EmailConnect({ store }: { store: Store }) {
  const { settings, status, save, toast, refresh } = store;
  const [busy, setBusy] = useState<'g' | 'm' | null>(null);
  const [adv, setAdv] = useState(!settings.oauthClients.googleClientId);
  const [gSecret, setGSecret] = useState('');

  const connect = async (which: 'g' | 'm') => {
    setBusy(which);
    const r = which === 'g' ? await api.connectGoogle() : await api.connectMicrosoft();
    setBusy(null);
    await refresh();
    if (r.ok) {
      if (which === 'm') await save({ delivery: { emailProvider: settings.sources.gmail.enabled ? settings.delivery.emailProvider : 'outlook' } });
      toast(`Conectat: ${r.account ?? 'cont'}`);
    } else toast(r.error ?? 'Eroare', 'err');
  };

  const disconnect = async (which: 'gmail' | 'outlook') => {
    if (!confirm(`Deconectezi contul ${which === 'gmail' ? 'Gmail' : 'Outlook'}? FacturaBot nu va mai citi facturi din el.`)) return;
    await api.disconnectAccount(which);
    await refresh();
    toast('Cont deconectat');
  };

  return (
    <div className="stack">
      <div className="connect-grid">
        <div className={`connect-card ${status?.connections.gmail ? 'connected' : ''}`}>
          <span className="src-logo logo-gmail big">G</span>
          <div className="grow">
            <div className="cc-title">Gmail / Google Workspace</div>
            <div className="hint">{status?.connections.gmail ? settings.sources.gmail.account ?? 'Conectat' : 'Recomandat – te loghezi în browser, atât.'}</div>
          </div>
          {status?.connections.gmail ? (
            <Connected onDisconnect={() => disconnect('gmail')} />
          ) : (
            <button className="btn primary" onClick={() => connect('g')} disabled={!!busy || !settings.oauthClients.googleClientId}>
              {busy === 'g' ? 'Aștept browserul…' : 'Conectează'}
            </button>
          )}
        </div>
        <div className={`connect-card ${status?.connections.outlook ? 'connected' : ''}`}>
          <span className="src-logo logo-outlook big">O</span>
          <div className="grow">
            <div className="cc-title">Outlook / Microsoft 365</div>
            <div className="hint">{status?.connections.outlook ? settings.sources.outlook.account ?? 'Conectat' : 'Alternativă pentru conturi Microsoft.'}</div>
          </div>
          {status?.connections.outlook ? (
            <Connected onDisconnect={() => disconnect('outlook')} />
          ) : (
            <button className="btn" onClick={() => connect('m')} disabled={!!busy || !settings.oauthClients.microsoftClientId}>
              {busy === 'm' ? 'Aștept browserul…' : 'Conectează'}
            </button>
          )}
        </div>
      </div>
      <button className="link-btn" onClick={() => setAdv(!adv)}>
        <Icon name="key" size={14} /> {adv ? 'Ascunde' : 'Arată'} cheile aplicației (Client ID) {!settings.oauthClients.googleClientId && '– necesare o singură dată'}
      </button>
      {adv && (
        <div className="advanced">
          <p className="hint">
            Dacă instalatorul nu vine cu chei pre-configurate, creează-le o singură dată (5 minute) urmând README → „Credențiale Google”. Cheile rămân pe acest PC.
          </p>
          <div className="grid2">
            <Field label="Google OAuth Client ID (tip Desktop app)">
              <input value={settings.oauthClients.googleClientId} onChange={(e) => save({ oauthClients: { googleClientId: e.target.value.trim() } })} placeholder="xxxx.apps.googleusercontent.com" />
            </Field>
            <Field label="Google Client secret">
              <input
                type="password"
                value={gSecret}
                placeholder="GOCSPX-…"
                onChange={(e) => setGSecret(e.target.value)}
                onBlur={async () => {
                  if (gSecret.trim()) {
                    await api.setSecret('google.clientSecret', gSecret.trim());
                    setGSecret('');
                    toast('Client secret salvat');
                  }
                }}
              />
            </Field>
            <Field label="Microsoft (Azure) Application ID" hint="Opțional, doar pentru Outlook">
              <input value={settings.oauthClients.microsoftClientId} onChange={(e) => save({ oauthClients: { microsoftClientId: e.target.value.trim() } })} placeholder="00000000-0000-…" />
            </Field>
          </div>
        </div>
      )}
    </div>
  );
}

function Connected({ onDisconnect }: { onDisconnect: () => void }) {
  return (
    <div className="row tight">
      <span className="pill ok">
        <Icon name="check" size={12} /> Conectat
      </span>
      <button className="btn ghost danger sm" onClick={onDisconnect} title="Deconectează contul">
        Deconectează
      </button>
    </div>
  );
}

export function SettingsPage({ store }: { store: Store }) {
  const { settings, save } = store;
  const [logs, setLogs] = useState<LogEntry[]>([]);
  useEffect(() => {
    api.listLogs(80).then(setLogs);
  }, [store.status]);

  const themes: [Theme, string, string][] = [
    ['system', 'Sistem', 'monitor'],
    ['light', 'Luminos', 'sun'],
    ['dark', 'Întunecat', 'moon'],
  ];

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Setări</h1>
          <p className="lead">Surse, contabilă, trimitere, TVA și acces de pe telefon.</p>
        </div>
      </header>
      <div className="settings-sheet">
        <section className="set-row">
          <div className="set-label">
            <h2>Surse de facturi</h2>
            <p>Gmail, Outlook și, opțional, FGO. Detectarea e pe reguli — fără AI, 100% local.</p>
          </div>
          <div className="set-panel stack">
            <EmailConnect store={store} />
            <div className="sep" />
            <h4 className="sub">FGO (API v2)</h4>
            <FgoForm store={store} />
          </div>
        </section>
        <section className="set-row" id="set-ads">
          <div className="set-label">
            <h2>Platforme de reclame</h2>
            <p>Opțional: facturile Meta, TikTok și Google Ads direct prin API-urile oficiale, pentru conturile cu facturare lunară.</p>
          </div>
          <div className="set-panel">
            <DirectSources store={store} />
          </div>
        </section>
        <section className="set-row">
          <div className="set-label">
            <h2>Contabila</h2>
            <p>Cui ajung facturile și prin ce adresă de expediere pleacă emailul de rezervă.</p>
          </div>
          <div className="set-panel stack">
            <AccountantForm store={store} />
            <Field label="Emailul pleacă prin">
              <div className="seg">
                {(['gmail', 'outlook', 'smtp'] as const).map((p) => (
                  <button key={p} className={settings.delivery.emailProvider === p ? 'on' : ''} onClick={() => save({ delivery: { emailProvider: p } })}>
                    {p === 'gmail' ? 'Gmail' : p === 'outlook' ? 'Outlook' : 'SMTP'}
                  </button>
                ))}
              </div>
            </Field>
            {settings.delivery.emailProvider === 'smtp' && <SmtpForm store={store} />}
          </div>
        </section>
        <section className="set-row">
          <div className="set-label">
            <h2>Trimitere pe WhatsApp</h2>
            <p>WhatsApp Web, API-ul oficial sau doar email. Poți schimba oricând.</p>
          </div>
          <div className="set-panel">
            <WhatsAppSetup store={store} compact />
          </div>
        </section>
        <section className="set-row">
          <div className="set-label">
            <h2>Automatizare</h2>
            <p>Cât de des verifică FacturaBot și dacă vrei confirmare înainte de trimitere.</p>
          </div>
          <div className="set-panel stack">
            <Field label={`Verifică facturi noi la fiecare ${settings.pollMinutes} minute`}>
              <input type="range" min={10} max={60} step={5} value={settings.pollMinutes} onChange={(e) => save({ pollMinutes: Number(e.target.value) })} />
            </Field>
            <Toggle checked={settings.confirmBeforeSend} onChange={(v) => save({ confirmBeforeSend: v })} label="Confirm înainte de trimitere" hint="Primești o notificare și aprobi fiecare factură din „Facturi”." />
            <Toggle checked={settings.autostart} onChange={(v) => save({ autostart: v })} label="Pornește odată cu Windows" hint="Rulează discret în tray, lângă ceas." />
            <Field label="La prima sincronizare, caută în ultimele">
              <select value={settings.lookbackDays} onChange={(e) => save({ lookbackDays: Number(e.target.value) })}>
                {[7, 14, 30, 60, 90].map((d) => (
                  <option key={d} value={d}>
                    {d} zile
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </section>
        <section className="set-row" id="set-tax">
          <div className="set-label">
            <h2>Firmă și TVA</h2>
            <p>Regimul de TVA și pragurile folosite în pagina TVA. Valorile au sursa oficială alături și pot fi schimbate dacă legea se modifică.</p>
          </div>
          <div className="set-panel">
            <CompanyTax store={store} />
          </div>
        </section>
        <section className="set-row" id="set-phone">
          <div className="set-label">
            <h2>Acces de pe telefon</h2>
            <p>Vezi facturile, cheltuielile și TVA-ul de pe telefon și aprobă trimiterile. Server local, împerechere cu cod QR.</p>
          </div>
          <div className="set-panel">
            <PhoneAccess store={store} />
          </div>
        </section>
        <section className="set-row">
          <div className="set-label">
            <h2>Rapoarte și remindere</h2>
            <p>Pachetul lunar pentru contabilă, facturi lunare lipsă și scadențe.</p>
          </div>
          <div className="set-panel">
            <ReportsSettings store={store} />
          </div>
        </section>
        <section className="set-row">
          <div className="set-label">
            <h2>Detectare</h2>
            <p>Reguli locale: cuvinte cheie, liste de expeditori și text extras din PDF. Fără model, fără cheie API de AI.</p>
          </div>
          <div className="set-panel">
            <AdvancedCard store={store} />
          </div>
        </section>
        <section className="set-row">
          <div className="set-label">
            <h2>Aspect și jurnal</h2>
            <p>Temă deschisă, închisă sau cea a sistemului. Jurnalul rămâne pe acest calculator.</p>
          </div>
          <div className="set-panel stack">
            <div className="theme-picker">
              {themes.map(([id, label, icon]) => (
                <button key={id} className={settings.theme === id ? 'on' : ''} onClick={() => save({ theme: id })}>
                  <Icon name={icon} size={20} />
                  {label}
                </button>
              ))}
            </div>
            <h4 className="sub">Jurnal</h4>
            <div className="log">
              {logs.length === 0 && <div className="hint">Nimic încă.</div>}
              {logs.map((l) => (
                <div key={l.id} className={`log-line ${l.level}`}>
                  <span className="log-ts">{fmtDate(l.ts, true)}</span>
                  <span>{l.message}</span>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function SmtpForm({ store }: { store: Store }) {
  const { settings, save, toast } = store;
  const s = settings.delivery.smtp;
  const [pw, setPw] = useState('');
  return (
    <div className="grid2">
      <Field label="Server SMTP">
        <input value={s.host} onChange={(e) => save({ delivery: { smtp: { host: e.target.value.trim() } } })} placeholder="smtp.firma.ro" />
      </Field>
      <Field label="Port">
        <input type="number" value={s.port} onChange={(e) => save({ delivery: { smtp: { port: Number(e.target.value), secure: Number(e.target.value) === 465 } } })} />
      </Field>
      <Field label="Utilizator">
        <input value={s.user} onChange={(e) => save({ delivery: { smtp: { user: e.target.value.trim() } } })} />
      </Field>
      <Field label="Parolă">
        <input
          type="password"
          value={pw}
          placeholder="••••••"
          onChange={(e) => setPw(e.target.value)}
          onBlur={async () => {
            if (pw) {
              await api.setSecret('smtp.password', pw);
              setPw('');
              toast('Parolă SMTP salvată');
            }
          }}
        />
      </Field>
    </div>
  );
}

/** Listă editabilă (separată prin virgulă sau rând nou) – salvată la ieșirea din câmp. */
function ListInput({ value, onSave, placeholder }: { value: string[]; onSave: (v: string[]) => void; placeholder: string }) {
  const [text, setText] = useState(value.join(', '));
  useEffect(() => setText(value.join(', ')), [value]);
  return (
    <textarea
      rows={2}
      value={text}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={() =>
        onSave(
          text
            .split(/[,;\n]/)
            .map((x) => x.trim())
            .filter(Boolean),
        )
      }
    />
  );
}

function AdvancedCard({ store }: { store: Store }) {
  const { settings, save } = store;
  const det = settings.detection;
  const d = settings.delivery;
  const num = (v: string) => Number(v.replace(',', '.'));
  return (
    <div className="stack">
      <p className="hint">Valorile implicite merg pentru majoritatea firmelor. Schimbările se aplică imediat, fără cloud.</p>
      <Field label="Furnizori proprii (adrese sau domenii)" hint="Emailurile de la ei sunt tratate mereu ca facturi. Ex.: contabilitate@furnizor.ro, utilitati.ro">
        <ListInput value={det.extraSenders} onSave={(v) => save({ detection: { extraSenders: v } })} placeholder="furnizor.ro, facturi@firma.ro" />
      </Field>
      <Field label="Expeditori ignorați" hint="Nu trimitem nimic de la aceste adrese/domenii.">
        <ListInput value={det.excludeSenders} onSave={(v) => save({ detection: { excludeSenders: v } })} placeholder="newsletter@magazin.ro" />
      </Field>
      <Field label="Cuvinte cheie suplimentare" hint="Pe lângă factură / invoice / receipt / chitanță.">
        <ListInput value={det.extraKeywords} onSave={(v) => save({ detection: { extraKeywords: v } })} placeholder="aviz, decont" />
      </Field>
      <div className="grid2">
        <Field label="Sensibilitate detectare">
          <select value={det.minScore} onChange={(e) => save({ detection: { minScore: Number(e.target.value) } })}>
            <option value={2}>Mare (prinde tot, poate și extra)</option>
            <option value={3}>Normală (recomandat)</option>
            <option value={4}>Strictă (doar facturi clare)</option>
          </select>
        </Field>
        <Field label="Mărime maximă atașament (MB)">
          <input type="number" min={1} max={100} value={det.maxAttachmentMB} onChange={(e) => save({ detection: { maxAttachmentMB: num(e.target.value) } })} />
        </Field>
        <Field label="Încercări de trimitere" hint="După atâtea eșecuri primești o notificare.">
          <input type="number" min={1} max={20} value={d.maxAttempts} onChange={(e) => save({ delivery: { maxAttempts: num(e.target.value) } })} />
        </Field>
        <Field label="Pauză între mesaje WhatsApp (sec.)" hint="Reduce riscul de restricționare.">
          <input type="number" min={0} max={120} value={d.waDelaySeconds} onChange={(e) => save({ delivery: { waDelaySeconds: num(e.target.value) } })} />
        </Field>
      </div>
      <Field label="Filtru Gmail suplimentar (opțional)" hint="Sintaxă Gmail, ex.: -from:noreply@exemplu.ro label:facturi">
        <input value={settings.sources.gmail.extraQuery ?? ''} onChange={(e) => save({ sources: { gmail: { extraQuery: e.target.value } } })} />
      </Field>
    </div>
  );
}
