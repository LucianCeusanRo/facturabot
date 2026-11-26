import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, Notification, safeStorage, shell, Tray } from 'electron';
import QRCode from 'qrcode';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DeepPartial, DirectSourceId, InvoiceStatus, SecretKey, Settings } from '../shared/types.js';
import { SettingsStore } from './config.js';
import { Db } from './db.js';
import { WhatsAppWeb } from './delivery/whatsappWeb.js';
import { WhatsAppCloud } from './delivery/whatsappCloud.js';
import { deliver } from './delivery/dispatcher.js';
import { connectGoogle, connectGoogleAds } from './oauth/google.js';
import { connectMicrosoft } from './oauth/microsoft.js';
import { SecretStore } from './secrets.js';
import { FgoClient, fgoNeededRights, isValidFgoApiKey, normalizeFgoApiKey } from './sources/fgo.js';
import { SyncEngine } from './sync.js';
import { seedDemo } from './demo.js';
import { Finance } from './finance.js';
import { exportTable, isMonth } from './export/package.js';
import { RemoteServer } from './remote/server.js';
import { sourceById } from './sources/registry.js';
import { parseVatId } from './tax/vat.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEMO = process.env.FACTURABOT_DEMO === '1';
const SCREENSHOT_DIR = process.env.FACTURABOT_SCREENSHOT_DIR;

// Capturi „retina” (ex. telefon la DPR 3): FACTURABOT_SCREENSHOT_DPR=3.
if (process.env.FACTURABOT_SCREENSHOT_DPR) app.commandLine.appendSwitch('force-device-scale-factor', process.env.FACTURABOT_SCREENSHOT_DPR);
if (DEMO) app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'facturabot-demo-')));
else if (process.env.FACTURABOT_DATA_DIR) app.setPath('userData', path.resolve(process.env.FACTURABOT_DATA_DIR));
app.setAppUserModelId('ro.facturabot.app');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

const assetPath = (...p: string[]) => (app.isPackaged ? path.join(process.resourcesPath, 'assets', ...p) : path.join(__dirname, '../../build', ...p));

