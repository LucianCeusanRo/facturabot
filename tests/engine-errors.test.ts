import { describe, expect, it, vi } from 'vitest';
import { Db } from '../src/main/db';
import { AuthExpiredError } from '../src/main/http';
import type { FoundDocument, InvoiceSource } from '../src/main/sources/types';
import { SyncEngine } from '../src/main/sync';
import type { DeepPartial, Settings } from '../src/shared/types';
import { fakeFetch, json, makeEnv } from './helpers';

const doc = (id: string, extra: Partial<FoundDocument> = {}): FoundDocument => ({
  externalId: id,
  vendor: 'Meta',
  fileName: `${id}.pdf`,
  data: Buffer.from(`%PDF ${id}`),
  ...extra,
});

const src = (docs: FoundDocument[] | (() => Promise<FoundDocument[]>), id = 'fake'): InvoiceSource => ({
  id,
  label: id,
  isEnabled: () => true,
  fetchNew: async (ctx) => (typeof docs === 'function' ? docs() : docs.filter((d) => !ctx.isKnown(d.externalId))),
});

async function engine(opts: { patch?: DeepPartial<Settings>; sources: InvoiceSource[]; wa?: any; fetch?: any }) {
  const env = makeEnv(opts.patch);
  const db = await Db.open(null);
  const notify = vi.fn();
  const waWeb = opts.wa ?? { sendDocument: vi.fn(async () => undefined) };
  const f = opts.fetch ?? fakeFetch((u) => (u.endsWith('/messages/send') ? json({ id: 'x' }) : undefined));
  const e = new SyncEngine({ db, settings: env.settings, secrets: env.secrets, waWeb, dataDir: env.dir, sources: opts.sources, fetch: f, notify, sleep: async () => undefined });
  return { e, db, notify, waWeb, f, env };
}

