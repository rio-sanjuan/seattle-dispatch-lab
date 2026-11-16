import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  server: { port: 8766, strictPort: true },
  worker: { format: 'es' },
  build: { rollupOptions: { input: ['index.html', 'embed.html'] } },
  test: { include: ['test/**/*.test.ts'], testTimeout: 120_000 },
});