async function htmlToPdf(html: string): Promise<Buffer> {
  const w = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true } });
  try {
    await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><meta charset="utf-8">${html}`));
    return await w.webContents.printToPDF({ pageSize: 'A4', printBackground: true });
  } finally {
    w.destroy();
  }
}

function notify(title: string, body: string) {
  if (Notification.isSupported()) new Notification({ title, body, icon: assetPath('icon.png') }).show();
}

async function main() {
  await app.whenReady();
  const dataDir = app.getPath('userData');
  const settings = new SettingsStore(dataDir);
  const secrets = new SecretStore(dataDir, safeStorage);
  const db = await Db.open(path.join(dataDir, 'facturabot.sqlite'));
  const waWeb = new WhatsAppWeb(path.join(dataDir, 'wa-session'));
  if (DEMO) seedDemo(db, settings, secrets, waWeb);

  const broadcast = () => win?.webContents.send('status', engine.snapshot(waWeb.getState().status));
  const finance = new Finance({ db, settings, secrets, notify });
  // În modul demo nu atingem conturi reale: nicio sursă activă.
  const engine = new SyncEngine({ db, settings, secrets, waWeb, dataDir, htmlToPdf, notify, onChange: broadcast, sources: DEMO ? [] : undefined, finance });

  // ---------- Panou pe telefon (opțional) ----------
  const monthRange = () => {
    const now = new Date();
    return { from: `${now.getFullYear()}-01-01`, to: now.toISOString().slice(0, 10) };
  };
  const remote = new RemoteServer({
    kv: db,
    staticDir: path.join(__dirname, '../renderer'),
    log: (l, m) => db.log(l, m),
    qr: (t) => QRCode.toDataURL(t, { margin: 1, width: 360, errorCorrectionLevel: 'M' }),
    publicUrl: () => settings.get().remote.publicUrl,
    api: {
      status: () => engine.snapshot(waWeb.getState().status),
      listInvoices: (st, limit) => db.listInvoices(st, limit),
      getInvoice: (id) => db.getInvoice(id),
      approve: (id) => engine.approve(id),
      skip: (id) => {
        db.setStatus(id, 'skipped');
        broadcast();
      },
      sync: async () => {
        await engine.runOnce();
      },
      spending: (from, to) => finance.spending(from, to),
      tax: (o) => finance.tax(o),
      insights: () => finance.insights(),
      exportTable: (format, from, to) => exportTable({ db, finance, from, to, format }),
      packageZip: async (month) => (await engine.sendMonthlyPackage(month, false)).zipPath,
      info: () => {
        const s = settings.get();
        return { company: s.company.name, accountant: s.accountant.name, whatsappMode: s.delivery.whatsappMode, pollMinutes: s.pollMinutes, version: app.getVersion(), range: monthRange() };
      },
    },
  });
  const pushRemote = async () => win?.webContents.send('remote-state', await remote.state());
  const applyRemote = async () => {
    const r = settings.get().remote;
    try {
      if (r.enabled && (!remote.running || remote.port !== r.port)) {
        await remote.stop();
        await remote.start(r.port);
        db.log('info', `Panoul pentru telefon pornit pe portul ${remote.port}`);
      } else if (!r.enabled && remote.running) {
        await remote.stop();
        db.log('info', 'Panoul pentru telefon a fost oprit');
      }
    } catch (e) {
      db.log('error', `Panou telefon: ${(e as Error).message}`);
    }
    await pushRemote();
  };

  if (DEMO) engine.nextSync = new Date(Date.now() + 14 * 60_000);
  waWeb.on('state', (s) => {
    win?.webContents.send('wa-state', s);
    broadcast();
    if (s.status === 'logged_out') notify('WhatsApp deconectat', 'Facturile vor merge pe email (backup) până scanezi din nou codul QR.');
  });

  nativeTheme.themeSource = settings.get().theme;
  applyAutostart(settings.get());

  // ---------- IPC ----------
  const handle = (ch: string, fn: (...a: any[]) => any) => ipcMain.handle(ch, (_e, ...a) => fn(...a));
  handle('settings:get', () => settings.get());
  handle('settings:save', (patch: DeepPartial<Settings>) => {
    const prevPoll = settings.get().pollMinutes;
    const wasDone = settings.get().onboardingDone;
    const s = settings.update(patch);
    nativeTheme.themeSource = s.theme;
    applyAutostart(s);
    // Programăm verificarea periodică imediat după terminarea asistentului sau la schimbarea intervalului.
    if (s.onboardingDone && (!wasDone || s.pollMinutes !== prevPoll) && !DEMO) engine.schedule();
    if (patch.remote) applyRemote();
    broadcast();
    return s;
  });
  handle('secret:set', (k: SecretKey, v: string) => {
    secrets.set(k, v);
    broadcast();
  });
  handle('secret:has', (k: SecretKey) => secrets.has(k));
  handle('secret:clear', (k: SecretKey) => {
    secrets.clear(k);
    broadcast();
  });
  handle('google:connect', async () => {
    try {
      const t = await connectGoogle(settings.get().oauthClients.googleClientId, secrets, (u) => shell.openExternal(u));
      settings.update({ sources: { gmail: { enabled: true, account: t.account } } });
      win?.show();
      win?.focus();
      broadcast();
      return { ok: true, account: t.account };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
  handle('microsoft:connect', async () => {
    try {
      const t = await connectMicrosoft(settings.get().oauthClients.microsoftClientId, secrets, (u) => shell.openExternal(u));
      settings.update({ sources: { outlook: { enabled: true, account: t.account } } });
      win?.show();
      broadcast();
      return { ok: true, account: t.account };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
  handle('account:disconnect', (which: 'gmail' | 'outlook') => {
    if (which === 'gmail') {
      secrets.clear('google.tokens');
      settings.update({ sources: { gmail: { enabled: false, account: '' } } });
    } else {
      secrets.clear('microsoft.tokens');
      settings.update({ sources: { outlook: { enabled: false, account: '' } } });
    }
    db.log('info', `Cont ${which === 'gmail' ? 'Gmail' : 'Outlook'} deconectat`);
    broadcast();
    return settings.get();
  });
  handle('fgo:test', async () => {
    const s = settings.get().sources.fgo;
    const key = secrets.get('fgo.apiKey');
    if (!s.codUnic) return { ok: false, error: 'Completează CUI-ul firmei (doar cifrele, fără RO).' };
    if (!key) return { ok: false, error: 'Lipsește cheia API FGO v2 (începe cu fgo_api_v2).' };
    if (!isValidFgoApiKey(key)) return { ok: false, error: 'Cheia trebuie să înceapă cu fgo_api_v2. Genereaz-o în FGO → eCommerce → API (nu mai folosi cheile v1).' };
    const r = await new FgoClient(normalizeFgoApiKey(key), s.codUnic, s.apiBase).probe(fgoNeededRights(s));
    return r;
  });
  handle('source:test', async (id: DirectSourceId) => {
    const src = sourceById(id);
    if (!src?.test || !['meta', 'tiktok', 'googleAds'].includes(id)) return { ok: false, error: 'Sursă necunoscută' };
    const r = await src.test({ settings: settings.get(), secrets, fetch });
    if (r.ok) settings.update({ sources: { [id]: { enabled: true } } } as DeepPartial<Settings>);
    broadcast();
    return r;
  });
  handle('googleAds:connect', async () => {
    try {
      const t = await connectGoogleAds(settings.get().oauthClients.googleClientId, secrets, (u) => shell.openExternal(u));
      settings.update({ sources: { googleAds: { account: t.account } } });
      win?.show();
      broadcast();
      return { ok: true, account: t.account };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
  handle('finance:spending', (o?: { from?: string; to?: string }) => {
    const r = monthRange();
    const day = /^\d{4}-\d{2}-\d{2}$/;
    return finance.spending(o?.from && day.test(o.from) ? o.from : r.from, o?.to && day.test(o.to) ? o.to : r.to);
  });
  handle('finance:tax', (o?: { year?: number; month?: string }) => finance.tax({ year: o?.year, month: o?.month && isMonth(o.month) ? o.month : undefined, checkVies: !DEMO }));
  handle('finance:insights', () => finance.insights());
  handle('vies:check', async (vatId: string) => {
    if (!parseVatId(vatId)) return { ok: false, error: 'Format invalid (ex. IE9692928F)' };
    return finance.vies(vatId, true);
  });
  handle('export:data', async (o: { format: 'csv' | 'xlsx'; from: string; to: string }) => {
    try {
      if (!['csv', 'xlsx'].includes(o?.format) || !/^\d{4}-\d{2}-\d{2}$/.test(o.from) || !/^\d{4}-\d{2}-\d{2}$/.test(o.to)) throw new Error('Parametri invalizi');
      await finance.convertPending().catch(() => undefined);
      const out = exportTable({ db, finance, ...o });
      const target = SCREENSHOT_DIR
        ? path.join(dataDir, out.fileName)
        : (await dialog.showSaveDialog(win!, { defaultPath: path.join(app.getPath('documents'), out.fileName), filters: [{ name: o.format.toUpperCase(), extensions: [o.format] }] })).filePath;
      if (!target) return { ok: false, error: 'Anulat' };
      fs.writeFileSync(target, out.data);
      shell.showItemInFolder(target);
      return { ok: true, path: target };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
  handle('package:build', async (month: string, send?: boolean) => {
    try {
      const r = await engine.sendMonthlyPackage(month, !!send);
      if (!send) shell.showItemInFolder(r.zipPath);
      broadcast();
      return { ok: true, path: r.zipPath, sentVia: r.sentVia };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
  handle('remote:state', () => remote.state());
  handle('remote:enable', async (on: boolean) => {
    settings.update({ remote: { enabled: !!on } });
    await applyRemote();
    if (on && remote.running && !remote.devices().length) remote.newPairing();
    return remote.state();
  });
  handle('remote:pair', async () => {
    if (!remote.running) await applyRemote();
    remote.newPairing();
    return remote.state();
  });
  handle('remote:revoke', async (id: string) => {
    remote.revoke(String(id));
    return remote.state();
  });
  handle('wa:start', () => (DEMO ? waWeb.simulateQr() : waWeb.start()));
  handle('wa:logout', () => waWeb.logout());
  handle('wa:state', () => waWeb.getState());
  handle('delivery:test', async () => {
    try {
      const pdf = await htmlToPdf(
        `<div style="font:16px Segoe UI,sans-serif;padding:40px"><h1>Test FacturaBot</h1><p>Dacă primiți acest document, conexiunea funcționează.</p><p>${new Date().toLocaleString('ro-RO')}</p></div>`,
      );
      const s = settings.get();
      if (s.delivery.whatsappMode === 'cloud') {
        const token = secrets.get('whatsapp.cloudToken');
        if (token) await new WhatsAppCloud({ token, ...s.delivery.cloud }).verify();
      }
      const r = await deliver(
        { data: pdf, fileName: 'Test_FacturaBot.pdf', description: 'Mesaj de test FacturaBot' },
        { settings: s, secrets, waWeb, log: (l, m) => db.log(l, m) },
      );
      db.log('success', `Test trimis cu succes pe ${r.channel}`);
      return { ok: true, channel: r.channel };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
  handle('sync:now', async () => {
    await engine.runOnce();
    if (!DEMO && settings.get().onboardingDone) engine.schedule();
  });
  handle('status', () => engine.snapshot(waWeb.getState().status));
  handle('invoices:list', (o?: { status?: InvoiceStatus | 'all'; limit?: number }) => db.listInvoices(o?.status ?? 'all', o?.limit ?? 300));
  handle('invoices:approve', (id: number) => engine.approve(id));
  handle('invoices:skip', (id: number) => {
    db.setStatus(id, 'skipped');
    broadcast();
  });
  handle('invoices:retry', (id: number) => engine.approve(id));
  handle('invoices:open', (id: number) => {
    const inv = db.getInvoice(id);
    if (inv?.filePath) shell.openPath(inv.filePath);
  });
  handle('logs:list', (limit?: number) => db.listLogs(limit ?? 200));
  handle('open:external', (url: string) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
  });

  createWindow(process.argv.includes('--hidden'));
  if (settings.get().remote.enabled) applyRemote();
  createTray(engine);
  createAppMenu(engine);

  if (settings.get().onboardingDone && !DEMO) {
    if (settings.get().delivery.whatsappMode === 'web' && waWeb.hasSession()) waWeb.start().catch(() => undefined);
    setTimeout(() => engine.runOnce().finally(() => engine.schedule()), 5_000);
  }

  app.on('second-instance', () => showWindow());
  app.on('before-quit', () => {
    quitting = true;
    engine.stop();
    remote.stop();
  });
  app.on('window-all-closed', () => {
    /* rămânem în tray */
  });

  if (SCREENSHOT_DIR) {
    if (DEMO && settings.get().remote.enabled) await applyRemote();
    await takeScreenshots(SCREENSHOT_DIR, remote.running ? { base: `http://127.0.0.1:${remote.port}`, pairCode: () => remote.newPairing().code } : null);
  }
}

