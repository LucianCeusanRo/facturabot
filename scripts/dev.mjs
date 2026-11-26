// Dev: Vite (UI cu hot reload) + esbuild watch (main/preload) + Electron, repornit la schimbări în main.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import { watchNode } from './esbuild.mjs';

const require = createRequire(import.meta.url);
const electronPath = require('electron');

const server = await createServer({ configFile: 'vite.config.ts' });
await server.listen();
const url = server.resolvedUrls.local[0];
console.log('UI:', url);

let child = null;
let timer = null;
const start = () => {
  if (child) {
    child.removeAllListeners('exit');
    child.kill();
  }
  child = spawn(electronPath, ['.', ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, VITE_DEV_SERVER_URL: url } });
  child.on('exit', () => process.exit(0));
};
await watchNode(() => {
  clearTimeout(timer);
  timer = setTimeout(start, 200);
});
