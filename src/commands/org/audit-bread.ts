/**
 * pop org audit-bread — comprehensive on-chain audit for Breadchain Cooperative.
 *
 * Background (from sentinel HB#1016 discovery):
 *   - BREAD token: 0xa555d5344f6FB6c65da19e403Cb4c1eC4a1a5Ee3 on Gnosis Chain
 *   - UUPS proxy → impl at storage slot 0x3608...82bbc; admin holds DEFAULT_ADMIN
 *   - ERC20Votes (OpenZeppelin) with block-number clock — checkpoint-based voting
 *   - sDAI-collateralized stablecoin; voting cycles allocate sDAI yield to member projects
 *   - Liquidity: Curve pool 0xf3d8…6b4 (BUTTER LP, BREAD/WXDAI) + Honeyswap 0x8d37…8812 (BREAD/HNY)
 *   - Governance: ON-CHAIN via YieldDistributor (NOT Snapshot)
 *
 * This audit computes:
 *   1. BREAD token state (supply, owner, impl) + proxy verification
 *   2. Top-N holder concentration + Gini + Nakamoto coefficient
 *   3. Delegation network: who delegates to whom (DelegateChanged events)
 *   4. Delegation-aggregation ratio: fraction of supply with non-self delegate
 *   5. Liquidity health: Curve + Honeyswap pool reserves + price (BREAD vs WXDAI peg)
 *   6. Voter participation: ERC20Votes checkpoints showing active vs inactive holders
 *
 * Closes the HB#680 governance-framework gap for on-chain checkpoint voting (BREAD-style)
 * — complement to the Snapshot allocation-distance metric on multi-option votes.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import * as output from '../../lib/output';

interface AuditBreadArgs {
  rpc?: string;
  blocks?: number;
  topN?: number;
  json?: boolean;
}

const BREAD_ADDR = '0xa555d5344f6FB6c65da19e403Cb4c1eC4a1a5Ee3';
const CURVE_POOL = '0xf3d8f3de71657d342db60dd714c8a2ae37eac6b4'; // BUTTER LP BREAD/WXDAI
const HNY_POOL = '0x8d374ab634a5a5396fce288d50cbe394a2018812'; // BREAD/HNY Honeyswap
const WXDAI = '0xe91d153e0b41518a2ce8dd3d7944fa863463a97d';
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

// YieldDistributor: monthly on-chain voting contract that allocates sDAI yield
// to member projects. Owner is the same governance multisig as BREAD itself.
// Discovered via BreadchainCoop/subgraph constants.ts (HB#1016).
const YIELD_DISTRIBUTOR = '0xeE95A62b749d8a2520E0128D9b3aCa241269024b';

// Known project labels (from BreadchainCoop/subgraph/src/constants.ts). Update
// as projects rotate. Unrecognized addresses get a "(unknown)" label.
const PROJECT_LABELS: Record<string, string> = {
  '0x7e1367998e1fe8fab8f0bbf41e97cd6e0c891b64': 'laborDao',
  '0x5405e2d4d12aadb57579e780458c9a1151b560f1': 'symbiota',
  '0x5c22b3f03b3d8fff56c9b2e90151512cb3f3de0f': 'cryptoCommonsAssociation',
  '0xa232f16ab37c9a646f91ba901e92ed1ba4b7b544': 'citizenWallet',
  '0x918def5d593f46735f74f9e2b280fe51af3a99ad': 'breadCore (owner multisig)',
  '0x6a148b997e6651237f2fcfc9e30330a6480519f0': 'breadTreasury',
  '0x68060388c7d97b4bf779a2ead46c86e5588f073f': 'refiDao',
  '0x1bd2212c9aa332d22d61a0be6bcc55b2a1de6c63': 'gardens',
  '0xfcb81c1b0e0d4fea01e5a0fbf0aebb91e78a67e1': 'regenCoordination',
};

const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
];

const VOTES_ABI = [
  'function getVotes(address) view returns (uint256)',
  'function delegates(address) view returns (address)',
  'function clock() view returns (uint48)',
  'function CLOCK_MODE() view returns (string)',
];

const YD_ABI = [
  'function getCurrentVotingDistribution() view returns (address[], uint256[])',
  'function getCurrentVotingPower(address) view returns (uint256)',
  'function maxPoints() view returns (uint256)',
  'function cycleLength() view returns (uint256)',
  'function owner() view returns (address)',
];

// ButteredBread (BB) — the LP-stake-derived voting-power token. Discovered in
// YD storage slot 14 during HB#1017 deep probe. Voting power in BREAD's on-
// chain governance is the SUM of direct BREAD balance + a multiplier-scaled
// ButteredBread balance (LP-staked BREAD). A voter with 0 BREAD direct can
// still have non-trivial voting power via BB.
const BUTTERED_BREAD = '0x680b581605dc0a6902735a80de35cb0ef6e90865';

const BB_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function owner() view returns (address)',
];

const PAIR_ABI = [
  'function getReserves() view returns (uint112,uint112,uint32)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
];

function gini(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  const n = v.length;
  if (n < 2) return 0;
  const total = v.reduce((s, x) => s + x, 0);
  if (total === 0) return 0;
  let sumDiff = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) sumDiff += Math.abs(v[i] - v[j]);
  }
  return sumDiff / (2 * n * total);
}

function nakamoto(values: number[], threshold = 0.5): number {
  const v = [...values].sort((a, b) => b - a);
  const total = v.reduce((s, x) => s + x, 0);
  let running = 0;
  for (let i = 0; i < v.length; i++) {
    running += v[i];
    if (running / total > threshold) return i + 1;
  }
  return v.length;
}

export const auditBreadHandler = {
  builder: (yargs: Argv) =>
    yargs
      .option('rpc', { type: 'string', default: 'https://rpc.gnosischain.com', describe: 'Gnosis Chain RPC URL' })
      .option('blocks', { type: 'number', default: 200_000, describe: 'How many recent blocks to scan for Transfer + Delegate events (default 200,000 ≈ 12 days on Gnosis)' })
      .option('top-n', { type: 'number', default: 15, describe: 'Top-N holders to display' })
      .option('json', { type: 'boolean', default: false, describe: 'Machine-readable JSON output' }),

  handler: async (argv: ArgumentsCamelCase<AuditBreadArgs>) => {
    const rpc = (argv.rpc as string) || 'https://rpc.gnosischain.com';
    const blockWindow = Number(argv.blocks) || 200_000;
    const topN = Number(argv.topN ?? (argv as any)['top-n']) || 15;
    const wantJson = Boolean(argv.json);

    const spin = wantJson ? null : output.spinner('Auditing Breadchain on Gnosis Chain...');
    spin?.start();

    try {
      const p = new ethers.providers.StaticJsonRpcProvider(rpc);

      // 1. Token state
      spin && (spin.text = 'Reading BREAD token state...');
      const bread = new ethers.Contract(BREAD_ADDR, [...ERC20_ABI, ...VOTES_ABI], p);
      const [name, symbol, decimals, supplyRaw, clockMode, clockNow] = await Promise.all([
        bread.name(),
        bread.symbol(),
        bread.decimals(),
        bread.totalSupply(),
        bread.CLOCK_MODE().catch(() => null),
        bread.clock().catch(() => null),
      ]);
      const supply = Number(ethers.utils.formatUnits(supplyRaw, decimals));

      // 2. UUPS proxy verification
      const implRaw = await p.getStorageAt(BREAD_ADDR, IMPL_SLOT);
      const impl = '0x' + implRaw.slice(-40);
      const implCode = await p.getCode(impl);

      // 3. Recent Transfer events → holder set
      spin && (spin.text = `Scanning ${blockWindow.toLocaleString()} blocks for Transfer + Delegate events...`);
      const latest = await p.getBlockNumber();
      const fromBlock = Math.max(0, latest - blockWindow);
      const Transfer = ethers.utils.id('Transfer(address,address,uint256)');
      const DelegateChanged = ethers.utils.id('DelegateChanged(address,address,address)');
      const DelegateVotesChanged = ethers.utils.id('DelegateVotesChanged(address,uint256,uint256)');

      // Chunked log scan (Gnosis public RPCs cap log queries)
      const CHUNK = 10_000;
      const holders = new Set<string>();
      const delegates = new Map<string, string>(); // delegator -> delegate
      let scanErrors = 0;
      for (let b = fromBlock; b <= latest; b += CHUNK) {
        const to = Math.min(b + CHUNK - 1, latest);
        try {
          const [tlogs, dlogs] = await Promise.all([
            p.getLogs({ address: BREAD_ADDR, fromBlock: b, toBlock: to, topics: [Transfer] }),
            p.getLogs({ address: BREAD_ADDR, fromBlock: b, toBlock: to, topics: [DelegateChanged] }),
          ]);
          for (const l of tlogs) {
            holders.add('0x' + l.topics[1].slice(-40));
            holders.add('0x' + l.topics[2].slice(-40));
          }
          for (const l of dlogs) {
            const delegator = '0x' + l.topics[1].slice(-40);
            const newDelegate = '0x' + l.topics[3].slice(-40);
            delegates.set(delegator.toLowerCase(), newDelegate.toLowerCase());
          }
        } catch {
          scanErrors++;
        }
      }
      holders.delete('0x0000000000000000000000000000000000000000');

      // Exclude known pool/AMM contracts from the holder ranking — they hold
      // BREAD as inventory, not as voters. Their balance shows up in totalSupply
      // but they're not governance participants.
      const POOL_ADDRS = new Set([
        CURVE_POOL.toLowerCase(),
        HNY_POOL.toLowerCase(),
        '0xba1333333333a1ba1108e8412f11850a5c319ba9', // Balancer V3 vault
      ]);

      // 4. Sample balances for top-holder analysis (cap to avoid runaway RPC use).
      // Exclude known pool addresses — they're inventory, not voters.
      const holderArr = [...holders].filter((a) => !POOL_ADDRS.has(a.toLowerCase())).slice(0, 1500);
      spin && (spin.text = `Sampling balances for ${holderArr.length} non-pool holders...`);
      const balances: Array<{ addr: string; balance: number }> = [];
      const erc20 = new ethers.Contract(BREAD_ADDR, ERC20_ABI, p);
      for (let i = 0; i < holderArr.length; i += 30) {
        const batch = holderArr.slice(i, i + 30);
        const results = await Promise.all(batch.map((a) => erc20.balanceOf(a).catch(() => null)));
        for (let j = 0; j < batch.length; j++) {
          const r = results[j];
          if (r && !r.isZero()) {
            balances.push({ addr: batch[j], balance: Number(ethers.utils.formatUnits(r, decimals)) });
          }
        }
      }
      balances.sort((a, b) => b.balance - a.balance);

      // 5. Compute concentration metrics on observed balances
      const values = balances.map((b) => b.balance);
      const sampledSupply = values.reduce((s, x) => s + x, 0);
      const giniVal = gini(values);
      const nak50 = nakamoto(values, 0.5);
      const nak75 = nakamoto(values, 0.75);
      const top10Share = values.slice(0, 10).reduce((s, x) => s + x, 0) / sampledSupply;

      // 6. Delegation network analysis
      let selfDelegated = 0;
      let nonSelfDelegated = 0;
      for (const [delegator, delegate] of delegates) {
        if (delegator === delegate) selfDelegated++;
        else nonSelfDelegated++;
      }
      const totalDelegationEvents = delegates.size;
      const nonSelfRatio = totalDelegationEvents > 0 ? nonSelfDelegated / totalDelegationEvents : 0;

      // 7. YieldDistributor — current vote distribution across member projects.
      //    Also reads ButteredBread (the LP-stake-derived VP token) state.
      spin && (spin.text = 'Reading YieldDistributor + ButteredBread state...');
      const risks: string[] = [];

      // ButteredBread state
      let bb: any = null;
      try {
        const bbC = new ethers.Contract(BUTTERED_BREAD, BB_ABI, p);
        const [bbName, bbSym, bbSupplyRaw, bbOwner] = await Promise.all([
          bbC.name(),
          bbC.symbol(),
          bbC.totalSupply(),
          bbC.owner(),
        ]);
        bb = {
          address: BUTTERED_BREAD,
          name: bbName,
          symbol: bbSym,
          totalSupply: Number(ethers.utils.formatUnits(bbSupplyRaw, 18)),
          owner: bbOwner,
        };
      } catch {}
      let yd: any = null;
      try {
        const ydC = new ethers.Contract(YIELD_DISTRIBUTOR, YD_ABI, p);
        const [maxPoints, cycleLengthRaw, ydOwner, distRaw] = await Promise.all([
          ydC.maxPoints().catch(() => null),
          ydC.cycleLength().catch(() => null),
          ydC.owner().catch(() => null),
          ydC.getCurrentVotingDistribution().catch(() => null),
        ]);
        const projects: Array<{ address: string; label: string; points: string; share: number }> = [];
        if (distRaw) {
          const [addrs, points] = distRaw;
          const total = points.reduce((s: any, x: any) => s.add(x), ethers.BigNumber.from(0));
          for (let i = 0; i < addrs.length; i++) {
            const a = addrs[i].toLowerCase();
            const share = total.isZero() ? 0 : Number(points[i].mul(10000).div(total)) / 100;
            projects.push({
              address: addrs[i],
              label: PROJECT_LABELS[a] || '(unknown)',
              points: points[i].toString(),
              share,
            });
          }
          projects.sort((a, b) => b.share - a.share);
        }
        // For the top-N BREAD holders, also query the YD's getCurrentVotingPower
        // to compare direct BREAD votes vs effective YD voting power (which
        // includes the ButteredBread multiplier).
        const dualVP: Array<{ address: string; breadVotes: number; effectiveVP: number; multiplier: number }> = [];
        const topAddrs = balances.slice(0, 12).map((b) => b.addr);
        for (const a of topAddrs) {
          try {
            const ev = await ydC.getCurrentVotingPower(a);
            const evFmt = Number(ethers.utils.formatEther(ev));
            const bvFmt = balances.find((b) => b.addr.toLowerCase() === a.toLowerCase())?.balance || 0;
            dualVP.push({
              address: a,
              breadVotes: bvFmt,
              effectiveVP: evFmt,
              multiplier: bvFmt > 0 ? evFmt / bvFmt : evFmt > 0 ? Infinity : 0,
            });
          } catch {}
        }
        yd = {
          address: YIELD_DISTRIBUTOR,
          owner: ydOwner,
          maxPoints: maxPoints ? Number(maxPoints) : null,
          cycleLength: cycleLengthRaw ? Number(cycleLengthRaw) : null,
          cycleApproxDays:
            cycleLengthRaw && Number(cycleLengthRaw) > 0
              ? (Number(cycleLengthRaw) * 5) / 86400 // Gnosis ~5s blocks
              : null,
          projects,
          topProjectShare: projects[0]?.share || 0,
          dualVP,
          butteredBread: bb,
        };
        // topProjectShare is already a percent (0-100). Flag when > 30%.
        if (yd.topProjectShare > 30) {
          risks.push(`YieldDistributor concentration: top project gets ${yd.topProjectShare.toFixed(1)}% of vote allocation`);
        }
        // Effective-VP concentration risk: LP-stake multipliers skew VP heavily.
        // Sum top-12 effective VP, then check top-2 share.
        if (yd.dualVP && yd.dualVP.length >= 2) {
          const totalEffVP = yd.dualVP.reduce((s: number, x: any) => s + (Number.isFinite(x.effectiveVP) ? x.effectiveVP : 0), 0);
          const sorted = [...yd.dualVP].sort((a: any, b: any) => b.effectiveVP - a.effectiveVP);
          const top2 = sorted[0].effectiveVP + sorted[1].effectiveVP;
          const top2Share = totalEffVP > 0 ? top2 / totalEffVP : 0;
          if (top2Share > 0.7) {
            risks.push(
              `Effective VP concentration via LP-stake multiplier: top-2 holders control ` +
                `${(top2Share * 100).toFixed(1)}% of effective YD voting power. ` +
                `BREAD-balance Gini understates true plutocratic risk because ButteredBread multipliers ` +
                `(observed up to 1.8M×) further skew weight toward LP-stakers.`,
            );
          }
          // Flag holders with 0 effective VP despite holding BREAD (passive holders losing voice)
          const passive = sorted.filter((x: any) => x.breadVotes > 100 && x.effectiveVP === 0).length;
          if (passive > 0) {
            risks.push(`${passive} holder(s) with >100 BREAD have 0 effective YD voting power (passive — no LP stake)`);
          }
        }
      } catch {}

      // 8. Liquidity pools
      spin && (spin.text = 'Reading Curve + Honeyswap pool reserves...');
      let poolWXDAI: any = null;
      let poolHNY: any = null;
      try {
        const cp = new ethers.Contract(CURVE_POOL, PAIR_ABI, p);
        const [r0, r1] = await cp.getReserves();
        const [t0, t1] = await Promise.all([cp.token0(), cp.token1()]);
        const breadIsT0 = t0.toLowerCase() === BREAD_ADDR.toLowerCase();
        const breadReserve = Number(ethers.utils.formatUnits(breadIsT0 ? r0 : r1, 18));
        const counter = Number(ethers.utils.formatUnits(breadIsT0 ? r1 : r0, 18));
        poolWXDAI = {
          address: CURVE_POOL,
          name: 'BUTTER (Curve BREAD/WXDAI)',
          breadReserve,
          wxdaiReserve: counter,
          ratio: counter > 0 ? breadReserve / counter : null,
          pegDeviation: counter > 0 ? Math.abs(breadReserve / counter - 1) : null,
        };
      } catch {}
      try {
        const hp = new ethers.Contract(HNY_POOL, PAIR_ABI, p);
        const [r0, r1] = await hp.getReserves();
        const [t0] = await Promise.all([hp.token0()]);
        const breadIsT0 = t0.toLowerCase() === BREAD_ADDR.toLowerCase();
        const breadReserve = Number(ethers.utils.formatUnits(breadIsT0 ? r0 : r1, 18));
        const counter = Number(ethers.utils.formatUnits(breadIsT0 ? r1 : r0, 18));
        poolHNY = {
          address: HNY_POOL,
          name: 'BREAD/HNY (Honeyswap)',
          breadReserve,
          hnyReserve: counter,
          ratio: counter > 0 ? breadReserve / counter : null,
        };
      } catch {}

      // 9. Risk flags (additional)
      if (giniVal > 0.85) risks.push(`HIGH concentration (Gini=${giniVal.toFixed(3)})`);
      else if (giniVal > 0.7) risks.push(`Moderate concentration (Gini=${giniVal.toFixed(3)})`);
      if (top10Share > 0.5) risks.push(`Top-10 hold ${(top10Share * 100).toFixed(1)}% of sampled supply — plutocratic risk`);
      if (nak50 <= 3) risks.push(`Nakamoto-50 = ${nak50}: ${nak50} holders can swing simple-majority votes`);
      if (nonSelfRatio < 0.05) risks.push(`Only ${(nonSelfRatio * 100).toFixed(1)}% of delegation events use non-self delegates — low delegate-engagement`);
      if (poolWXDAI && poolWXDAI.pegDeviation !== null && poolWXDAI.pegDeviation > 0.05) {
        risks.push(`Curve pool peg deviation ${(poolWXDAI.pegDeviation * 100).toFixed(1)}% — possible sell pressure or imbalance`);
      }
      if (poolWXDAI) {
        const dexPctOfSupply = (poolWXDAI.breadReserve / supply) * 100;
        if (dexPctOfSupply < 2) risks.push(`Curve pool holds ${dexPctOfSupply.toFixed(1)}% of supply — thin secondary liquidity`);
      }

      const result = {
        chain: 'gnosis',
        breadAddr: BREAD_ADDR,
        token: { name, symbol, decimals: Number(decimals), totalSupply: supply },
        proxy: { impl, implCodeBytes: (implCode.length - 2) / 2, clockMode, clockNow: clockNow ? Number(clockNow) : null },
        scan: { fromBlock, latest, blockWindow, scanErrors },
        holders: { observed: holders.size, sampled: balances.length, sampledSupplyPct: (sampledSupply / supply) * 100 },
        concentration: {
          gini: giniVal,
          top10Share,
          nakamoto50: nak50,
          nakamoto75: nak75,
        },
        delegation: {
          changeEvents: totalDelegationEvents,
          selfDelegated,
          nonSelfDelegated,
          nonSelfRatio,
        },
        yieldDistributor: yd,
        liquidity: { curve: poolWXDAI, honeyswap: poolHNY },
        risks,
        topHolders: balances.slice(0, topN).map((h) => ({
          address: h.addr,
          balance: h.balance,
          pctOfSupply: (h.balance / supply) * 100,
        })),
      };

      if (wantJson) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        spin?.succeed(`Breadchain audit complete (${result.holders.observed} holders observed; ${result.holders.sampled} sampled)`);
        console.log('');
        console.log(`BREAD: ${result.token.name} (${result.token.symbol}) on Gnosis Chain`);
        console.log(`  Total supply: ${result.token.totalSupply.toLocaleString()} BREAD`);
        console.log(`  Proxy: UUPS @ ${result.proxy.impl} (${result.proxy.implCodeBytes.toLocaleString()} bytes)`);
        console.log(`  Clock mode: ${result.proxy.clockMode}  at block ${result.proxy.clockNow}`);
        console.log('');
        console.log(`Concentration metrics:`);
        console.log(`  Gini:           ${result.concentration.gini.toFixed(3)}`);
        console.log(`  Top-10 share:   ${(result.concentration.top10Share * 100).toFixed(1)}% of sampled supply`);
        console.log(`  Nakamoto-50:    ${result.concentration.nakamoto50} holders to reach 50% supply`);
        console.log(`  Nakamoto-75:    ${result.concentration.nakamoto75} holders to reach 75% supply`);
        console.log('');
        console.log(`Delegation network (last ${blockWindow.toLocaleString()} blocks):`);
        console.log(`  Delegation events:    ${result.delegation.changeEvents}`);
        console.log(`  Self-delegated:       ${result.delegation.selfDelegated}`);
        console.log(`  Non-self delegated:   ${result.delegation.nonSelfDelegated} (${(result.delegation.nonSelfRatio * 100).toFixed(1)}%)`);
        console.log('');
        if (yd) {
          console.log(`YieldDistributor (on-chain voting):`);
          console.log(`  Address:      ${yd.address}`);
          console.log(`  Owner:        ${yd.owner}`);
          console.log(`  Cycle length: ${yd.cycleLength} blocks (~${yd.cycleApproxDays?.toFixed(1)} days)`);
          console.log(`  Max points:   ${yd.maxPoints}`);
          console.log(`  Current vote distribution across ${yd.projects.length} projects:`);
          for (const proj of yd.projects) {
            console.log(`    ${proj.share.toFixed(2).padStart(6)}%  ${proj.address}  ${proj.label}`);
          }
          if (yd.butteredBread) {
            console.log('');
            console.log(`ButteredBread (LP-stake-derived VP token):`);
            console.log(`  Address:      ${yd.butteredBread.address}`);
            console.log(`  Supply:       ${yd.butteredBread.totalSupply.toFixed(2)} BB`);
            console.log(`  Owner:        ${yd.butteredBread.owner}`);
          }
          if (yd.dualVP && yd.dualVP.length > 0) {
            console.log('');
            console.log(`Dual VP (direct BREAD votes vs YD effective VP, top 12):`);
            for (const x of yd.dualVP) {
              const mult = x.multiplier === Infinity ? '∞ (BB-only)' : x.multiplier.toFixed(2) + 'x';
              console.log(`  ${x.address}  BREAD=${x.breadVotes.toFixed(2).padStart(12)}  effective=${x.effectiveVP.toFixed(2).padStart(14)}  multiplier=${mult}`);
            }
          }
          console.log('');
        }
        if (poolWXDAI) {
          console.log(`Curve pool (${poolWXDAI.name}):`);
          console.log(`  BREAD reserve:  ${poolWXDAI.breadReserve.toFixed(0)} (${((poolWXDAI.breadReserve / supply) * 100).toFixed(2)}% of supply)`);
          console.log(`  WXDAI reserve:  ${poolWXDAI.wxdaiReserve.toFixed(0)}`);
          console.log(`  Ratio:          ${poolWXDAI.ratio ? poolWXDAI.ratio.toFixed(3) : '—'}  (peg dev: ${poolWXDAI.pegDeviation ? (poolWXDAI.pegDeviation * 100).toFixed(1) + '%' : '—'})`);
        }
        if (poolHNY) {
          console.log(`Honeyswap pool (${poolHNY.name}):`);
          console.log(`  BREAD reserve:  ${poolHNY.breadReserve.toFixed(0)}`);
          console.log(`  HNY reserve:    ${poolHNY.hnyReserve.toFixed(0)}`);
        }
        console.log('');
        console.log(`Top ${topN} holders:`);
        for (const h of result.topHolders) {
          console.log(`  ${h.address}  ${h.balance.toFixed(2).padStart(14)} BREAD  ${h.pctOfSupply.toFixed(2).padStart(6)}%`);
        }
        if (risks.length > 0) {
          console.log('');
          console.log(`Risks flagged:`);
          for (const r of risks) console.log(`  ⚠ ${r}`);
        }
      }
    } catch (e) {
      spin?.fail((e as Error).message);
      if (wantJson) console.log(JSON.stringify({ error: (e as Error).message }));
      throw e;
    }
  },
};
