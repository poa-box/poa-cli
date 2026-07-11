/**
 * pop task folders — org folder-tree root (TaskManager v4+).
 *
 * The folder structure itself (names, parents, project assignments) lives
 * off-chain in IPFS as JSON; only the 32-byte root digest is on-chain. The
 * subgraph schema documents the encoding: "bytes32 sha256 digest; frontend
 * prepends 0x1220 and base58-encodes to a CIDv0" — which is exactly what
 * lib/encoding's bytes32ToIpfsCid/ipfsCidToBytes32 implement.
 *
 * setFolders(expectedCurrentRoot, newRoot) is CAS-guarded (verified contracts
 * origin/main src/TaskManager.sol): if another organizer published first the
 * call reverts FoldersRootStale(expected, actual). `set` auto-fills the
 * expected root from chain and, on a stale revert, re-reads and retries ONCE.
 * Permission: executor or any organizer hat (_requireOrganizer).
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { ipfsCidToBytes32, bytes32ToIpfsCid, formatAddress } from '../../lib/encoding';
import { detectTaskManagerFeatures, featureUnavailable } from '../../lib/version';
import { getFoldersRoot, getOrganizerHats } from '../../lib/task-lens';
import { getWriteContext, confirmWrite, finishWrite } from '../../lib/command';
import { runPreflight, checkGasBalance } from '../../lib/preflight';
import { requireModule, resolveOrgModules } from '../../lib/resolve';
import { resolveNetworkConfig } from '../../config/networks';
import { formatRelativeTime } from '../../lib/format';
import { CliError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import { queryWithFieldFallback } from '../../lib/subgraph';
import * as output from '../../lib/output';

/** Tier 0: v4 schema with folders provenance on Organization. */
const FOLDERS_QUERY_FULL = `
  query OrgFolders($orgId: Bytes!) {
    organization(id: $orgId) {
      id
      foldersRoot
      foldersUpdatedAt
      foldersUpdatedBy
    }
  }
`;

/** Tier 1: pre-folders schema. */
const FOLDERS_QUERY_LEGACY = `
  query OrgFoldersLegacy($orgId: Bytes!) {
    organization(id: $orgId) {
      id
    }
  }
`;

/**
 * Parse --new-root input: CIDv0 (Qm…), 0x-prefixed bytes32, or "clear".
 * Deliberately stricter than ipfsCidToBytes32 (which keccaks arbitrary
 * strings — a silent footgun for a root pointer).
 */
export function parseFoldersRoot(input: string): string {
  const trimmed = (input || '').trim();
  if (trimmed.toLowerCase() === 'clear') return ethers.constants.HashZero;
  if (trimmed.startsWith('0x')) {
    if (trimmed.length === 66 && ethers.utils.isHexString(trimmed, 32)) return trimmed.toLowerCase();
    throw new CliError(`Invalid bytes32 root "${input}".`, EXIT.USAGE, 'Pass a 32-byte 0x-prefixed hex value, a Qm… CIDv0, or "clear".');
  }
  if (trimmed.startsWith('Qm')) {
    const converted = ipfsCidToBytes32(trimmed);
    if (converted === ethers.constants.HashZero) {
      throw new CliError(`Could not decode CIDv0 "${input}".`, EXIT.USAGE, 'Check the CID — it must be a base58 CIDv0 (Qm…, 46 chars).');
    }
    return converted;
  }
  throw new CliError(`Unparseable --new-root "${input}".`, EXIT.USAGE, 'Pass a Qm… CIDv0, a 0x-prefixed bytes32, or "clear".');
}

function describeRoot(root: string): { root: string; cid?: string } {
  if (root === ethers.constants.HashZero) return { root: 'none (zero)' };
  return { root, cid: bytes32ToIpfsCid(root) ?? undefined };
}

// ────────────────────────────── show ──────────────────────────────

interface FoldersShowArgs {
  org: string;
  chain?: number;
  rpc?: string;
}

