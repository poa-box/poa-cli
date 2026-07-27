/**
 * pop vote classes — N-class hybrid voting configuration.
 *
 * Two nested subcommands (template: task/perms.ts):
 *   show    — read-only table of the current class config (getClasses) or the
 *             snapshot frozen for one proposal (getProposalClasses), plus the
 *             two distinct validity parameters: support threshold (% of
 *             weighted power, thresholdPct) and quorum (VOTER COUNT, quorum).
 *   propose — replace the class config via setClasses(ClassConfig[]).
 *             Gate VERIFIED against contracts origin/main src/HybridVoting.sol:
 *             `function setClasses(ClassConfig[] calldata) external onlyExecutor`
 *             → must ship as a governance proposal whose option-0 execution
 *             batch calls the HybridVoting contract through the Executor
 *             (same wrapping as vote propose-config / task perms propose-global).
 *
 * ClassConfig (verified origin/main src/HybridVoting.sol):
 *   { ClassStrategy strategy;   // DIRECT=0 (1 person → 100 raw points),
 *                               // ERC20_BAL=1 (balance or sqrt, scaled)
 *     uint8 slicePct;           // 1..100; all classes must sum to 100
 *     bool quadratic;           // token strategies only
 *     uint256 minBalance;       // sybil floor for token strategies
 *     address asset;            // ERC20 token (required for ERC20_BAL)
 *     uint256[] hatIds }        // voter must wear ≥1 (union)
 *
 * Contract-side validation mirrored here (src/libs/HybridVotingConfig.sol):
 * 1..MAX_CLASSES(8) classes, each slicePct 1..100, slices sum exactly 100,
 * ERC20_BAL requires a non-zero asset.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import fs from 'fs';
import { ethers } from 'ethers';
import { createReadContract, createWriteContract, loadAbi } from '../../lib/contracts';
import { createProvider } from '../../lib/signer';
import { executeTx } from '../../lib/tx';
import { pinJson } from '../../lib/ipfs';
import { stringToBytes, ipfsCidToBytes32, formatAddress } from '../../lib/encoding';
import { formatToken } from '../../lib/format';
import { getWriteContext, confirmWrite, finishWrite, withIdempotency } from '../../lib/command';
import { runPreflight, checkGasBalance } from '../../lib/preflight';
import { resolveOrgModules } from '../../lib/resolve';
import { CliError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';
import { resolveProposalId } from './helpers';

/** ClassStrategy enum — verified origin/main src/HybridVoting.sol. */
export const CLASS_STRATEGY = { DIRECT: 0, ERC20_BAL: 1 } as const;
const STRATEGY_NAMES = ['DIRECT', 'ERC20_BAL'] as const;

/** Contract constant MAX_CLASSES (origin/main src/HybridVoting.sol). */
export const MAX_CLASSES = 8;

export interface ParsedClassConfig {
  strategy: number;
  slicePct: number;
  quadratic: boolean;
  minBalance: ethers.BigNumber;
  asset: string;
  hatIds: ethers.BigNumber[];
}

function usageError(message: string): CliError {
  return new CliError(message, EXIT.USAGE,
    'Expected a JSON array of ClassConfig objects: ' +
    '[{"strategy":"DIRECT"|"ERC20_BAL"|0|1,"slicePct":n,"quadratic":bool,"minBalance":"0","asset":"0x…","hatIds":["…"]}] ' +
    'with slicePct values summing to 100.');
}

function parseStrategy(value: any, index: number): number {
  if (value === 0 || value === 1) return value;
  if (typeof value === 'string') {
    const upper = value.trim().toUpperCase();
    if (upper === 'DIRECT' || upper === '0') return CLASS_STRATEGY.DIRECT;
    if (upper === 'ERC20_BAL' || upper === '1') return CLASS_STRATEGY.ERC20_BAL;
  }
  throw usageError(`Class ${index}: invalid strategy ${JSON.stringify(value)} — use 'DIRECT'|'ERC20_BAL'|0|1.`);
}

/**
 * Validate + normalize a ClassConfig[] JSON document (exported for tests).
 * Mirrors HybridVotingConfig.setClasses so bad configs fail locally with a
 * pointer to the offending class instead of a generic on-chain revert.
 * Hat IDs are parsed as BigNumbers straight from their raw strings — real
 * Hats IDs exceed 2^53 and would be mangled by Number.
 */
