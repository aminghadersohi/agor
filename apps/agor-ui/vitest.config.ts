import path from 'node:path';
import react from '@vitejs/plugin-react';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    conditions: ['source'],
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['../../test/isolate-host-env.ts', './src/test/setup.ts'],
    server: {
      deps: {
        // Streamdown dynamically imports KaTeX CSS; inline both packages so
        // Vite transforms that CSS import in jsdom component tests.
        inline: ['streamdown', 'katex'],
      },
    },
    // `*.browser.test.tsx` run only under the real-browser config
    // (vitest.browser.config.ts) — they rely on true layout/scroll/stacking that
    // jsdom can't model.
    exclude: [...configDefaults.exclude, 'src/utils/theme.test.ts', 'src/**/*.browser.test.tsx'],
    // Ant Design Form / Select first-mount cost (CSS parse + JSDOM
    // getComputedStyle stubs) can blow past short defaults on a saturated CI
    // shard, even though the same test runs in <300ms warm. Keep enough room
    // for cold Ant Design confirmation portals without weakening assertions.
    testTimeout: 30_000,
  },
});
