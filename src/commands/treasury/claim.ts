/**
 * pop treasury claim — claim your allocation from a merkle distribution.
 *
 * Human units: --amount is a DECIMAL amount in the distribution's payout
 * token by default. The payout token (and its decimals) comes from the indexed
 * Distribution entity — the same source the sibling `pop treasury claim-mine`
 * already uses, so the two commands cannot disagree about one value — with
 * PaymentManager.getDistribution retained as the fallback for a distribution
 * the subgraph has not indexed yet. address(0) means the chain's native token
 * (verified against contracts origin/main src/PaymentManager.sol), otherwise
 * a live ERC20 decimals() read. Pass --wei to supply the exact raw integer
 * instead (the merkle leaf hashes the raw amount, so exactness matters when
 * your allocation has full-precision dust).
 *
 * Pre-flight (skippable with --no-preflight) mirrors the contract's revert
 * gates: DistributionNotFound, DistributionAlreadyFinalized and AlreadyClaimed
 * (hasClaimed) fail fast before gas is spent. Opt-out only WARNS — audit L-19
 * removed that gate from the claim path so an opt-out cannot strand funds
 * already allocated to you.
 *
 * Prefer `pop treasury claim-mine` — it recomputes the tree and derives your
 * amount + proof automatically. This command is the manual escape hatch.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import * as fs from 'fs';
import { createReadContract, createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { formatToken } from '../../lib/format';
import { getWriteContext, confirmWrite, finishWrite } from '../../lib/command';
import { runPreflight, checkGasBalance } from '../../lib/preflight';
import { requireModule } from '../../lib/resolve';
import { query } from '../../lib/subgraph';
import { FETCH_DISTRIBUTION_BY_ID, distributionEntityId } from '../../queries/treasury';
import { resolvePayoutTokenInfo, PayoutTokenInfo } from './helpers';
import { CliError, PreconditionError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';

interface ClaimArgs {
  org?: string;
  distribution: number;
  amount: string;
  proof?: string;
  'proof-file'?: string;
  wei?: boolean;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
}

/** Parse --proof (inline JSON) or --proof-file (JSON array, or object with a `proof` field). */
export function parseProof(proof?: string, proofFile?: string): string[] {
  if (!proof && !proofFile) {
    throw new CliError(
      'Provide the merkle proof with --proof (inline JSON) or --proof-file <path>.',
      EXIT.USAGE,
      'Or let pop treasury claim-mine derive your amount + proof automatically.'
    );
  }
  if (proof && proofFile) {
    throw new CliError('Pass either --proof or --proof-file, not both.', EXIT.USAGE);
  }

  let raw: any;
  if (proofFile) {
    if (!fs.existsSync(proofFile)) {
      throw new CliError(`Proof file not found: ${proofFile}`, EXIT.USAGE);
    }
    try {
      raw = JSON.parse(fs.readFileSync(proofFile, 'utf8'));
    } catch {
      throw new CliError(`Could not parse ${proofFile} as JSON.`, EXIT.USAGE);
    }
    if (raw && !Array.isArray(raw) && Array.isArray(raw.proof)) raw = raw.proof; // allocation-object form
  } else {
    try {
      raw = JSON.parse(proof as string);
    } catch {
      throw new CliError('--proof must be a JSON array of bytes32 hex strings.', EXIT.USAGE);
    }
  }

  if (!Array.isArray(raw) || raw.some((p: any) => typeof p !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(p))) {
    throw new CliError(
      'The merkle proof must be a JSON array of bytes32 hex strings.',
      EXIT.USAGE,
      'Each entry looks like 0x followed by 64 hex characters (see merkle-distribution.json from compute-merkle).'
    );
  }
  return raw;
}

/** Convert --amount to the raw claim value: decimal token units, or raw wei with --wei. */
export function parseClaimAmount(amount: string, wei: boolean, decimals: number): ethers.BigNumber {
  const trimmed = String(amount).trim();
  if (wei) {
    if (!/^\d+$/.test(trimmed)) {
      throw new CliError(`--wei expects a raw integer amount, got "${amount}".`, EXIT.USAGE, 'Drop --wei to pass decimal token units instead.');
    }
    return ethers.BigNumber.from(trimmed);
  }
  try {
    return ethers.utils.parseUnits(trimmed, decimals);
  } catch {
    throw new CliError(
      `Invalid --amount "${amount}" for a token with ${decimals} decimals.`,
      EXIT.USAGE,
      'Pass a decimal token amount (e.g. 12.5), or the exact raw integer with --wei.'
    );
  }
}