function applyAutostart(s: Settings) {
  if (process.platform === 'win32' || process.platform === 'darwin') {
    app.setLoginItemSettings({ openAtLogin: s.autostart, args: ['--hidden'] });
  }
}

function titleBarOverlay() {
  const dark = nativeTheme.shouldUseDarkColors;
  return { color: dark ? '#000000' : '#f2f4f7', symbolColor: dark ? '#e8e8e8' : '#0a0a0a', height: 32 };
}

function createWindow(hidden: boolean) {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 380,
    minHeight: 560,
    show: !hidden,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#000000' : '#f2f4f7',
    title: 'FacturaBot',
    icon: assetPath('icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarOverlay(),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  nativeTheme.on('updated', () => {
    try {
      win?.setTitleBarOverlay(titleBarOverlay());
      win?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#000000' : '#f2f4f7');
    } catch {
      /* nu e suportat pe toate platformele */
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('close', (e) => {
    if (!quitting && !SCREENSHOT_DIR) {
      e.preventDefault();
      win?.hide();
    }
  });
  if (process.env.VITE_DEV_SERVER_URL) win.loadURL(process.env.VITE_DEV_SERVER_URL);
  else win.loadFile(path.join(__dirname, '../renderer/index.html'));
}

function showWindow(page?: string) {
  if (!win) return;
  win.show();
  win.focus();
  if (page) win.webContents.send('navigate', page);
}

function createTray(engine: SyncEngine) {
  const img = nativeImage.createFromPath(assetPath('tray.png'));
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.setToolTip('FacturaBot – trimite facturile la contabilă');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Deschide FacturaBot', click: () => showWindow() },
      { label: 'Sincronizează acum', click: () => engine.runOnce() },
      { label: 'Istoric', click: () => showWindow('history') },
      { label: 'Cheltuieli și TVA', click: () => showWindow('spending') },
      { label: 'Setări', click: () => showWindow('settings') },
      { type: 'separator' },
      {
        label: 'Ieșire',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', () => showWindow());
}

/** Meniul aplicației. Bara de meniu e ascunsă (titlebar custom), dar scurtăturile funcționează. */
function createAppMenu(engine: SyncEngine) {
  const nav = (page: string) => () => showWindow(page);
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'FacturaBot',
        submenu: [
          { label: 'Sincronizează acum', accelerator: 'CmdOrCtrl+R', click: () => engine.runOnce() },
          { label: 'Ascunde în tray', accelerator: 'CmdOrCtrl+W', click: () => win?.hide() },
          { type: 'separator' },
          {
            label: 'Ieșire',
            accelerator: 'CmdOrCtrl+Q',
            click: () => {
              quitting = true;
              app.quit();
            },
          },
        ],
      },
      {
        label: 'Navigare',
        submenu: [
          { label: 'Acasă', accelerator: 'CmdOrCtrl+1', click: nav('dashboard') },
          { label: 'Istoric', accelerator: 'CmdOrCtrl+2', click: nav('history') },
          { label: 'Cheltuieli', accelerator: 'CmdOrCtrl+3', click: nav('spending') },
          { label: 'TVA', accelerator: 'CmdOrCtrl+4', click: nav('tax') },
          { label: 'Setări', accelerator: 'CmdOrCtrl+5', click: nav('settings') },
          { label: 'Asistent de configurare', click: nav('onboarding-1') },
        ],
      },
      {
        label: 'Editare',
        submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }],
      },
      {
        label: 'Ajutor',
        submenu: [
          { label: 'Deschide folderul cu facturi', click: () => shell.openPath(path.join(app.getPath('userData'), 'facturi')) },
          { label: 'Instrumente dezvoltator', accelerator: 'CmdOrCtrl+Shift+I', click: () => win?.webContents.toggleDevTools() },
          { label: `Despre FacturaBot ${app.getVersion()}`, click: () => app.showAboutPanel() },
        ],
      },
    ]),
  );
  app.setAboutPanelOptions({ applicationName: 'FacturaBot', applicationVersion: app.getVersion(), copyright: '© 2026 Lucian Ceușan' });
}

