/**
 * pop user claim-hats — claim additional role hats after joining.
 *
 * Since audit H-03, QuickJoin REFUSES an openly-claimable hat (one the Hats eligibility
 * module says everyone qualifies for) and reverts HatOpenlyClaimable — the inverse of the old
 * "ineligible reverts" model. The pre-flight below replicates the contract's own sentinel probe
 * so it reports the real condition on both the upgraded and pre-audit QuickJoin.
 *
 * QuickJoin.claimHatsWithUser(uint256[] claimHatIds) — verified against
 * contracts origin/main src/QuickJoin.sol and src/abi/QuickJoinNew.json:
 * the vouch-first flow. The caller must already have a username (the
 * contract reverts NoUsername otherwise — pre-flighted here), and Hats
 * Protocol enforces per-hat eligibility via the EligibilityModule (an
 * ineligible claim reverts NotEligible; that decode flows through the
 * error catalog).
 *
 * Hat IDs are uint256 (Hats Protocol IDs exceed Number.MAX_SAFE_INTEGER),
 * so they are parsed with BigNumber — never parseInt.
 *
 * Read strategy. Only the ADDRESSES come from the subgraph
 * (QuickJoinContract.accountRegistry / .hatsContract, byte-verified against
 * the live accountRegistry()/hats() eth_calls on Gnosis and Arbitrum); the
 * pre-flight probes themselves stay on-chain deliberately. getUsername
 * predicts NoUsername, MAX_HATS_PER_MINT predicts the executor's batch-cap
 * revert, and isEligible predicts HatOpenlyClaimable — answering any of them
 * from a lagging indexer means knowingly broadcasting a doomed transaction,
 * or blocking a valid one. What DID change: the N strictly sequential
 * isEligible awaits (one round-trip per hat) plus the username and cap reads
 * are now a single Multicall3 batch — one round-trip for the whole
 * pre-flight instead of N+2.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { requireModule } from '../../lib/resolve';
import { query } from '../../lib/subgraph';
import { FETCH_QUICKJOIN_MODULES, IndexedQuickJoin } from '../../queries/user';
import { tryAggregate, Call, CallResult } from '../../lib/multicall';
import { runPreflight, checkGasBalance } from '../../lib/preflight';
import { getWriteContext, confirmWrite, finishWrite, withIdempotency } from '../../lib/command';
import { CliError, PreconditionError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';

const QUICKJOIN_IFACE = new ethers.utils.Interface([
  'function accountRegistry() view returns (address)',
  'function hats() view returns (address)',
]);
const UAR_IFACE = new ethers.utils.Interface([
  'function getUsername(address user) view returns (string)',
]);
const EXECUTOR_IFACE = new ethers.utils.Interface([
  'function MAX_HATS_PER_MINT() view returns (uint8)',
]);
const HATS_IFACE = new ethers.utils.Interface([
  'function isEligible(address wearer, uint256 hatId) view returns (bool)',
]);

/** keccak256("poa.quickjoin.claim.probe") truncated to an address — QuickJoin._CLAIM_PROBE. */
const CLAIM_PROBE = ethers.utils.getAddress(
  '0x' + ethers.utils.id('poa.quickjoin.claim.probe').slice(-40)
);

function decodeOrNull<T>(fn: () => T, result: CallResult | undefined): T | null {
  if (!result?.success || !result.returnData || result.returnData === '0x') return null;
  try {
    return fn();
  } catch {
    return null;
  }
}

interface ClaimHatsArgs {
  org: string;
  hats: string;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
  'idempotency-key'?: string;
  'no-idempotency'?: boolean;
}

/**
 * Parse a comma-separated hat-ID list into BigNumbers. Accepts decimal and
 * 0x-hex forms. Hats Protocol IDs are uint256 — far beyond 2^53 — so
 * parseInt/Number would silently corrupt them.
 */
export function parseHatIds(input: string): ethers.BigNumber[] {
  const parts = String(input).split(',').map(part => part.trim()).filter(part => part.length > 0);
  if (parts.length === 0) {
    throw new CliError('No hat IDs given.', EXIT.USAGE, 'Pass --hats <id>[,<id>...] (see pop org roles for hat IDs).');
  }
  return parts.map(part => {
    try {
      return ethers.BigNumber.from(part);
    } catch {
      throw new CliError(
        `Invalid hat ID "${part}".`,
        EXIT.USAGE,
        'Hat IDs are uint256 integers — pass them as decimal or 0x-hex strings (see pop org roles).'
      );
    }
  });
}

