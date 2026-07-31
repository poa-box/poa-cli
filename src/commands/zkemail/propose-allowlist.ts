/**
 * pop zkemail propose-allowlist — commit an allowlist root + CID via governance.
 *
 * `ZkEmailInvites.setActiveAllowlist` is onlyExecutor, so this cannot be sent directly by a
 * member wallet — it goes through a HybridVoting proposal whose option 0 executes the call
 * from the Executor. Same shape as the treasury proposals.
 *
 * `--cid` takes the CIDv0 string (Qm…); the contract stores the 32-byte digest, so it is
 * converted here. Passing a raw bytes32 also works.
 *
 * Guard: the supplied root is checked against the pinned file before proposing. Committing a
 * root that does not match the file it points at produces an allowlist where every claim fails
 * to prove — and undoing it costs another full governance cycle.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { getWriteContext, confirmWrite, finishWrite } from '../../lib/command';
import { createWriteContract, createReadContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { resolveZkEmailModule } from './helpers';
import { query } from '../../lib/subgraph';
import { FETCH_ZKEMAIL_ACTIVE_ROOT } from '../../queries/zkemail';
import { assertRootMatches, summarize } from '../../lib/zkemail';
import { fetchJson, pinJson } from '../../lib/ipfs';
import { ipfsCidToBytes32, bytes32ToIpfsCid, stringToBytes } from '../../lib/encoding';
import { CliError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';

interface ProposeArgs {
  org?: string;
  chain?: number;
  root: string;
  cid: string;
  duration: number;
  skipVerify?: boolean;
  yes?: boolean;
  dryRun?: boolean;
}

export const proposeAllowlistHandler = {
  builder: (yargs: Argv) => yargs
    .option('root', { type: 'string', demandOption: true, describe: 'Merkle root from pop zkemail build-allowlist' })
    .option('cid', { type: 'string', demandOption: true, describe: 'IPFS CIDv0 of the pinned allowlist file' })
    .option('duration', { type: 'number', default: 1440, describe: 'Voting window in minutes (default 24h)' })
    .option('skip-verify', {
      type: 'boolean',
      default: false,
      describe: 'Skip fetching the pinned file to confirm it reproduces --root (not recommended)',
    })
    .example('pop zkemail propose-allowlist --root 0x1d5d… --cid QmXyz…', 'Propose committing a new invite allowlist')
    .epilogue('Build the file first: pop zkemail build-allowlist --file entries.json --pin'),

  handler: async (argv: ArgumentsCamelCase<ProposeArgs>) => {
    const spin = output.spinner('Preparing allowlist proposal...');
    spin.start();

    try {
      const ctx = await getWriteContext(argv);
      // getWriteContext already resolved the org's modules — including zkEmailInvitesAddress —
      // so re-resolving here would repeat the org lookup and pull the whole allowlist we discard.
      const orgId = ctx.orgId;
      const orgName: string | null = null;
      const moduleAddr: string | null = ctx.modules?.zkEmailInvitesAddress ?? null;
      if (!moduleAddr) {
        throw new CliError(
          `Org ${orgId} has no ZkEmailInvites module.`,
          EXIT.PRECONDITION,
          'ZK Email invites are opt-in per org — the module is wired at deploy time via '
            + 'OrgDeployer.deployFullOrgWithZkEmail.'
        );
      }

      const hybridVotingAddr = ctx.modules?.hybridVotingAddress;
      if (!hybridVotingAddr) {
        throw new CliError(
          `Org "${orgName || orgId}" has no HybridVoting module, so an executor-gated call cannot be proposed.`,
          EXIT.PRECONDITION
        );
      }

      // Normalize the root and CID.
      let root: string;
      try {
        root = ethers.utils.hexZeroPad(ethers.utils.hexlify(argv.root), 32);
      } catch {
        throw new CliError(`--root "${argv.root}" is not a valid bytes32.`, EXIT.USAGE);
      }
      if (root === ethers.constants.HashZero) {
        throw new CliError(
          'A zero root would make the module dormant and revert every claim.',
          EXIT.USAGE,
          'Pass the root printed by pop zkemail build-allowlist.'
        );
      }

      // ipfsCidToBytes32 falls back to keccak256(string) for anything that is neither a Qm…
      // CIDv0 nor a 0x-bytes32, which yields a non-zero digest that sails past a HashZero check
      // and commits a dead pointer on-chain. Accept only the two forms the contract can round-trip.
      const isCidV0 = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(argv.cid);
      const isBytes32 = /^0x[0-9a-fA-F]{64}$/.test(argv.cid);
      if (!isCidV0 && !isBytes32) {
        throw new CliError(
          `--cid "${argv.cid}" is not a CIDv0 (Qm…) or a 0x bytes32 digest.`,
          EXIT.USAGE,
          argv.cid.startsWith('baf')
            ? 'That looks like a CIDv1. The contract stores a raw 32-byte multihash digest, so the '
              + 'file must be pinned as CIDv0 — re-pin with --cid-version=0 (pop pins CIDv0 by default).'
            : 'Pass the CID printed by pop zkemail build-allowlist --pin.'
        );
      }
      const cidDigest = ipfsCidToBytes32(argv.cid);
      if (cidDigest === ethers.constants.HashZero) {
        throw new CliError(`--cid "${argv.cid}" did not decode to a valid digest.`, EXIT.USAGE);
      }
      const cidV0 = isCidV0 ? argv.cid : bytes32ToIpfsCid(cidDigest);

      // Verify the pinned file actually reproduces the root being committed.
      let entrySummary = '(not verified)';
      if (!argv.skipVerify) {
        spin.text = 'Verifying pinned allowlist reproduces the root...';
        const doc = await fetchJson<any>(cidV0 || argv.cid);
        if (!doc) {
          throw new CliError(
            `Could not fetch allowlist ${cidV0 || argv.cid} from IPFS.`,
            EXIT.INFRA,
            'Pin the file before proposing, or pass --skip-verify if you are certain it is retrievable.'
          );
        }
        // Mismatch here means --root and --cid disagree; committing them would cost a full
        // governance cycle to undo, so fail before the proposal exists.
        assertRootMatches(doc, root, 'root you are proposing (--root)');
        const s = summarize(doc);
        entrySummary = `${doc.entries?.length ?? 0} entries (${s.domains.length} domain, ${s.emails.length} specific)`;
      }

      // Read the current commit so the diff is visible before voting.
      //
      // The root is DISPLAY ONLY (the confirm diff and the proposal description), so it comes
      // from the indexed ZkEmailInvites.activeRoot — the same value the sibling
      // helpers.readModuleState already serves without an eth_call, which this file used to
      // bypass. A module row that exists with a null activeRoot is dormant, exactly what
      // merkleRoot() == 0 means on-chain; a MISSING row means "not indexed yet" and falls back
      // to the contract so a brand-new module still renders its real root.
      //
      // `executor` deliberately stays on-chain. It gates the Unauthorized check below, and
      // being wrong there costs a full governance cycle — the one place subgraph lag is
      // unacceptable in this command.
      const readModule = createReadContract(moduleAddr, 'ZkEmailInvites', ctx.provider);
      const [indexedRoot, moduleExecutor] = await Promise.all([
        query<{ organization: any }>(FETCH_ZKEMAIL_ACTIVE_ROOT, { orgId }, argv.chain)
          .then((res) => {
            const mod = res.organization?.zkEmailInvites;
            // Guard on identity: a stale org->module pointer must not describe a different
            // contract than the one the proposal targets.
            if (!mod?.id || String(mod.id).toLowerCase() !== moduleAddr.toLowerCase()) return null;
            return (mod.activeRoot as string | null) ?? ethers.constants.HashZero;
          })
          .catch(() => null),
        readModule.executor() as Promise<string>,
      ]);
      const currentRoot: string = indexedRoot ?? (await readModule.merkleRoot());

      // setActiveAllowlist is onlyExecutor, and the proposal executes from the org's Executor.
      // If the module answers to a different one the call reverts Unauthorized only AFTER the
      // full voting window — check now, while it is still free.
      const orgExecutor = ctx.modules?.executorAddress;
      if (orgExecutor && moduleExecutor.toLowerCase() !== orgExecutor.toLowerCase()) {
        throw new CliError(
          `The ZkEmailInvites module answers to executor ${moduleExecutor}, but this org's Executor `
            + `is ${orgExecutor}. A proposal from this org could never execute the call.`,
          EXIT.PRECONDITION,
          'The module was deployed against a different executor, or the executor was rotated. '
            + 'Re-wire the module before proposing.'
        );
      }

      spin.stop();

      await confirmWrite(argv, {
        module: moduleAddr,
        currentRoot: currentRoot === ethers.constants.HashZero ? '(dormant — no allowlist)' : currentRoot,
        newRoot: root,
        cid: cidV0 ?? argv.cid,
        allowlist: entrySummary,
        via: `HybridVoting proposal (${argv.duration} min vote)`,
        org: orgName || orgId,
        chain: ctx.networkName,
      }, { destructive: true, actionLabel: 'About to propose REPLACING the ZK Email invite allowlist' });

      spin.start();

      const call = readModule.interface.encodeFunctionData('setActiveAllowlist', [root, cidDigest]);
      const batches = [[[moduleAddr, ethers.BigNumber.from(0), call]], []];

      const metadata = {
        description:
          `Set the ZK Email invite allowlist to root ${root} (IPFS ${cidV0 ?? argv.cid}). `
          + `${entrySummary}. Replaces ${currentRoot === ethers.constants.HashZero ? 'no active allowlist' : currentRoot}. `
          + 'Anyone who can prove a DKIM-signed email from an allowlisted domain or address may then claim the listed role hats.',
        optionNames: ['Set this allowlist', 'Keep the current allowlist'],
        createdAt: Date.now(),
      };

      spin.text = 'Pinning proposal metadata...';
      const metaCid = await pinJson(JSON.stringify(metadata));
      const descriptionHash = ipfsCidToBytes32(metaCid);
      const titleBytes = stringToBytes('Set ZK Email invite allowlist');

      spin.text = 'Sending transaction...';
      const voting = createWriteContract(hybridVotingAddr, 'HybridVotingNew', ctx.signer);
      const result = await executeTx(
        voting,
        'createProposal',
        [titleBytes, descriptionHash, argv.duration, 2, batches, []],
        { dryRun: argv.dryRun }
      );
      spin.stop();

      const proposalEvent = result.logs?.find(l => l.name === 'NewProposal' || l.name === 'NewHatProposal');
      const proposalId = proposalEvent?.args?.id?.toString();

      finishWrite(result, {
        successMsg: 'ZK Email allowlist proposal created',
        fields: {
          proposalId,
          module: moduleAddr,
          newRoot: root,
          cid: cidV0 ?? argv.cid,
          allowlist: entrySummary,
          duration: `${argv.duration} minutes`,
          metadataCid: metaCid,
          nextStep: `pop vote cast --proposal ${proposalId ?? '<id>'} --choice 0`,
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