/** Capturi ale panoului de pe telefon (390×844, DPR 3) – același server ca pe un telefon real. */
async function takeMobileShots(dir: string, themes: string[], m: { base: string; pairCode: () => string }) {
  const tabs = (process.env.FACTURABOT_SCREENSHOT_MOBILE ?? '').split(',').filter(Boolean);
  if (!tabs.length) return;
  const token = process.env.FACTURABOT_DEMO_REMOTE_TOKEN ?? '';
  const W = 390;
  const H = 844;
  for (const theme of themes) {
    nativeTheme.themeSource = theme as 'dark' | 'light';
    for (const tab of tabs) {
      const unpaired = tab === 'pair';
      const partition = unpaired ? `mobile-unpaired-${theme}` : `mobile-${theme}`;
      const mw = new BrowserWindow({ show: true, useContentSize: true, width: W, height: H, frame: false, webPreferences: { partition, contextIsolation: true, sandbox: true } });
      if (!unpaired && token) await mw.webContents.session.cookies.set({ url: m.base, name: 'fb_s', value: token, httpOnly: true, sameSite: 'strict' });
      mw.webContents.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1');
      const [name, scroll] = tab.split('@');
      const url = unpaired ? `${m.base}/#pair=${m.pairCode()}` : `${m.base}/${name === 'home' ? '' : `#${name}`}`;
      await mw.loadURL(url);
      await new Promise((r) => setTimeout(r, 1800));
      if (scroll) await mw.webContents.executeJavaScript(`window.scrollTo(0, ${Number(scroll)})`);
      await new Promise((r) => setTimeout(r, 400));
      const img = await mw.webContents.capturePage();
      fs.writeFileSync(path.join(dir, `mobile-${scroll ? `${name}-scroll${scroll}` : name}-${theme}.png`), img.toPNG());
      mw.destroy();
    }
  }
}

