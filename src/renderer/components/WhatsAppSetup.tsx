import { useEffect, useState } from 'react';
import type { WhatsAppMode } from '../../shared/types';
import { api } from '../api';
import type { Store } from '../App';
import { Icon } from './Icon';
import { Field, Toggle } from './ui';

const MODES: { id: WhatsAppMode; title: string; tag: string; tagKind: string; points: [boolean, string][] }[] = [
  {
    id: 'web',
    title: 'WhatsApp Web (cod QR)',
    tag: 'Cel mai simplu',
    tagKind: 'ok',
    points: [
      [true, 'Scanezi o dată codul QR cu telefonul și gata – rămâi conectat.'],
      [true, 'Mesajele pleacă de pe numărul tău, contabila te vede pe tine.'],
      [true, 'Telefonul nu trebuie să fie pe același Wi-Fi sau lângă calculator.'],
      [false, 'Neoficial: WhatsApp poate restricționa numărul dacă detectează automatizare (risc mic la câteva mesaje/zi, dar există).'],
      [false, 'Dacă nu folosești telefonul ~14 zile, sesiunea se închide și trebuie scanat din nou.'],
    ],
  },
  {
    id: 'cloud',
    title: 'WhatsApp Business API (oficial)',
    tag: 'Fără risc de blocare',
    tagKind: 'info',
    points: [
      [true, 'Oficial de la Meta – numărul nu riscă să fie blocat.'],
      [true, 'Merge stabil 24/7, fără sesiune care expiră.'],
      [false, 'Setup mai greu: număr separat, cont Meta Business verificat și un șablon de mesaj aprobat.'],
      [false, 'Meta taxează per mesaj (câțiva bani pe conversație de tip Utility).'],
    ],
  },
  {
    id: 'none',
    title: 'Doar pe email',
    tag: 'Fără WhatsApp',
    tagKind: 'muted',
    points: [
      [true, 'Facturile pleacă direct pe emailul contabilei, ca atașament.'],
      [true, 'Zero risc, zero setup în plus.'],
    ],
  },
];