export const claimHandler = {
  builder: (yargs: Argv) => yargs
    .option('distribution', { type: 'number', demandOption: true, describe: 'Distribution ID' })
    .option('amount', { type: 'string', demandOption: true, describe: 'Your allocated amount in TOKEN UNITS (e.g. 12.5) — must match the merkle leaf exactly; use --wei for the raw integer' })
    .option('proof', { type: 'string', describe: 'JSON array of merkle proof bytes32 hashes' })
    .option('proof-file', { type: 'string', describe: 'Path to a JSON file with the proof array (or an allocation object with a "proof" field, as in merkle-distribution.json)' })
    .option('wei', { type: 'boolean', default: false, describe: 'Treat --amount as the raw integer (wei-level) value instead of decimal token units' })
    .example('pop treasury claim --distribution 3 --amount 12.5 --proof-file my-proof.json', 'Claim 12.5 payout tokens from distribution 3')
    .example('pop treasury claim --distribution 3 --amount 12500000000000000000 --wei --proof \'["0x..."]\'', 'Exact raw amount when the allocation has full-precision dust')
    .epilogue('Recommended: pop treasury claim-mine derives your amount and proof automatically for every unclaimed distribution.'),

  handler: async (argv: ArgumentsCamelCase<ClaimArgs>) => {
    const spin = output.spinner('Reading distribution...');
    spin.start();

    try {
      const proofArray = parseProof(argv.proof, argv.proofFile);

      const ctx = await getWriteContext(argv);
      const paymentManagerAddress = requireModule(ctx.modules, 'paymentManagerAddress');
      const pmRead = createReadContract(paymentManagerAddress, 'PaymentManager', ctx.provider);

      // The distribution read is core to amount encoding (payout token →
      // decimals), so it always runs unless --wei makes it unnecessary AND
      // pre-flight is disabled.
      //
      // Subgraph FIRST, contract as the fallback. `distribution(id:)` answers null (not an
      // error) for an id it has not indexed, and a brand-new distribution is exactly the case
      // where someone claims early — so a null MUST fall through to getDistribution rather
      // than render as DistributionNotFound. Every field used below is populated on every live
      // Gnosis row; see src/queries/treasury.ts for the field-by-field mapping.
      let dist: { payoutToken: string; totalAmount: ethers.BigNumber; finalized: boolean } | null = null;
      let token: PayoutTokenInfo | null = null;
      const needDecimals = !argv.wei;
      if (needDecimals || argv.preflight !== false) {
        const indexed = await query<{ distribution: any }>(
          FETCH_DISTRIBUTION_BY_ID,
          { id: distributionEntityId(paymentManagerAddress, argv.distribution) },
          argv.chain
        ).then(r => r.distribution).catch(() => null);

        if (indexed) {
          dist = {
            // Checksum at the boundary. The subgraph stores addresses lowercased, while the
            // ABI-decoded getDistribution() path yields EIP-55. Without this the --json
            // `token` field silently changes case depending on whether the distribution
            // happens to be indexed, breaking any consumer doing an exact string compare.
            payoutToken: ethers.utils.getAddress(indexed.payoutToken),
            totalAmount: ethers.BigNumber.from(indexed.totalAmount),
            // The status enum is exactly Active | Finalized, and it only becomes Finalized once
            // DistributionFinalized is indexed — so a false positive here is impossible. A stale
            // Active is caught by executeTx's gas estimation, which decodes the revert.
            finalized: indexed.status === 'Finalized',
          };
        } else {
          let onChain: any;
          try {
            onChain = await pmRead.getDistribution(argv.distribution);
          } catch {
            throw new PreconditionError(
              `Could not read distribution ${argv.distribution} on-chain.`,
              'List distributions with: pop treasury distributions'
            );
          }
          dist = {
            payoutToken: onChain.payoutToken,
            totalAmount: ethers.BigNumber.from(onChain.totalAmount),
            finalized: Boolean(onChain.finalized),
          };
        }

        if (dist.totalAmount.isZero()) {
          throw new PreconditionError(
            `Distribution ${argv.distribution} does not exist.`,
            'List distributions with: pop treasury distributions'
          );
        }
        token = await resolvePayoutTokenInfo(ctx.provider, dist.payoutToken, ctx.chainId);
      }

      const amountWei = parseClaimAmount(argv.amount, Boolean(argv.wei), token?.decimals ?? 18);

      // ── Pre-flight (skippable with --no-preflight) ────────────────────
      // Mirror the contract's claim gates so failures are one clear message.
      if (argv.preflight !== false && dist) {
        if (dist.finalized) {
          throw new PreconditionError(
            `Distribution ${argv.distribution} is finalized — claims are closed and unclaimed funds were returned to the treasury.`
          );
        }
        // Both stay on-chain, for different reasons:
        //   hasClaimed  — a revert predictor (AlreadyClaimed). Subgraph lag here means
        //                 knowingly broadcasting a doomed transaction.
        //   isOptedOut  — the indexed twin would be OptOutToggle, but that entity has ZERO rows
        //                 on live Gnosis (verified 2026-07) because zero OptOutToggled events
        //                 have ever been emitted across all nine PaymentManagers. The mapping is
        //                 therefore unexercised, so there is no live row to prove it indexes.
        //                 They share one Promise.all round-trip anyway.
        const [alreadyClaimed, optedOut] = await Promise.all([
          pmRead.hasClaimed(argv.distribution, ctx.address),
          pmRead.isOptedOut(ctx.address),
        ]);
        if (alreadyClaimed) {
          throw new PreconditionError(`You already claimed from distribution ${argv.distribution}.`);
        }
        if (optedOut) {
          // BLOCK, do not warn. Audit L-19 proposes removing the OptedOut gate from the claim
          // path, but that build is NOT deployed: the live Gnosis PaymentManager still anchors
          // finalizeDistribution at checkpointBlock (verified by eth_call — see
          // propose-finalize.ts), which makes it a pre-L-19/pre-M-08 implementation, and every
          // PaymentManager source of that vintage has `if (s.optedOut[msg.sender]) revert
          // OptedOut();` in claimDistribution. A bytecode selector scan cannot settle this
          // either way (the impl demonstrably returns ClaimPeriodNotExpired while that selector
          // does not appear as a substring of its runtime code), so this fails closed.
          //
          // Downgrading to output.warn would ALSO be silent for machine consumers:
          // output.warn is a no-op under --json/--quiet (src/lib/output.ts), so an agent would
          // get no signal at all and the clean EXIT.PRECONDITION would degrade into a
          // gas-estimation failure. Re-open this only once an L-19 hub is actually deployed
          // and can be feature-detected.
          throw new PreconditionError(
            'This wallet is opted out of distributions — the claim would revert OptedOut.',
            'Opt back in first: pop treasury opt-in'
          );
        }
      }
      await runPreflight(ctx.provider, [checkGasBalance(ctx.address)], { skip: !argv.preflight });
      spin.stop();

      await confirmWrite(argv, {
        distribution: `#${argv.distribution}`,
        amount: token ? formatToken(amountWei, token.decimals, token.symbol) : `${amountWei.toString()} (raw)`,
        token: token && !token.isNative ? token.address : undefined,
        recipient: `${ctx.address} (you)`,
        org: argv.org,
        chain: ctx.networkName,
      }, { actionLabel: 'About to claim from distribution' });

      const txSpin = output.spinner('Claiming distribution...');
      txSpin.start();
      const pm = createWriteContract(paymentManagerAddress, 'PaymentManager', ctx.signer);
      const result = await executeTx(
        pm,
        'claimDistribution',
        [argv.distribution, amountWei, proofArray],
        { dryRun: argv.dryRun }
      );
      txSpin.stop();

      finishWrite(result, {
        successMsg: `Claimed from distribution #${argv.distribution}`,
        fields: {
          distributionId: argv.distribution,
          amount: token ? formatToken(amountWei, token.decimals) : amountWei.toString(),
          amountWei: amountWei.toString(),
          token: token?.isNative ? 'native' : token?.address,
          symbol: token?.symbol,
        },
      });
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
