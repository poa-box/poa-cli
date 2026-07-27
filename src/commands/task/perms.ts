/**
 * pop task perms — TaskPerm bitmask inspection and management.
 *
 * Three subcommands:
 *   show           — global hat→mask table (subgraph GlobalRolePermission) +
 *                    per-project overrides (--project), corroborated by the
 *                    on-chain lens (organizer + permission hat arrays).
 *   set            — per-project override via setProjectRolePerm(pid,hat,mask).
 *                    Gate (verified contracts origin/main TaskManager.sol):
 *                    _requireCreator() — creator hat or executor → DIRECT tx.
 *   propose-global — global mask via setConfig(ROLE_PERM, abi.encode(hat,mask)).
 *                    Gate: _requireExecutor() → must ship as a governance
 *                    proposal whose execution batch targets the TaskManager.
 *
 * ConfigKey enum VERIFIED against contracts origin/main src/TaskManager.sol:
 *   EXECUTOR=0, CREATOR_HAT_ALLOWED=1, ROLE_PERM=2, PROJECT_ROLE_PERM=3,
 *   BOUNTY_CAP=4, PROJECT_MANAGER=5, PROJECT_CAP=6, ORGANIZER_HAT_ALLOWED=7.
 *
 * Masks are NOT readable per-wearer on-chain (only the subgraph indexes the
 * hat→mask events), so `show` is subgraph-first with the lens hat arrays as
 * corroboration, and the write paths let a decoded Unauthorized revert (which
 * carries the perms hint via the error catalog) be the authority.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { pinJson } from '../../lib/ipfs';
import { stringToBytes, ipfsCidToBytes32, parseProjectId, formatAddress } from '../../lib/encoding';
import { parsePermList, formatMask, describeMask, PERM_BITS } from '../../lib/perms';
import {
  STORAGE_KEYS,
  encodeLensCall,
  decodeLensResult,
  getOrganizerHats,
  getPermissionHats,
} from '../../lib/task-lens';
import { getWriteContext, confirmWrite, finishWrite } from '../../lib/command';
import { runPreflight, checkGasBalance, PreflightCheck } from '../../lib/preflight';
import { requireModule, resolveOrgModules } from '../../lib/resolve';
import { resolveNetworkConfig } from '../../config/networks';
import { CliError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import { queryWithFieldFallback } from '../../lib/subgraph';
import * as output from '../../lib/output';

/** TaskManager.ConfigKey.ROLE_PERM — verified enum index (see header). */
export const CONFIG_KEY_ROLE_PERM = 2;

/**
 * Tier 0: deployed v4 schema — GlobalRolePermission masks, organizerHatIds,
 * per-project ProjectRolePermission masks.
 */
const PERMS_QUERY_FULL = `
  query TaskPermsFull($orgId: Bytes!) {
    organization(id: $orgId) {
      id
      taskManager {
        id
        creatorHatIds
        organizerHatIds
        globalRolePermissions { hatId mask }
        projects(where: { deleted: false }, first: 50) {
          id
          title
          rolePermissions { hatId mask }
        }
      }
    }
  }
`;

/** Tier 1: older schema — no global perms/organizer hats; boolean per-project flags. */
const PERMS_QUERY_LEGACY = `
  query TaskPermsLegacy($orgId: Bytes!) {
    organization(id: $orgId) {
      id
      taskManager {
        id
        creatorHatIds
        projects(where: { deleted: false }, first: 50) {
          id
          title
          rolePermissions { hatId canCreate canClaim canReview canAssign }
        }
      }
    }
  }
`;

/** Rebuild a mask from tier-1 boolean flags (partial: only bits 1..8 indexable). */
function maskFromBooleans(rp: any): number {
  let mask = 0;
  if (rp.canCreate) mask |= PERM_BITS.create;
  if (rp.canClaim) mask |= PERM_BITS.claim;
  if (rp.canReview) mask |= PERM_BITS.review;
  if (rp.canAssign) mask |= PERM_BITS.assign;
  return mask;
}

/** Parse a --hat argument (decimal or 0x hex) into a BigNumber hat ID. */
function parseHatId(input: string): ethers.BigNumber {
  try {
    return ethers.BigNumber.from(String(input).trim());
  } catch {
    throw new CliError(`Invalid --hat "${input}".`, EXIT.USAGE, 'Pass the hat ID as a decimal or 0x-hex integer (see pop org roles).');
  }
}

/**
 * Resolve --project input (bytes32 hex, subgraph composite ID, or title) to
 * the on-chain bytes32 pid using an already-fetched projects list.
 */
