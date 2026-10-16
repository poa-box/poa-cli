import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

describe('bundled provenance using actual ethers browser ESM', () => {
  it('runs exact operation/role proofs with no browser, provider or external network', async () => {
    const bundle = await build({ entryPoints: [resolve(__dirname, 'fixtures/bundled-operation-provenance-browser.ts')], bundle: true,
      platform: 'browser', mainFields: ['browser', 'module', 'main'], format: 'iife', target: 'es2022', write: false, metafile: true });
    const inputs = Object.keys(bundle.metafile!.inputs);
    expect(inputs.some(p => /@ethersproject\/abi\/lib\.esm\/interface\.js$/.test(p))).toBe(true);
    expect(inputs.some(p => /@ethersproject\/abi\/lib\/interface\.js$/.test(p))).toBe(false);
    let networkCalls = 0;
    const sandbox: any = { console, setTimeout, clearTimeout, atob, btoa,
      fetch: () => { networkCalls++; throw new Error('OFFLINE_BROWSER_TEST_NETWORK_BLOCKED'); } };
    sandbox.window = sandbox; sandbox.self = sandbox;
    runInNewContext(bundle.outputFiles[0].text, sandbox);
    const result = await sandbox.runBundledOperationProvenanceBrowser();
    expect(result.cases).toHaveLength(10);
    expect(result.cases.filter((c: any) => !c.passed)).toEqual([]);
    expect(networkCalls).toBe(0);
  });
});
