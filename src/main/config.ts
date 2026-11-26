import fs from 'node:fs';
import path from 'node:path';
import type { DeepPartial, Settings } from '../shared/types.js';

declare const __FB_GOOGLE_CLIENT_ID__: string | undefined;
declare const __FB_MS_CLIENT_ID__: string | undefined;
const BUILD_GOOGLE_ID = typeof __FB_GOOGLE_CLIENT_ID__ === 'string' ? __FB_GOOGLE_CLIENT_ID__ : '';
const BUILD_MS_ID = typeof __FB_MS_CLIENT_ID__ === 'string' ? __FB_MS_CLIENT_ID__ : '';

const env = (k: string) => (typeof process !== 'undefined' ? process.env[k] : undefined);
const envNum = (k: string, d: number) => {
  const v = Number(env(k));
  return Number.isFinite(v) && env(k) !== undefined && env(k) !== '' ? v : d;
};

/** Limite de validare – folosite și de interfață. */
export const LIMITS = {
  pollMinutes: [5, 240],
  lookbackDays: [1, 365],
  minScore: [1, 8],
  maxAttachmentMB: [1, 100],
  maxAttempts: [1, 20],
  retryWindowDays: [1, 60],
  waDelaySeconds: [0, 120],
} as const;

export const DEFAULT_SETTINGS: Settings = {
  onboardingDone: false,
  theme: 'system',
  pollMinutes: envNum('FACTURABOT_POLL_MINUTES', 20),
  confirmBeforeSend: false,
  autostart: true,
  lookbackDays: envNum('FACTURABOT_LOOKBACK_DAYS', 30),
  detection: { extraKeywords: [], extraSenders: [], excludeSenders: [], minScore: 3, maxAttachmentMB: 25 },
  sources: {
    gmail: { enabled: false, extraQuery: '' },
    outlook: { enabled: false },
    fgo: { enabled: false, codUnic: '', includeIssued: false, includeSuppliers: true, apiBase: env('FACTURABOT_FGO_API_BASE') || 'https://api.fgo.ro' },
  },
  accountant: { name: '', whatsappNumber: '', email: '' },
  delivery: {
    whatsappMode: 'web',
    emailFallback: true,
    emailProvider: 'gmail',
    maxAttempts: 5,
    retryWindowDays: 7,
    waDelaySeconds: 4,
    cloud: { phoneNumberId: '', templateName: 'factura_noua', templateLang: 'ro', bodyParam: true, apiVersion: env('FACTURABOT_WA_API_VERSION') || 'v21.0' },
    smtp: { host: '', port: 465, secure: true, user: '', from: '' },
  },
  oauthClients: {
    // Pot fi pre-completate la build prin variabile de mediu, ca utilizatorul final să nu facă nimic.
    googleClientId: env('FACTURABOT_GOOGLE_CLIENT_ID') || BUILD_GOOGLE_ID,
    microsoftClientId: env('FACTURABOT_MS_CLIENT_ID') || BUILD_MS_ID,
  },
};

export function deepMerge<T>(base: T, patch: DeepPartial<T> | undefined): T {
  if (!patch) return base;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
  for (const [k, v] of Object.entries(patch as any)) {
    if (v === undefined) continue;
    const cur = (base as any)?.[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object') {
      out[k] = deepMerge(cur, v as any);
    } else {
      out[k] = v;
    }
  }
  return out;
}

const clamp = (v: unknown, [lo, hi]: readonly [number, number], d: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
const list = (v: unknown): string[] =>
  (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,;\n]/) : [])
    .map((x) => String(x).trim().toLowerCase())
    .filter(Boolean)
    .filter((x, i, a) => a.indexOf(x) === i)
    .slice(0, 200);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const isValidEmail = (e: string) => EMAIL_RE.test(e.trim());
/** Număr WhatsApp: acceptăm 07xx…, +40…, 0040…; verificăm doar că rămân 8–15 cifre. */
export const isValidPhone = (p: string) => {
  const d = p.replace(/[^\d]/g, '');
  return d.length >= 8 && d.length <= 15;
};