/** Mod folosit doar la dezvoltare: randează fiecare ecran și salvează PNG-uri. */
async function takeScreenshots(dir: string, mobile: { base: string; pairCode: () => string } | null) {
  fs.mkdirSync(dir, { recursive: true });
  const w = win!;
  w.setContentSize(Number(process.env.FACTURABOT_SCREENSHOT_W ?? 1280), Number(process.env.FACTURABOT_SCREENSHOT_H ?? 820));
  w.show();
  if (w.webContents.isLoading()) await new Promise<void>((r) => w.webContents.once('did-finish-load', () => r()));
  await new Promise((r) => setTimeout(r, 1500));
  console.log('[screenshot] viewport', await w.webContents.executeJavaScript('`${innerWidth}x${innerHeight}@${devicePixelRatio}`'));
  const pages = (process.env.FACTURABOT_SCREENSHOT_PAGES ?? 'dashboard,history,settings,onboarding-1,onboarding-4').split(',').filter((p) => p && p !== 'none');
  const themes = (process.env.FACTURABOT_SCREENSHOT_THEMES ?? 'dark,light').split(',');
  for (const theme of themes) {
    nativeTheme.themeSource = theme as 'dark' | 'light';
    for (const spec of pages) {
      // „settings#900” = pagina Setări derulată 900px
      const [p, scroll] = spec.split('#');
      w.webContents.send('navigate', p);
      await new Promise((r) => setTimeout(r, 900));
      await w.webContents.executeJavaScript(`document.querySelectorAll('.content, .ob-body').forEach(e => e.scrollTop = ${Number(scroll ?? 0)})`);
      await new Promise((r) => setTimeout(r, 300));
      const img = await w.webContents.capturePage();
      const name = scroll ? `${p}-scroll${scroll}` : p;
      fs.writeFileSync(path.join(dir, `${name}-${theme}.png`), img.toPNG());
    }
  }
  if (mobile) await takeMobileShots(dir, themes, mobile);
  quitting = true;
  app.quit();
}

main().catch((e) => {
  console.error(e);
  app.quit();
});
