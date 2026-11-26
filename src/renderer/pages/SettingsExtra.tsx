import { useEffect, useState } from 'react';
import { DIRECT_SOURCES, TAX_SOURCES, type SourceMeta } from '../../shared/sourcesMeta';
import type { DirectSourceId, FxRule, RemoteState, SecretKey, VatRegime } from '../../shared/types';
import { api, fmtDate } from '../api';
import type { Store } from '../App';
import { Icon } from '../components/Icon';
import { Field, Toggle } from '../components/ui';

/** Câmp numeric salvat la ieșire (nu la fiecare tastă – validarea din main ar tăia valorile intermediare). */
function NumberInput({ value, onSave, min, max, step, suffix }: { value: number; onSave: (v: number) => void; min?: number; max?: number; step?: number; suffix?: string }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <div className="input-suffix">
      <input
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const n = Number(text.replace(',', '.'));
          if (Number.isFinite(n) && n !== value) onSave(n);
          else setText(String(value));
        }}
      />
      {suffix && <span>{suffix}</span>}
    </div>
  );
}

function TextInput({ value, onSave, placeholder, mono }: { value: string; onSave: (v: string) => void; placeholder?: string; mono?: boolean }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return <input className={mono ? 'mono' : ''} value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} onBlur={() => text.trim() !== value && onSave(text.trim())} />;
}

function SecretInput({ k, label, hint, store }: { k: SecretKey; label: string; hint?: string; store: Store }) {
  const [has, setHas] = useState(false);
  const [v, setV] = useState('');
  useEffect(() => {
    api.hasSecret(k).then(setHas);
  }, [k]);
  return (
    <Field label={label} hint={hint}>
      <div className="row tight">
        <input
          type="password"
          className="mono"
          value={v}
          placeholder={has ? 'salvat – lipește altul ca să-l schimbi' : 'lipește aici'}
          onChange={(e) => setV(e.target.value)}
          onBlur={async () => {
            if (!v.trim()) return;
            await api.setSecret(k, v.trim());
            setV('');
            setHas(true);
            store.toast('Salvat criptat pe acest calculator');
          }}
        />
        {has && (
          <button
            className="btn ghost danger sm"
            onClick={async () => {
              await api.clearSecret(k);
              setHas(false);
            }}
          >
            Șterge
          </button>
        )}
      </div>
    </Field>
  );
}

// ---------- Surse directe ----------
export function DirectSources({ store }: { store: Store }) {
  return (
    <div className="stack">
      {DIRECT_SOURCES.map((m) => (
        <DirectSourceCard key={m.id} meta={m} store={store} />
      ))}
      <p className="hint">
        Shopify nu are API public pentru facturile de abonament: facturile și chitanțele Shopify (ca și cele Meta, TikTok, Google plătite cu cardul) sunt preluate din email, iar suma, moneda și scadența sunt citite din text pe reguli.
      </p>
    </div>
  );
}