function resolveProjectFromList(projects: any[], input: string): { pid: string; title?: string } {
  if (input.startsWith('0x') && input.length === 66) {
    const match = projects.find((p: any) => parseProjectId(p.id) === input);
    return { pid: input, title: match?.title };
  }
  const byTitle = projects.find((p: any) => (p.title || '').toLowerCase() === input.toLowerCase());
  if (byTitle) return { pid: parseProjectId(byTitle.id), title: byTitle.title };
  const available = projects.map((p: any) => p.title).filter(Boolean).join(', ');
  throw new CliError(
    `Project "${input}" not found.`,
    EXIT.USAGE,
    `Available projects: ${available || 'none'} (or pass the 0x-prefixed bytes32 project ID).`
  );
}

/** Project exists on-chain (lens PROJECT_INFO → (cap, spent, exists)). */
function checkProjectExists(taskManagerAddr: string, pid: string): PreflightCheck {
  return {
    label: `project ${pid.slice(0, 10)}…`,
    call: {
      to: taskManagerAddr,
      data: encodeLensCall(STORAGE_KEYS.PROJECT_INFO, ethers.utils.defaultAbiCoder.encode(['bytes32'], [pid])),
    },
    interpret: (returnData, success) => {
      if (!success || !returnData || returnData === '0x') {
        return { ok: false, detail: 'could not read the project on-chain', suggestion: 'check the project ID with pop project list' };
      }
      const [, , exists] = ethers.utils.defaultAbiCoder.decode(
        ['uint128', 'uint128', 'bool'],
        decodeLensResult(returnData)
      );
      if (exists) return { ok: true };
      return { ok: false, detail: 'project does not exist on-chain', suggestion: 'list projects with pop project list' };
    },
  };
}

// ────────────────────────────── show ──────────────────────────────

interface PermsShowArgs {
  org: string;
  project?: string;
  chain?: number;
  rpc?: string;
}

