// Tipuri partajate între procesul principal (main) și interfață (renderer).

export type WhatsAppMode = 'web' | 'cloud' | 'none';
export type EmailProvider = 'gmail' | 'outlook' | 'smtp';
export type InvoiceStatus = 'pending' | 'awaiting_confirm' | 'sending' | 'sent' | 'failed' | 'skipped' | 'duplicate';
export type DeliveryChannel = 'whatsapp-web' | 'whatsapp-cloud' | 'email';
export type Theme = 'system' | 'dark' | 'light';
/** Regimul de TVA al firmei utilizatorului (informativ – decide ce declarații îți reamintim). */
export type VatRegime = 'none' | 'art317' | 'art316';
/** Tratament TVA detectat pe reguli pentru o factură primită. */
export type VatTreatment = 'domestic' | 'intra-eu' | 'extra-eu' | 'unknown';
export type FxRule = 'previous' | 'same-day';

export interface Settings {
  onboardingDone: boolean;
  theme: Theme;
  pollMinutes: number; // 15–30 recomandat
  confirmBeforeSend: boolean;
  autostart: boolean;
  lookbackDays: number; // la prima sincronizare
  /** Reguli de detectare a facturilor (editabile din Setări → Avansat). */
  detection: {
    extraKeywords: string[]; // cuvinte cheie suplimentare (subiect/fișier/corp)
    extraSenders: string[]; // adrese sau domenii considerate mereu furnizori (ex. „furnizor.ro”)
    excludeSenders: string[]; // adrese/domenii ignorate complet
    minScore: number; // prag de încredere (implicit 3)
    maxAttachmentMB: number; // atașamente mai mari sunt ignorate
  };
  sources: {
    gmail: { enabled: boolean; account?: string; extraQuery?: string };
    outlook: { enabled: boolean; account?: string };
    fgo: { enabled: boolean; codUnic?: string; includeIssued: boolean; includeSuppliers: boolean; apiBase: string };
    /** Meta Marketing API – GET /{business-id}/business_invoices (facturare lunară). */
    meta: { enabled: boolean; businessId: string; apiVersion: string };
    /** TikTok API for Business – /bc/invoice/get/ + /bc/invoice/download/. */
    tiktok: { enabled: boolean; bcId: string; invoiceTypes: string[]; apiBase: string };
    /** Google Ads API – InvoiceService.ListInvoices + pdf_url (facturare lunară). */
    googleAds: { enabled: boolean; customerId: string; billingSetupId: string; loginCustomerId: string; apiVersion: string; account?: string };
  };
  /** Datele firmei – folosite la detectarea TVA (furnizor intracomunitar, CUI propriu). */
  company: { name: string; vatRegime: VatRegime; country: string };
  /** Parametri fiscali – configurabili, cu sursa oficială. Informativ, nu consultanță fiscală. */
  tax: {
    vatThresholdRon: number; // art. 310 alin. (1) Cod fiscal – 395.000 lei din 1 sept. 2025 (OG 22/2025)
    vatThresholdSource: string;
    warnPercent: number; // alertă la X% din plafon (implicit 80)
    vatRatePercent: number; // cota standard (21% din 1 aug. 2025)
    ossThresholdEur: number; // 10.000 EUR – art. 59c Directiva 2006/112/CE
    ossThresholdSource: string;
    extraRevenueRon: number; // venituri în afara FGO (adăugate manual la calculul plafonului)
    fxRule: FxRule; // 'previous' = ultimul curs BNR publicat ÎNAINTE de data facturii (art. 290 Cod fiscal)
    bnrBaseUrl: string;
    viesBaseUrl: string;
  };
  /** Acces de pe telefon – server local, opțional, cu împerechere prin cod QR / PIN. */
  remote: { enabled: boolean; port: number; publicUrl: string };
  /** Raport lunar + „pachet pentru contabil”. */
  reports: { monthlyEnabled: boolean; dayOfMonth: number; dueReminderDays: number; missingGraceDays: number };
  accountant: {
    name: string;
    whatsappNumber: string; // format internațional, ex. 40722123456
    email: string;
  };
  delivery: {
    whatsappMode: WhatsAppMode;
    emailFallback: boolean; // dacă WhatsApp eșuează → email
    emailProvider: EmailProvider;
    maxAttempts: number; // de câte ori reîncearcă o factură eșuată
    retryWindowDays: number; // după câte zile renunță la reîncercări
    waDelaySeconds: number; // pauză între mesaje WhatsApp (reduce riscul de blocare)
    cloud: { phoneNumberId: string; templateName: string; templateLang: string; bodyParam: boolean; apiVersion: string };
    smtp: { host: string; port: number; secure: boolean; user: string; from: string };
  };
  oauthClients: {
    googleClientId: string;
    microsoftClientId: string;
  };
}

