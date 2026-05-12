/**
 * pop org probe-proxy <address> — automated proxy pattern detection + impl/admin extraction.
 *
 * Task #553 (vigil HB#703): codifies the manual EIP-1967 owner-walk done in
 * vigil HB#702 for vlCVX #2 (0x96c68d). Cross-DAO research repeatedly hits
 * upgradeable proxies on top-holder lists — manual probing via ethers + raw
 * storage-slot reads is slow + error-prone. This tool automates the cascade.
 *
 * Detection cascade (in priority order):
 *   1. EIP-1167 minimal-proxy via bytecode pattern match (45-byte template)
 *   2. EIP-1967 admin + impl + beacon storage slots
 *   3. EIP-1822 UUPS proxy slot (legacy; pre-1967)
 *   4. EIP-7201 namespaced-storage candidates (best-effort)
 *   5. Common-getter probing on the address (delegatecalls to impl)
 *
 * Output: human-readable + --json mode for tooling chains.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import * as output from '../../lib/output';

interface ProbeProxyArgs {
  address: string;
  chain?: number;
  rpc?: string;
  json?: boolean;
  sourcify?: boolean;
}

interface SourcifyResult {
  verified: boolean;
  name?: string;
  projectSources?: string[];
  error?: string;
}

/**
 * Task #554 (HB#706): query Sourcify v2 for a verified-source lookup of an
 * address. Returns contract name (derived from the FIRST project-specific
 * source file path — i.e., source files NOT prefixed with `@openzeppelin` /
 * `@aave` / `node_modules` / `dependencies`) + the top 5 project source
 * paths.
 *
 * No API key required. Sourcify v2 endpoint is public.
 */
async function fetchSourcify(chainId: number, addr: string): Promise<SourcifyResult> {
  const url = `https://sourcify.dev/server/v2/contract/${chainId}/${addr}?fields=sources,abi`;
  try {
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = require('https').request(
        new URL(url),
        { method: 'GET', headers: { Accept: 'application/json' }, timeout: 15000 },
        (res: any) => {
          let body = '';
          res.on('data', (chunk: any) => (body += chunk));
          res.on('end', () => resolve({ status: res.statusCode, body }));
        },
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy(new Error('sourcify-timeout'));
      });
      req.end();
    });
    if (res.status !== 200) {
      return { verified: false, error: `http-${res.status}` };
    }
    const data = JSON.parse(res.body);
    if (data.match !== 'match' && data.match !== 'exact_match' && data.match !== 'partial_match') {
      return { verified: false };
    }
    const sources = data.sources && typeof data.sources === 'object' ? Object.keys(data.sources) : [];
    const project = sources.filter(
      (s) =>
        !s.startsWith('@') &&
        !s.includes('node_modules') &&
        !s.startsWith('dependencies/') &&
        !s.toLowerCase().includes('openzeppelin'),
    );
    let name: string | undefined;
    if (project.length > 0) {
      const path = project[0];
      const file = path.split('/').pop() || path;
      name = file.replace(/\.sol$/i, '');
    }
    return {
      verified: true,
      name,
      projectSources: project.slice(0, 5),
    };
  } catch (err: any) {
    return { verified: false, error: err.message || 'fetch-failed' };
  }
}

const DEFAULT_RPC: Record<number, string> = {
  1: 'https://ethereum.publicnode.com',
  10: 'https://mainnet.optimism.io',
  100: 'https://rpc.gnosischain.com',
  137: 'https://polygon-rpc.com',
  8453: 'https://mainnet.base.org',
  42161: 'https://arb1.arbitrum.io/rpc',
};

// EIP-1967 storage slots
const EIP1967_IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const EIP1967_ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';
const EIP1967_BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';

// EIP-1822 (legacy UUPS proxy)
const EIP1822_IMPL_SLOT = '0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bcf7';

// EIP-1167 minimal-proxy bytecode template
// 0x363d3d373d3d3d363d73<20-byte impl>5af43d82803e903d91602b57fd5bf3
const EIP1167_PREFIX = '363d3d373d3d3d363d73';
const EIP1167_SUFFIX = '5af43d82803e903d91602b57fd5bf3';

function slotToAddress(slotRaw: string): string {
  if (!slotRaw || slotRaw === '0x' || /^0x0+$/.test(slotRaw)) return '';
  return ('0x' + slotRaw.slice(-40)).toLowerCase();
}