export const claimHatsHandler = {
  builder: (yargs: Argv) => yargs
    .option('hats', {
      type: 'string',
      demandOption: true,
      describe: 'Comma-separated hat IDs to claim (decimal or 0x-hex), e.g. after being vouched for a role',
    })
    .option('idempotency-key', {
      type: 'string',
      describe: 'Explicit idempotency key. Two identical claims within the TTL return the same result without re-submitting. Default: auto-derived from argv.',
    })
    .option('no-idempotency', {
      type: 'boolean',
      default: false,
      describe: 'Bypass the idempotency cache and always submit.',
    })
    .example('pop user claim-hats --hats 123,456', 'Claim two role hats you are eligible for (e.g. via vouching)')
    .example('pop user claim-hats --hats 0x0000000100020001000000000000000000000000000000000000000000000000', 'Claim one hat by 0x-hex ID'),

  handler: async (argv: ArgumentsCamelCase<ClaimHatsArgs>) => {
    const spin = output.spinner('Checking account state...');
    spin.start();

    try {
      const hatIds = parseHatIds(argv.hats);

      const ctx = await getWriteContext(argv);
      const quickJoinAddr = requireModule(ctx.modules, 'quickJoinAddress');

      // ── Pre-flight (skippable with --no-preflight) ────────────────────
      if (argv.preflight !== false) {
        // Step 1: module addresses. Subgraph-first — these are static
        // deploy-time pointers, verified byte-identical to the live
        // accountRegistry()/hats() reads on Gnosis and Arbitrum. The RPC
        // fallback now asks for BOTH pointers in one batch instead of
        // re-instantiating QuickJoin for each.
        let registryAddr: string | null = null;
        let hatsAddr: string | null = null;
        try {
          const indexed = await query<{ quickJoinContract: IndexedQuickJoin | null }>(
            FETCH_QUICKJOIN_MODULES,
            { quickJoinAddress: quickJoinAddr.toLowerCase() },
            argv.chain
          );
          registryAddr = indexed?.quickJoinContract?.accountRegistry ?? null;
          hatsAddr = indexed?.quickJoinContract?.hatsContract ?? null;
        } catch (err: any) {
          output.debug(`subgraph QuickJoin lookup failed, falling back to RPC (${err?.message || err})`);
        }
        if (!registryAddr || !hatsAddr) {
          const pointers = await tryAggregate(ctx.provider, [
            { to: quickJoinAddr, data: QUICKJOIN_IFACE.encodeFunctionData('accountRegistry') },
            { to: quickJoinAddr, data: QUICKJOIN_IFACE.encodeFunctionData('hats') },
          ]).catch(() => [] as CallResult[]);
          registryAddr = registryAddr ?? decodeOrNull<string>(
            () => QUICKJOIN_IFACE.decodeFunctionResult('accountRegistry', pointers[0]?.returnData)[0],
            pointers[0]
          );
          hatsAddr = hatsAddr ?? decodeOrNull<string>(
            () => QUICKJOIN_IFACE.decodeFunctionResult('hats', pointers[1]?.returnData)[0],
            pointers[1]
          );
        }

        // Step 2: every probe in ONE Multicall3 round-trip. All three stay
        // on-chain on purpose — each one predicts a specific revert, and a
        // lagging indexer would either broadcast a doomed tx or block a
        // valid one.
        const calls: Call[] = [];
        let usernameIdx = -1;
        let capIdx = -1;
        let probeBase = -1;
        if (registryAddr) {
          usernameIdx = calls.length;
          calls.push({ to: registryAddr, data: UAR_IFACE.encodeFunctionData('getUsername', [ctx.address]) });
        }
        const executorAddr = ctx.modules?.executorAddress;
        if (executorAddr) {
          capIdx = calls.length;
          calls.push({ to: executorAddr, data: EXECUTOR_IFACE.encodeFunctionData('MAX_HATS_PER_MINT') });
        }
        if (hatsAddr) {
          probeBase = calls.length;
          for (const hatId of hatIds) {
            calls.push({ to: hatsAddr, data: HATS_IFACE.encodeFunctionData('isEligible', [CLAIM_PROBE, hatId]) });
          }
        }

        const results: CallResult[] = calls.length > 0
          ? await tryAggregate(ctx.provider, calls).catch(() => [] as CallResult[])
          : [];
        const batchAnswered = results.length === calls.length;

        // claimHatsWithUser reverts NoUsername for unregistered accounts —
        // fail fast with the fix instead of burning gas estimation.
        if (batchAnswered && usernameIdx >= 0) {
          const username = decodeOrNull<string>(
            () => UAR_IFACE.decodeFunctionResult('getUsername', results[usernameIdx].returnData)[0],
            results[usernameIdx]
          );
          if (username === null) {
            output.debug('username pre-check skipped (registry read failed)');
          } else if (username.length === 0) {
            throw new PreconditionError(
              `${ctx.address} has no registered username — claimHatsWithUser would revert NoUsername.`,
              'Join first (pop user join --username <name>), or register with pop user register.'
            );
          }
        } else {
          output.debug('username pre-check skipped (account registry unreadable)');
        }

        // Batch cap (audit L-60): Executor.mintHatsForUser rejects more than MAX_HATS_PER_MINT
        // hats to bound gas. Read the live constant rather than hard-coding 20 — an older
        // Executor has no such getter and simply has no cap. NOT available from the
        // subgraph: ExecutorContract indexes no such field (reported as a gap).
        if (batchAnswered && capIdx >= 0) {
          const capRaw = decodeOrNull<number>(
            () => EXECUTOR_IFACE.decodeFunctionResult('MAX_HATS_PER_MINT', results[capIdx].returnData)[0],
            results[capIdx]
          );
          const cap = capRaw === null ? null : Number(capRaw);
          if (cap !== null && cap > 0 && hatIds.length > cap) {
            throw new PreconditionError(
              `${hatIds.length} hats requested but the executor mints at most ${cap} per call.`,
              `Split into batches of ${cap} or fewer.`
            );
          }
        }

        // Open-hat gate (audit H-03). QuickJoin now refuses to mint a hat that ANYONE is
        // eligible for, closing a self-mint vector. Detect the CONDITION rather than the contract
        // version by running the contract's own probe: it asks the Hats contract whether a
        // domain-separated sentinel address is eligible, and treats "yes" — or a reverting probe —
        // as open. Replicated here so the answer is right on both the upgraded and old QuickJoin.
        if (batchAnswered && probeBase >= 0) {
          const open: string[] = [];
          hatIds.forEach((hatId, i) => {
            const probeEligible = decodeOrNull<boolean>(
              () => HATS_IFACE.decodeFunctionResult('isEligible', results[probeBase + i].returnData)[0],
              results[probeBase + i]
            );
            // A reverting probe fails CLOSED, exactly as the contract does.
            if (probeEligible === null || probeEligible) open.push(hatId.toString());
          });
          if (open.length > 0) {
            throw new PreconditionError(
              `Hat(s) ${open.join(', ')} are openly claimable — anyone is eligible for them — so `
                + 'QuickJoin refuses to mint them (reverts HatOpenlyClaimable).',
              'Gate the hat first: pop role eligibility set-default --hat <id> --no-eligible, then '
                + 'grant per-wearer eligibility or configure vouching. An org admin can also mint '
                + 'it directly with pop role admin mint.'
            );
          }
        } else {
          output.debug('open-hat pre-check skipped (hats address unreadable)');
        }
      }

      await runPreflight(ctx.provider, [checkGasBalance(ctx.address)], { skip: argv.preflight === false });
      spin.stop();

      await confirmWrite(argv, {
        org: argv.org,
        hats: hatIds.map(id => id.toString()).join(', '),
        chain: ctx.networkName,
      }, { actionLabel: 'About to claim role hats' });

      const run = async (): Promise<Record<string, any>> => {
        const txSpin = output.spinner('Claiming hats...');
        txSpin.start();
        const contract = createWriteContract(quickJoinAddr, 'QuickJoinNew', ctx.signer);
        const result = await executeTx(contract, 'claimHatsWithUser', [hatIds], { dryRun: argv.dryRun });
        txSpin.stop();

        finishWrite(result, {
          successMsg: hatIds.length === 1 ? `Hat ${hatIds[0].toString()} claimed` : `${hatIds.length} hats claimed`,
          fields: { hatIds: hatIds.map(id => id.toString()).join(','), orgId: ctx.orgId },
        });
        return { hatIds: hatIds.map(id => id.toString()).join(','), txHash: result.txHash };
      };

      if (argv.dryRun) {
        await run();
      } else {
        await withIdempotency(argv, ctx.orgId, 'user.claim-hats', run);
      }
    } catch (err: any) {
      spin.stop();
      if (err instanceof CliError) {
        output.error(err.message, { suggestion: err.suggestion });
        process.exit(err.code);
      }
      output.error(err?.message || String(err));
      process.exit(EXIT.USAGE);
    }
  },
};
