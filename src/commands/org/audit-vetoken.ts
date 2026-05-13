/**
 * pop org audit-vetoken — on-chain veToken top-holder probe.
 *
 * Task #383 (HB#442). Closes the methodology gap surfaced in HB#441 when
 * reading argus_prime's Curve DAO audit (task #380, docs/audits/curve-dao.md):
 *
 * The Capture Cluster v1.2 identifies that our Snapshot-based top-voter-share
 * numbers for veToken protocols (Curve, Balancer, Frax, Convex, Beethoven X,
 * Kwenta, likely Prisma / 1inch) are measuring off-chain signaling votes, NOT
 * the binding on-chain veCRV-weighted decisions. The real voter population
 * lives in the VotingEscrow contract: holders hold time-locked positions
 * whose balanceOf() returns a linearly-decaying current voting power. This
 * command reads those balances directly.
 *
 * MVP scope:
 *   - Takes a VotingEscrow address + a list of candidate holder addresses
 *   - Reads balanceOf(holder) for each + totalSupply() for the denominator
 *   - Reports top-N ranked by current veBalance + share-of-supply percentages
 *   - --json output mirrors the AUDIT_DB row shape for downstream consumption
 *
 * Explicitly NOT in this MVP:
 *   - Event-based enumeration of ALL historical holders (paginated getLogs)
 *     — out of scope for the 3h task, flagged as a follow-up. The operator
 *     provides the candidate list for now. Fetching top holders from a block
 *     explorer or the-graph is a separate enhancement.
 *   - GaugeController gauge-weight vote enumeration — this is just the
 *     balance read, not the vote direction. Richer per-proposal data is a
 *     separate follow-up task.
 *   - All-chain support beyond Ethereum mainnet. Curve + Balancer + Frax
 *     all run their VotingEscrow on mainnet, so this is sufficient for the
 *     cluster entries; L2 veToken forks would need their own --chain flag.
 *
 * Usage:
 *
 *   pop org audit-vetoken \
 *     --escrow 0x5f3b5DfEb7B28CDbD7FAba78963EE202a494e2A2 \
 *     --holders 0x989a...,0x7a16...,0xe3c4... \
 *     [--top 10] [--chain 1] [--json]
 *
 * Dogfood against Curve VotingEscrow (mainnet addresses from
 * docs/audits/curve-dao.md) is the acceptance test.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { resolveNetworkConfig, getNetworkByChainId } from '../../config/networks';
import * as output from '../../lib/output';

// Minimal view-surface ABI for any veCRV-family VotingEscrow. Contract uses
// Vyper's `public(HashMap[address, ...])` to expose these as implicit getters.
// Curve's VotingEscrow ships these; Balancer's veBAL, Frax's veFXS, and
// Convex's vlCVX all follow the same interface.
const VE_VIEW_ABI = [
  'function balanceOf(address addr) view returns (uint256)',
  'function supportsInterface(bytes4) view returns (bool)',
  'function balanceOfNFT(uint256 tokenId) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function totalSupplyAt(uint256 block) view returns (uint256)',
  'function locked__end(address addr) view returns (uint256)',
  'function token() view returns (address)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  // HB#448 task #386: Deposit event for --enumerate mode candidate discovery.
  // Signature matches the Curve VotingEscrow reference impl; Balancer veBAL,
  // Frax veFXS, and related forks use the same signature.
  'event Deposit(address indexed provider, uint256 value, uint256 indexed locktime, int128 type, uint256 ts)',
  // HB#252 task #418: ERC-721 Transfer event for Solidly veNFT enumeration.
  // When --enumerate finds 0 Deposit events (Solidly contracts use a different
  // Deposit signature), falls back to scanning Transfer(from=0x0) mint events
  // on the VE contract itself. Every createLock mints an NFT position.
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
];

// Default enumeration window: last 50,000 blocks (~7 days on Ethereum mainnet
// at 12s block time, or ~23 hours on Gnosis at 5s). Conservative enough to
// be a cheap first call but wide enough to find active depositors.
const DEFAULT_ENUMERATE_LOOKBACK_BLOCKS = 50_000;
// Per-chunk getLogs range. Most RPCs cap at 10k; setting lower is safer.
const DEFAULT_ENUMERATE_CHUNK_BLOCKS = 10_000;

interface AuditVetokenArgs {
  escrow: string;
  holders?: string;
  'known-actors-seed'?: string;
  enumerate?: boolean;
  'enumerate-transfers'?: boolean;
  'multi-window'?: string;
  'verify-top-holder'?: boolean;
  underlying?: string;
  'from-block'?: number;
  'to-block'?: number;
  chunk?: number;
  top?: number;
  chain?: number;
  rpc?: string;
  json?: boolean;
}

/**
 * HB#470: `--verify-top-holder` implementation.
 *
 * The HB#463 cascade-fingerprinting-method.md document and the HB#460+#461
 * worked examples established a reliable labeling technique for the
 * Convex/Aura VoterProxy contract class: call `operator()` and `escrow()`,
 * cross-check returns against a public-manifest map of known Booster
 * addresses.
 *
 * This function automates it. For a top-holder address, try calling the
 * VoterProxy-shaped getters with a minimal inline ABI. If operator()
 * returns a known-public Booster address AND escrow() returns the same
 * address we were probing, we have a positive ID. Otherwise return null
 * and let the caller decide what to do with the unknown contract.
 *
 * Manifest built from HB#460 (Convex) and HB#461 (Aura) verified probes.
 * Adding new VoterProxy-family aggregators is a one-line append to this
 * map.
 */
