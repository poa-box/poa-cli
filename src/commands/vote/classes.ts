/**
 * pop vote classes — N-class hybrid voting configuration.
 *
 * Two nested subcommands (template: task/perms.ts):
 *   show    — read-only table of the current class config or the snapshot
 *             frozen for one proposal, plus the two distinct validity
 *             parameters: support threshold (% of weighted power,
 *             thresholdPct) and quorum (VOTER COUNT, quorum).
 *             Served from the subgraph (VotingClass rows +
 *             HybridVotingContract.thresholdPct/quorum — the same source
 *             `pop vote results` uses), with getClasses()/
 *             getProposalClasses()/thresholdPct()/quorum() kept as the
 *             fallback for un-indexed contracts and older deployments.
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
import { queryWithFieldFallback } from '../../lib/subgraph';
import {
  FETCH_VOTING_CLASS_CONFIG_EXACT,
  FETCH_PROPOSAL_VOTING_CLASSES_EXACT,
  selectIndexedClassSnapshot,
  FETCH_VOTING_CLASS_CONFIG,
  FETCH_VOTING_CLASS_CONFIG_LEGACY,
  FETCH_PROPOSAL_VOTING_CLASSES,
  selectClassSnapshot,
  SubgraphVotingClass,
} from '../../queries/voting-classes';
import { CliError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';
import { resolveProposalId } from './helpers';
import { tryAggregate } from '../../lib/multicall';

// One parser validates native subject IDs and ABI-compatible legacy hatIds in both hosts.
import { CLASS_STRATEGY, MAX_CLASSES, parseClassConfigs, describeClass } from '@poa-box/core/tx/vote';
import type { ParsedClassConfig } from '@poa-box/core/tx/vote';
export { CLASS_STRATEGY, MAX_CLASSES, parseClassConfigs, describeClass };
export type { ParsedClassConfig };
const STRATEGY_NAMES = ['DIRECT', 'ERC20_BAL'] as const;

// ────────────────────────────── show ──────────────────────────────

interface ClassesShowArgs {
  org: string;
  proposal?: string;
  chain?: number;
  rpc?: string;
}

/** Normalized class row — identical shape from the subgraph and the contract. */
interface NormalizedClass {
  classIndex: number;
  strategy: string;
  slicePct: number;
  quadratic: boolean;
  minBalance: string;
  asset: string;
  hatIds: string[];
  subjectId: string | null;
  subjectBindingKnown: boolean;
}

/**
 * Subgraph rows → the exact shape the contract path produces. `asset` is
 * checksummed because ethers returns a checksummed address and the subgraph
 * returns lowercase Bytes; without this the --json `asset` value would change
 * casing depending on which source answered.
 */
function normalizeSubgraphClasses(rows: SubgraphVotingClass[]): NormalizedClass[] {
  return rows.map((c, i) => ({
    classIndex: i,
    strategy: String(c.strategy),
    slicePct: Number(c.slicePct),
    quadratic: Boolean(c.quadratic),
    minBalance: ethers.BigNumber.from(String(c.minBalance ?? '0')).toString(),
    asset: ethers.utils.getAddress(String(c.asset)),
    hatIds: (c.hatIds ?? []).map(h => String(h)),
    subjectId: null,
    subjectBindingKnown: false,
  }));
}

interface ClassConfigSnapshot {
  classes: NormalizedClass[];
  supportThresholdPct: number;
  quorumVoterCount: number;
  effectiveQuorumVoterCount: number | null;
}

/**
 * Subgraph read of the class table + both validity parameters. Returns null
 * whenever the subgraph cannot answer authoritatively (contract not indexed,
 * no rows for the requested version, missing schema fields, network error) so
 * the caller falls back to the contract instead of printing an empty table.
 *
 * `vote results` already sources thresholdPct/quorum from HybridVotingContract;
 * reading them here too keeps one command family on one source of truth.
 */
