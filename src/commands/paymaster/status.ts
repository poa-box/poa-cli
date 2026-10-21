/**
 * pop paymaster status — indexed configuration/history plus current RPC state.
 * Every consumable budget, org financial and deposit observation uses one
 * canonical RPC block; lazy epoch rollover uses that block's chain timestamp.
 * Indexed budgets discover additional subject keys and retain separately labeled
 * historical lifetime counters. They never establish current remaining gas.
 * Subject keys use the canonical PaymasterHub HAT hash, not padded subject IDs.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { remainingBudget } from '@poa-box/core/sponsorship/budget';
import { resolveNetworkConfig } from '../../config/networks';
import { resolveOrgId } from '../../lib/resolve';
import { createReadContract } from '../../lib/contracts';
import { createProvider } from '../../lib/signer';
import { formatToken, formatRelativeTime } from '../../lib/format';
import { tryAggregate } from '../../lib/multicall';
import {
  resolvePaymasterInfra,
  fetchPaymasterSubgraphState,
  subgraphMatchesHub,
  hatSubjectKey,
} from './helpers';
import type { PaymasterBudgetRecord, PaymasterFeeCaps, PaymasterOrgConfig } from './helpers';
import { CliError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';

interface StatusArgs {
  org?: string;
  chain?: number;
  rpc?: string;
  hat?: Array<string | number>;
}

const NINETY_DAYS = 90 * 86400;

const EP_IFACE = new ethers.utils.Interface([
  'function balanceOf(address) view returns (uint256)',
]);

interface BudgetRow {
  subject: string;
  subjectKey: string;
  capPerEpoch: string;
  usedInEpoch: string;
  epochLen: number;
  epochStart: number;
  // Additive — see the epoch-rollover note in the file header.
  epochEnd: number | null;
  epochExpired: boolean;
  usedInEpochEffective: string;
  totalUsed: string | null;
  remainingRaw: string | null;
  remaining: string | null;
  remainingCode?: string;
  raw: { capPerEpoch: string; usedInEpoch: string; epochLen: string; epochStart: string };
  source: 'rpc';
  blockNumber: number;
  blockHash: string;
  totalUsedSource: 'indexed-history' | 'unavailable';
  indexedHistory: { snapshot: 'latest'; block: null; totalUsedRaw: string | null; capPerEpochRaw: string; usedInEpochRaw: string; epochLen: number; epochStart: number } | null;
}

interface PlannedCall {
  key: string;
  to: string;
  data: string;
}

/**
 * Run a batch of read-only calls in one Multicall3 round trip.
 *
 * tryAggregate swallows per-call reverts as { success: false }; re-issuing those
 * directly keeps the pre-batching behaviour where a genuinely failing read
 * surfaces its revert reason instead of silently decoding as zero.
 */
async function runBatch(
  provider: ethers.providers.Provider,
  planned: PlannedCall[],
  blockTag: number
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (planned.length === 0) return out;

  const results = await tryAggregate(provider, planned.map(p => ({ to: p.to, data: p.data })), { blockTag });
  if (results.length !== planned.length) throw new Error('PAYMASTER_READ_INCOMPLETE');
  const retries: PlannedCall[] = [];
  results.forEach((r, i) => {
    if (r.success && r.returnData && r.returnData !== '0x') out.set(planned[i].key, r.returnData);
    else retries.push(planned[i]);
  });
  await Promise.all(retries.map(async p => {
    out.set(p.key, await provider.call({ to: p.to, data: p.data }, blockTag));
  }));
  return out;
}

/** Has this budget's epoch elapsed? The contract zeroes `usedInEpoch` on the next op. */
export function budgetEpochState(
  epochStart: number,
  epochLen: number,
  now: number
): { epochEnd: number | null; expired: boolean } {
  if (!epochLen) return { epochEnd: null, expired: false };
  const epochEnd = epochStart + epochLen;
  return { epochEnd, expired: now >= epochEnd };
}