const VOTER_PROXY_MANIFEST: Record<string, string> = {
  // Convex Finance Booster (mainnet) — verified HB#460 via the
  // 0x989AEb4d CurveVoterProxy operator() return
  '0xf403c135812408bfbe8713b5a23a04b3d48aae31': 'Convex',
  // Aura Finance Booster (mainnet) — verified HB#461 via the
  // 0xaf52695e BalancerVoterProxy operator() return
  '0xa57b8d98dae62b26ec3bcc4a365338157060b234': 'Aura',
};

const VOTER_PROXY_ABI = [
  'function operator() view returns (address)',
  'function escrow() view returns (address)',
];

async function verifyTopHolder(
  holderAddr: string,
  escrowAddr: string,
  provider: ethers.providers.Provider,
): Promise<string | null> {
  try {
    const c = new ethers.Contract(holderAddr, VOTER_PROXY_ABI, provider);
    const [operator, escrow] = await Promise.all([
      c.operator().catch(() => null),
      c.escrow().catch(() => null),
    ]);
    if (!operator || !escrow) return null;
    const escrowMatches = String(escrow).toLowerCase() === escrowAddr.toLowerCase();
    if (!escrowMatches) return null;
    const aggregator = VOTER_PROXY_MANIFEST[String(operator).toLowerCase()];
    if (!aggregator) {
      // operator() returns something, but it's not in our manifest. Still a
      // useful partial signal — it's a VoterProxy-shaped contract with a
      // matching escrow but an unknown aggregator.
      return `VoterProxy (unknown aggregator: operator=${operator})`;
    }
    return `${aggregator} VoterProxy (verified via operator=${operator}, escrow=${escrow})`;
  } catch {
    return null;
  }
}

/**
 * HB#448 task #386: enumerate candidate holders via Deposit-event scan.
 * Paginates getLogs in chunks of `chunk` blocks from `fromBlock` to `toBlock`,
 * decodes the Deposit event topic[1] as `provider`, and returns a deduped set
 * of addresses. Typed as a generic helper so future veToken contracts with
 * alternate event signatures can plug in their own topic decoder without
 * rewriting the pagination scaffold.
 */
async function enumerateDepositors(
  contract: ethers.Contract,
  provider: ethers.providers.Provider,
  fromBlock: number,
  toBlock: number,
  chunk: number,
): Promise<{ holders: string[]; windowFrom: number; windowTo: number; chunksScanned: number }> {
  const depositFilter = contract.filters.Deposit();
  const seen = new Set<string>();
  let chunksScanned = 0;

  for (let start = fromBlock; start <= toBlock; start += chunk) {
    const end = Math.min(start + chunk - 1, toBlock);
    try {
      const logs = await contract.queryFilter(depositFilter, start, end);
      chunksScanned++;
      for (const log of logs) {
        const providerAddr = (log.args as any)?.provider;
        if (providerAddr) {
          seen.add(String(providerAddr).toLowerCase());
        }
      }
    } catch (err: any) {
      // Transient RPC errors: chunk too large, rate limit, timeout. Log via
      // debug path (stderr would disrupt JSON output); just skip the chunk.
      // Aggregate enumeration is best-effort.
      void err;
    }
  }

  // HB#252 task #418: if Deposit events returned 0 holders, fall back to
  // ERC-721 Transfer-from-zero (mint) events. Solidly veNFT contracts
  // (Velodrome, Aerodrome) emit Transfer on createLock but use a different
  // Deposit signature than Curve-family contracts.
  if (seen.size === 0) {
    const zeroAddr = '0x0000000000000000000000000000000000000000';
    const mintFilter = contract.filters.Transfer(zeroAddr);
    for (let start = fromBlock; start <= toBlock; start += chunk) {
      const end = Math.min(start + chunk - 1, toBlock);
      try {
        const logs = await contract.queryFilter(mintFilter, start, end);
        chunksScanned++;
        for (const log of logs) {
          const to = (log.args as any)?.to;
          if (to) {
            seen.add(String(to).toLowerCase());
          }
        }
      } catch {
        void 0; // same best-effort pattern as Deposit scan
      }
    }
  }

  return {
    holders: Array.from(seen),
    windowFrom: fromBlock,
    windowTo: toBlock,
    chunksScanned,
  };
}

/**
 * HB#731 task #557 (v0.2 NFT-mode Transfer scan): build tokenId → current-owner
 * mapping by scanning the veNFT contract's own Transfer(from, to, tokenId)
 * events. Used when ERC721Enumerable is not implemented (Velodrome veNFT case).
 * The latest Transfer for each tokenId wins (transfers are linear). Returns a
 * Map<owner-lowercase, tokenId-string[]> so per-address ve-power can be summed
 * via balanceOfNFT(tokenId) without an O(N²) per-owner scan.
 *
 * Cost note: veNFT contracts have far fewer Transfer events than ERC20 tokens
 * (one mint per lock + occasional transfers), so this scan is cheap relative
 * to enumerateHoldersViaUnderlyingTransfers.
 */
