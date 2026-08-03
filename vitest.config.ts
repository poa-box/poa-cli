import { defineConfig } from 'vitest/config';
import * as path from 'path';

export default defineConfig({
  resolve: {
    alias: [
      // Resolve @poa/core to its TypeScript SOURCE in tests. The package is a
      // symlink (link:./packages/core), and mixing vite-transformed copies of
      // its dist with require-loaded ones yields two module instances — every
      // `instanceof CliError` then fails. One source graph, one instance.
      { find: /^@poa\/core\/(.*)$/, replacement: path.resolve(__dirname, 'packages/core/src/$1') },
      { find: '@poa/core', replacement: path.resolve(__dirname, 'packages/core/src/index.ts') },
    ],
  },
  test: {
    // Root suite covers @poa/cli only. @poa/agent has its own suite and its
    // own dependency tree (libp2p et al.) — running its tests from here would
    // resolve against the wrong node_modules. `yarn --cwd packages/agent test`
    // runs them.
    exclude: ['**/node_modules/**', '**/dist/**', 'packages/**'],
  },
});