export function parseClassConfigs(doc: any): ParsedClassConfig[] {
  if (!Array.isArray(doc)) throw usageError('Classes file must contain a JSON array of ClassConfig objects.');
  if (doc.length === 0) throw usageError('At least one voting class is required.');
  if (doc.length > MAX_CLASSES) {
    throw usageError(`Too many classes: ${doc.length} (the contract allows at most ${MAX_CLASSES}).`);
  }

  const classes = doc.map((entry: any, i: number): ParsedClassConfig => {
    if (typeof entry !== 'object' || entry === null) throw usageError(`Class ${i}: expected an object.`);

    const strategy = parseStrategy(entry.strategy, i);

    const slicePct = Number(entry.slicePct);
    if (!Number.isInteger(slicePct) || slicePct < 1 || slicePct > 100) {
      throw usageError(`Class ${i}: slicePct must be an integer 1-100 (got ${JSON.stringify(entry.slicePct)}).`);
    }

    let minBalance: ethers.BigNumber;
    try {
      minBalance = ethers.BigNumber.from(String(entry.minBalance ?? 0));
    } catch {
      throw usageError(`Class ${i}: invalid minBalance ${JSON.stringify(entry.minBalance)} — pass a base-unit integer string.`);
    }

    const asset = String(entry.asset ?? ethers.constants.AddressZero);
    if (!ethers.utils.isAddress(asset)) {
      throw usageError(`Class ${i}: invalid asset address ${JSON.stringify(entry.asset)}.`);
    }
    if (strategy === CLASS_STRATEGY.ERC20_BAL && asset === ethers.constants.AddressZero) {
      throw usageError(`Class ${i}: ERC20_BAL strategy requires a non-zero asset address (the contract reverts ZeroAddress).`);
    }

    const rawHatIds = entry.hatIds ?? [];
    if (!Array.isArray(rawHatIds)) throw usageError(`Class ${i}: hatIds must be an array.`);
    const hatIds = rawHatIds.map((h: any) => {
      try {
        return ethers.BigNumber.from(String(h).trim());
      } catch {
        throw usageError(`Class ${i}: invalid hat ID ${JSON.stringify(h)}.`);
      }
    });

    return { strategy, slicePct, quadratic: Boolean(entry.quadratic), minBalance, asset, hatIds };
  });

  const sliceSum = classes.reduce((sum, c) => sum + c.slicePct, 0);
  if (sliceSum !== 100) {
    throw new CliError(
      `Class slice percentages must sum to exactly 100 — got ${sliceSum} ` +
      `(${classes.map(c => `${c.slicePct}%`).join(' + ')}). The contract reverts InvalidSliceSum otherwise.`,
      EXIT.USAGE,
      'Adjust the slicePct values in the classes file so they total 100.'
    );
  }

  return classes;
}

/** One-line human description of a class (confirm summary + metadata). */
export function describeClass(c: ParsedClassConfig): string {
  const name = STRATEGY_NAMES[c.strategy] ?? String(c.strategy);
  const parts = [`${name} ${c.slicePct}%`];
  if (c.quadratic) parts.push('quadratic');
  if (!c.minBalance.isZero()) parts.push(`min balance ${formatToken(c.minBalance)}`);
  if (c.asset !== ethers.constants.AddressZero) parts.push(`asset ${formatAddress(c.asset)}`);
  if (c.hatIds.length > 0) parts.push(`hats ${c.hatIds.map(h => h.toString()).join(',')}`);
  return parts.join(', ');
}

// ────────────────────────────── show ──────────────────────────────

interface ClassesShowArgs {
  org: string;
  proposal?: string;
  chain?: number;
  rpc?: string;
}

