/**
 * pop treasury claim — claim your allocation from a merkle distribution.
 *
 * Human units: --amount is a DECIMAL amount in the distribution's payout
 * token by default. The payout token (and its decimals) is read from
 * PaymentManager.getDistribution — address(0) means the chain's native token
 * (verified against contracts origin/main src/PaymentManager.sol), otherwise
 * a live ERC20 decimals() read. Pass --wei to supply the exact raw integer
 * instead (the merkle leaf hashes the raw amount, so exactness matters when
 * your allocation has full-precision dust).
 *
 * Pre-flight (skippable with --no-preflight) mirrors the contract's revert
 * gates: DistributionNotFound, DistributionAlreadyFinalized, AlreadyClaimed
 * (hasClaimed), and OptedOut (isOptedOut) all fail fast before gas is spent.
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
      let dist: any = null;
      let token: PayoutTokenInfo | null = null;
      const needDecimals = !argv.wei;
      if (needDecimals || argv.preflight !== false) {
        try {
          dist = await pmRead.getDistribution(argv.distribution);
        } catch {
          throw new PreconditionError(
            `Could not read distribution ${argv.distribution} on-chain.`,
            'List distributions with: pop treasury distributions'
          );
        }
        if (ethers.BigNumber.from(dist.totalAmount).isZero()) {
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
        const [alreadyClaimed, optedOut] = await Promise.all([
          pmRead.hasClaimed(argv.distribution, ctx.address),
          pmRead.isOptedOut(ctx.address),
        ]);
        if (alreadyClaimed) {
          throw new PreconditionError(`You already claimed from distribution ${argv.distribution}.`);
        }
        if (optedOut) {
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