async function scanNftTokenOwnersViaTransfers(
  contract: ethers.Contract,
  fromBlock: number,
  toBlock: number,
  chunk: number,
): Promise<{ ownerToTokenIds: Map<string, string[]>; tokensSeen: number; chunksScanned: number }> {
  const tokenIdToOwner = new Map<string, string>();
  let chunksScanned = 0;

  for (let start = fromBlock; start <= toBlock; start += chunk) {
    const end = Math.min(start + chunk - 1, toBlock);
    try {
      const logs = await contract.queryFilter(contract.filters.Transfer(), start, end);
      chunksScanned++;
      for (const log of logs) {
        const to = (log.args as any)?.to;
        const tokenId = (log.args as any)?.tokenId;
        if (to && tokenId !== undefined && tokenId !== null) {
          const tokenIdStr = tokenId.toString();
          const toAddr = String(to).toLowerCase();
          // Latest Transfer for this tokenId wins (chronological event order
          // within and across chunks is preserved by getLogs).
          tokenIdToOwner.set(tokenIdStr, toAddr);
        }
      }
    } catch {
      // Best-effort: skip transient chunk failures (rate limit, timeout).
      void 0;
    }
  }

  // Invert into owner → tokenIds[] for efficient per-address lookup.
  const zeroAddr = '0x0000000000000000000000000000000000000000';
  const ownerToTokenIds = new Map<string, string[]>();
  for (const [tokenId, owner] of tokenIdToOwner.entries()) {
    if (owner === zeroAddr) continue; // burned
    const arr = ownerToTokenIds.get(owner) ?? [];
    arr.push(tokenId);
    ownerToTokenIds.set(owner, arr);
  }

  return { ownerToTokenIds, tokensSeen: tokenIdToOwner.size, chunksScanned };
}

/**
 * HB#456 task #389: enumerate candidate holders via the underlying ERC20's
 * Transfer events filtered to (to == locker address).
 *
 * This path is CONTRACT-AGNOSTIC. The Deposit-event enumeration in
 * enumerateDepositors() depends on the locker contract emitting a Deposit
 * event with an indexed `provider` topic — the veCRV pattern. That works for
 * Curve + Balancer + Frax because they're all veCRV-family forks, BUT it
 * fails for:
 *   - CvxLockerV2 (Convex vlCVX) which emits `Staked` events, not Deposit
 *   - Dormant-holder protocols where the top holders deposited years ago
 *     and don't show up in a recent Deposit-event window
 *
 * The Transfer-events fallback fixes both cases: every ERC20 token emits
 * standard Transfer(from, to, amount) events, regardless of the locker's
 * own event signatures, and historical transfers into the locker include
 * every lock in history (within the block window scanned).
 *
 * We filter by topic[2] == padded locker address, collecting topic[1]
 * (the `from` address) as a candidate historical depositor.
 *
 * Cost note: underlying tokens like CRV, BAL, FXS emit MANY more Transfer
 * events than the locker's own Deposit events (every ordinary transfer
 * between users + swap + LP action). So this path is more RPC-expensive
 * per block than the Deposit-event path, and operators should use narrower
 * windows when invoking it.
 */
async function enumerateHoldersViaUnderlyingTransfers(
  underlyingAddr: string,
  escrowAddr: string,
  provider: ethers.providers.Provider,
  fromBlock: number,
  toBlock: number,
  chunk: number,
): Promise<{ holders: string[]; windowFrom: number; windowTo: number; chunksScanned: number }> {
  const erc20Iface = new ethers.utils.Interface([
    'event Transfer(address indexed from, address indexed to, uint256 value)',
  ]);
  const transferTopic = erc20Iface.getEventTopic('Transfer');
  const paddedEscrowTopic = ethers.utils.hexZeroPad(escrowAddr.toLowerCase(), 32);

  const seen = new Set<string>();
  let chunksScanned = 0;

  for (let start = fromBlock; start <= toBlock; start += chunk) {
    const end = Math.min(start + chunk - 1, toBlock);
    try {
      const logs = await provider.getLogs({
        address: underlyingAddr,
        topics: [transferTopic, null, paddedEscrowTopic],
        fromBlock: start,
        toBlock: end,
      });
      chunksScanned++;
      for (const log of logs) {
        // topic[1] is the `from` address padded to bytes32. Slice the last
        // 20 bytes and hexlify.
        if (log.topics.length >= 3) {
          const fromTopicHex = log.topics[1];
          // Last 40 hex chars (20 bytes) = address
          const fromAddr = '0x' + fromTopicHex.slice(-40);
          if (ethers.utils.isAddress(fromAddr)) {
            seen.add(fromAddr.toLowerCase());
          }
        }
      }
    } catch (err: any) {
      // Same best-effort skip policy as the Deposit-event path
      void err;
    }
  }

  return {
    holders: Array.from(seen),
    windowFrom: fromBlock,
    windowTo: toBlock,
    chunksScanned,
  };
}