export function WhatsAppSetup({ store, compact }: { store: Store; compact?: boolean }) {
  const { settings, save, wa, toast } = store;
  const mode = settings.delivery.whatsappMode;
  const cloud = settings.delivery.cloud;
  const [token, setToken] = useState('');
  const [hasToken, setHasToken] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    api.hasSecret('whatsapp.cloudToken').then(setHasToken);
  }, []);

  const test = async () => {
    setTesting(true);
    const r = await api.testDelivery();
    setTesting(false);
    toast(r.ok ? `Mesaj de test trimis (${r.channel}) ✅` : `Testul a eșuat: ${r.error}`, r.ok ? 'ok' : 'err');
  };

  return (
    <div className="wa-setup">
      <div className={`mode-grid ${compact ? 'compact' : ''}`}>
        {MODES.map((m) => (
          <button key={m.id} type="button" className={`mode-card ${mode === m.id ? 'selected' : ''}`} onClick={() => save({ delivery: { whatsappMode: m.id } })}>
            <div className="mode-head">
              <span className="radio" />
              <span className="mode-title">{m.title}</span>
              <span className={`pill ${m.tagKind}`}>{m.tag}</span>
            </div>
            <ul>
              {m.points.map(([good, t], i) => (
                <li key={i} className={good ? 'good' : 'bad'}>
                  <Icon name={good ? 'check' : 'alert'} size={14} /> {t}
                </li>
              ))}
            </ul>
          </button>
        ))}
      </div>

      {mode === 'web' && (
        <div className="qr-panel">
          <div className="qr-box">
            {wa.status === 'connected' ? (
              <div className="qr-ok">
                <Icon name="check" size={44} />
                <div>Conectat{wa.me ? ` ca +${wa.me}` : ''}</div>
              </div>
            ) : wa.status === 'qr' && wa.qrDataUrl ? (
              <img src={wa.qrDataUrl} alt="Cod QR WhatsApp" />
            ) : wa.status === 'connecting' ? (
              <div className="qr-wait">
                <div className="spinner" /> Se generează codul…
              </div>
            ) : (
              <div className="qr-wait">
                <Icon name="whatsapp" size={40} />
              </div>
            )}
          </div>
          <div className="qr-steps">
            <h4>{wa.status === 'connected' ? 'WhatsApp este conectat' : 'Leagă WhatsApp în 3 pași'}</h4>
            {wa.status !== 'connected' ? (
              <ol>
                <li>
                  Apasă <b>Generează cod QR</b>
                </li>
                <li>
                  Pe telefon: WhatsApp → <b>Setări</b> → <b>Dispozitive asociate</b> → <b>Asociază un dispozitiv</b>
                </li>
                <li>Scanează codul. Sesiunea se salvează pe acest calculator – nu mai trebuie refăcut.</li>
              </ol>
            ) : (
              <p className="hint">Sesiunea e salvată local, în profilul tău Windows, și rămâne activă după repornire. Poți închide fereastra – FacturaBot rulează în fundal.</p>
            )}
            {wa.status === 'logged_out' && <p className="error-text">{wa.error}</p>}
            <div className="row">
              {wa.status !== 'connected' ? (
                <button className="btn primary" onClick={() => api.waStart()} disabled={wa.status === 'connecting' || wa.status === 'qr'}>
                  <Icon name="whatsapp" /> Generează cod QR
                </button>
              ) : (
                <>
                  <button className="btn" onClick={test} disabled={testing}>
                    <Icon name="send" /> {testing ? 'Se trimite…' : 'Trimite un test'}
                  </button>
                  <button className="btn ghost danger" onClick={() => api.waLogout()}>
                    Deconectează
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {mode === 'cloud' && (
        <div className="cloud-panel">
          <div className="grid2">
            <Field label="Phone number ID" hint="Din Meta for Developers → WhatsApp → API Setup">
              <input value={cloud.phoneNumberId} onChange={(e) => save({ delivery: { cloud: { phoneNumberId: e.target.value.trim() } } })} placeholder="ex. 123456789012345" />
            </Field>
            <Field label="Token de acces (permanent, System User)" hint={hasToken ? 'Token salvat ✓ (scrie altul pentru a-l înlocui)' : 'Se salvează criptat pe acest PC'}>
              <input
                type="password"
                value={token}
                placeholder={hasToken ? '••••••••••••' : 'EAAG…'}
                onChange={(e) => setToken(e.target.value)}
                onBlur={async () => {
                  if (token.trim()) {
                    await api.setSecret('whatsapp.cloudToken', token.trim());
                    setToken('');
                    setHasToken(true);
                    toast('Token salvat');
                  }
                }}
              />
            </Field>
            <Field label="Nume șablon aprobat" hint="Categoria Utility, header DOCUMENT">
              <input value={cloud.templateName} onChange={(e) => save({ delivery: { cloud: { templateName: e.target.value.trim() } } })} />
            </Field>
            <Field label="Limba șablonului">
              <input value={cloud.templateLang} onChange={(e) => save({ delivery: { cloud: { templateLang: e.target.value.trim() } } })} />
            </Field>
          </div>
          <Toggle
            checked={cloud.bodyParam}
            onChange={(v) => save({ delivery: { cloud: { bodyParam: v } } })}
            label="Șablonul are o variabilă {{1}} în corp"
            hint="Ex.: „Bună ziua! Vă trimit o factură nouă: {{1}}.” – FacturaBot o completează cu furnizorul, suma și data."
          />
          <div className="row">
            <button className="btn" onClick={test} disabled={testing}>
              <Icon name="send" /> {testing ? 'Se trimite…' : 'Trimite un test'}
            </button>
            <button className="btn ghost" onClick={() => api.openExternal('https://developers.facebook.com/docs/whatsapp/cloud-api/get-started')}>
              <Icon name="open" /> Ghid Meta
            </button>
          </div>
        </div>
      )}

      {mode !== 'none' && (
        <Toggle
          checked={settings.delivery.emailFallback}
          onChange={(v) => save({ delivery: { emailFallback: v } })}
          label="Backup pe email"
          hint="Dacă WhatsApp nu merge (deconectat, eroare), factura pleacă automat pe emailul contabilei."
        />
      )}
    </div>
  );
}
