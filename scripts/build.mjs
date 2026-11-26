import { build } from 'vite';
import { buildNode } from './esbuild.mjs';

await buildNode();
await build({ configFile: 'vite.config.ts', logLevel: 'warn' });
console.log('✓ build gata în dist/');
