import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/main/**/*.ts', 'src/shared/**/*.ts'],
      // Doar „lipici” Electron (ferestre, tray, IPC) – testat manual / prin capturi de ecran.
      exclude: ['src/main/index.ts', 'src/main/demo.ts'],
      reporter: ['text-summary', 'text', 'html', 'json-summary'],
      thresholds: { lines: 90, functions: 90, branches: 75, statements: 90 },
    },
  },
});
