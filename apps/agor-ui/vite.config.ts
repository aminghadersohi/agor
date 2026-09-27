import path from 'node:path';
import { getDefaultConfig, loadConfigSync } from '@agor-live/client/config';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import viteCompression from 'vite-plugin-compression';

// Load Agor config to get daemon port
const agorConfig = (() => {
  try {
    return loadConfigSync();
  } catch {
    return getDefaultConfig();
  }
})();

const defaults = getDefaultConfig();
const daemonPort = process.env.VITE_DAEMON_PORT
  ? Number(process.env.VITE_DAEMON_PORT)
  : agorConfig.daemon?.port || defaults.daemon?.port || 3030;

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    // Pre-compress assets with gzip (works over HTTP and HTTPS)
    // Gzip: ~1MB compressed (vs 3.5MB uncompressed) - 70% reduction
    viteCompression({
      algorithm: 'gzip',
      ext: '.gz',
      threshold: 1024, // Only compress files > 1KB
      deleteOriginFile: false, // Keep originals for fallback
    }),
  ],

  // Polyfill Node.js globals for browser compatibility
  define: {
    global: 'globalThis',
    // Inject daemon port from config.yaml (allows frontend to respect config)
    'import.meta.env.VITE_DAEMON_PORT': String(daemonPort),
  },

  // Set base path for production builds (served from /ui by daemon)
  // In development, this is ignored (uses default /)
  base: process.env.NODE_ENV === 'production' ? '/ui/' : '/',

  // Path alias resolution
  resolve: {
    conditions: ['source'],
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
    // Guard against @codemirror/state being duplicated across async chunks.
    // manualChunks forces CM6 packages into the 'editor' chunk, but a nested
    // dynamic import() inside that chunk can still cause Rollup to emit a
    // second copy of @codemirror/state (breaking instanceof checks). Dedupe
    // pins all resolutions to the same singleton regardless of chunk layout.
    dedupe: ['@codemirror/state', '@codemirror/view'],
  },

  // Mark Node.js-only packages as external so they're not bundled
  build: {
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      external: ['@openai/codex-sdk', '@anthropic-ai/claude-agent-sdk', '@google/gemini-cli-core'],
      output: {
        // Name only the vendor chunks every page boots with, so their hashes
        // (and browser caches) survive app-only deploys.
        //
        // Do NOT add groups for libraries that are only reached through a
        // lazy boundary (CodeMirror, Sandpack, emoji picker, syntax
        // highlighter, xterm, vega, streamdown). Rolldown folds a group's
        // dependencies into the group, so shared modules such as
        // `react/jsx-runtime` or Vite's preload helper land inside it and
        // the entry then statically imports (and modulepreloads) the whole
        // heavy chunk. Left alone, those libraries split at their dynamic
        // imports and load only when used. `resolve.dedupe` above keeps a
        // single @codemirror/state instance without the group.
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('@ant-design') || /\/antd\//.test(id)) return 'antd';
          if (id.includes('reactflow')) return 'reactflow';
          return undefined;
        },
      },
    },
  },

  server: {
    // Bind to 0.0.0.0 for Docker accessibility
    host: '0.0.0.0',
    port: 5173,
    // Proxy API and socket traffic to the daemon
    proxy: {
      '/authentication': { target: `http://localhost:${daemonPort}`, changeOrigin: true },
      '/socket.io': { target: `http://localhost:${daemonPort}`, changeOrigin: true, ws: true },
      '/api': { target: `http://localhost:${daemonPort}`, changeOrigin: true },
    },
    // Watch for changes in workspace packages
    watch: {
      // Watch the @agor-live/client package for changes
      ignored: ['!**/node_modules/@agor-live/client/**'],
    },
    fs: {
      // Allow serving files from the monorepo root
      allow: ['../..'],
    },
  },
});
