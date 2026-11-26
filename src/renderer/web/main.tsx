import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import { createRoot } from 'react-dom/client';
import '../styles.css';
import './web.css';
import { WebApp } from './WebApp';

createRoot(document.getElementById('root')!).render(<WebApp />);

// PWA: service worker doar pe HTTPS (Tailscale / Cloudflare Tunnel) sau localhost – browserele îl refuză pe HTTP în LAN.
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
}