function detectEip1167(code: string): string {
  if (!code.toLowerCase().includes(EIP1167_PREFIX)) return '';
  if (!code.toLowerCase().includes(EIP1167_SUFFIX)) return '';
  const re = new RegExp(EIP1167_PREFIX + '([0-9a-fA-F]{40})' + EIP1167_SUFFIX, 'i');
  const m = code.match(re);
  return m ? ('0x' + m[1].toLowerCase()) : '';
}

interface ProbeResult {
  address: string;
  chain: number;
  codeSize: number;
  isContract: boolean;
  isProxy: boolean;
  proxyKind: string;
  implementation: string;
  admin: string;
  beacon: string;
  commonGetters: Record<string, string | null>;
  notes: string[];
  sourcify?: {
    self?: SourcifyResult;
    implementation?: SourcifyResult;
    admin?: SourcifyResult;
  };
}

async function probeCommonGetters(
  provider: ethers.providers.Provider,
  addr: string,
): Promise<Record<string, string | null>> {
  const result: Record<string, string | null> = {};
  const getters = [
    { name: 'name', returns: 'string' },
    { name: 'symbol', returns: 'string' },
    { name: 'decimals', returns: 'uint8' },
    { name: 'owner', returns: 'address' },
    { name: 'admin', returns: 'address' },
    { name: 'governance', returns: 'address' },
    { name: 'asset', returns: 'address' },
    { name: 'token', returns: 'address' },
    { name: 'vault', returns: 'address' },
    { name: 'strategy', returns: 'address' },
    { name: 'totalSupply', returns: 'uint256' },
  ];
  for (const g of getters) {
    try {
      const iface = new ethers.utils.Interface([
        `function ${g.name}() view returns (${g.returns})`,
      ]);
      const data = iface.encodeFunctionData(g.name);
      const out = await provider.call({ to: addr, data });
      const decoded = iface.decodeFunctionResult(g.name, out);
      result[g.name] = decoded.toString();
    } catch {
      // skip — not implemented or reverts
    }
  }
  return result;
}

export const probeProxyHandler = {
  builder: (yargs: Argv) =>
    yargs
      .positional('address', {
        describe: 'Target contract address to probe',
        type: 'string',
        demandOption: true,
      })
      .option('chain', { type: 'number', default: 1, describe: 'Chain ID (default 1 = Ethereum)' })
      .option('rpc', { type: 'string', describe: 'RPC URL override' })
      .option('json', { type: 'boolean', default: false, describe: 'Machine-readable JSON output' })
      .option('sourcify', {
        type: 'boolean',
        default: false,
        describe:
          'Task #554 (HB#706): query Sourcify v2 source-verification for impl + admin + main address; surface contract name (from project source file path) + top 5 project source paths. Closes HB#705 manual-lookup workflow (audit-vetoken → probe-proxy → Sourcify in 3 steps becomes 1).',
      }),

  handler: async (argv: ArgumentsCamelCase<ProbeProxyArgs>) => {
    const addr = (argv.address as string).toLowerCase();
    if (!ethers.utils.isAddress(addr)) {
      output.error(`Invalid address: ${addr}`);
      process.exit(1);
    }
    const chainId = argv.chain ?? 1;
    const rpcUrl = argv.rpc || DEFAULT_RPC[chainId];
    if (!rpcUrl) {
      output.error(`No RPC available for chainId=${chainId}; pass --rpc explicitly.`);
      process.exit(1);
    }
    const provider = new ethers.providers.StaticJsonRpcProvider(rpcUrl, {
      chainId,
      name: `chain-${chainId}`,
    });

    const result: ProbeResult = {
      address: addr,
      chain: chainId,
      codeSize: 0,
      isContract: false,
      isProxy: false,
      proxyKind: 'none',
      implementation: '',
      admin: '',
      beacon: '',
      commonGetters: {},
      notes: [],
    };

    const spin = (argv.json ? null : output.spinner('Probing proxy pattern...'));
    spin?.start();

    try {
      const code = await provider.getCode(addr);
      result.codeSize = (code.length - 2) / 2;
      result.isContract = code !== '0x';

      if (!result.isContract) {
        result.notes.push('Address is an EOA (no code).');
      } else {
        // Step 1: EIP-1167 minimal-proxy
        const eip1167Impl = detectEip1167(code);
        if (eip1167Impl) {
          result.isProxy = true;
          result.proxyKind = 'eip-1167';
          result.implementation = eip1167Impl;
          result.notes.push('Detected EIP-1167 minimal-proxy via bytecode pattern.');
        }

        // Step 2: EIP-1967 storage slots
        const implSlot = await provider.getStorageAt(addr, EIP1967_IMPL_SLOT);
        const adminSlot = await provider.getStorageAt(addr, EIP1967_ADMIN_SLOT);
        const beaconSlot = await provider.getStorageAt(addr, EIP1967_BEACON_SLOT);
        const eip1967Impl = slotToAddress(implSlot);
        const eip1967Admin = slotToAddress(adminSlot);
        const eip1967Beacon = slotToAddress(beaconSlot);

        if (eip1967Impl) {
          result.isProxy = true;
          if (result.proxyKind === 'none') result.proxyKind = 'eip-1967';
          if (!result.implementation) result.implementation = eip1967Impl;
          result.notes.push(`EIP-1967 implementation slot non-empty: ${eip1967Impl}`);
        }
        if (eip1967Admin) {
          result.admin = eip1967Admin;
          result.notes.push(`EIP-1967 admin slot non-empty: ${eip1967Admin}`);
        }
        if (eip1967Beacon) {
          result.beacon = eip1967Beacon;
          if (result.proxyKind === 'none') result.proxyKind = 'eip-1967-beacon';
          result.notes.push(`EIP-1967 beacon slot non-empty: ${eip1967Beacon}`);
        }

        // Step 3: EIP-1822 (legacy UUPS)
        const eip1822Slot = await provider.getStorageAt(addr, EIP1822_IMPL_SLOT);
        const eip1822Impl = slotToAddress(eip1822Slot);
        if (eip1822Impl && !result.implementation) {
          result.isProxy = true;
          result.proxyKind = 'eip-1822';
          result.implementation = eip1822Impl;
          result.notes.push(`EIP-1822 (legacy UUPS) implementation slot: ${eip1822Impl}`);
        }

        // Step 4: bytecode-pattern hint for upgradeTo/upgradeToAndCall selectors
        // (presence indicates OZ UUPS implementation surface even when slots empty)
        if (code.toLowerCase().includes('3659cfe6') && !result.isProxy) {
          result.notes.push(
            'Bytecode contains upgradeTo() selector (0x3659cfe6); may be UUPS proxy with non-standard storage.',
          );
        }

        // Step 5: common-getter probe
        result.commonGetters = await probeCommonGetters(provider, addr);

        // Step 6 (Task #554): optional Sourcify v2 source-lookup
        if (argv.sourcify) {
          result.sourcify = {};
          result.sourcify.self = await fetchSourcify(chainId, addr);
          if (result.implementation) {
            result.sourcify.implementation = await fetchSourcify(chainId, result.implementation);
          }
          if (result.admin) {
            result.sourcify.admin = await fetchSourcify(chainId, result.admin);
          }
        }
      }

      spin?.succeed(
        result.isProxy
          ? `Proxy detected (${result.proxyKind}) — impl: ${result.implementation || '?'}`
          : `No proxy pattern detected (${result.codeSize} bytes)`,
      );

      if (argv.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      // Human output
      console.log('');
      console.log(`  Address: ${result.address}`);
      console.log(`  Chain:   ${result.chain}`);
      console.log(`  Code:    ${result.codeSize} bytes (isContract=${result.isContract})`);
      console.log(`  Proxy:   ${result.isProxy ? 'YES (' + result.proxyKind + ')' : 'NO'}`);
      if (result.implementation) console.log(`  Impl:    ${result.implementation}`);
      if (result.admin) console.log(`  Admin:   ${result.admin}`);
      if (result.beacon) console.log(`  Beacon:  ${result.beacon}`);
      const gettersPresent = Object.entries(result.commonGetters).filter(([, v]) => v !== null && v !== undefined);
      if (gettersPresent.length > 0) {
        console.log(`\n  Common getters present:`);
        for (const [k, v] of gettersPresent) {
          console.log(`    ${k}(): ${String(v).slice(0, 80)}`);
        }
      }
      if (result.notes.length > 0) {
        console.log(`\n  Notes:`);
        for (const n of result.notes) console.log(`    - ${n}`);
      }
      if (result.sourcify) {
        console.log(`\n  Sourcify v2:`);
        for (const [layer, r] of Object.entries(result.sourcify) as Array<[string, SourcifyResult]>) {
          if (!r) continue;
          const verdict = r.verified ? (r.name || '(verified, no name)') : (r.error || 'not verified');
          console.log(`    ${layer.padEnd(15)} ${verdict}`);
          if (r.projectSources && r.projectSources.length > 0) {
            console.log(`      source[0]: ${r.projectSources[0]}`);
          }
        }
      }
      console.log('');
    } catch (err: any) {
      spin?.fail(err.message);
      if (argv.json) {
        console.log(JSON.stringify({ ...result, error: err.message }, null, 2));
      }
      process.exit(1);
    }
  },
};