const permsShowHandler = {
  builder: (yargs: Argv) => yargs
    .option('project', { type: 'string', describe: 'Also show this project\'s per-hat overrides (ID or name)' })
    .example('pop task perms show', 'Global hat→permission table for the org')
    .example('pop task perms show --project "Protocol Work"', 'Include one project\'s overrides'),

  handler: async (argv: ArgumentsCamelCase<PermsShowArgs>) => {
    const spin = output.spinner('Fetching permission masks...');
    spin.start();

    try {
      const modules = await resolveOrgModules(argv.org, argv.chain);
      const taskManagerAddress = requireModule(modules, 'taskManagerAddress');

      const { data, tierIndex } = await queryWithFieldFallback<any>([
        { query: PERMS_QUERY_FULL, variables: { orgId: modules.orgId } },
        { query: PERMS_QUERY_LEGACY, variables: { orgId: modules.orgId } },
      ], { chainId: argv.chain });
      const tm = data.organization?.taskManager;
      if (!tm) {
        spin.stop();
        output.error('No TaskManager indexed for this org yet.', { suggestion: 'The subgraph may still be syncing — retry shortly.' });
        process.exit(EXIT.INFRA);
        return;
      }
      if (tierIndex > 0) {
        output.debug('deployed subgraph predates global role permissions — masks rebuilt from per-project booleans');
      }

      const globalPerms: Array<{ hatId: string; mask: number }> =
        (tm.globalRolePermissions || []).map((g: any) => ({ hatId: String(g.hatId), mask: Number(g.mask) }));

      let projectSection: { pid: string; title?: string; perms: Array<{ hatId: string; mask: number }> } | null = null;
      if (argv.project) {
        const projects = tm.projects || [];
        const { pid, title } = resolveProjectFromList(projects, argv.project);
        const entity = projects.find((p: any) => parseProjectId(p.id) === pid);
        const perms = (entity?.rolePermissions || []).map((rp: any) => ({
          hatId: String(rp.hatId),
          mask: rp.mask !== undefined ? Number(rp.mask) : maskFromBooleans(rp),
        }));
        projectSection = { pid, title, perms };
      }

      // On-chain corroboration via the lens (authoritative hat arrays).
      const netConfig = resolveNetworkConfig(argv.chain);
      const provider = new ethers.providers.JsonRpcProvider(netConfig.resolvedRpc, netConfig.chainId);
      let organizerHats: string[] = [];
      let permissionHats: string[] = [];
      try {
        const [organizers, permHats] = await Promise.all([
          getOrganizerHats(provider, taskManagerAddress),
          getPermissionHats(provider, taskManagerAddress),
        ]);
        organizerHats = organizers.map((h) => h.toString());
        permissionHats = permHats.map((h) => h.toString());
      } catch {
        output.debug('lens hat-array reads unavailable (pre-v4 implementation?) — showing subgraph data only');
      }

      spin.stop();

      if (output.isJsonMode()) {
        output.json({
          taskManager: taskManagerAddress,
          global: globalPerms.map((g) => ({ ...g, permissions: formatMask(g.mask) })),
          project: projectSection ? {
            projectId: projectSection.pid,
            title: projectSection.title,
            permissions: projectSection.perms.map((p) => ({ ...p, permissions: formatMask(p.mask) })),
          } : undefined,
          creatorHatIds: (tm.creatorHatIds || []).map(String),
          organizerHatIds: organizerHats,
          permissionHatIds: permissionHats,
          _source: tierIndex === 0 ? 'subgraph+lens' : 'subgraph(legacy tier)+lens',
        });
        return;
      }

      console.log('');
      console.log('  Global task permissions (hat → mask):');
      if (globalPerms.length === 0) {
        console.log('    (none set — only executor/creator-hat defaults apply)');
      } else {
        output.table(
          ['Hat ID', 'Mask', 'Permissions'],
          globalPerms.map((g) => [g.hatId, String(g.mask), formatMask(g.mask)])
        );
      }

      if (projectSection) {
        console.log('');
        console.log(`  Project overrides — ${projectSection.title || projectSection.pid}:`);
        if (projectSection.perms.length === 0) {
          console.log('    (no per-project overrides — global masks apply)');
        } else {
          output.table(
            ['Hat ID', 'Mask', 'Permissions'],
            projectSection.perms.map((p) => [p.hatId, String(p.mask), formatMask(p.mask)])
          );
        }
      }

      console.log('');
      output.keyValueBlock('On-chain corroboration (lens)', {
        'creator hats': (tm.creatorHatIds || []).map(String).join(', ') || 'none',
        'organizer hats': organizerHats.join(', ') || 'none',
        'permission hats': permissionHats.join(', ') || 'none',
      });
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

interface PermsSetArgs {
  org: string;
  project: string;
  hat: string;
  perms: string;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
}

const permsSetHandler = {
  builder: (yargs: Argv) => yargs
    .option('project', { type: 'string', demandOption: true, describe: 'Project ID (bytes32) or name' })
    .option('hat', { type: 'string', demandOption: true, describe: 'Hat ID whose project mask to set' })
    .option('perms', {
      type: 'string',
      demandOption: true,
      describe: `Comma-separated permission list (${Object.keys(PERM_BITS).join(', ')}) or "none" to remove the override`,
    })
    .example('pop task perms set --project 0xabc… --hat 123 --perms create,claim', 'Let hat 123 create and claim tasks in one project'),

  handler: async (argv: ArgumentsCamelCase<PermsSetArgs>) => {
    const spin = output.spinner('Preparing setProjectRolePerm...');
    spin.start();

    try {
      const mask = parsePermList(argv.perms);
      const hatId = parseHatId(argv.hat);

      const ctx = await getWriteContext(argv);
      const taskManagerAddress = requireModule(ctx.modules, 'taskManagerAddress');

      // Resolve the project by hex or name (subgraph list, like task create).
      let pid: string;
      if (argv.project.startsWith('0x') && argv.project.length === 66) {
        pid = argv.project;
      } else {
        const { data } = await queryWithFieldFallback<any>([
          { query: PERMS_QUERY_FULL, variables: { orgId: ctx.orgId } },
          { query: PERMS_QUERY_LEGACY, variables: { orgId: ctx.orgId } },
        ], { chainId: argv.chain });
        pid = resolveProjectFromList(data.organization?.taskManager?.projects || [], argv.project).pid;
      }

      await runPreflight(ctx.provider, [
        checkGasBalance(ctx.address),
        checkProjectExists(taskManagerAddress, pid),
      ], { skip: !argv.preflight });

      spin.stop();

      await confirmWrite(argv, {
        project: pid,
        hat: hatId.toString(),
        mask,
        permissions: formatMask(mask),
        grants: describeMask(mask).join('; ') || '(removes the project override — global mask applies)',
      }, { actionLabel: 'Set project role permission' });

      const txSpin = output.spinner('Sending setProjectRolePerm...');
      txSpin.start();
      const contract = createWriteContract(taskManagerAddress, 'TaskManagerNew', ctx.signer);
      const result = await executeTx(contract, 'setProjectRolePerm', [pid, hatId, mask], { dryRun: argv.dryRun });
      txSpin.stop();

      finishWrite(result, {
        successMsg: `Project permission set — hat ${hatId.toString()} → ${formatMask(mask)}`,
        fields: {
          projectId: pid,
          hatId: hatId.toString(),
          mask,
          permissions: formatMask(mask),
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

// ─────────────────────────── propose-global ───────────────────────────

interface PermsProposeGlobalArgs {
  org: string;
  hat: string;
  perms: string;
  duration: number;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
}

const permsProposeGlobalHandler = {
  builder: (yargs: Argv) => yargs
    .option('hat', { type: 'string', demandOption: true, describe: 'Hat ID whose GLOBAL mask to set' })
    .option('perms', {
      type: 'string',
      demandOption: true,
      describe: `Comma-separated permission list (${Object.keys(PERM_BITS).join(', ')}) or "none" to revoke`,
    })
    .option('duration', { type: 'number', default: 60, describe: 'Vote duration in minutes' })
    .example('pop task perms propose-global --hat 123 --perms create,claim,review', 'Propose org-wide task permissions for hat 123 (needs a vote)'),

  handler: async (argv: ArgumentsCamelCase<PermsProposeGlobalArgs>) => {
    const spin = output.spinner('Building governance proposal...');
    spin.start();

    try {
      const mask = parsePermList(argv.perms);
      const hatId = parseHatId(argv.hat);

      const ctx = await getWriteContext(argv);
      const taskManagerAddress = requireModule(ctx.modules, 'taskManagerAddress');
      const hybridVotingAddress = ctx.modules.hybridVotingAddress;
      if (!hybridVotingAddress) {
        throw new CliError('HybridVoting not deployed for this org — cannot create a governance proposal.', EXIT.PRECONDITION);
      }

      // setConfig(ROLE_PERM=2, abi.encode(uint256 hatId, uint8 mask)) is
      // executor-only on the TaskManager, so wrap it in a proposal whose
      // option-0 execution batch calls the TaskManager via the executor.
      const tmIface = new ethers.utils.Interface(['function setConfig(uint8 key, bytes value)']);
      const encodedValue = ethers.utils.defaultAbiCoder.encode(['uint256', 'uint8'], [hatId, mask]);
      const setConfigCall = tmIface.encodeFunctionData('setConfig', [CONFIG_KEY_ROLE_PERM, encodedValue]);
      const batches = [
        [[taskManagerAddress, ethers.BigNumber.from(0), setConfigCall]], // option 0: apply
        [], // option 1: keep current
      ];

      const permsLabel = formatMask(mask);
      const title = `Set global task permissions for hat ${hatId.toString()} to ${permsLabel}`;
      const metadata = {
        description: `Set the GLOBAL TaskPerm mask for hat ${hatId.toString()} to ${mask} (${permsLabel}) via TaskManager.setConfig(ROLE_PERM). ${describeMask(mask).join('; ') || 'Revokes all global task permissions for this hat.'}`,
        optionNames: [title, 'Keep current permissions'],
        createdAt: Date.now(),
      };

      await runPreflight(ctx.provider, [checkGasBalance(ctx.address)], { skip: !argv.preflight });

      spin.stop();

      await confirmWrite(argv, {
        hat: hatId.toString(),
        mask,
        permissions: permsLabel,
        target: `TaskManager ${formatAddress(taskManagerAddress)}`,
        via: `HybridVoting proposal (${argv.duration} min vote)`,
      }, { actionLabel: 'Propose global permission change' });

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
          ? `Proposal #${proposalId} created — needs a vote to take effect`
          : 'Proposal created — needs a vote to take effect',
        fields: {
          proposalId,
          hatId: hatId.toString(),
          mask,
          permissions: permsLabel,
          duration: `${argv.duration} minutes`,
          ipfsCid: cid,
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

// ────────────────────────────── registration ──────────────────────────────

export function registerPermsCommands(yargs: Argv) {
  return yargs
    .command('show', 'Show global + per-project task permission masks', permsShowHandler.builder, permsShowHandler.handler)
    .command('set', 'Set a hat\'s permission mask on one project (direct tx; creator-hat/executor)', permsSetHandler.builder, permsSetHandler.handler)
    .command('propose-global', 'Propose an org-wide permission mask change (governance vote)', permsProposeGlobalHandler.builder, permsProposeGlobalHandler.handler)
    .demandCommand(1, 'Please specify a perms action: show, set, or propose-global')
    .example('pop task perms show --json', 'Machine-readable permission dump');
}

export { permsShowHandler, permsSetHandler, permsProposeGlobalHandler };
