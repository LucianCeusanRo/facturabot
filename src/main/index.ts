import { app, BrowserWindow, ipcMain, Menu, nativeImage, nativeTheme, Notification, safeStorage, shell, Tray } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DeepPartial, InvoiceStatus, SecretKey, Settings } from '../shared/types.js';
import { SettingsStore } from './config.js';
import { Db } from './db.js';
import { WhatsAppWeb } from './delivery/whatsappWeb.js';
import { WhatsAppCloud } from './delivery/whatsappCloud.js';
import { deliver } from './delivery/dispatcher.js';
import { connectGoogle } from './oauth/google.js';
import { connectMicrosoft } from './oauth/microsoft.js';
import { SecretStore } from './secrets.js';
import { FgoClient, fgoNeededRights, isValidFgoApiKey, normalizeFgoApiKey } from './sources/fgo.js';
import { SyncEngine } from './sync.js';
import { seedDemo } from './demo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEMO = process.env.FACTURABOT_DEMO === '1';
const SCREENSHOT_DIR = process.env.FACTURABOT_SCREENSHOT_DIR;

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
  // În modul demo nu atingem conturi reale: nicio sursă activă.
  const engine = new SyncEngine({ db, settings, secrets, waWeb, dataDir, htmlToPdf, notify, onChange: broadcast, sources: DEMO ? [] : undefined });

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
  });
  app.on('window-all-closed', () => {
    /* rămânem în tray */
  });

  if (SCREENSHOT_DIR) await takeScreenshots(SCREENSHOT_DIR);
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
    minWidth: 980,
    minHeight: 640,
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
          { label: 'Setări', accelerator: 'CmdOrCtrl+3', click: nav('settings') },
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

/** Mod folosit doar la dezvoltare: randează fiecare ecran și salvează PNG-uri. */
async function takeScreenshots(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  const w = win!;
  w.setContentSize(Number(process.env.FACTURABOT_SCREENSHOT_W ?? 1280), Number(process.env.FACTURABOT_SCREENSHOT_H ?? 820));
  w.show();
  if (w.webContents.isLoading()) await new Promise<void>((r) => w.webContents.once('did-finish-load', () => r()));
  await new Promise((r) => setTimeout(r, 1500));
  console.log('[screenshot] viewport', await w.webContents.executeJavaScript('`${innerWidth}x${innerHeight}@${devicePixelRatio}`'));
  const pages = (process.env.FACTURABOT_SCREENSHOT_PAGES ?? 'dashboard,history,settings,onboarding-1,onboarding-4').split(',');
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
  quitting = true;
  app.quit();
}

main().catch((e) => {
  console.error(e);
  app.quit();
});