describe('SyncEngine – căi de eroare', () => {
  it('o sursă căzută (rețea) nu oprește celelalte surse', async () => {
    const bad = src(async () => {
      throw new Error('Rețea indisponibilă: ENOTFOUND');
    }, 'bad');
    const { e, db } = await engine({ sources: [bad, src([doc('ok')])] });
    await e.runOnce();
    expect(db.listInvoices('sent')).toHaveLength(1);
    expect(db.listLogs().some((l) => l.level === 'error' && /ENOTFOUND/.test(l.message))).toBe(true);
  });

  it('token expirat definitiv → notificare „Reconectează”', async () => {
    const bad = src(async () => {
      throw new AuthExpiredError('gmail', 'Accesul la Gmail a fost revocat');
    }, 'Gmail');
    const { e, notify } = await engine({ sources: [bad] });
    await e.runOnce();
    expect(notify).toHaveBeenCalledWith('Reconectează Gmail', expect.stringMatching(/revocat/));
  });

  it('cursorul sursei nu avansează când sursa eșuează (nu pierdem facturi)', async () => {
    const bad = src(async () => {
      throw new Error('500');
    }, 'bad');
    const { e, db } = await engine({ sources: [bad] });
    await e.runOnce();
    expect(db.getKv('cursor:bad')).toBeNull();
  });

  it('WhatsApp delogat → backup pe email', async () => {
    const wa = { sendDocument: vi.fn(async () => Promise.reject(new Error('Sesiunea WhatsApp a fost deconectată de pe telefon'))) };
    const { e, db, f } = await engine({ sources: [src([doc('a')])], wa });
    await e.runOnce();
    const inv = db.listInvoices('sent')[0];
    expect(inv.channel).toBe('email');
    expect(inv.error).toMatch(/deconectată/);
    expect(f.mock.calls.some((c: any[]) => String(c[0]).includes('/messages/send'))).toBe(true);
  });

  it('fără backup pe email: WhatsApp căzut → „eșuată”, apoi reîncercare până la limita de încercări', async () => {
    const wa = { sendDocument: vi.fn(async () => Promise.reject(new Error('timeout'))) };
    const { e, db, notify } = await engine({ sources: [src([doc('a')])], wa, patch: { delivery: { emailFallback: false, maxAttempts: 3 } } });
    for (let i = 0; i < 5; i++) await e.runOnce();
    const inv = db.listInvoices()[0];
    expect(inv.status).toBe('failed');
    expect(inv.attempts).toBe(3);
    expect(wa.sendDocument).toHaveBeenCalledTimes(3);
    expect(notify).toHaveBeenCalledWith('Factură netrimisă', expect.any(String));
  });

  it('„Reîncearcă” manual resetează încercările', async () => {
    let fail = true;
    const wa = { sendDocument: vi.fn(async () => (fail ? Promise.reject(new Error('x')) : undefined)) };
    const { e, db } = await engine({ sources: [src([doc('a')])], wa, patch: { delivery: { emailFallback: false, maxAttempts: 1 } } });
    await e.runOnce();
    const id = db.listInvoices()[0].id;
    expect(db.getInvoice(id)?.status).toBe('failed');
    fail = false;
    await e.approve(id);
    expect(db.getInvoice(id)?.status).toBe('sent');
  });

  it('WhatsApp și email ambele căzute → eșuată cu ambele motive', async () => {
    const wa = { sendDocument: vi.fn(async () => Promise.reject(new Error('WA jos'))) };
    const f = fakeFetch(() => json({ error: { message: 'backend' } }, 500));
    const { e, db } = await engine({ sources: [src([doc('a')])], wa, fetch: f });
    await e.runOnce();
    const inv = db.listInvoices()[0];
    expect(inv.status).toBe('failed');
    expect(inv.error).toMatch(/Gmail send 500/);
  });

  it('niciun canal configurat → eroare clară', async () => {
    const { e, db } = await engine({ sources: [src([doc('a')])], patch: { accountant: { whatsappNumber: '', email: '' } } });
    await e.runOnce();
    expect(db.listInvoices()[0].error).toMatch(/Nu există niciun canal/);
  });

  it('doar email: nu atinge WhatsApp', async () => {
    const { e, db, waWeb } = await engine({ sources: [src([doc('a')])], patch: { delivery: { whatsappMode: 'none' } } });
    await e.runOnce();
    expect(waWeb.sendDocument).not.toHaveBeenCalled();
    expect(db.listInvoices('sent')[0].channel).toBe('email');
  });

  it('fără trimiteri duble când „Sincronizează” și „Trimite” rulează simultan', async () => {
    const wa = {
      sendDocument: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 15));
      }),
    };
    const { e, db } = await engine({ sources: [src([doc('a'), doc('b')])], wa });
    await e.ingest('fake', doc('c'));
    const id = db.listInvoices('pending')[0].id;
    await Promise.all([e.runOnce(), e.approve(id), e.processQueue(), e.processQueue()]);
    expect(wa.sendDocument).toHaveBeenCalledTimes(3);
    expect(db.listInvoices('sent')).toHaveLength(3);
  });

  it('pauză între mesajele WhatsApp (anti-ban) configurabilă', async () => {
    const env = makeEnv({ delivery: { waDelaySeconds: 7 } });
    const db = await Db.open(null);
    const sleep = vi.fn(async () => undefined);
    const wa = { sendDocument: vi.fn(async () => undefined) };
    const e = new SyncEngine({ db, settings: env.settings, secrets: env.secrets, waWeb: wa as any, dataDir: env.dir, sources: [src([doc('a'), doc('b'), doc('c')])], sleep });
    await e.runOnce();
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(7000);
  });

  it('documentul ignorat între timp nu mai e trimis', async () => {
    const { e, db, waWeb } = await engine({ sources: [], patch: { confirmBeforeSend: true } });
    await e.ingest('fake', doc('a'));
    const id = db.listInvoices()[0].id;
    db.setStatus(id, 'skipped');
    await e.processQueue();
    expect(waWeb.sendDocument).not.toHaveBeenCalled();
  });

  it('fișier local șters → eșuată cu mesaj clar', async () => {
    const { e, db } = await engine({ sources: [] });
    db.insertInvoice({ source: 'x', externalId: 'gone', filePath: '/nu/exista.pdf', fileName: 'a.pdf', status: 'pending' });
    await e.processQueue();
    expect(db.listInvoices()[0].error).toBe('Fișierul local lipsește');
  });

  it('documente fără PDF (FGO furnizori) → rezumat text', async () => {
    const { e, db, waWeb } = await engine({ sources: [src([{ externalId: 'fgo1', vendor: 'Digi', summary: 'Factura DIGI 1 – 63,50 RON', seriesNumber: 'DIGI 1' }])] });
    await e.runOnce();
    expect(db.listInvoices('sent')).toHaveLength(1);
    const call = (waWeb.sendDocument as any).mock.calls[0];
    expect(call[2]).toMatch(/\.txt$/);
    expect(call[4]).toBe('text/plain');
  });

  it('snapshot raportează problemele de configurare', async () => {
    const { e } = await engine({ sources: [], patch: { accountant: { email: 'gresit' } } });
    expect(e.snapshot('disconnected').problems.join(' ')).toMatch(/Emailul contabilei/);
  });

  it('schedule/stop folosesc intervalul din setări', async () => {
    vi.useFakeTimers();
    try {
      const { e, env } = await engine({ sources: [], patch: { pollMinutes: 15 } });
      const spy = vi.spyOn(e, 'runOnce').mockResolvedValue();
      e.schedule();
      expect(e.nextSync!.getTime() - Date.now()).toBe(15 * 60_000);
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(spy).toHaveBeenCalledTimes(1);
      e.stop();
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(env.settings.get().pollMinutes).toBe(15);
    } finally {
      vi.useRealTimers();
    }
  });
});