async function fetchClassConfigFromSubgraph(
  hybridVotingAddress: string,
  proposalId: number | undefined,
  chainId?: number
): Promise<ClassConfigSnapshot | null> {
  try {
    const hybridVoting = hybridVotingAddress.toLowerCase();
    // The proposal-snapshot query has a single tier on purpose: a deployment
    // without Proposal.classesVersion cannot identify the frozen snapshot, and
    // guessing the newest version would silently misreport an old proposal.
    const tiers = proposalId === undefined
      ? [
          { query: FETCH_VOTING_CLASS_CONFIG_EXACT, variables: { hybridVoting } },
          { query: FETCH_VOTING_CLASS_CONFIG, variables: { hybridVoting } },
          { query: FETCH_VOTING_CLASS_CONFIG_LEGACY, variables: { hybridVoting } },
        ]
      : [
          { query: FETCH_PROPOSAL_VOTING_CLASSES_EXACT, variables: { hybridVoting, proposalId: String(proposalId) } },
          { query: FETCH_PROPOSAL_VOTING_CLASSES, variables: { hybridVoting, proposalId: String(proposalId) } },
        ];

    const { data } = await queryWithFieldFallback<any>(tiers, { chainId });
    const contract = data?.hybridVotingContract;
    if (!contract) return null;

    const version = proposalId === undefined
      ? contract.classVersion
      : contract.proposals?.[0]?.classesVersion;
    // For a proposal we must know its frozen version — no version, no answer.
    if (proposalId !== undefined && (version === null || version === undefined)) return null;
    // Restricted V2 polls can have a synthetic equal-weight snapshot that the
    // index's org-level classVersion cannot reconstruct.
    if (proposalId !== undefined && contract.proposals?.[0]?.isHatRestricted !== false) return null;

    const rows = selectIndexedClassSnapshot(contract, proposalId);
    if (rows.length === 0) return null;
    if (contract.thresholdPct === null || contract.thresholdPct === undefined) return null;
    if (contract.quorum === null || contract.quorum === undefined) return null;

    return {
      classes: normalizeSubgraphClasses(rows),
      supportThresholdPct: Number(contract.thresholdPct),
      quorumVoterCount: Number(contract.quorum),
      effectiveQuorumVoterCount: proposalId === undefined || contract.proposals?.[0]?.isHatRestricted === false ? Number(contract.quorum) : null,
    };
  } catch {
    // Any subgraph problem (unknown field on an old deployment, lag, HTTP) —
    // the contract is authoritative anyway, so just fall back.
    return null;
  }
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

      let scope = 'current configuration';
      let proposalId: number | undefined;
      if (argv.proposal !== undefined && argv.proposal !== '') {
        proposalId = await resolveProposalId(String(argv.proposal), modules.hybridVotingAddress, argv.chain);
        scope = `snapshot for proposal #${proposalId}`;
      }

      // Subgraph first — VotingClass mirrors getClasses()/getProposalClasses()
      // row for row (verified live: strategy DIRECT/ERC20_BAL, slicePct,
      // quadratic, minBalance, asset, hatIds), and HybridVotingContract carries
      // thresholdPct/quorum. Three contract reads become zero.
      //
      // An explicit --rpc is an explicit instruction about WHERE to read (a
      // fork, a private node), so it opts out of the subgraph entirely rather
      // than being silently ignored.
      let normalized: NormalizedClass[];
      let threshold: number;
      let quorumCount: number;
      let effectiveQuorum: number | null = null;
      let source: 'subgraph' | 'rpc';

      const fromSubgraph = argv.rpc
        ? null
        : await fetchClassConfigFromSubgraph(modules.hybridVotingAddress, proposalId, argv.chain);
      if (fromSubgraph) {
        normalized = fromSubgraph.classes;
        threshold = fromSubgraph.supportThresholdPct;
        quorumCount = fromSubgraph.quorumVoterCount;
        effectiveQuorum = fromSubgraph.effectiveQuorumVoterCount;
        source = 'subgraph';
      } else {
        const provider = createProvider({ chainId: argv.chain, rpcUrl: argv.rpc });
        const contract = createReadContract(modules.hybridVotingAddress, 'HybridVotingNew', provider);
        const classes: any[] = proposalId !== undefined
          ? await contract.getProposalClasses(proposalId)
          : await contract.getClasses();
        const [rawThreshold, rawQuorum] = await Promise.all([contract.thresholdPct(), contract.quorum()]);
        normalized = classes.map((c: any, i: number) => ({
          classIndex: i,
          strategy: STRATEGY_NAMES[Number(c.strategy)] ?? String(c.strategy),
          slicePct: Number(c.slicePct),
          quadratic: Boolean(c.quadratic),
          minBalance: ethers.BigNumber.from(c.minBalance ?? 0).toString(),
          asset: String(c.asset),
          hatIds: (c.hatIds ?? []).map((h: any) => h.toString()),
          subjectId: null,
          subjectBindingKnown: false,
        }));
        // A stable class binding takes precedence over the ABI's legacy hatIds
        // list. Read it alongside the existing authoritative RPC fallback;
        // old implementations or failed calls leave it explicitly unknown.
        try {
          const iface = new ethers.utils.Interface(loadAbi('HybridVotingNew'));
          const first = await tryAggregate(provider, normalized.map(c => ({
            to: modules.hybridVotingAddress!, data: proposalId !== undefined
              ? iface.encodeFunctionData('proposalClassSubject', [proposalId, c.classIndex])
              : iface.encodeFunctionData('classIdOfIndex', [c.classIndex]),
          })));
          const ids = first.map(r => r.success && r.returnData !== '0x' ? ethers.BigNumber.from(r.returnData) : null);
          const bindings = proposalId !== undefined ? ids : await (async () => {
            const rows = await tryAggregate(provider, ids.map(id => ({ to: modules.hybridVotingAddress!, data: iface.encodeFunctionData('classSubjectOf', [id ?? 0]) })));
            return rows.map((r, i) => ids[i] !== null && r.success && r.returnData !== '0x' ? ethers.BigNumber.from(r.returnData) : null);
          })();
          normalized.forEach((c, i) => { c.subjectId = bindings[i]?.toString() ?? null; c.subjectBindingKnown = bindings[i] !== null; });
        } catch { /* Unknown bindings must never be reported as a fallback electorate. */ }
        threshold = Number(rawThreshold);
        quorumCount = Number(rawQuorum);
        if (proposalId === undefined) effectiveQuorum = quorumCount;
        source = 'rpc';
      }
      spin.stop();

      if (output.isJsonMode()) {
        output.json({
          hybridVoting: modules.hybridVotingAddress,
          scope,
          classes: normalized,
          supportThresholdPct: threshold,
          quorumVoterCount: quorumCount,
          quorumSource: 'current-global-config',
          effectiveQuorumVoterCount: effectiveQuorum,
          source,
        });
        return;
      }

      console.log('');
      console.log(`  Hybrid voting classes — ${scope}:`);
      if (normalized.length === 0) {
        console.log('    (no classes configured)');
      } else {
        output.table(
          ['#', 'Strategy', 'Slice %', 'Quadratic', 'Min balance', 'Asset', 'Authority subjects'],
          normalized.map(c => [
            String(c.classIndex),
            c.strategy,
            `${c.slicePct}%`,
            c.quadratic ? 'yes' : 'no',
            c.minBalance === '0' ? '0' : formatToken(c.minBalance),
            c.asset === ethers.constants.AddressZero ? '—' : formatAddress(c.asset),
            !c.subjectBindingKnown ? `binding unknown; fallback: ${c.hatIds.join(', ') || 'open'}`
              : c.subjectId !== '0' ? `binding: ${c.subjectId}` : c.hatIds.join(', ') || 'open',
          ])
        );
      }
      console.log('');
      // Two DISTINCT validity parameters — do not conflate them:
      // threshold is a % of weighted power, quorum is a raw voter count.
      console.log(`  Support threshold: ${threshold}% (weighted power the winning option needs)`);
      console.log(`  Global quorum: ${quorumCount} voters (0 = disabled)`);
      if (proposalId !== undefined) console.log(effectiveQuorum === null
        ? '  Effective proposal quorum is unavailable: restricted polls can override the global quorum.'
        : `  Effective proposal quorum: ${effectiveQuorum} voters`);
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
      describe: 'Path to a ClassConfig[] JSON file (strategy, slicePct, quadratic, minBalance, asset, subjectIds; optional subjectId sets a stable binding, 0 clears it)',
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
        [[hybridVotingAddress, ethers.BigNumber.from(0), setClassesCall], ...classes.flatMap((c, index) => c.subjectId === undefined ? [] : [
          [hybridVotingAddress, ethers.BigNumber.from(0), iface.encodeFunctionData('setClassSubject', [index, c.subjectId])],
        ])], // option 0: apply classes and explicit stable bindings
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
        const cid = argv.dryRun ? undefined : await pinJson(JSON.stringify(metadata));
        const descriptionHash = cid ? ipfsCidToBytes32(cid) : ethers.constants.HashZero;
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