function DirectSourceCard({ meta, store }: { meta: SourceMeta; store: Store }) {
  const { settings, save, status, toast } = store;
  const id = meta.id as DirectSourceId;
  const cfg = settings.sources[id];
  const connected = !!status?.connections[id];
  const [open, setOpen] = useState(cfg.enabled && !connected);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const test = async () => {
    setBusy(true);
    setResult(null);
    const r = await api.testSource(id);
    setBusy(false);
    setResult({ ok: r.ok, text: r.ok ? (r.info ?? 'Conexiune reușită') : (r.error ?? 'Eroare') });
    await store.refresh();
  };

  return (
    <div className={`source-card ${connected ? 'connected' : ''}`}>
      <button className="source-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={`src-logo big logo-${id === 'googleAds' ? 'gads' : id}`}>{id === 'meta' ? 'M' : id === 'tiktok' ? 'T' : 'A'}</span>
        <div className="grow">
          <div className="cc-title">{meta.title}</div>
          <div className="hint">{meta.short}</div>
        </div>
        {connected ? <span className="pill ok">Conectat</span> : cfg.enabled ? <span className="pill warn">Neverificat</span> : <span className="pill muted">Opțional</span>}
      </button>
      {open && (
        <div className="source-body stack">
          <ol className="steps">
            {meta.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          <div className="grid2">
            {id === 'meta' && (
              <>
                <Field label="Business ID">
                  <TextInput mono value={settings.sources.meta.businessId} placeholder="1234567890" onSave={(v) => save({ sources: { meta: { businessId: v } } })} />
                </Field>
                <Field label="Versiune Graph API" hint="Implicit v27.0">
                  <TextInput mono value={settings.sources.meta.apiVersion} onSave={(v) => save({ sources: { meta: { apiVersion: v } } })} />
                </Field>
              </>
            )}
            {id === 'tiktok' && (
              <>
                <Field label="Business Center ID">
                  <TextInput mono value={settings.sources.tiktok.bcId} placeholder="7000000000000000000" onSave={(v) => save({ sources: { tiktok: { bcId: v } } })} />
                </Field>
                <Field label="Tipuri de facturi" hint="Separate prin virgulă (ex. RECON, CREDIT).">
                  <TextInput
                    mono
                    value={settings.sources.tiktok.invoiceTypes.join(', ')}
                    onSave={(v) => save({ sources: { tiktok: { invoiceTypes: v.split(/[,\s]+/).filter(Boolean) } } })}
                  />
                </Field>
              </>
            )}
            {id === 'googleAds' && (
              <>
                <Field label="Customer ID" hint="Fără liniuțe.">
                  <TextInput mono value={settings.sources.googleAds.customerId} placeholder="1234567890" onSave={(v) => save({ sources: { googleAds: { customerId: v.replace(/-/g, '') } } })} />
                </Field>
                <Field label="Billing setup ID">
                  <TextInput mono value={settings.sources.googleAds.billingSetupId} onSave={(v) => save({ sources: { googleAds: { billingSetupId: v } } })} />
                </Field>
                <Field label="login-customer-id (MCC, opțional)">
                  <TextInput mono value={settings.sources.googleAds.loginCustomerId} onSave={(v) => save({ sources: { googleAds: { loginCustomerId: v.replace(/-/g, '') } } })} />
                </Field>
                <Field label="Versiune API" hint="Implicit v26">
                  <TextInput mono value={settings.sources.googleAds.apiVersion} onSave={(v) => save({ sources: { googleAds: { apiVersion: v } } })} />
                </Field>
              </>
            )}
          </div>
          {id === 'meta' && <SecretInput store={store} k="meta.token" label="Token utilizator de sistem" hint="Stocat criptat local (Windows DPAPI)." />}
          {id === 'tiktok' && <SecretInput store={store} k="tiktok.token" label="Access Token" hint="Stocat criptat local (Windows DPAPI)." />}
          {id === 'googleAds' && (
            <>
              <SecretInput store={store} k="googleAds.developerToken" label="Developer token" hint="Din Google Ads → API Center." />
              <div className="row">
                <button
                  className="btn"
                  disabled={busy || !settings.oauthClients.googleClientId}
                  onClick={async () => {
                    setBusy(true);
                    const r = await api.connectGoogleAds();
                    setBusy(false);
                    await store.refresh();
                    toast(r.ok ? `Google Ads autorizat: ${r.account ?? 'cont'}` : (r.error ?? 'Eroare'), r.ok ? 'ok' : 'err');
                  }}
                >
                  <Icon name="key" size={15} /> {settings.sources.googleAds.account ? `Autorizat: ${settings.sources.googleAds.account}` : 'Conectează Google Ads'}
                </button>
                {!settings.oauthClients.googleClientId && <span className="hint">Necesită Google Client ID (vezi Gmail mai sus).</span>}
              </div>
            </>
          )}
          <Toggle checked={cfg.enabled} onChange={(v) => save({ sources: { [id]: { enabled: v } } })} label="Preia facturile din această sursă" hint={meta.note} />
          <div className="row">
            <button className="btn primary" disabled={busy} onClick={test}>
              <Icon name="zap" size={15} /> {busy ? 'Testez…' : 'Testează conexiunea'}
            </button>
            <a className="link-btn" href={meta.docs} target="_blank" rel="noreferrer">
              Documentația oficială <Icon name="open" size={13} />
            </a>
          </div>
          {result && <div className={`test-result ${result.ok ? 'ok' : 'err'}`}>{result.text}</div>}
        </div>
      )}
    </div>
  );
}

// ---------- Firmă și TVA ----------
const REGIMES: { id: VatRegime; label: string; hint: string }[] = [
  { id: 'none', label: 'Neplătitor de TVA', hint: 'Pentru servicii din UE (Meta, Google…) ai nevoie de cod special art. 317 (D700) și depui D301 + D390.' },
  { id: 'art317', label: 'Cod special TVA (art. 317)', hint: 'Ai cod pentru achiziții intracomunitare: D301 lunar când ai achiziții, D390 pentru cele din UE.' },
  { id: 'art316', label: 'Plătitor de TVA (art. 316)', hint: 'Taxarea inversă intră în D300 (și D390 pentru UE).' },
];

export function CompanyTax({ store }: { store: Store }) {
  const { settings, save } = store;
  const t = settings.tax;
  const regime = REGIMES.find((r) => r.id === settings.company.vatRegime)!;
  return (
    <div className="stack">
      <div className="grid2">
        <Field label="Numele firmei" hint="Apare în raportul lunar.">
          <TextInput value={settings.company.name} placeholder="SC Exemplu SRL" onSave={(v) => save({ company: { name: v } })} />
        </Field>
        <Field label="Regim TVA" hint={regime.hint}>
          <select value={settings.company.vatRegime} onChange={(e) => save({ company: { vatRegime: e.target.value as VatRegime } })}>
            {REGIMES.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Plafon scutire TVA"
          hint={
            <>
              395.000 lei din 1 sept. 2025 ·{' '}
              <a href={TAX_SOURCES.vatThreshold} target="_blank" rel="noreferrer">
                OG 22/2025
              </a>
            </>
          }
        >
          <NumberInput value={t.vatThresholdRon} min={1000} step={1000} suffix="lei" onSave={(v) => save({ tax: { vatThresholdRon: v } })} />
        </Field>
        <Field
          label="Prag OSS"
          hint={
            <>
              10.000 EUR/an, art. 59c Directiva TVA ·{' '}
              <a href={TAX_SOURCES.oss} target="_blank" rel="noreferrer">
                Comisia Europeană
              </a>
            </>
          }
        >
          <NumberInput value={t.ossThresholdEur} min={0} step={500} suffix="EUR" onSave={(v) => save({ tax: { ossThresholdEur: v } })} />
        </Field>
        <Field label="Alertă la" hint="Primești notificare la acest procent și la 100%.">
          <NumberInput value={t.warnPercent} min={10} max={99} suffix="%" onSave={(v) => save({ tax: { warnPercent: v } })} />
        </Field>
        <Field label="Cota standard TVA" hint="21% din 1 aug. 2025 (Legea 141/2025). Folosită la estimarea taxării inverse.">
          <NumberInput value={t.vatRatePercent} min={0} max={30} suffix="%" onSave={(v) => save({ tax: { vatRatePercent: v } })} />
        </Field>
        <Field label="Alte venituri în anul curent" hint="Încasări care nu sunt facturate prin FGO (se adună la plafon).">
          <NumberInput value={t.extraRevenueRon} min={0} step={100} suffix="lei" onSave={(v) => save({ tax: { extraRevenueRon: v } })} />
        </Field>
        <Field
          label="Curs BNR folosit"
          hint={
            <>
              Art. 290 Cod fiscal ·{' '}
              <a href={TAX_SOURCES.fx} target="_blank" rel="noreferrer">
                ANAF
              </a>
            </>
          }
        >
          <select value={t.fxRule} onChange={(e) => save({ tax: { fxRule: e.target.value as FxRule } })}>
            <option value="previous">Ultimul curs publicat înainte de data facturii</option>
            <option value="same-day">Cursul publicat în ziua facturii</option>
          </select>
        </Field>
      </div>
      <p className="hint">Toate calculele de TVA sunt informative, pe reguli, și nu înlocuiesc contabilul sau consultanța fiscală.</p>
    </div>
  );
}

// ---------- Rapoarte ----------
export function ReportsSettings({ store }: { store: Store }) {
  const { settings, save } = store;
  const r = settings.reports;
  return (
    <div className="stack">
      <Toggle
        checked={r.monthlyEnabled}
        onChange={(v) => save({ reports: { monthlyEnabled: v } })}
        label="Trimite lunar pachetul pentru contabilă"
        hint="Raportul PDF pe canalul principal + arhiva ZIP pe email, pentru luna încheiată."
      />
      <div className="grid2">
        <Field label="În ziua din lună">
          <NumberInput value={r.dayOfMonth} min={1} max={28} onSave={(v) => save({ reports: { dayOfMonth: v } })} />
        </Field>
        <Field label="Amintește scadențele cu" hint="Facturi furnizori neplătite (din FGO sau din email).">
          <NumberInput value={r.dueReminderDays} min={0} max={30} suffix="zile" onSave={(v) => save({ reports: { dueReminderDays: v } })} />
        </Field>
        <Field label="Factură lunară lipsă după" hint="Ex. Meta vine lunar – dacă nu a venit până pe X, te anunțăm.">
          <NumberInput value={r.missingGraceDays} min={1} max={28} suffix="zile" onSave={(v) => save({ reports: { missingGraceDays: v } })} />
        </Field>
      </div>
    </div>
  );
}

// ---------- Acces de pe telefon ----------
export function PhoneAccess({ store }: { store: Store }) {
  const { settings, save, toast } = store;
  const [st, setSt] = useState<RemoteState | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.remoteState().then(setSt);
    return api.on('remote-state', setSt);
  }, []);

  const toggle = async (on: boolean) => {
    setBusy(true);
    const s = await api.remoteSetEnabled(on);
    setSt(s);
    setBusy(false);
    await store.refresh();
    if (on && !s.running) toast(s.error ?? 'Nu am putut porni serverul local', 'err');
  };

  return (
    <div className="stack">
      <Toggle
        checked={settings.remote.enabled}
        onChange={toggle}
        label="Panou pe telefon"
        hint="Pornește un server local pe acest calculator. Telefonul se conectează prin Wi-Fi-ul tău, după împerechere cu cod. Nimic nu trece printr-un cloud FacturaBot."
      />
      {settings.remote.enabled && st && (
        <>
          {st.running ? (
            <div className="pair">
              {st.pairing ? (
                <>
                  <img className="pair-qr" src={st.pairing.qrDataUrl} alt="Cod QR pentru împerechere" />
                  <div className="stack">
                    <div>
                      <div className="hint">Scanează cu camera telefonului sau deschide adresa și introdu codul:</div>
                      <div className="pair-code mono">{st.pairing.code.replace(/(\d{3})(\d{3})/, '$1 $2')}</div>
                      <div className="hint">Valabil până la {fmtDate(st.pairing.expiresAt, true)} · o singură folosire</div>
                    </div>
                    <div className="url-list">
                      {st.urls.map((u) => (
                        <code key={u}>{u}</code>
                      ))}
                    </div>
                    <div className="row">
                      <button className="btn" disabled={busy} onClick={() => api.remoteNewPairing().then(setSt)}>
                        <Icon name="refresh" size={15} /> Cod nou
                      </button>
                    </div>
                  </div>
                </>
              ) : (
                <div className="stack">
                  <div className="url-list">
                    {st.urls.map((u) => (
                      <code key={u}>{u}</code>
                    ))}
                  </div>
                  <div className="row">
                    <button className="btn primary" onClick={() => api.remoteNewPairing().then(setSt)}>
                      <Icon name="qr" size={15} /> Adaugă un telefon
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="test-result err">{st.error ?? 'Serverul nu rulează.'}</div>
          )}

          <h4 className="sub">Dispozitive împerecheate</h4>
          {st.devices.length === 0 ? (
            <div className="hint">Niciun telefon încă.</div>
          ) : (
            <div className="list">
              {st.devices.map((d) => (
                <div key={d.id} className="list-row">
                  <Icon name="phone" size={18} />
                  <div className="grow">
                    <div className="row-title">{d.name}</div>
                    <div className="hint">
                      împerecheat {fmtDate(d.createdAt)} · văzut {d.lastSeen ? fmtDate(d.lastSeen, true) : 'niciodată'}
                    </div>
                  </div>
                  <button className="btn ghost danger sm" onClick={() => api.remoteRevoke(d.id).then(setSt)}>
                    Revocă
                  </button>
                </div>
              ))}
            </div>
          )}

          <details className="advanced">
            <summary>Avansat: port și acces din afara casei</summary>
            <div className="stack" style={{ marginTop: 12 }}>
              <div className="grid2">
                <Field label="Port" hint="Implicit 8787. Permite-l în Windows Firewall pentru rețele private.">
                  <NumberInput value={settings.remote.port} min={1024} max={65535} onSave={(v) => save({ remote: { port: v } })} />
                </Field>
                <Field label="Adresă publică (opțional)" hint="Adresa HTTPS din Tailscale sau Cloudflare Tunnel – apare în codul QR.">
                  <TextInput mono value={settings.remote.publicUrl} placeholder="https://pc.tailnet-xyz.ts.net" onSave={(v) => save({ remote: { publicUrl: v } })} />
                </Field>
              </div>
              <ul className="hint bullets">
                <li>
                  <strong>Tailscale (recomandat):</strong> instalează Tailscale pe PC și telefon, apoi rulează <code>tailscale serve --bg {settings.remote.port}</code>. Primești o adresă HTTPS vizibilă doar în rețeaua ta privată.
                </li>
                <li>
                  <strong>Cloudflare Tunnel:</strong> <code>cloudflared tunnel --url http://localhost:{settings.remote.port}</code>. Adresa e publică – protejeaz-o cu Cloudflare Access; împerecherea cu cod rămâne obligatorie.
                </li>
                <li>Pe HTTPS poți instala panoul ca aplicație (PWA). Pe Wi-Fi-ul local folosește „Adaugă pe ecranul principal”.</li>
              </ul>
            </div>
          </details>
        </>
      )}
    </div>
  );
}
