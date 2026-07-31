import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Root suite covers @poa/cli only. @poa/agent has its own suite and its
    // own dependency tree (libp2p et al.) — running its tests from here would
    // resolve against the wrong node_modules. `yarn --cwd packages/agent test`
    // runs them.
    exclude: ['**/node_modules/**', '**/dist/**', 'packages/**'],
  },
});
