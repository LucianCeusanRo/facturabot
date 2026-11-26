import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Store } from '../App';
import { Icon } from '../components/Icon';
import { WhatsAppSetup } from '../components/WhatsAppSetup';
import { Field, Toggle } from '../components/ui';
import { EmailConnect } from './Settings';

const STEPS = [
  { title: 'Conectează emailul', icon: 'mail' },
  { title: 'FGO (opțional)', icon: 'building' },
  { title: 'Contabila', icon: 'user' },
  { title: 'Trimitere', icon: 'whatsapp' },
];

export function Onboarding({ store, initialStep, onDone }: { store: Store; initialStep: number; onDone: () => void }) {
  const [step, setStep] = useState(initialStep);
  const { settings, save, status, toast } = store;
  useEffect(() => setStep(initialStep), [initialStep]);

  const canNext =
    step === 1
      ? !!(status?.connections.gmail || status?.connections.outlook)
      : step === 3
        ? !!(settings.accountant.whatsappNumber || settings.accountant.email)
        : true;

  const finish = async () => {
    await save({ onboardingDone: true });
    await api.syncNow();
    toast('Gata! FacturaBot rulează acum în fundal 🎉');
    onDone();
  };

  return (
    <div className="onboarding">
      <div className="ob-side">
        <div className="brand big">
          <div className="logo">
            <Icon name="send" size={22} />
          </div>
          <div>
            <div className="brand-name">FacturaBot</div>
            <div className="brand-sub">Facturile ajung singure la contabilă</div>
          </div>
        </div>
        <ol className="stepper">
          {STEPS.map((s, i) => (
            <li key={i} className={step === i + 1 ? 'current' : step > i + 1 ? 'done' : ''} onClick={() => i + 1 < step && setStep(i + 1)}>
              <span className="step-num">{step > i + 1 ? <Icon name="check" size={14} /> : i + 1}</span>
              <span>{s.title}</span>
            </li>
          ))}
        </ol>
        <div className="ob-note">
          <Icon name="shield" size={16} />
          <span>Totul rămâne pe calculatorul tău. Parolele și tokenurile sunt criptate de Windows.</span>
        </div>
      </div>

      <div className="ob-main">
        <div className="ob-progress">
          <div style={{ width: `${(step / STEPS.length) * 100}%` }} />
        </div>
        <div className="ob-body">
          {step === 1 && (
            <>
              <h1>Unde îți vin facturile?</h1>
              <p className="lead">
                Conectează emailul firmei. FacturaBot caută automat PDF-urile de tip factură/chitanță (Meta, Google, TikTok, Shopify, Stripe, PayPal, eMAG,
                curieri…) – inclusiv chitanțele Meta Ads care vin fără PDF.
              </p>
              <EmailConnect store={store} />
            </>
          )}
          {step === 2 && (
            <>
              <h1>Folosești FGO?</h1>
              <p className="lead">Dacă da, FacturaBot ia și facturile de la furnizori (și, opțional, pe cele emise de tine) direct din FGO. Poți sări peste.</p>
              <FgoForm store={store} />
            </>
          )}
          {step === 3 && (
            <>
              <h1>Cui trimitem facturile?</h1>
              <p className="lead">Datele contabilei. Completează WhatsApp, email sau ambele (emailul e folosit și ca backup).</p>
              <AccountantForm store={store} />
            </>
          )}
          {step === 4 && (
            <>
              <h1>Cum ajung facturile la contabilă?</h1>
              <p className="lead">Alege varianta potrivită. O poți schimba oricând din Setări.</p>
              <WhatsAppSetup store={store} />
            </>
          )}
        </div>
        <div className="ob-foot">
          {step > 1 ? (
            <button className="btn ghost" onClick={() => setStep(step - 1)}>
              <Icon name="back" /> Înapoi
            </button>
          ) : (
            <span />
          )}
          <div className="row">
            {step === 2 && (
              <button className="btn ghost" onClick={() => setStep(3)}>
                Sari peste
              </button>
            )}
            {step < 4 ? (
              <button className="btn primary" disabled={!canNext} onClick={() => setStep(step + 1)}>
                Continuă <Icon name="arrow" />
              </button>
            ) : (
              <button className="btn primary" onClick={finish}>
                <Icon name="zap" /> Pornește FacturaBot
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function FgoForm({ store }: { store: Store }) {
  const { settings, save, toast } = store;
  const fgo = settings.sources.fgo;
  const [key, setKey] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.hasSecret('fgo.apiKey').then(setHasKey);
  }, []);
  const test = async () => {
    setBusy(true);
    if (key.trim()) {
      await api.setSecret('fgo.apiKey', key.trim());
      setKey('');
      setHasKey(true);
    }
    const r = await api.testFgo();
    setBusy(false);
    if (r.ok) {
      await save({ sources: { fgo: { enabled: true } } });
      toast(`FGO conectat. ${r.info ?? ''}`);
    } else toast(`FGO: ${r.error}`, 'err');
  };
  return (
    <div className="stack">
      <div className="grid2">
        <Field label="CUI firmă (fără RO)">
          <input value={fgo.codUnic ?? ''} onChange={(e) => save({ sources: { fgo: { codUnic: e.target.value.replace(/\s/g, '') } } })} placeholder="12345678" />
        </Field>
        <Field label="Cheie API FGO" hint={hasKey ? 'Cheie salvată ✓' : 'FGO → Setări → Utilizatori → cheie API (drepturi: furnizori:citire, facturi:citire)'}>
          <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={hasKey ? '••••••••' : 'fgo_api_v2…'} />
        </Field>
      </div>
      <Toggle checked={fgo.includeSuppliers} onChange={(v) => save({ sources: { fgo: { includeSuppliers: v } } })} label="Facturi de la furnizori" hint="Documentele primite înregistrate în FGO." />
      <Toggle checked={fgo.includeIssued} onChange={(v) => save({ sources: { fgo: { includeIssued: v } } })} label="Facturi emise de mine" hint="Trimite și PDF-ul facturilor pe care le emiți." />
      <div className="row">
        <button className="btn" onClick={test} disabled={busy || !fgo.codUnic || (!key && !hasKey)}>
          <Icon name="key" /> {busy ? 'Verific…' : 'Verifică și conectează'}
        </button>
        {fgo.enabled && (
          <span className="pill ok">
            <Icon name="check" size={12} /> Activ
          </span>
        )}
      </div>
    </div>
  );
}

export function AccountantForm({ store }: { store: Store }) {
  const { settings, save } = store;
  const a = settings.accountant;
  return (
    <div className="stack">
      <Field label="Nume (opțional)">
        <input value={a.name} onChange={(e) => save({ accountant: { name: e.target.value } })} placeholder="ex. Andreea – Cabinet contabil" />
      </Field>
      <div className="grid2">
        <Field label="WhatsApp contabilă" hint="Format: 07xx xxx xxx sau +40…">
          <input value={a.whatsappNumber} onChange={(e) => save({ accountant: { whatsappNumber: e.target.value } })} placeholder="0722 123 456" />
        </Field>
        <Field label="Email contabilă" hint="Folosit ca backup sau ca metodă principală">
          <input type="email" value={a.email} onChange={(e) => save({ accountant: { email: e.target.value.trim() } })} placeholder="contabil@cabinet.ro" />
        </Field>
      </div>
    </div>
  );
}
