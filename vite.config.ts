import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const root = path.resolve(__dirname, 'src/renderer');

export default defineConfig({
  root,
  base: './',
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    // index.html = aplicația desktop (Electron); web.html = panoul de pe telefon (servit de serverul local).
    rollupOptions: { input: { index: path.resolve(root, 'index.html'), web: path.resolve(root, 'web.html') } },
  },
  server: { port: 5183, strictPort: true },
});