interface HolderRow {
  address: string;
  veBalance: string;
  veBalanceNum: number;
  sharePct: string;
  sharePctNum: number;
  lockEnd?: number | null;
  lockEndIso?: string | null;
}

export const auditVetokenHandler = {
  builder: (yargs: Argv) => yargs
    .option('escrow', {
      type: 'string',
      describe: 'VotingEscrow contract address (veCRV, veBAL, veFXS, …)',
      demandOption: true,
    })
    .option('holders', {
      type: 'string',
      describe:
        'Comma-separated list of candidate holder addresses to rank. ' +
        'Optional when --enumerate is passed. The two modes can be combined ' +
        '— enumerated addresses are union-ed with the explicit list.',
    })
    .option('known-actors-seed', {
      type: 'string',
      describe:
        'Task #545 (HB#1051): path to a newline-delimited file of known actor ' +
        'addresses. Merged into the holder candidate list before ranking. ' +
        '"#" comments and blank lines skipped. Closes the window-bias trap ' +
        'from HB#1047/#1049 (e.g. Convex VoterProxy missing from veCRV ' +
        '--enumerate-transfers in a 50K block window because their lock ' +
        'predates the scan). COMPOSITION (HB#1053): pair with --multi-window ' +
        'for full coverage — multi-window finds UNKNOWN dormant lockers; ' +
        'known-actors-seed verifies KNOWN whales rank correctly. Both ' +
        'compose without conflict.',
    })
    .option('multi-window', {
      type: 'string',
      describe:
        'Task #545 (HB#1051): run enumeration across N windows and union ' +
        'results. Accepts either an integer (auto-split into N equal-size ' +
        'windows between --from-block and --to-block) OR a comma-separated ' +
        '"from-to" pair list (e.g. "20000000-20500000,21000000-21500000"). ' +
        'Composes with both --enumerate and --enumerate-transfers. ' +
        'IMPORTANT (HB#1053 methodology refinement): pair with WIDE ' +
        '--from-block/--to-block range covering the target locker\'s ' +
        'deposit period (e.g. --from-block 18000000 for Ethereum-mainnet ' +
        've-tokens with 2021+ deposits). Default-window 3-split produces ' +
        'sparse results; 1M+ blocks across 3-6 windows is the empirical ' +
        'sweet spot for catching dormant whales like the 117M veCRV holder ' +
        '(HB#1052) or humpy.eth on veBAL (HB#1047).',
    })
    .option('enumerate', {
      type: 'boolean',
      default: false,
      describe:
        'Scan recent Deposit events to discover candidate holders. Defaults ' +
        'to the last 50,000 blocks (~7 days on Ethereum). Override with ' +
        '--from-block / --to-block / --chunk.',
    })
    .option('enumerate-transfers', {
      type: 'boolean',
      default: false,
      describe:
        'Task #389 (HB#456): contract-agnostic holder discovery via the ' +
        'underlying ERC20\'s Transfer(from, to) events filtered to (to == ' +
        'escrow). Catches dormant lockers and works for non-veCRV-family ' +
        'contracts (CvxLockerV2, Convex, etc.). More RPC-expensive per ' +
        'block than --enumerate, so use narrower --from-block windows.',
    })
    .option('underlying', {
      type: 'string',
      describe:
        'Override the underlying ERC20 token address for --enumerate-transfers. ' +
        'If omitted, reads VotingEscrow.token() to get it automatically.',
    })
    .option('from-block', {
      type: 'number',
      describe:
        'Enumeration lower bound (inclusive). Default: latest - 50000.',
    })
    .option('to-block', {
      type: 'number',
      describe: 'Enumeration upper bound (inclusive). Default: latest block.',
    })
    .option('chunk', {
      type: 'number',
      default: DEFAULT_ENUMERATE_CHUNK_BLOCKS,
      describe:
        'getLogs pagination chunk size in blocks. Default 10000 (most RPCs cap here).',
    })
    .option('top', {
      type: 'number',
      describe: 'Limit output to the top N holders by current veBalance',
      default: 10,
    })
    .option('nft-mode', {
      type: 'boolean',
      default: false,
      describe:
        'Task #556 (HB#716): force NFT-locked ve-token mode (veVELO/veAERO/veRAM/veCHR class). Auto-detected via supportsInterface(0x80ac58cd) when omitted. NFT-mode enumerates owner tokenIds via tokenOfOwnerByIndex + sums balanceOfNFT per tokenId for true per-owner ve-power.',
    })
    .option('nft-scan-transfers', {
      type: 'boolean',
      default: false,
      describe:
        'Task #557 (HB#731) v0.2: in nft-mode, when ERC721Enumerable not supported (e.g. Velodrome veNFT), scan Transfer(from,to,tokenId) events between --from-block/--to-block to build tokenId→current-owner mapping + sum balanceOfNFT for true ve-power. Without this flag, the v0.1 fallback ranks by NFT-count only (which understates power for users with old high-value locks).',
    })
    .option('validate-coverage', {
      type: 'number',
      describe:
        'Task #548 (HB#699): WARN when top-N aggregate share < threshold percent. Default 30. Closes the window-bias trap (HB#1049 Convex/veCRV, HB#693 Aura/veBAL, HB#696 c2tp.eth/vlCVX all missed without --known-actors-seed). Pair with --strict-coverage to exit non-zero on low coverage.',
    })
    .option('strict-coverage', {
      type: 'boolean',
      default: false,
      describe:
        'Task #548 (HB#699): exit non-zero when --validate-coverage threshold not met. CI-friendly.',
    })
    .option('chain', { type: 'number', describe: 'Chain ID (default: Ethereum mainnet)', default: 1 })
    .option('rpc', { type: 'string', describe: 'RPC URL override' }),

  handler: async (argv: ArgumentsCamelCase<AuditVetokenArgs>) => {
    const spin = output.spinner('Probing VotingEscrow balances...');
    spin.start();

    try {
      // HB#445 UX fix: ethers.utils.isAddress rejects mixed-case-wrong-checksum
      // addresses. Operators frequently paste from explorers with inconsistent
      // case. Normalize to lowercase before validation, which isAddress accepts
      // as canonical EIP-55-lowercase-form.
      const escrow = argv.escrow.trim().toLowerCase();
      if (!ethers.utils.isAddress(escrow)) {
        spin.stop();
        output.error(`Invalid escrow address: ${escrow}`);
        process.exit(1);
        return;
      }

      const explicitHolders = argv.holders
        ? argv.holders
            .split(',')
            .map(a => a.trim().toLowerCase())
            .filter(a => a.length > 0)
        : [];

      // Task #545: merge --known-actors-seed file contents into the holder list.
      // One address per line; '#' comments and blank lines skipped. Composes
      // with --holders (union, lowercase-deduped) — surfaces dormant whales
      // that the enumerate window-scan would miss (HB#1047/#1049 window-bias
      // empirical finding: even Convex 53% veCRV holder was invisible from a
      // 50K-block --enumerate-transfers scan because their lock predates it).
      if (argv['known-actors-seed']) {
        const fs = require('fs');
        const path = argv['known-actors-seed'] as string;
        if (!fs.existsSync(path)) {
          spin.stop();
          output.error(`--known-actors-seed file not found: ${path}`);
          process.exit(1);
          return;
        }
        const seedAddrs = fs
          .readFileSync(path, 'utf8')
          .split('\n')
          .map((l: string) => l.replace(/#.*$/, '').trim().toLowerCase())
          .filter((l: string) => l.length > 0);
        explicitHolders.push(...seedAddrs);
      }

      for (const h of explicitHolders) {
        if (!ethers.utils.isAddress(h)) {
          spin.stop();
          output.error(`Invalid holder address: ${h}`);
          process.exit(1);
          return;
        }
      }

      // Chain-aware chunk size: L2 RPCs have stricter getLogs limits
      const chainNetwork = argv.chain ? getNetworkByChainId(argv.chain) : null;
      const chainDefaultChunk = chainNetwork?.defaultLogsChunkBlocks ?? DEFAULT_ENUMERATE_CHUNK_BLOCKS;

      const anyEnumerate = argv.enumerate || argv['enumerate-transfers'];
      if (!anyEnumerate && explicitHolders.length === 0) {
        spin.stop();
        output.error(
          'Provide --holders <comma-list> OR pass --enumerate (Deposit events) OR --enumerate-transfers (underlying ERC20 Transfer events)',
        );
        process.exit(1);
        return;
      }

      const networkConfig = resolveNetworkConfig(argv.chain ?? 1);
      const rpc = argv.rpc || networkConfig.resolvedRpc;
      const provider = new ethers.providers.JsonRpcProvider(rpc, networkConfig.chainId);

      const ve = new ethers.Contract(escrow, VE_VIEW_ABI, provider);

      // Read metadata UP FRONT so --enumerate-transfers can use veTokenAddr
      // as the default underlying token address. Older MVP read this later;
      // hoisted to support the Transfer-events path at HB#456 task #389.
      let veName = 'unknown';
      let veSymbol = 'unknown';
      let veTokenAddr = '0x0';
      try {
        [veName, veSymbol, veTokenAddr] = await Promise.all([
          ve.name(),
          ve.symbol(),
          ve.token(),
        ]);
      } catch {
        // Vyper public getters sometimes mis-ABI; don't fail the whole audit
        // if metadata reads fail — just label unknown and continue.
      }

      // HB#448 task #386 + HB#456 task #389: enumerate candidate holders
      // BEFORE the balanceOf loop so the top-N ranking can include them.
      // Two modes:
      //   - --enumerate          scan VotingEscrow's own Deposit events
      //   - --enumerate-transfers  scan underlying ERC20 Transfer events
      //                            filtered to (to == escrow). Contract-
      //                            agnostic, catches dormant lockers.
      //
      // Task #545 (HB#1051): --multi-window mode runs the same scan against
      // N windows + unions results, closing the window-bias trap from HB#1047
      // empirically validated HB#1049 (Convex VoterProxy missing from a 50K-
      // block veCRV scan because their lock predates it).
      let enumerationMeta: { windowFrom: number; windowTo: number; chunksScanned: number; enumerated: number; method: string; windowsScanned?: number } | null = null;
      let discoveredHolders: string[] = [];

      // Parse --multi-window into a list of {from, to} pairs.
      // Accepts:
      //   - integer N → split (latest - DEFAULT_LOOKBACK*4) to latest into N windows
      //   - "from1-to1,from2-to2,..." → explicit window list
      const multiWindowRanges: Array<{ from: number; to: number }> = [];
      if (argv['multi-window']) {
        const latestBlock = await provider.getBlockNumber();
        const raw = (argv['multi-window'] as string).trim();
        const intMatch = raw.match(/^\d+$/);
        if (intMatch) {
          const n = Math.max(1, Math.min(24, parseInt(raw, 10)));
          // Default span: 4× the single-window lookback (~ 200K blocks ≈ 28 days)
          // Override via --from-block to anchor the span start; --to-block for end.
          const spanEnd = argv['to-block'] ?? latestBlock;
          const spanStart = argv['from-block'] ?? Math.max(0, spanEnd - DEFAULT_ENUMERATE_LOOKBACK_BLOCKS * 4);
          const step = Math.floor((spanEnd - spanStart) / n);
          for (let i = 0; i < n; i++) {
            multiWindowRanges.push({
              from: spanStart + i * step,
              to: i === n - 1 ? spanEnd : spanStart + (i + 1) * step - 1,
            });
          }
        } else {
          for (const pair of raw.split(',')) {
            const [a, b] = pair.split('-').map(s => parseInt(s.trim(), 10));
            if (isNaN(a) || isNaN(b) || a >= b) {
              spin.stop();
              output.error(`Invalid --multi-window pair "${pair}". Expected "from-to" with from<to.`);
              process.exit(1);
              return;
            }
            multiWindowRanges.push({ from: a, to: b });
          }
        }
      }

      if (argv.enumerate) {
        const latestBlock = await provider.getBlockNumber();
        const chunk = argv.chunk ?? chainDefaultChunk;

        // If --multi-window passed, iterate; else single-window legacy behavior.
        const windows = multiWindowRanges.length > 0
          ? multiWindowRanges
          : [{
              from: argv['from-block'] ?? Math.max(0, latestBlock - DEFAULT_ENUMERATE_LOOKBACK_BLOCKS),
              to: argv['to-block'] ?? latestBlock,
            }];

        let chunksAcc = 0;
        for (const w of windows) {
          spin.stop();
          output.info(
            `  Enumerating Deposit events ${w.from}..${w.to} (${chunk}-block chunks)${windows.length > 1 ? ` [window ${windows.indexOf(w) + 1}/${windows.length}]` : ''}...`,
          );
          spin.start();
          const enumResult = await enumerateDepositors(ve, provider, w.from, w.to, chunk);
          discoveredHolders = [...discoveredHolders, ...enumResult.holders];
          chunksAcc += enumResult.chunksScanned;
        }

        enumerationMeta = {
          windowFrom: windows[0].from,
          windowTo: windows[windows.length - 1].to,
          chunksScanned: chunksAcc,
          enumerated: discoveredHolders.length,
          method: windows.length > 1 ? `multi-window:deposit-events(x${windows.length})` : 'deposit-events',
          windowsScanned: windows.length,
        };
      }

      if (argv['enumerate-transfers']) {
        const latestBlock = await provider.getBlockNumber();
        const chunk = argv.chunk ?? chainDefaultChunk;

        let underlyingAddr = argv.underlying?.trim().toLowerCase() || veTokenAddr;
        if (!underlyingAddr || underlyingAddr === '0x0' || underlyingAddr === '0x0000000000000000000000000000000000000000') {
          spin.stop();
          output.error(
            '--enumerate-transfers requires --underlying <ERC20 address> when the escrow\'s token() getter returns 0x0. Pass the CVX/CRV/BAL/FXS address explicitly.',
          );
          process.exit(1);
          return;
        }

        // Task #545 (HB#1051): multi-window support for the Transfer-events path too.
        const windows = multiWindowRanges.length > 0
          ? multiWindowRanges
          : [{
              from: argv['from-block'] ?? Math.max(0, latestBlock - DEFAULT_ENUMERATE_LOOKBACK_BLOCKS),
              to: argv['to-block'] ?? latestBlock,
            }];

        let chunksAcc = 0;
        let foundAcc = 0;
        for (const w of windows) {
          spin.stop();
          output.info(
            `  Enumerating underlying Transfer events to ${escrow} ${w.from}..${w.to} (${chunk}-block chunks, underlying=${underlyingAddr})${windows.length > 1 ? ` [window ${windows.indexOf(w) + 1}/${windows.length}]` : ''}...`,
          );
          spin.start();
          const enumResult = await enumerateHoldersViaUnderlyingTransfers(
            underlyingAddr, escrow, provider, w.from, w.to, chunk,
          );
          discoveredHolders = [...discoveredHolders, ...enumResult.holders];
          chunksAcc += enumResult.chunksScanned;
          foundAcc += enumResult.holders.length;
        }

        if (!enumerationMeta) {
          enumerationMeta = {
            windowFrom: windows[0].from,
            windowTo: windows[windows.length - 1].to,
            chunksScanned: chunksAcc,
            enumerated: foundAcc,
            method: windows.length > 1 ? `multi-window:underlying-transfers(x${windows.length})` : 'underlying-transfers',
            windowsScanned: windows.length,
          };
        } else {
          enumerationMeta.enumerated += foundAcc;
          enumerationMeta.chunksScanned += chunksAcc;
          enumerationMeta.method = windows.length > 1
            ? `multi-window:union(deposit-events+underlying-transfers,x${windows.length})`
            : 'union(deposit-events,underlying-transfers)';
        }
      }

      // Union the explicit list and the discovered list, deduping case-
      // insensitively.
      const holderAddrs = Array.from(
        new Set([...explicitHolders, ...discoveredHolders].map(a => a.toLowerCase())),
      );

      if (holderAddrs.length === 0) {
        spin.stop();
        output.error(
          `No candidate holders found. ${argv.enumerate ? 'Enumeration returned 0 addresses — try widening --from-block or verifying the VotingEscrow address has Deposit activity in the window.' : ''}`,
        );
        process.exit(1);
        return;
      }

      const totalSupplyBn = await ve.totalSupply();
      const totalSupplyNum = Number(ethers.utils.formatUnits(totalSupplyBn, 18));

      // Task #556 (HB#716): detect ERC-721 NFT-locked ve-tokens (veVELO/veAERO/veRAM class).
      // Velodrome v2 + family use ERC-721 where each lock is a tokenId; ve-power
      // is balanceOfNFT(tokenId) not balanceOf(address). Auto-detect via supportsInterface.
      let nftMode = Boolean((argv as any).nftMode);
      if (!nftMode) {
        try {
          const isERC721 = await (ve as any).supportsInterface('0x80ac58cd');
          if (isERC721) {
            nftMode = true;
            output.info(
              `  ℹ️  ERC-721 detected via supportsInterface — auto-enabling --nft-mode (veNFT class: Velodrome / Aerodrome / Ramses / Chronos family).`,
            );
          }
        } catch {
          // Not an ERC-721; proceed with default ERC20 path
        }
      }

      // HB#731 task #557 v0.2: build owner→tokenIds map ONCE via Transfer-event
      // scan when caller passed --nft-scan-transfers. Used as the v0.2 fallback
      // when ERC721Enumerable isn't supported (Velodrome veNFT case).
      let nftOwnerMap: Map<string, string[]> | null = null;
      let nftScanMeta: { tokensSeen: number; chunksScanned: number; windowFrom: number; windowTo: number } | null = null;
      if (nftMode && (argv as any).nftScanTransfers) {
        const latestBlock = await provider.getBlockNumber();
        const chunkV = argv.chunk ?? chainDefaultChunk;
        const fromB = argv['from-block'] ?? Math.max(0, latestBlock - DEFAULT_ENUMERATE_LOOKBACK_BLOCKS);
        const toB = argv['to-block'] ?? latestBlock;
        spin.stop();
        output.info(
          `  Scanning veNFT Transfer events ${fromB}..${toB} (${chunkV}-block chunks) for tokenId→owner map...`,
        );
        spin.start();
        const scanResult = await scanNftTokenOwnersViaTransfers(ve, fromB, toB, chunkV);
        nftOwnerMap = scanResult.ownerToTokenIds;
        nftScanMeta = {
          tokensSeen: scanResult.tokensSeen,
          chunksScanned: scanResult.chunksScanned,
          windowFrom: fromB,
          windowTo: toB,
        };
      }

      const rows: HolderRow[] = await Promise.all(
        holderAddrs.map(async (addr) => {
          const lockEnd = await (ve as any).locked__end(addr).catch(() => null);
          let balNum: number;

          if (nftMode) {
            // NFT-mode: try ERC721Enumerable path first (tokenOfOwnerByIndex);
            // HB#731 v0.2: when --nft-scan-transfers provided, use pre-built
            // owner→tokenIds map from Transfer-event scan (Velodrome veNFT case
            // where Enumerable isn't implemented). Else fallback to NFT count.
            try {
              const nftCount = await ve.balanceOf(addr);
              const count = Number(nftCount.toString());
              let totalVePower = 0;
              let enumerableOk = true;
              for (let i = 0; i < count; i++) {
                try {
                  const tokenId = await (ve as any).tokenOfOwnerByIndex(addr, i);
                  const power = await (ve as any).balanceOfNFT(tokenId);
                  totalVePower += Number(ethers.utils.formatUnits(power, 18));
                } catch {
                  enumerableOk = false;
                  break;
                }
              }
              if (!enumerableOk && nftOwnerMap) {
                // v0.2 path: scan-derived tokenId list for this owner
                const tokenIds = nftOwnerMap.get(addr.toLowerCase()) ?? [];
                let vePower = 0;
                for (const tid of tokenIds) {
                  try {
                    const power = await (ve as any).balanceOfNFT(tid);
                    vePower += Number(ethers.utils.formatUnits(power, 18));
                  } catch {
                    // Token may have been burned mid-scan; skip
                  }
                }
                balNum = vePower;
              } else if (!enumerableOk) {
                // v0.1 fallback: NFT-count ranking (understates power when
                // some owners hold older high-value locks).
                balNum = count;
              } else {
                balNum = totalVePower;
              }
            } catch {
              balNum = 0;
            }
          } else {
            // ERC20-mode (default): balanceOf returns ve-power directly
            const balBn = await ve.balanceOf(addr).catch(() => ethers.BigNumber.from(0));
            balNum = Number(ethers.utils.formatUnits(balBn, 18));
          }

          const sharePctNum = totalSupplyNum > 0 ? (balNum / totalSupplyNum) * 100 : 0;
          const lockEndNum = lockEnd ? Number(lockEnd.toString()) : null;
          return {
            address: addr,
            veBalance: balNum.toFixed(4),
            veBalanceNum: balNum,
            sharePct: sharePctNum.toFixed(2) + '%',
            sharePctNum,
            lockEnd: lockEndNum,
            lockEndIso: lockEndNum && lockEndNum > 0 ? new Date(lockEndNum * 1000).toISOString() : null,
          };
        }),
      );

      rows.sort((a, b) => b.veBalanceNum - a.veBalanceNum);

      const topN = rows.slice(0, argv.top ?? 10);
      const topShareAggregate = topN.reduce((a, r) => a + r.sharePctNum, 0);

      // Task #548 (HB#699): coverage validation. Warn when top-N aggregate
      // share is below threshold — strong signal that a high-concentration
      // holder is missing from the scan window (Convex/Aura/c2tp.eth pattern).
      const coverageThreshold = (argv as any).validateCoverage as number | undefined;
      const strictCoverage = Boolean((argv as any).strictCoverage);
      let lowCoverage = false;
      if (typeof coverageThreshold === 'number' && coverageThreshold > 0) {
        if (topShareAggregate < coverageThreshold) {
          lowCoverage = true;
          const msg =
            `Low coverage detected: top-${topN.length} aggregate share ${topShareAggregate.toFixed(2)}% < threshold ${coverageThreshold}%. ` +
            `Consider adding --known-actors-seed for high-concentration contracts. ` +
            `Window-bias examples: HB#1049 Convex/veCRV, HB#693 Aura/veBAL, HB#696 c2tp.eth/vlCVX all missed without explicit seed.`;
          if (!(argv.json || output.isJsonMode())) {
            output.warn(msg);
          }
        }
      }

      spin.stop();

      if (argv.json || output.isJsonMode()) {
        const artifact = {
          contract: escrow,
          chain: argv.chain ?? 1,
          escrowName: veName,
          escrowSymbol: veSymbol,
          underlyingToken: veTokenAddr,
          totalSupply: totalSupplyBn.toString(),
          totalSupplyHuman: totalSupplyNum.toFixed(4),
          probedHolderCount: holderAddrs.length,
          explicitHolderCount: explicitHolders.length,
          enumerationWindow: enumerationMeta,
          nftScan: nftScanMeta,
          topHolders: topN,
          topNAggregateSharePct: topShareAggregate.toFixed(2) + '%',
          topHolderSharePct: topN[0]?.sharePct || '0%',
          method: 'veBalance-via-balanceOf',
          coverage: typeof coverageThreshold === 'number' && coverageThreshold > 0 ? {
            threshold: coverageThreshold,
            actual: topShareAggregate,
            lowCoverage,
            warning: lowCoverage
              ? `Low coverage: top-${topN.length} aggregate ${topShareAggregate.toFixed(2)}% < ${coverageThreshold}%. Add --known-actors-seed.`
              : null,
          } : null,
          note:
            'Snapshot is current-time decayed balance. veToken voting power decays linearly over the lock period; re-run for a temporal delta.',
        };
        output.json(artifact);
        if (lowCoverage && strictCoverage) process.exit(2);
        return;
      }

      output.info(`\n  veToken: ${veName} (${veSymbol}) @ ${escrow}`);
      output.info(`  Underlying: ${veTokenAddr}`);
      output.info(`  Total supply: ${totalSupplyNum.toFixed(4)}`);
      if (enumerationMeta) {
        output.info(
          `  Enumerated: ${enumerationMeta.enumerated} unique depositor(s) from blocks ${enumerationMeta.windowFrom}..${enumerationMeta.windowTo} (${enumerationMeta.chunksScanned} chunk(s) scanned)`,
        );
      }
      output.info(`  Probed: ${holderAddrs.length} candidate holder(s)${explicitHolders.length > 0 ? ` (${explicitHolders.length} explicit, ${discoveredHolders.length} enumerated)` : ''}`);
      output.info(`\n  Top ${topN.length} by current veBalance:\n`);

      const table = topN.map((r, i) => [
        `${i + 1}`,
        r.address,
        r.veBalance,
        r.sharePct,
        r.lockEndIso || '(no lock)',
      ]);
      output.table(['#', 'Holder', 'veBalance', 'Share', 'Lock end'], table);

      output.info(
        `\n  Top ${topN.length} aggregate share: ${topShareAggregate.toFixed(2)}% of total supply`,
      );
      output.info(`  Top 1 share: ${topN[0]?.sharePct || '0%'}`);
      output.info(
        `\n  Note: snapshot is current-time decayed balance. veToken voting power decays linearly over the lock period; re-run for a temporal delta.`,
      );
      if (lowCoverage && strictCoverage) process.exit(2);
    } catch (err: any) {
      spin.stop();
      output.error(err.message || String(err));
      process.exit(1);
    }
  },
};
