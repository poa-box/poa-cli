import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

describe('canonical provenance using actual ethers browser ESM classes', () => {
  it('executes the browser bundle with exact call/event proofs and fail-closed identities', async () => {
    const bundle = await build({ entryPoints: [resolve(__dirname, 'fixtures/provenance-browser.ts')], bundle: true,
      platform: 'browser', mainFields: ['browser', 'module', 'main'], format: 'iife', target: 'es2022', write: false, metafile: true });
    const inputs = Object.keys(bundle.metafile!.inputs);
    expect(inputs.some(p => /@ethersproject\/abi\/lib\.esm\/interface\.js$/.test(p))).toBe(true);
    expect(inputs.some(p => /@ethersproject\/abi\/lib\/interface\.js$/.test(p))).toBe(false);
    const sandbox: any = { console, setTimeout, clearTimeout, atob, btoa,
      fetch: () => { throw new Error('OFFLINE_BROWSER_TEST_NETWORK_BLOCKED'); } };
    sandbox.window = sandbox; sandbox.self = sandbox;
    runInNewContext(bundle.outputFiles[0].text, sandbox);
    const result = await sandbox.runProvenanceBrowserRegression();
    expect(result.diagnostics.functionParsedFormat).toBe('undefined');
    expect(result.diagnostics.eventParsedFormat).toBe('undefined');
    expect(result.diagnostics.functionOriginalFormat).toBe('function');
    expect(result.diagnostics.eventOriginalFormat).toBe('function');
    expect(result.diagnostics.originalParsedFunctionError).toContain('fragment.format is not a function');
    expect(result.diagnostics.originalParsedEventError).toContain('eventFragment.format is not a function');
    expect(result.cases).toHaveLength(16);
    expect(result.cases.filter((c: any) => !c.passed)).toEqual([]);
    expect(result.networkCalls).toBe(0);
  });
});
