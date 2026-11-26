import type { ReactNode } from 'react';
import type { DeliveryChannel, InvoiceStatus } from '../../shared/types';
import { Icon } from './Icon';

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="toggle-row">
      <div>
        <div className="toggle-label">{label}</div>
        {hint && <div className="hint">{hint}</div>}
      </div>
      <button type="button" role="switch" aria-checked={checked} className={`switch ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)}>
        <span />
      </button>
    </label>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

export function Card({ title, icon, children, actions, className }: { title?: string; icon?: string; children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <section className={`card ${className ?? ''}`}>
      {(title || actions) && (
        <header className="card-head">
          <h3>
            {icon && <Icon name={icon} size={17} />} {title}
          </h3>
          <div className="card-actions">{actions}</div>
        </header>
      )}
      {children}
    </section>
  );
}

const STATUS: Record<InvoiceStatus, [string, string]> = {
  sent: ['Trimisă', 'ok'],
  pending: ['În coadă', 'info'],
  sending: ['Se trimite…', 'info'],
  awaiting_confirm: ['De confirmat', 'warn'],
  failed: ['Eșuată', 'err'],
  skipped: ['Ignorată', 'muted'],
  duplicate: ['Duplicat', 'muted'],
};

export function StatusPill({ s }: { s: InvoiceStatus }) {
  const [label, kind] = STATUS[s];
  return <span className={`pill ${kind}`}>{label}</span>;
}

export function ChannelBadge({ c }: { c: DeliveryChannel | null }) {
  if (!c) return <span className="muted">—</span>;
  const map = { 'whatsapp-web': ['whatsapp', 'WhatsApp'], 'whatsapp-cloud': ['whatsapp', 'WA Business'], email: ['mail', 'Email'] } as const;
  const [icon, label] = map[c];
  return (
    <span className={`chan ${c === 'email' ? 'mail' : 'wa'}`}>
      <Icon name={icon} size={14} /> {label}
    </span>
  );
}

export function Dot({ ok, warn }: { ok: boolean; warn?: boolean }) {
  return <span className={`dot ${ok ? 'ok' : warn ? 'warn' : 'off'}`} />;
}

export function SourceLogo({ source }: { source: string }) {
  const m: Record<string, [string, string]> = {
    gmail: ['G', 'logo-gmail'],
    outlook: ['O', 'logo-outlook'],
    fgo: ['F', 'logo-fgo'],
    meta: ['M', 'logo-meta'],
    tiktok: ['T', 'logo-tiktok'],
    googleAds: ['A', 'logo-gads'],
  };
  const [ch, cls] = m[source] ?? ['?', ''];
  return <span className={`src-logo ${cls}`}>{ch}</span>;
}
