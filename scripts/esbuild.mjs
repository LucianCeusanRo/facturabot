import * as esbuild from 'esbuild';

export const mainOptions = {
  entryPoints: ['src/main/index.ts'],
  outfile: 'dist/main/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external', // dependențele din node_modules rămân externe (Baileys, sql.js, nodemailer…)
  sourcemap: true,
  banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
  // Credențialele OAuth ale aplicației pot fi „coapte” la build (CI secrets), ca utilizatorul final să nu facă setup.
  // Pentru aplicații desktop, Google/Microsoft nu consideră aceste valori secrete (RFC 8252) – siguranța vine din PKCE.
  define: {
    __FB_GOOGLE_CLIENT_ID__: JSON.stringify(process.env.FACTURABOT_GOOGLE_CLIENT_ID ?? ''),
    __FB_GOOGLE_CLIENT_SECRET__: JSON.stringify(process.env.FACTURABOT_GOOGLE_CLIENT_SECRET ?? ''),
    __FB_MS_CLIENT_ID__: JSON.stringify(process.env.FACTURABOT_MS_CLIENT_ID ?? ''),
  },
};

export const preloadOptions = {
  entryPoints: ['src/preload/index.ts'],
  outfile: 'dist/preload/index.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  sourcemap: true,
};

export async function buildNode() {
  await Promise.all([esbuild.build(mainOptions), esbuild.build(preloadOptions)]);
}

export async function watchNode(onRebuild) {
  const plugin = { name: 'notify', setup: (b) => b.onEnd((r) => !r.errors.length && onRebuild?.()) };
  const c1 = await esbuild.context({ ...mainOptions, plugins: [plugin] });
  const c2 = await esbuild.context({ ...preloadOptions, plugins: [plugin] });
  await Promise.all([c1.watch(), c2.watch()]);
}
