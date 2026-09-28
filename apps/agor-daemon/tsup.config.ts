import { glob } from 'glob';
import { defineConfig } from 'tsup';

// Find all source files
const srcFiles = glob.sync('src/**/*.ts', { ignore: ['**/*.test.ts', '**/*.spec.ts'] });

// Create entry points
const entries = Object.fromEntries(
  srcFiles.map((file) => [file.replace(/^src\//, '').replace(/\.ts$/, ''), file])
);

export default defineConfig({
  entry: entries,
  format: ['esm'],
  dts: false,
  clean: true,
  // Every source file is an entry, so without splitting each one inlines a
  // private copy of everything it imports (zod, the MCP server, route tables).
  // Shared code goes to root-level chunks instead; entry files stay at their
  // source-relative paths as thin re-exports. Chunks sit at the same depth as
  // dist/index.js, a layout every import.meta.url lookup (UI, executor,
  // package.json, .build-info) already resolves.
  splitting: true,
  outDir: 'dist',
  // Bundle pure-JS feature trees that otherwise add many tiny packages to the
  // global install. Native and platform-selected dependencies stay external.
  noExternal: [
    /^@anthropic-ai\/sdk$/,
    /^@aws-sdk\/(client-s3|lib-storage)$/,
    /^@octokit\/(auth-app|rest)$/,
    /^(mdast-util-gfm|mdast-util-to-markdown|remark-gfm|remark-parse|unified)$/,
  ],
  external: [/^@agor\/core/, '@cursor/sdk'],
});