const foldersShowHandler = {
  builder: (yargs: Argv) => yargs
    .example('pop task folders show', 'Current folder-tree root, as bytes32 and CIDv0'),

  handler: async (argv: ArgumentsCamelCase<FoldersShowArgs>) => {
    const spin = output.spinner('Reading folders root...');
    spin.start();

    try {
      const modules = await resolveOrgModules(argv.org, argv.chain);
      const taskManagerAddress = requireModule(modules, 'taskManagerAddress');

      const netConfig = resolveNetworkConfig(argv.chain);
      const provider = new ethers.providers.JsonRpcProvider(netConfig.resolvedRpc, netConfig.chainId);

      const features = await detectTaskManagerFeatures(provider, taskManagerAddress, netConfig.chainId);
      if (!features.folders) {
        spin.stop();
        output.error(featureUnavailable(
          'task folders',
          'TaskManager v4',
          'Upgrade the org TaskManager beacon to use folder organization.'
        ));
        process.exit(EXIT.PRECONDITION);
        return;
      }

      const root = await getFoldersRoot(provider, taskManagerAddress);
      let organizerHats: string[] = [];
      try {
        organizerHats = (await getOrganizerHats(provider, taskManagerAddress)).map((h) => h.toString());
      } catch { /* corroboration only */ }

      // Subgraph provenance (who last moved the root, when) — best-effort.
      let updatedAt: string | undefined;
      let updatedBy: string | undefined;
      try {
        const { data } = await queryWithFieldFallback<any>([
          { query: FOLDERS_QUERY_FULL, variables: { orgId: modules.orgId } },
          { query: FOLDERS_QUERY_LEGACY, variables: { orgId: modules.orgId } },
        ], { chainId: argv.chain });
        if (data.organization?.foldersUpdatedAt) {
          updatedAt = formatRelativeTime(Number(data.organization.foldersUpdatedAt));
        }
        if (data.organization?.foldersUpdatedBy) {
          updatedBy = data.organization.foldersUpdatedBy;
        }
      } catch { /* provenance only */ }

      spin.stop();

      const described = describeRoot(root);
      if (output.isJsonMode()) {
        output.json({
          taskManager: taskManagerAddress,
          foldersRoot: root,
          cid: described.cid ?? null,
          isSet: root !== ethers.constants.HashZero,
          organizerHatIds: organizerHats,
          lastUpdatedAt: updatedAt,
          lastUpdatedBy: updatedBy,
          _source: 'chain lens (authoritative) + subgraph provenance',
        });
        return;
      }

      console.log('');
      output.keyValueBlock('Task folders', {
        root: described.root,
        cid: described.cid,
        'organizer hats': organizerHats.join(', ') || 'none (executor only)',
        'last updated': updatedAt && updatedBy ? `${updatedAt} by ${formatAddress(updatedBy)}` : updatedAt,
      });
      if (root === ethers.constants.HashZero) {
        output.info('No folder tree published yet — set one with pop task folders set --new-root <cid>.');
      }
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

// ────────────────────────────── set ──────────────────────────────

interface FoldersSetArgs {
  org: string;
  'new-root': string;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
}

const foldersSetHandler = {
  builder: (yargs: Argv) => yargs
    .option('new-root', {
      type: 'string',
      demandOption: true,
      describe: 'New folder-tree root: Qm… CIDv0, 0x-prefixed bytes32, or "clear"',
    })
    .example('pop task folders set --new-root QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG', 'Publish a new folder tree (expected current root auto-filled from chain)'),

  handler: async (argv: ArgumentsCamelCase<FoldersSetArgs>) => {
    const spin = output.spinner('Reading current folders root...');
    spin.start();

    try {
      const newRoot = parseFoldersRoot(argv.newRoot as string);

      const ctx = await getWriteContext(argv);
      const taskManagerAddress = requireModule(ctx.modules, 'taskManagerAddress');

      const features = await detectTaskManagerFeatures(ctx.provider, taskManagerAddress, ctx.chainId);
      if (!features.folders) {
        spin.stop();
        output.error(featureUnavailable(
          'task folders',
          'TaskManager v4',
          'Upgrade the org TaskManager beacon to use folder organization.'
        ));
        process.exit(EXIT.PRECONDITION);
        return;
      }

      // CAS auto-fill: the contract wants the root we believe is current.
      const currentRoot = await getFoldersRoot(ctx.provider, taskManagerAddress);
      if (currentRoot.toLowerCase() === newRoot.toLowerCase()) {
        spin.stop();
        output.success('Folders root already up to date — nothing to change', {
          foldersRoot: currentRoot,
          cid: describeRoot(currentRoot).cid,
        });
        return;
      }

      await runPreflight(ctx.provider, [checkGasBalance(ctx.address)], { skip: !argv.preflight });

      spin.stop();

      const currentDesc = describeRoot(currentRoot);
      const newDesc = describeRoot(newRoot);
      await confirmWrite(argv, {
        'current root': currentDesc.root,
        'new root': newDesc.root,
        'new cid': newDesc.cid,
        note: 'CAS-guarded: reverts FoldersRootStale if another organizer publishes first',
      }, { actionLabel: 'Update task folders root' });

      const txSpin = output.spinner('Sending setFolders...');
      txSpin.start();
      const contract = createWriteContract(taskManagerAddress, 'TaskManagerNew', ctx.signer);
      let expectedRoot = currentRoot;
      let result = await executeTx(contract, 'setFolders', [expectedRoot, newRoot], { dryRun: argv.dryRun });

      // CAS race: someone published between our read and our tx. Re-read the
      // fresh root and retry exactly once (mirrors the frontend's UX contract).
      const isStale = !result.success && (
        result.errorName === 'FoldersRootStale'
        || /FoldersRootStale/i.test(result.error ?? '')
        || /FoldersRootStale/i.test(result.rawMessage ?? '')
      );
      if (isStale) {
        const freshRoot = await getFoldersRoot(ctx.provider, taskManagerAddress);
        if (freshRoot.toLowerCase() === newRoot.toLowerCase()) {
          txSpin.stop();
          output.success('Folders root already set by another organizer — nothing to change', {
            foldersRoot: freshRoot,
            cid: describeRoot(freshRoot).cid,
          });
          return;
        }
        txSpin.stop();
        output.warn(`Folders root moved while sending (FoldersRootStale) — retrying once against the fresh root ${freshRoot.slice(0, 10)}…`);
        txSpin.start();
        expectedRoot = freshRoot;
        result = await executeTx(contract, 'setFolders', [expectedRoot, newRoot], { dryRun: argv.dryRun });
      }
      txSpin.stop();

      finishWrite(result, {
        successMsg: 'Folders root updated',
        fields: {
          foldersRoot: newRoot,
          cid: newDesc.cid,
          previousRoot: expectedRoot,
          retriedAfterStaleRoot: isStale || undefined,
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

// ────────────────────────────── registration ──────────────────────────────

export function registerFoldersCommands(yargs: Argv) {
  return yargs
    .command('show', 'Show the org folder-tree root (bytes32 + CIDv0)', foldersShowHandler.builder, foldersShowHandler.handler)
    .command('set', 'Publish a new folder-tree root (CAS-guarded; organizer hat/executor)', foldersSetHandler.builder, foldersSetHandler.handler)
    .demandCommand(1, 'Please specify a folders action: show or set')
    .example('pop task folders show --json', 'Machine-readable folders root');
}

export { foldersShowHandler, foldersSetHandler };
