import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { createSigner } from '../../lib/signer';
import { createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { pinJson } from '../../lib/ipfs';
import { stringToBytes, ipfsCidToBytes32 } from '../../lib/encoding';
import { loadAbi } from '../../lib/contracts';
import { resolveOrgModules } from '../../lib/resolve';
import { resolveVotingContracts } from '../vote/helpers';
import { query } from '../../lib/subgraph';
import * as output from '../../lib/output';

interface ProposeArgs {
  org: string;
  name: string;
  description?: string;
  cap: number;
  duration: number;
  'create-hats'?: string;
  'claim-hats'?: string;
  'review-hats'?: string;
  'assign-hats'?: string;
  'auto-hats'?: boolean;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
}

// HB#730: closes #562 cycle-gap. Pulls hats from an existing same-org project's
// rolePermissions so the new project inherits the SAME known-good permission
// config. Without this, proposals execute but the new project has empty
// rolePermissions and task-create reverts.
//
// Why existing project rather than org.taskManager.creatorHatIds: those are
// different hat IDs on Argus — creatorHatIds is org-level (can create PROJECTS)
// but rolePermissions is project-level (can create TASKS within). Agents hold
// the project-level hat, so that's what we need to seed the new project with.
//
// HB#755 (RULE #33 implementation): split the hat-union per permission type
// instead of single create+claim intersection. RULE #33 (review-perm-parity)
// requires every active project to grant canReview to ALL fleet hats. The
// per-permission union ensures auditor-only hats (canReview but not canCreate)
// also propagate, closing the HB#1083 review-perm-asymmetry trap.
interface PermHatSets {
  createHats: ethers.BigNumber[];
  claimHats: ethers.BigNumber[];
  reviewHats: ethers.BigNumber[];
  assignHats: ethers.BigNumber[];
}

async function fetchOrgPermHats(orgId: string, chainId?: number): Promise<PermHatSets> {
  const q = `{ organization(id: "${orgId}") { taskManager { projects(where: {deleted: false}, first: 50) { rolePermissions { hatId canCreate canClaim canReview canAssign } } } } }`;
  const empty: PermHatSets = { createHats: [], claimHats: [], reviewHats: [], assignHats: [] };
  try {
    const r: any = await query(q, {}, chainId);
    const projects = r?.organization?.taskManager?.projects || [];
    const create = new Set<string>();
    const claim = new Set<string>();
    const review = new Set<string>();
    const assign = new Set<string>();
    for (const p of projects) {
      const rps = p?.rolePermissions || [];
      for (const rp of rps) {
        if (!rp?.hatId) continue;
        if (rp.canCreate) create.add(rp.hatId);
        if (rp.canClaim) claim.add(rp.hatId);
        if (rp.canReview) review.add(rp.hatId);
        if (rp.canAssign) assign.add(rp.hatId);
      }
    }
    const toBN = (s: Set<string>) => Array.from(s).map(h => ethers.BigNumber.from(h));
    return {
      createHats: toBN(create),
      claimHats: toBN(claim),
      reviewHats: toBN(review),
      assignHats: toBN(assign),
    };
  } catch {
    return empty;
  }
}

// Backwards-compat alias retained for any external callers.
async function fetchOrgCreatorHats(orgId: string, chainId?: number): Promise<ethers.BigNumber[]> {
  const sets = await fetchOrgPermHats(orgId, chainId);
  return sets.createHats;
}

function parseBigNumberList(val?: string): ethers.BigNumber[] {
  if (!val) return [];
  return val.split(',').map(s => ethers.BigNumber.from(s.trim()));
}

export const proposeHandler = {
  builder: (yargs: Argv) => yargs
    .option('name', { type: 'string', demandOption: true, describe: 'Project name' })
    .option('description', { type: 'string', describe: 'Project description' })
    .option('cap', { type: 'number', default: 0, describe: 'PT budget cap (0 = unlimited)' })
    .option('duration', { type: 'number', default: 60, describe: 'RULE #32 (HB#733): vote duration in minutes. Default 60 (fleet-aligned proposals). Use 1440 (24h) only for high-stakes irreversible changes — token mints, major Executor calls, quorum/threshold changes.' })
    .option('create-hats', { type: 'string', describe: 'Hat IDs for task creation permission' })
    .option('claim-hats', { type: 'string', describe: 'Hat IDs for task claim permission' })
    .option('review-hats', { type: 'string', describe: 'Hat IDs for task review permission' })
    .option('assign-hats', { type: 'string', describe: 'Hat IDs for task assign permission' })
    .option('auto-hats', { type: 'boolean', default: true, describe: 'HB#730 (#562 fix) + HB#755 (RULE #33 review-perm-parity): when no explicit hat flags are passed, auto-populate per-permission hat unions from existing org projects (canCreate hats → createHats; canReview hats → reviewHats; etc). Closes the cycle-gap (empty rolePermissions on new project) + the HB#1083 review-perm-asymmetry trap (auditor-only hats now propagate). Pass --no-auto-hats to disable.' }),

  handler: async (argv: ArgumentsCamelCase<ProposeArgs>) => {
    const spin = output.spinner('Creating project proposal...');
    spin.start();

    try {
      const modules = await resolveOrgModules(argv.org, argv.chain);
      const votingContracts = await resolveVotingContracts(argv.org, argv.chain);
      const { signer } = createSigner({ privateKey: argv.privateKey as string, chainId: argv.chain, rpcUrl: argv.rpc as string });

      const taskManagerAddr = modules.taskManagerAddress;
      if (!taskManagerAddr) {
        throw new Error('No TaskManager found for this org');
      }
      const hybridVotingAddr = votingContracts.hybridVotingAddress;
      if (!hybridVotingAddr) {
        throw new Error('No HybridVoting found for this org');
      }

      // Pin project metadata to IPFS
      let metaHash = ethers.constants.HashZero;
      if (argv.description) {
        const metadata = { description: argv.description };
        spin.text = 'Pinning project metadata to IPFS...';
        const cid = await pinJson(JSON.stringify(metadata));
        metaHash = ipfsCidToBytes32(cid);
      }

      // Build BootstrapProjectConfig struct
      const titleBytes = stringToBytes(argv.name);
      const cap = argv.cap ? ethers.utils.parseUnits(argv.cap.toString(), 18) : 0;
      let createHats = parseBigNumberList(argv.createHats as string);
      let claimHats = parseBigNumberList(argv.claimHats as string);
      let reviewHats = parseBigNumberList(argv.reviewHats as string);
      let assignHats = parseBigNumberList(argv.assignHats as string);

      // HB#730: closes #562 cycle-gap. If --auto-hats (default) and no explicit
      // hat flags were passed, pull the org's per-permission hat unions so the
      // new project has the same role coverage as the org's existing projects.
      // Without this, proposals execute but the project is "frozen" — no hat
      // has canCreate/canClaim, so task-create reverts.
      //
      // HB#755 (RULE #33 implementation): per-permission split instead of
      // single-union-applied-to-all-4. Closes the HB#1083 review-perm-asymmetry
      // trap where auditor-only hats (canReview without canCreate) were missed.
      const anyExplicit = createHats.length || claimHats.length || reviewHats.length || assignHats.length;
      if (argv.autoHats && !anyExplicit) {
        spin.text = 'Fetching org per-permission hat unions for auto-grant...';
        const sets = await fetchOrgPermHats(modules.orgId, argv.chain);
        if (sets.createHats.length || sets.claimHats.length || sets.reviewHats.length || sets.assignHats.length) {
          createHats = sets.createHats;
          claimHats = sets.claimHats;
          reviewHats = sets.reviewHats;
          assignHats = sets.assignHats;
        }
      }

      const projectStruct = [
        titleBytes, metaHash, cap,
        [],          // managers (hat-based instead)
        createHats, claimHats, reviewHats, assignHats,
        [],          // bountyTokens
        [],          // bountyCaps
      ];

      // Encode the createProject call
      const taskManagerAbi = loadAbi('TaskManagerNew');
      const iface = new ethers.utils.Interface(taskManagerAbi);
      const calldata = iface.encodeFunctionData('createProject', [projectStruct]);

      // Build proposal metadata
      const proposalMeta = {
        description: `Create project "${argv.name}"${argv.description ? ': ' + argv.description : ''}. PT cap: ${argv.cap || 'unlimited'}. If this proposal passes, the project will be created automatically via execution call.`,
        optionNames: [`Create "${argv.name}"`, 'Do not create'],
        createdAt: Date.now(),
      };

      spin.text = 'Pinning proposal metadata to IPFS...';
      const proposalCid = await pinJson(JSON.stringify(proposalMeta));
      const descriptionHash = ipfsCidToBytes32(proposalCid);

      const proposalTitle = stringToBytes(`Create project: ${argv.name}`);

      // Build execution batches: option 0 = create project, option 1 = do nothing
      const batches = [
        [[taskManagerAddr, ethers.BigNumber.from(0), calldata]],
        [],
      ];

      spin.text = 'Creating proposal...';
      const contract = createWriteContract(hybridVotingAddr, 'HybridVotingNew', signer);
      const result = await executeTx(
        contract,
        'createProposal',
        [proposalTitle, descriptionHash, argv.duration, 2, batches, []],
        { dryRun: argv.dryRun }
      );

      spin.stop();

      if (result.success) {
        const proposalEvent = result.logs?.find(l => l.name === 'NewProposal');
        const proposalId = proposalEvent?.args?.id?.toString();
        output.success('Project proposal created', {
          proposalId,
          txHash: result.txHash,
          explorerUrl: result.explorerUrl,
          project: argv.name,
          cap: argv.cap ? `${argv.cap} PT` : 'unlimited',
          voteDuration: `${argv.duration} minutes`,
          rolePermissionHats: createHats.length > 0 ? createHats.map(h => h.toString()) : [],
          autoHatsApplied: argv.autoHats && !anyExplicit && createHats.length > 0,
          ipfsCid: proposalCid,
        });
      } else {
        output.error('Proposal creation failed', { error: result.error, errorCode: result.errorCode });
        process.exit(2);
      }
    } catch (err: any) {
      spin.stop();
      output.error(err.message);
      process.exit(1);
    }
  },
};
