import type { Settings } from '../../shared/types.js';
import type { SecretStore } from '../secrets.js';

/** Un document găsit de o sursă (email, FGO, ANAF...), gata de trimis la contabilă. */
export interface FoundDocument {
  /** ID stabil, unic în cadrul sursei (folosit pentru deduplicare). */
  externalId: string;
  vendor?: string | null;
  subject?: string | null;
  fileName?: string | null;
  /** Conținutul fișierului (PDF). Poate lipsi când sursa oferă doar date (ex. FGO furnizori). */
  data?: Buffer | null;
  mimeType?: string;
  /** Text trimis când nu există fișier sau ca mesaj însoțitor. */
  summary?: string | null;
  seriesNumber?: string | null;
  amount?: number | null;
  currency?: string | null;
  invoiceDate?: string | null;
  /** v0.2 – date folosite la analiză și TVA. */
  direction?: 'in' | 'out';
  platform?: string | null;
  supplierCountry?: string | null;
  supplierVatId?: string | null;
  dueDate?: string | null;
  paid?: boolean | null;
  /** Text (PDF/email) folosit DOAR pentru detectarea TVA – nu se salvează. */
  text?: string | null;
}

export interface TestDeps {
  settings: Settings;
  secrets: SecretStore;
  fetch: typeof fetch;
  retry?: import('../http.js').RetryOptions;
}

export interface TestResult {
  ok: boolean;
  info?: string;
  error?: string;
}

export interface SourceContext {
  settings: Settings;
  secrets: SecretStore;
  since: Date;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** true dacă (source, externalId) e deja în baza de date – evită descărcări inutile. */
  isKnown: (externalId: string) => boolean;
  /** Transformă HTML (chitanțe în corpul emailului) în PDF. Injectat de Electron. */
  htmlToPdf?: (html: string) => Promise<Buffer>;
  fetch: typeof fetch;
  /** Opțiuni de reîncercare HTTP (testele le scurtează). */
  retry?: import('../http.js').RetryOptions;
}

/**
 * Interfața de plugin. Pentru a adăuga o sursă nouă (ANAF e-Factura, Meta Ads Billing API,
 * TikTok Ads, Google Ads InvoiceService, Shopify Billing...) implementează această interfață
 * și înregistreaz-o în sources/registry.ts.
 */
export interface InvoiceSource {
  id: string;
  label: string;
  isEnabled(settings: Settings, secrets: SecretStore): boolean;
  fetchNew(ctx: SourceContext): Promise<FoundDocument[]>;
  /** „Testează conexiunea” – un apel ieftin, fără efecte. */
  test?(deps: TestDeps): Promise<TestResult>;
}
