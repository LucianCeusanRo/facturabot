// Tipuri partajate între procesul principal (main) și interfață (renderer).

export type WhatsAppMode = 'web' | 'cloud' | 'none';
export type EmailProvider = 'gmail' | 'outlook' | 'smtp';
export type InvoiceStatus = 'pending' | 'awaiting_confirm' | 'sending' | 'sent' | 'failed' | 'skipped' | 'duplicate';
export type DeliveryChannel = 'whatsapp-web' | 'whatsapp-cloud' | 'email';
export type Theme = 'system' | 'dark' | 'light';

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
  };
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
  | 'google.clientSecret';

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
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };
