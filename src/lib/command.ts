/**
 * Command Composition Layer
 * Shared plumbing for write commands: context resolution (org + signer),
 * the confirmation policy, transaction result rendering, interactive
 * gap-filling for missing args, and idempotency wiring. Commands compose
 * these helpers instead of re-implementing the same boilerplate.
 */

import { ethers } from 'ethers';
import { resolveOrgModules } from './resolve';
import { createSigner } from './signer';
import { getNetworkByChainId } from '../config/networks';
import { AbortedError, CliError } from './errors';
import { EXIT } from './exit-codes';
import { isInteractive, confirm, input, select } from './prompt';
import {
  argvToIdempotencyString,
  checkIdempotencyCache,
  recordIdempotentResult,
  resolveTtlSeconds,
} from './idempotency';
import type { TxResult } from './tx';
import * as output from './output';

export interface WriteContext {
  orgId: string;
  modules: any;
  signer: ethers.Wallet;
  provider: ethers.providers.Provider;
  address: string;
  chainId: number;
  networkName: string;
}

// Memoized per org-input + chain so multi-step commands (and future
// multi-write flows) resolve the org and construct the signer once per
// process. Keyed on the raw --org value: two spellings of the same org
// (name vs hex ID) resolve independently, which is harmless.
const contextCache = new Map<string, Promise<WriteContext>>();

/** Test-only hook: reset the per-process context memo. */
export function _clearWriteContextCacheForTest(): void {
  contextCache.clear();
}

/**
 * Resolve everything a write command needs: org modules (unless
 * opts.needsOrg is false), a connected signer, and network identity.
 */
export function getWriteContext(argv: any, opts?: { needsOrg?: boolean }): Promise<WriteContext> {
  const needsOrg = opts?.needsOrg !== false;
  const cacheKey = `${argv.org ?? ''}|${argv.chain ?? ''}|${needsOrg ? 'org' : 'no-org'}`;
  const cached = contextCache.get(cacheKey);
  if (cached) return cached;

  const pending = buildWriteContext(argv, needsOrg).catch(err => {
    contextCache.delete(cacheKey); // don't memoize failures
    throw err;
  });
  contextCache.set(cacheKey, pending);
  return pending;
}

async function buildWriteContext(argv: any, needsOrg: boolean): Promise<WriteContext> {
  const modules = needsOrg ? await resolveOrgModules(argv.org, argv.chain) : null;
  const { signer, provider, address, chainId } = createSigner({
    privateKey: argv.privateKey,
    chainId: argv.chain,
    rpcUrl: argv.rpc,
  });
  const networkName = getNetworkByChainId(chainId)?.name ?? `chain ${chainId}`;

  return {
    orgId: modules?.orgId ?? '',
    modules,
    signer,
    provider,
    address,
    chainId,
    networkName,
  };
}

/**
 * Confirmation policy for write commands:
 * - --yes, POP_ASSUME_YES=1, or --json → proceed without asking
 * - interactive TTY → show the summary, ask, throw AbortedError on decline
 * - non-TTY, non-destructive → proceed (preserves current agent behavior)
 * - non-TTY, destructive → refuse without an explicit --yes
 */
export async function confirmWrite(
  argv: any,
  summary: Record<string, string | number | undefined>,
  opts?: { destructive?: boolean; actionLabel?: string }
): Promise<void> {
  if (argv.yes || process.env.POP_ASSUME_YES === '1' || output.isJsonMode()) return;

  if (isInteractive()) {
    output.keyValueBlock(opts?.actionLabel ?? 'About to send', summary);
    const ok = await confirm('Proceed?');
    if (!ok) throw new AbortedError('aborted by user');
    return;
  }

  if (opts?.destructive) {
    throw new AbortedError('This is a destructive action. Pass --yes to run non-interactively.');
  }
  // Non-TTY and non-destructive: proceed silently.
}