export interface InvoiceRecord {
  id: number;
  source: string;
  externalId: string;
  fileHash: string | null;
  seriesNumber: string | null;
  vendor: string | null;
  subject: string | null;
  fileName: string | null;
  filePath: string | null;
  amount: number | null;
  currency: string | null;
  invoiceDate: string | null;
  /** 'in' = factură primită (cheltuială), 'out' = factură emisă (venit). */
  direction: 'in' | 'out';
  platform: string | null;
  supplierCountry: string | null;
  supplierVatId: string | null;
  vatTreatment: VatTreatment;
  dueDate: string | null;
  paid: boolean | null;
  amountRon: number | null;
  fxRate: number | null;
  status: InvoiceStatus;
  channel: DeliveryChannel | null;
  error: string | null;
  attempts: number;
  createdAt: string;
  sentAt: string | null;
}

export interface LogEntry {
  id: number;
  ts: string;
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
}

export interface WhatsAppWebState {
  status: 'disconnected' | 'connecting' | 'qr' | 'connected' | 'logged_out' | 'error';
  qrDataUrl?: string;
  me?: string;
  error?: string;
}

export interface StatusSnapshot {
  syncing: boolean;
  lastSync: string | null;
  nextSync: string | null;
  connections: {
    gmail: boolean;
    outlook: boolean;
    fgo: boolean;
    meta: boolean;
    tiktok: boolean;
    googleAds: boolean;
    whatsappWeb: WhatsAppWebState['status'];
    whatsappCloud: boolean;
    smtp: boolean;
  };
  stats: { total: number; sent: number; failed: number; pending: number; thisMonth: number };
  /** Probleme de configurare (ex. email contabilă invalid). */
  problems: string[];
}

export type SecretKey =
  | 'google.tokens'
  | 'microsoft.tokens'
  | 'fgo.apiKey'
  | 'whatsapp.cloudToken'
  | 'smtp.password'
  | 'google.clientSecret'
  | 'meta.token'
  | 'tiktok.token'
  | 'googleAds.tokens'
  | 'googleAds.developerToken';

export type DirectSourceId = 'meta' | 'tiktok' | 'googleAds';

// ---------- Analiză cheltuieli ----------
export interface SpendBucket {
  key: string;
  label: string;
  totalRon: number;
  count: number;
}
export interface MonthBucket {
  month: string; // YYYY-MM
  totalRon: number;
  count: number;
  byPlatform: Record<string, number>;
}
export interface SpendingReport {
  from: string;
  to: string;
  totalRon: number;
  count: number;
  /** Facturi fără sumă sau fără curs BNR – nu intră în totaluri. */
  unconverted: number;
  byPlatform: SpendBucket[];
  bySupplier: SpendBucket[];
  byMonth: MonthBucket[];
  byCurrency: { currency: string; total: number; count: number }[];
}

// ---------- TVA ----------
export interface ThresholdProgress {
  valueRon: number;
  thresholdRon: number;
  percent: number;
  level: 'ok' | 'warn' | 'over';
  remainingRon: number;
}
export interface VatObligation {
  code: 'D390' | 'D301' | 'D300' | 'D700';
  title: string;
  detail: string;
  deadline: string | null; // YYYY-MM-DD
}
export interface ReverseChargeItem {
  id: number;
  vendor: string | null;
  invoiceDate: string | null;
  amountRon: number | null;
  amount: number | null;
  currency: string | null;
  supplierCountry: string | null;
  supplierVatId: string | null;
  treatment: VatTreatment;
  vies: { valid: boolean; name?: string; checkedAt: string } | null;
}
export interface TaxOverview {
  year: number;
  disclaimer: string;
  warnPercent: number;
  vatRatePercent: number;
  /** Observații despre datele folosite (ex. lipsă drept clienti:citire în FGO). */
  notes: string[];
  revenueByMonth: Record<string, number>;
  vatThreshold: ThresholdProgress & { source: string; revenueSource: 'fgo' | 'local' | 'none'; updatedAt: string | null };
  oss: { valueEur: number; previousYearEur: number; thresholdEur: number; percent: number; level: 'ok' | 'warn' | 'over'; source: string };
  reverseCharge: { month: string; items: ReverseChargeItem[]; totalRon: number; vatDueRon: number; obligations: VatObligation[] };
}