const classesShowHandler = {
  builder: (yargs: Argv) => yargs
    .option('proposal', {
      type: 'string',
      describe: 'Show the class snapshot frozen for one proposal (ID or fuzzy title query) instead of the live config',
    })
    .example('pop vote classes show', 'Current hybrid voting class table + threshold/quorum')
    .example('pop vote classes show --proposal 7', 'The class snapshot proposal #7 was created with'),

  handler: async (argv: ArgumentsCamelCase<ClassesShowArgs>) => {
    const spin = output.spinner('Fetching voting classes...');
    spin.start();

    try {
      const modules = await resolveOrgModules(argv.org, argv.chain);

      // Graceful degradation: orgs without HybridVoting have no classes.
      if (!modules.hybridVotingAddress) {
        spin.stop();
        if (output.isJsonMode()) {
          output.json({
            hybridVoting: null,
            classes: [],
            note: 'This org has no HybridVoting module — voting classes only apply to hybrid voting.',
          });
        } else {
          output.info('This org has no HybridVoting module — voting classes only apply to hybrid voting.');
        }
        return;
      }

      const provider = createProvider({ chainId: argv.chain, rpcUrl: argv.rpc });
      const contract = createReadContract(modules.hybridVotingAddress, 'HybridVotingNew', provider);

      let scope = 'current configuration';
      let classes: any[];
      if (argv.proposal !== undefined && argv.proposal !== '') {
        const proposalId = await resolveProposalId(String(argv.proposal), modules.hybridVotingAddress, argv.chain);
        classes = await contract.getProposalClasses(proposalId);
        scope = `snapshot for proposal #${proposalId}`;
      } else {
        classes = await contract.getClasses();
      }

      const [threshold, quorumCount] = await Promise.all([contract.thresholdPct(), contract.quorum()]);
      spin.stop();

      const normalized = classes.map((c: any, i: number) => ({
        classIndex: i,
        strategy: STRATEGY_NAMES[Number(c.strategy)] ?? String(c.strategy),
        slicePct: Number(c.slicePct),
        quadratic: Boolean(c.quadratic),
        minBalance: ethers.BigNumber.from(c.minBalance ?? 0).toString(),
        asset: String(c.asset),
        hatIds: (c.hatIds ?? []).map((h: any) => h.toString()),
      }));

      if (output.isJsonMode()) {
        output.json({
          hybridVoting: modules.hybridVotingAddress,
          scope,
          classes: normalized,
          supportThresholdPct: Number(threshold),
          quorumVoterCount: Number(quorumCount),
        });
        return;
      }

      console.log('');
      console.log(`  Hybrid voting classes — ${scope}:`);
      if (normalized.length === 0) {
        console.log('    (no classes configured)');
      } else {
        output.table(
          ['#', 'Strategy', 'Slice %', 'Quadratic', 'Min balance', 'Asset', 'Hat IDs'],
          normalized.map(c => [
            String(c.classIndex),
            c.strategy,
            `${c.slicePct}%`,
            c.quadratic ? 'yes' : 'no',
            c.minBalance === '0' ? '0' : formatToken(c.minBalance),
            c.asset === ethers.constants.AddressZero ? '—' : formatAddress(c.asset),
            c.hatIds.join(', ') || '—',
          ])
        );
      }
      console.log('');
      // Two DISTINCT validity parameters — do not conflate them:
      // threshold is a % of weighted power, quorum is a raw voter count.
      console.log(`  Support threshold: ${threshold}% (weighted power the winning option needs)`);
      console.log(`  Quorum: ${quorumCount} voters (0 = disabled)`);
      console.log('');
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

// ────────────────────────────── propose ──────────────────────────────

interface ClassesProposeArgs {
  org: string;
  file: string;
  duration: number;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
  'idempotency-key'?: string;
  'no-idempotency'?: boolean;
}

const classesProposeHandler = {
  builder: (yargs: Argv) => yargs
    .option('file', {
      type: 'string',
      demandOption: true,
      describe: 'Path to a ClassConfig[] JSON file (strategy, slicePct, quadratic, minBalance, asset, hatIds)',
    })
    .option('duration', { type: 'number', default: 60, describe: 'Vote duration in minutes' })
    .option('idempotency-key', { type: 'string', describe: 'Explicit idempotency key (default: derived from argv).' })
    .option('no-idempotency', { type: 'boolean', default: false, describe: 'Bypass the idempotency cache and always submit.' })
    .example('pop vote classes propose --file classes.json', 'Propose replacing the voting classes (needs a vote)')
    .example('pop vote classes propose --file classes.json --duration 1440', 'Same, with a 24h voting window'),

  handler: async (argv: ArgumentsCamelCase<ClassesProposeArgs>) => {
    const spin = output.spinner('Building class-change proposal...');
    spin.start();

    try {
      let raw: string;
      try {
        raw = fs.readFileSync(String(argv.file), 'utf-8');
      } catch {
        throw new CliError(`Could not read classes file: ${argv.file}`, EXIT.USAGE, 'Pass --file with a path to a ClassConfig[] JSON file.');
      }
      let doc: any;
      try {
        doc = JSON.parse(raw);
      } catch (parseErr: any) {
        throw new CliError(`Classes file is not valid JSON: ${parseErr?.message ?? parseErr}`, EXIT.USAGE);
      }
      const classes = parseClassConfigs(doc);

      const ctx = await getWriteContext(argv);
      const hybridVotingAddress = ctx.modules?.hybridVotingAddress;
      if (!hybridVotingAddress) {
        throw new CliError(
          'HybridVoting not deployed for this org — voting classes only apply to hybrid voting.',
          EXIT.PRECONDITION
        );
      }

      // setClasses(ClassConfig[]) is executor-gated on HybridVoting, so wrap
      // it in a proposal whose option-0 execution batch calls the voting
      // contract via the Executor (propose-config pattern).
      const iface = new ethers.utils.Interface(loadAbi('HybridVotingNew'));
      const setClassesCall = iface.encodeFunctionData('setClasses', [
        classes.map(c => [c.strategy, c.slicePct, c.quadratic, c.minBalance, c.asset, c.hatIds]),
      ]);
      const batches = [
        [[hybridVotingAddress, ethers.BigNumber.from(0), setClassesCall]], // option 0: apply
        [], // option 1: keep current
      ];

      const classLines = classes.map(describeClass);
      const title = `Update hybrid voting classes (${classes.length} class${classes.length === 1 ? '' : 'es'})`;
      const metadata = {
        description:
          `Replace the hybrid voting class configuration via HybridVoting.setClasses (executor-gated). ` +
          `New classes: ${classLines.map((line, i) => `[${i}] ${line}`).join('; ')}.`,
        optionNames: [title, 'Keep current classes'],
        createdAt: Date.now(),
      };

      await runPreflight(ctx.provider, [checkGasBalance(ctx.address)], { skip: !argv.preflight });
      spin.stop();

      const summary: Record<string, string | number | undefined> = {
        classes: classes.length,
        target: `HybridVoting ${formatAddress(hybridVotingAddress)}`,
        via: `governance proposal (${argv.duration} min vote)`,
      };
      classLines.forEach((line, i) => { summary[`class ${i}`] = line; });
      await confirmWrite(argv, summary, { actionLabel: 'Propose voting class change' });

      const run = async (): Promise<Record<string, any>> => {
        const txSpin = output.spinner('Pinning metadata + creating proposal...');
        txSpin.start();
        const cid = await pinJson(JSON.stringify(metadata));
        const descriptionHash = ipfsCidToBytes32(cid);
        const titleBytes = stringToBytes(title);

        const voting = createWriteContract(hybridVotingAddress, 'HybridVotingNew', ctx.signer);
        const result = await executeTx(
          voting,
          'createProposal',
          [titleBytes, descriptionHash, argv.duration, 2, batches, []],
          { dryRun: argv.dryRun }
        );
        txSpin.stop();

        const proposalEvent = result.logs?.find(l => l.name === 'NewProposal' || l.name === 'NewHatProposal');
        const proposalId = proposalEvent?.args?.id?.toString();

        finishWrite(result, {
          successMsg: proposalId !== undefined
            ? `Proposal #${proposalId} created — needs a vote`
            : 'Proposal created — needs a vote',
          fields: {
            proposalId,
            classes: classes.length,
            duration: `${argv.duration} minutes`,
            ipfsCid: cid,
            nextStep: `pop vote cast --type hybrid --proposal ${proposalId ?? '<id>'} --options 0 --weights 100`,
          },
        });
        return { proposalId, txHash: result.txHash, ipfsCid: cid };
      };

      // Dry runs simulate unconditionally: they neither consult nor record
      // the idempotency cache (nothing lands on-chain).
      if (argv.dryRun) {
        await run();
      } else {
        await withIdempotency(argv, ctx.orgId, 'vote.classes.propose', run);
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

// ────────────────────────────── registration ──────────────────────────────

export function registerClassesCommands(yargs: Argv) {
  return yargs
    .command('show', 'Show the hybrid voting class config + support threshold and quorum', classesShowHandler.builder, classesShowHandler.handler)
    .command('propose', 'Propose replacing the voting classes via setClasses (governance vote)', classesProposeHandler.builder, classesProposeHandler.handler)
    .demandCommand(1, 'Please specify a classes action: show or propose')
    .example('pop vote classes show --json', 'Machine-readable class config dump');
}

export { classesShowHandler, classesProposeHandler };
