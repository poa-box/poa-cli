/**
 * Smart Account Implementation Registry (SAIR) corpus scan — HB#859 Sprint 21 Idea 9 prototype.
 *
 * For each Snapshot DAO in corpus, call audit-proxy-factory to get top-5 voters + family,
 * then for any eip-7702-delegated-eoa voter, extract the delegation target + probe VERSION/
 * entryPoint to identify the smart-account implementation.
 *
 * Output: JSON registry of targets → {versions, entryPoints, observedIn: [DAO names]}.
 */
const { execSync } = require('child_process');
const { ethers } = require('ethers');

const provider = new ethers.providers.StaticJsonRpcProvider(
  { url: 'https://ethereum.publicnode.com', timeout: 30000 },
  { chainId: 1, name: 'mainnet' },
);

// HB#852 n=17 corpus Snapshot spaces (data-returning only)
const spaces = [
  'ens.eth', 'curve.eth', 'gearbox.eth', 'uniswapgovernance.eth',
  'balancer.eth', 'frax.eth', 'arbitrumfoundation.eth', 'gitcoindao.eth',
  'nouns.eth', 'sushigov.eth', 'lido-snapshot.eth', 'safe.eth',
  'dydxgov.eth', '1inch.eth', 'apecoin.eth', 'pooltogether.eth',
];

function extractTarget(code) {
  if (!code || code.length !== 48) return null;
  const lc = code.toLowerCase();
  if (!lc.startsWith('0xef0100')) return null;
  return ethers.utils.getAddress('0x' + lc.slice(8));
}

async function probeTarget(addr) {
  const abi = [
    'function VERSION() view returns (string)',
    'function version() view returns (string)',
    'function entryPoint() view returns (address)',
  ];
  const c = new ethers.Contract(addr, abi, provider);
  const result = { address: addr, codeSize: null, VERSION: null, entryPoint: null };
  try { const code = await provider.getCode(addr); result.codeSize = (code.length - 2) / 2; } catch {}
  for (const fn of ['VERSION', 'version', 'entryPoint']) {
    try {
      const r = await c[fn]();
      if (fn === 'VERSION' || fn === 'version') {
        if (!result.VERSION) result.VERSION = r;
      } else {
        result.entryPoint = r.toLowerCase();
      }
    } catch {}
  }
  return result;
}

(async () => {
  const registry = {}; // targetAddr → {...info, observedIn: [{dao, voter}]}
  for (const space of spaces) {
    try {
      const out = execSync(`node dist/index.js org audit-proxy-factory --space ${space} --json 2>/dev/null`, { encoding: 'utf-8', maxBuffer: 10e6 });
      const d = JSON.parse(out.trim().split('\n').pop());
      if (d.status === 'error' || !d.voters) { console.error(`  ${space}: no data`); continue; }
      for (const v of d.voters) {
        if (v.family === 'eip-7702-delegated-eoa') {
          // Need the raw code to extract target
          const code = await provider.getCode(v.address);
          const target = extractTarget(code);
          if (!target) continue;
          if (!registry[target]) {
            registry[target] = { ...(await probeTarget(target)), observedIn: [] };
          }
          registry[target].observedIn.push({ dao: space, voter: v.address });
          console.error(`  ${space}: ${v.address} → delegates to ${target}`);
        }
      }
    } catch (e) {
      console.error(`  ${space}: ERROR ${e.message.substring(0, 100)}`);
    }
  }
  console.log(JSON.stringify(registry, null, 2));
})();