// ---------- Observații (fără AI, pe reguli) ----------
export interface Insight {
  id: string;
  kind: 'missing' | 'due' | 'overdue' | 'threshold';
  level: 'info' | 'warn' | 'err';
  title: string;
  detail: string;
  invoiceId?: number;
}

// ---------- Acces telefon ----------
export interface RemoteDevice {
  id: string;
  name: string;
  createdAt: string;
  lastSeen: string | null;
}
export interface RemoteState {
  running: boolean;
  port: number;
  urls: string[];
  pairing: { code: string; expiresAt: string; url: string; qrDataUrl: string } | null;
  devices: RemoteDevice[];
  error?: string;
}

export interface FacturaBotApi {
  getSettings(): Promise<Settings>;
  saveSettings(patch: DeepPartial<Settings>): Promise<Settings>;
  setSecret(key: SecretKey, value: string): Promise<void>;
  hasSecret(key: SecretKey): Promise<boolean>;
  clearSecret(key: SecretKey): Promise<void>;
  connectGoogle(): Promise<{ ok: boolean; account?: string; error?: string }>;
  connectMicrosoft(): Promise<{ ok: boolean; account?: string; error?: string }>;
  disconnectAccount(which: 'gmail' | 'outlook'): Promise<Settings>;
  testFgo(): Promise<{ ok: boolean; info?: string; error?: string }>;
  testSource(id: DirectSourceId): Promise<{ ok: boolean; info?: string; error?: string }>;
  connectGoogleAds(): Promise<{ ok: boolean; account?: string; error?: string }>;
  spending(opts?: { from?: string; to?: string }): Promise<SpendingReport>;
  tax(opts?: { year?: number; month?: string }): Promise<TaxOverview>;
  insights(): Promise<Insight[]>;
  checkVies(vatId: string): Promise<{ ok: boolean; valid?: boolean; name?: string; error?: string }>;
  exportData(opts: { format: 'csv' | 'xlsx'; from: string; to: string }): Promise<{ ok: boolean; path?: string; error?: string }>;
  buildPackage(month: string, send?: boolean): Promise<{ ok: boolean; path?: string; sentVia?: string; error?: string }>;
  remoteState(): Promise<RemoteState>;
  remoteSetEnabled(on: boolean): Promise<RemoteState>;
  remoteNewPairing(): Promise<RemoteState>;
  remoteRevoke(id: string): Promise<RemoteState>;
  waStart(): Promise<void>;
  waLogout(): Promise<void>;
  waState(): Promise<WhatsAppWebState>;
  testDelivery(): Promise<{ ok: boolean; channel?: string; error?: string }>;
  syncNow(): Promise<void>;
  status(): Promise<StatusSnapshot>;
  listInvoices(opts?: { status?: InvoiceStatus | 'all'; limit?: number }): Promise<InvoiceRecord[]>;
  approveInvoice(id: number): Promise<void>;
  skipInvoice(id: number): Promise<void>;
  retryInvoice(id: number): Promise<void>;
  openInvoiceFile(id: number): Promise<void>;
  listLogs(limit?: number): Promise<LogEntry[]>;
  openExternal(url: string): Promise<void>;
  on(channel: 'wa-state', cb: (s: WhatsAppWebState) => void): () => void;
  on(channel: 'status', cb: (s: StatusSnapshot) => void): () => void;
  on(channel: 'navigate', cb: (page: string) => void): () => void;
  on(channel: 'remote-state', cb: (s: RemoteState) => void): () => void;
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };
