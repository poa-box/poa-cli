import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['test/**/*.test.ts'], pool: 'forks', poolOptions: { forks: { maxForks: 4, minForks: 1 } } } });