/** Aduce setările într-o stare validă (valori numerice în limite, liste curate, enum-uri cunoscute). */
export function sanitizeSettings(s: Settings): Settings {
  const d = DEFAULT_SETTINGS;
  const out = structuredClone(s);
  if (!['system', 'dark', 'light'].includes(out.theme)) out.theme = d.theme;
  out.pollMinutes = clamp(out.pollMinutes, LIMITS.pollMinutes, d.pollMinutes);
  out.lookbackDays = clamp(out.lookbackDays, LIMITS.lookbackDays, d.lookbackDays);
  out.detection.extraKeywords = list(out.detection.extraKeywords);
  out.detection.extraSenders = list(out.detection.extraSenders);
  out.detection.excludeSenders = list(out.detection.excludeSenders);
  out.detection.minScore = clamp(out.detection.minScore, LIMITS.minScore, d.detection.minScore);
  out.detection.maxAttachmentMB = clamp(out.detection.maxAttachmentMB, LIMITS.maxAttachmentMB, d.detection.maxAttachmentMB);
  if (!['web', 'cloud', 'none'].includes(out.delivery.whatsappMode)) out.delivery.whatsappMode = d.delivery.whatsappMode;
  if (!['gmail', 'outlook', 'smtp'].includes(out.delivery.emailProvider)) out.delivery.emailProvider = d.delivery.emailProvider;
  out.delivery.maxAttempts = clamp(out.delivery.maxAttempts, LIMITS.maxAttempts, d.delivery.maxAttempts);
  out.delivery.retryWindowDays = clamp(out.delivery.retryWindowDays, LIMITS.retryWindowDays, d.delivery.retryWindowDays);
  out.delivery.waDelaySeconds = clamp(out.delivery.waDelaySeconds, LIMITS.waDelaySeconds, d.delivery.waDelaySeconds);
  out.delivery.smtp.port = clamp(out.delivery.smtp.port, [1, 65535], d.delivery.smtp.port);
  out.accountant.email = (out.accountant.email ?? '').trim();
  out.accountant.whatsappNumber = (out.accountant.whatsappNumber ?? '').trim();
  out.sources.fgo.codUnic = (out.sources.fgo.codUnic ?? '').replace(/^RO/i, '').replace(/\s/g, '');
  if (!/^https:\/\//.test(out.sources.fgo.apiBase || '')) out.sources.fgo.apiBase = d.sources.fgo.apiBase;
  // Valorile din mediu au prioritate doar când utilizatorul nu a completat nimic.
  out.oauthClients.googleClientId = (out.oauthClients.googleClientId || d.oauthClients.googleClientId).trim();
  out.oauthClients.microsoftClientId = (out.oauthClients.microsoftClientId || d.oauthClients.microsoftClientId).trim();
  return out;
}

/** Probleme de configurare afișate în interfață (nu blochează salvarea). */
export function settingsProblems(s: Settings): string[] {
  const p: string[] = [];
  const a = s.accountant;
  if (!a.email && !a.whatsappNumber) p.push('Adaugă WhatsApp-ul sau emailul contabilei.');
  if (a.email && !isValidEmail(a.email)) p.push('Emailul contabilei nu pare valid.');
  if (a.whatsappNumber && !isValidPhone(a.whatsappNumber)) p.push('Numărul de WhatsApp al contabilei nu pare valid.');
  if (s.delivery.whatsappMode !== 'none' && !a.whatsappNumber) p.push('Ai ales WhatsApp, dar lipsește numărul contabilei.');
  if (s.delivery.whatsappMode === 'cloud' && !s.delivery.cloud.phoneNumberId) p.push('WhatsApp Business API: lipsește Phone number ID.');
  if (s.delivery.emailProvider === 'smtp' && !s.delivery.smtp.host) p.push('Email prin SMTP: lipsește serverul.');
  return p;
}

export class SettingsStore {
  private file: string;
  private cache: Settings;

  constructor(dir: string) {
    this.file = path.join(dir, 'settings.json');
    this.cache = this.load();
  }

  private load(): Settings {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return sanitizeSettings(deepMerge(DEFAULT_SETTINGS, raw));
    } catch {
      return structuredClone(DEFAULT_SETTINGS);
    }
  }

  get(): Settings {
    return this.cache;
  }

  update(patch: DeepPartial<Settings>): Settings {
    this.cache = sanitizeSettings(deepMerge(this.cache, patch));
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // Scriere atomică: un crash în timpul salvării nu corupe setările.
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.cache, null, 2));
    fs.renameSync(tmp, this.file);
    return this.cache;
  }
}