/**
 * Render a TxResult consistently:
 * - dry-run → one success line with method/to/gasEstimate, no lag warning
 * - success → success line with entity fields + txHash/explorerUrl, then
 *   onSuccess() (e.g. idempotency recording) and the subgraph lag warning
 * - failure → decoded error details, exit EXIT.TX_FAILED
 */
export function finishWrite(
  result: TxResult,
  opts: { successMsg: string; fields?: Record<string, any>; onSuccess?: () => void }
): void {
  if (result.dryRun) {
    output.success('DRY RUN — transaction not sent', {
      method: result.method,
      to: result.to,
      gasEstimate: result.gasEstimate,
    });
    return;
  }

  if (result.success) {
    output.success(opts.successMsg, {
      ...opts.fields,
      txHash: result.txHash,
      explorerUrl: result.explorerUrl,
    });
    opts.onSuccess?.();
    output.subgraphLagWarning();
    return;
  }

  output.error(result.error ?? 'Transaction failed', {
    code: result.errorCode,
    errorName: result.errorName,
    suggestion: result.suggestion,
  });
  process.exit(EXIT.TX_FAILED);
}

export interface MissingArgSpec {
  key: string;
  question: string;
  kind: 'input' | 'select' | 'number';
  choices?: Array<{ label: string; value: any }>;
  validate?: (s: string) => string | true;
}

/**
 * Fill missing argv keys (undefined/null/empty string) interactively.
 * Non-TTY sessions get the classic hard error instead, so agents keep
 * their explicit-flags contract.
 */
export async function promptMissing<A>(argv: A, spec: MissingArgSpec[]): Promise<A> {
  const anyArgv = argv as Record<string, any>;
  const missing = spec.filter(s => {
    const value = anyArgv[s.key];
    return value === undefined || value === null || value === '';
  });
  if (missing.length === 0) return argv;

  if (!isInteractive()) {
    throw new CliError(`Missing required argument: --${missing[0].key}`, EXIT.USAGE);
  }

  for (const s of missing) {
    if (s.kind === 'select') {
      anyArgv[s.key] = await select(s.question, s.choices ?? []);
    } else if (s.kind === 'number') {
      const answer = await input(s.question, {
        validate: value => {
          if (value.trim() === '' || Number.isNaN(Number(value))) return 'Please enter a number.';
          return s.validate ? s.validate(value) : true;
        },
      });
      anyArgv[s.key] = Number(answer);
    } else {
      anyArgv[s.key] = await input(s.question, { validate: s.validate });
    }
  }
  return argv;
}

/**
 * Idempotency wrapper — the pattern from task/create.ts + vote/cast.ts
 * (task #369/#370) extracted. Cache hit within the TTL prints the prior
 * result and returns without running; otherwise `run()` executes and its
 * returned fields are recorded for the next retry. Honors
 * --idempotency-key, --no-idempotency, and --idempotency-ttl (seconds,
 * resolved via resolveTtlSeconds's param → env → default chain).
 */
export async function withIdempotency(
  argv: any,
  orgId: string,
  command: string,
  run: () => Promise<Record<string, any>>
): Promise<void> {
  const idempKey = argv.idempotencyKey || argvToIdempotencyString(argv as Record<string, any>);
  const ttlSeconds = resolveTtlSeconds(argv.idempotencyTtl ?? argv['idempotency-ttl']);

  if (!argv.noIdempotency) {
    const cached = checkIdempotencyCache(orgId, command, idempKey, ttlSeconds);
    if (cached) {
      output.success('Already executed (idempotency cache hit)', {
        ...cached,
        cached: true,
        note: 'A prior call within the idempotency window produced this result. Pass --no-idempotency to force a new submission.',
      });
      return;
    }
  }

  const result = await run();

  if (!argv.noIdempotency) {
    recordIdempotentResult(orgId, command, idempKey, result, ttlSeconds);
  }
}