function shortKey(key: string): string {
  return key.length > 20 ? `${key.slice(0, 10)}…${key.slice(-6)}` : key;
}

export const statusHandler = {
  builder: (yargs: Argv) => yargs
    .option('hat', {
      type: 'string',
      array: true,
      describe: 'Additional hat ID(s) whose sponsorship budgets to show (admin/operator hats are probed automatically)',
    })
    .example('pop paymaster status', 'Sponsorship balance, budgets, and solidarity state for the default org')
    .example('pop paymaster status --hat 123 --json', 'Include hat 123\'s budget in the machine-readable dump'),

  handler: async (argv: ArgumentsCamelCase<StatusArgs>) => {
    const spin = output.spinner('Fetching paymaster status...');
    spin.start();

    try {
      const orgId = await resolveOrgId(argv.org, argv.chain);
      const network = resolveNetworkConfig(argv.chain);
      const provider = createProvider({ chainId: network.chainId, rpcUrl: argv.rpc });
      const [rpcNetwork, block] = await Promise.all([provider.getNetwork(), provider.getBlock('latest')]);
      if (rpcNetwork.chainId !== network.chainId) throw new Error('RPC_CHAIN_MISMATCH');
      if (!block?.hash || !/^0x[\da-f]{64}$/i.test(block.hash) || !Number.isSafeInteger(block.number) || block.number < 0
        || !Number.isSafeInteger(block.timestamp) || block.timestamp < 0) throw new Error('PAYMASTER_BLOCK_UNAVAILABLE');

      // The hub address itself already comes from the subgraph, so pulling the
      // hub/org state alongside it costs no extra latency.
      const [infra, rawState] = await Promise.all([
        resolvePaymasterInfra(argv.chain),
        fetchPaymasterSubgraphState(orgId, argv.chain),
      ]);
      const paymasterAddr = infra.paymasterHubAddress;
      // A hub mismatch means the indexed rows describe a different contract.
      const sg = subgraphMatchesHub(rawState, paymasterAddr)
        ? rawState
        : { hubAddress: null, entryPoint: null, orgConfig: null, feeCaps: null, budgets: null };

      const paymaster = createReadContract(paymasterAddr, 'PaymasterHub', provider);
      const hubIface = paymaster.interface;

      // ── Round 1: everything the subgraph could not serve ──────────────────
      const planned: PlannedCall[] = [
        { key: 'financials', to: paymasterAddr, data: hubIface.encodeFunctionData('getOrgFinancials', [orgId]) },
        { key: 'solidarity', to: paymasterAddr, data: hubIface.encodeFunctionData('getSolidarityFund', []) },
      ];
      let entryPoint = sg.entryPoint;
      if (entryPoint) {
        // Only possible because ENTRY_POINT no longer has to resolve first.
        planned.push({ key: 'deposit', to: entryPoint, data: EP_IFACE.encodeFunctionData('balanceOf', [paymasterAddr]) });
      } else {
        planned.push({ key: 'entryPoint', to: paymasterAddr, data: hubIface.encodeFunctionData('ENTRY_POINT', []) });
      }
      if (!sg.orgConfig) {
        planned.push({ key: 'orgConfig', to: paymasterAddr, data: hubIface.encodeFunctionData('getOrgConfig', [orgId]) });
      }
      if (!sg.feeCaps) {
        planned.push({ key: 'feeCaps', to: paymasterAddr, data: hubIface.encodeFunctionData('getFeeCaps', [orgId]) });
      }

      const round1 = await runBatch(provider, planned, block.number);

      const financials = hubIface.decodeFunctionResult('getOrgFinancials', round1.get('financials')!)[0];
      const solidarity = hubIface.decodeFunctionResult('getSolidarityFund', round1.get('solidarity')!)[0];
      if (!entryPoint) {
        entryPoint = hubIface.decodeFunctionResult('ENTRY_POINT', round1.get('entryPoint')!)[0] as string;
      }

      let orgConfig: PaymasterOrgConfig;
      if (sg.orgConfig) {
        orgConfig = sg.orgConfig;
      } else {
        const raw = hubIface.decodeFunctionResult('getOrgConfig', round1.get('orgConfig')!)[0];
        const adminHatId = ethers.BigNumber.from(raw.adminHatId);
        orgConfig = {
          adminHatId,
          operatorHatId: ethers.BigNumber.from(raw.operatorHatId),
          // Named field (was positional [4] against a stale struct order — the
          // synced ABI puts `paused` at index 2 and bannedFromSolidarity at 4).
          paused: Boolean(raw.paused),
          registeredAt: Number(raw.registeredAt ?? 0),
          bannedFromSolidarity: Boolean(raw.bannedFromSolidarity),
          registered: !adminHatId.isZero(),
        };
      }

      let feeCaps: PaymasterFeeCaps;
      if (sg.feeCaps) {
        feeCaps = sg.feeCaps;
      } else {
        const raw = hubIface.decodeFunctionResult('getFeeCaps', round1.get('feeCaps')!)[0];
        feeCaps = {
          maxFeePerGas: ethers.BigNumber.from(raw.maxFeePerGas),
          maxPriorityFeePerGas: ethers.BigNumber.from(raw.maxPriorityFeePerGas),
          maxCallGas: Number(raw.maxCallGas),
          maxVerificationGas: Number(raw.maxVerificationGas),
          maxPreVerificationGas: Number(raw.maxPreVerificationGas),
        };
      }

      const adminHatId = orgConfig.adminHatId;
      const operatorHatId = orgConfig.operatorHatId;
      const registered = orgConfig.registered;
      const isPaused = orgConfig.paused;

      const deposited = ethers.BigNumber.from(financials.deposited);
      const spent = ethers.BigNumber.from(financials.spent);
      const available = deposited.gt(spent) ? deposited.sub(spent) : ethers.BigNumber.from(0);
      const periodStart = Number(financials.periodStart);

      // Budgets per subject: admin + operator hats automatically, --hat extras.
      const subjects: Array<{ label: string; key: string }> = [];
      if (registered) subjects.push({ label: `admin hat ${adminHatId.toString()}`, key: hatSubjectKey(adminHatId) });
      if (!operatorHatId.isZero()) subjects.push({ label: `operator hat ${operatorHatId.toString()}`, key: hatSubjectKey(operatorHatId) });
      for (const h of argv.hat ?? []) {
        try {
          const id = ethers.BigNumber.from(String(h).trim());
          subjects.push({ label: `hat ${id.toString()}`, key: hatSubjectKey(id) });
        } catch {
          throw new CliError(`Invalid --hat "${h}".`, EXIT.USAGE, 'Pass hat IDs as decimal or 0x-hex integers.');
        }
      }
      const seen = new Set<string>();
      const uniqueSubjects = subjects.filter(s => !seen.has(s.key) && seen.add(s.key));

      // ── Round 2: the EntryPoint deposit (only when ENTRY_POINT had to be
      // read first) plus current budgets for all requested/discovered subjects.
      const planned2: PlannedCall[] = [];
      if (!round1.has('deposit')) {
        planned2.push({ key: 'deposit', to: entryPoint, data: EP_IFACE.encodeFunctionData('balanceOf', [paymasterAddr]) });
      }
      const budgetSubjects = [...uniqueSubjects];
      for (const budget of sg.budgets ?? []) {
        if (!/^0x[\da-f]{64}$/i.test(budget.subjectKey)) throw new Error('INVALID_INDEXED_BUDGET_KEY');
        if (!seen.has(budget.subjectKey.toLowerCase())) {
          seen.add(budget.subjectKey.toLowerCase());
          budgetSubjects.push({ label: `subject ${shortKey(budget.subjectKey)}`, key: budget.subjectKey });
        }
      }
      for (const subject of budgetSubjects) {
        planned2.push({ key: `budget:${subject.key.toLowerCase()}`, to: paymasterAddr, data: hubIface.encodeFunctionData('getBudget', [orgId, subject.key]) });
      }
      const round2 = await runBatch(provider, planned2, block.number);

      const depositData = round1.get('deposit') ?? round2.get('deposit')!;
      const deposit = EP_IFACE.decodeFunctionResult('balanceOf', depositData)[0] as ethers.BigNumber;

      const byKey = new Map<string, PaymasterBudgetRecord>();
      const indexedBudgets = new Map((sg.budgets ?? []).map(budget => [budget.subjectKey.toLowerCase(), budget]));
      for (const s of budgetSubjects) {
        const data = round2.get(`budget:${s.key.toLowerCase()}`);
        if (!data) throw new Error('CURRENT_BUDGET_UNAVAILABLE');
        const raw = hubIface.decodeFunctionResult('getBudget', data)[0];
        byKey.set(s.key.toLowerCase(), {
          subjectKey: s.key,
          capPerEpoch: ethers.BigNumber.from(raw.capPerEpoch),
          usedInEpoch: ethers.BigNumber.from(raw.usedInEpoch),
          epochLen: Number(raw.epochLen),
          epochStart: Number(raw.epochStart),
          totalUsed: indexedBudgets.get(s.key.toLowerCase())?.totalUsed ?? null, // historical display only
        });
      }

      const now = block.timestamp;
      const toRow = (label: string, b: PaymasterBudgetRecord): BudgetRow => {
        const { epochEnd, expired } = budgetEpochState(b.epochStart, b.epochLen, now);
        let remainingRaw: string | null = null, remainingCode: string | undefined;
        try { remainingRaw = remainingBudget({ capPerEpoch: b.capPerEpoch.toString(), usedInEpoch: b.usedInEpoch.toString(), epochLen: b.epochLen, epochStart: b.epochStart }, now); }
        catch { remainingCode = 'BUDGET_STATE_INVALID'; }
        const historical = indexedBudgets.get(b.subjectKey.toLowerCase());
        return {
          subject: label,
          subjectKey: b.subjectKey,
          capPerEpoch: ethers.utils.formatEther(b.capPerEpoch),
          usedInEpoch: ethers.utils.formatEther(b.usedInEpoch),
          epochLen: b.epochLen,
          epochStart: b.epochStart,
          epochEnd,
          epochExpired: expired,
          usedInEpochEffective: expired
            ? ethers.utils.formatEther(0)
            : ethers.utils.formatEther(b.usedInEpoch),
          totalUsed: b.totalUsed ? ethers.utils.formatEther(b.totalUsed) : null,
          remainingRaw,
          remaining: remainingRaw === null ? null : ethers.utils.formatEther(remainingRaw),
          remainingCode,
          raw: { capPerEpoch: b.capPerEpoch.toString(), usedInEpoch: b.usedInEpoch.toString(), epochLen: String(b.epochLen), epochStart: String(b.epochStart) },
          source: 'rpc', blockNumber: block.number, blockHash: block.hash,
          totalUsedSource: b.totalUsed === null ? 'unavailable' : 'indexed-history',
          indexedHistory: historical ? { snapshot: 'latest', block: null, totalUsedRaw: historical.totalUsed?.toString() ?? null,
            capPerEpochRaw: historical.capPerEpoch.toString(), usedInEpochRaw: historical.usedInEpoch.toString(),
            epochLen: historical.epochLen, epochStart: historical.epochStart } : null,
        };
      };

      // Probed subjects keep their historical position and order; anything the
      // subgraph knows about beyond them is appended, never interleaved.
      const budgets: BudgetRow[] = [];
      const emitted = new Set<string>();
      for (const s of uniqueSubjects) {
        const b = byKey.get(s.key.toLowerCase());
        if (!b) continue;
        emitted.add(s.key.toLowerCase());
        if (b.capPerEpoch.isZero() && b.usedInEpoch.isZero()) continue; // unset subject — skip
        budgets.push(toRow(s.label, b));
      }
      let discovered = 0;
      for (const b of sg.budgets ?? []) {
        const k = b.subjectKey.toLowerCase();
        if (emitted.has(k)) continue;
        emitted.add(k);
        const current = byKey.get(k);
        if (!current) throw new Error('CURRENT_BUDGET_UNAVAILABLE');
        if (current.capPerEpoch.isZero() && current.usedInEpoch.isZero()) continue;
        budgets.push(toRow(`subject ${shortKey(b.subjectKey)}`, current));
        discovered++;
      }

      const dataSource = {
        entryPoint: sg.entryPoint ? 'subgraph' : 'rpc',
        orgConfig: sg.orgConfig ? 'subgraph' : 'rpc',
        feeCaps: sg.feeCaps ? 'subgraph' : 'rpc',
        budgets: 'rpc',
        financials: 'rpc',
        solidarityFund: 'rpc',
        deposit: 'rpc',
      };

      const [afterBlock, afterNetwork] = await Promise.all([provider.getBlock(block.number), provider.getNetwork()]);
      if (afterNetwork.chainId !== network.chainId || afterBlock?.hash?.toLowerCase() !== block.hash.toLowerCase()
        || afterBlock.number !== block.number || afterBlock.timestamp !== block.timestamp) throw new Error('PAYMASTER_OBSERVATION_CHANGED');
      spin.stop();

      if (output.isJsonMode()) {
        output.json({
          // Existing fields — unchanged names/formats (additive-only contract)
          paymasterHub: paymasterAddr,
          entryPoint,
          deposit: ethers.utils.formatEther(deposit),
          maxFeePerGas: ethers.utils.formatUnits(feeCaps.maxFeePerGas, 'gwei'),
          maxPriorityFeePerGas: ethers.utils.formatUnits(feeCaps.maxPriorityFeePerGas, 'gwei'),
          paused: isPaused,
          // Additive: registration + financials + solidarity + budgets
          registered,
          adminHatId: registered ? adminHatId.toString() : null,
          operatorHatId: operatorHatId.isZero() ? null : operatorHatId.toString(),
          registeredAt: Number(orgConfig.registeredAt ?? 0) || null,
          bannedFromSolidarity: Boolean(orgConfig.bannedFromSolidarity),
          financials: {
            deposited: ethers.utils.formatEther(deposited),
            spent: ethers.utils.formatEther(spent),
            available: ethers.utils.formatEther(available),
            solidarityUsedThisPeriod: ethers.utils.formatEther(financials.solidarityUsedThisPeriod),
            periodStart: periodStart || null,
            periodEnd: periodStart ? periodStart + NINETY_DAYS : null,
          },
          solidarityFund: {
            balance: ethers.utils.formatEther(solidarity.balance),
            numActiveOrgs: Number(solidarity.numActiveOrgs),
            feePercentageBps: Number(solidarity.feePercentageBps),
            distributionPaused: Boolean(solidarity.distributionPaused),
          },
          budgets,
          // Additive: which reads the subgraph served this run.
          dataSource,
          budgetObservedAtSeconds: now,
          rpcObservation: { chainId: network.chainId, blockNumber: block.number, blockHash: block.hash, timestamp: now },
          indexedObservation: sg.hubAddress ? { snapshot: 'latest', block: null, currentAvailabilityVerified: false } : null,
          indexedBudgetHistory: (sg.budgets ?? []).map(budget => ({ subjectKey: budget.subjectKey, snapshot: 'latest', block: null,
            totalUsedRaw: budget.totalUsed?.toString() ?? null, capPerEpochRaw: budget.capPerEpoch.toString(),
            usedInEpochRaw: budget.usedInEpoch.toString(), epochLen: budget.epochLen, epochStart: budget.epochStart })),
        });
      } else {
        console.log('');
        console.log('  Paymaster Status');
        console.log('  ' + '─'.repeat(40));
        console.log(`  Hub:          ${paymasterAddr}`);
        console.log(`  EntryPoint:   ${entryPoint}`);
        console.log(`  Deposit:      ${ethers.utils.formatEther(deposit)} xDAI (hub-wide EntryPoint stake)`);
        console.log(`  Max Fee:      ${ethers.utils.formatUnits(feeCaps.maxFeePerGas, 'gwei')} gwei`);
        console.log(`  Max Priority: ${ethers.utils.formatUnits(feeCaps.maxPriorityFeePerGas, 'gwei')} gwei`);
        console.log(`  Paused:       ${isPaused ? 'YES' : 'no'}`);

        console.log('');
        if (!registered) {
          console.log('  Org registration: NOT REGISTERED');
          console.log('  Register with: pop paymaster register --admin-hat <hatId>');
        } else {
          console.log('  Org registration');
          console.log(`    Admin hat:     ${adminHatId.toString()}`);
          console.log(`    Operator hat:  ${operatorHatId.isZero() ? 'none' : operatorHatId.toString()}`);
          if (Number(orgConfig.registeredAt)) {
            console.log(`    Registered:    ${formatRelativeTime(Number(orgConfig.registeredAt))}`);
          }
          if (orgConfig.bannedFromSolidarity) {
            console.log('    Solidarity:    BANNED from the solidarity fund');
          }
          console.log('');
          console.log('  Org financials (90-day solidarity periods)');
          console.log(`    Deposited:     ${formatToken(deposited)} (lifetime)`);
          console.log(`    Spent:         ${formatToken(spent)}`);
          console.log(`    Available:     ${formatToken(available)}`);
          console.log(`    Solidarity used this period: ${formatToken(financials.solidarityUsedThisPeriod)}`);
          if (periodStart) {
            console.log(`    Period:        started ${formatRelativeTime(periodStart)}, resets ${formatRelativeTime(periodStart + NINETY_DAYS)}`);
          }
        }

        console.log('');
        console.log('  Solidarity fund (protocol-wide)');
        console.log(`    Balance:       ${formatToken(solidarity.balance)}`);
        console.log(`    Fee:           ${Number(solidarity.feePercentageBps) / 100}%`);
        console.log(`    Distribution:  ${solidarity.distributionPaused ? 'paused (collection-only)' : 'active'}`);

        if (budgets.length > 0) {
          console.log('');
          console.log('  Budgets per subject:');
          output.table(
            ['Subject', 'Cap/epoch', 'Used this epoch', 'Epoch', 'Lifetime'],
            budgets.map(b => [
              b.subject,
              b.capPerEpoch,
              b.epochExpired ? `${b.usedInEpochEffective} (epoch lapsed)` : b.usedInEpoch,
              `${b.epochLen}s`,
              b.totalUsed ?? '—',
            ])
          );
          if (budgets.some(b => b.epochExpired)) {
            console.log('  "epoch lapsed" = the window ended; the hub zeroes the counter on the next sponsored op.');
          }
          if (discovered > 0) {
            console.log(`  (${discovered} further subject${discovered === 1 ? '' : 's'} found via the subgraph — hashed keys the CLI cannot derive.)`);
          }
        } else if (registered) {
          console.log('');
          console.log('  Budgets: none set for the observed or requested subjects (admin/operator hats' + ((argv.hat?.length ?? 0) > 0 ? ' + --hat' : '') + ')');
        }

        console.log('');
        console.log('  Note: Gas sponsorship requires ERC-4337 UserOperations.');
        console.log('  CLI routes configured delegated EOAs through the bundler and paymaster.');
        console.log('  Frontend passkey accounts use the bundler + paymaster flow.');
        console.log('');
      }
    } catch (err: any) {
      spin.stop();
      if (err instanceof CliError) {
        output.error(err.message, { suggestion: err.suggestion });
        process.exit(err.code);
      }
      output.error(err.message);
      process.exit(1);
    }
  },
};
