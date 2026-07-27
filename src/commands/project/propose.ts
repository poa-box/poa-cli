/**
 * pop project propose — create a project via a governance vote.
 *
 * Wraps TaskManager.createProject(BootstrapProjectConfig) in a HybridVoting
 * proposal whose option-0 execution batch targets the TaskManager (the
 * executor performs the call when the vote passes). Use `pop project create`
 * for the direct creator-hat/executor path.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { createWriteContract, loadAbi } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { pinJson } from '../../lib/ipfs';
import { stringToBytes, ipfsCidToBytes32, formatAddress } from '../../lib/encoding';
import { getWriteContext, confirmWrite, finishWrite } from '../../lib/command';
import { runPreflight, checkGasBalance } from '../../lib/preflight';
import { requireModule } from '../../lib/resolve';
import { CliError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
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
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
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
    .option('duration', { type: 'number', default: 1440, describe: 'Vote duration in minutes (default 24h)' })
    .option('create-hats', { type: 'string', describe: 'Hat IDs for task creation permission' })
    .option('claim-hats', { type: 'string', describe: 'Hat IDs for task claim permission' })
    .option('review-hats', { type: 'string', describe: 'Hat IDs for task review permission' })
    .option('assign-hats', { type: 'string', describe: 'Hat IDs for task assign permission' })
    .example('pop project propose --name "Research" --cap 1000', 'Propose a 1000 PT project (24h vote)')
    .example('pop project propose --name "Ops" --duration 60 --create-hats 123', 'One-hour vote; hat 123 can create tasks'),

  handler: async (argv: ArgumentsCamelCase<ProposeArgs>) => {
    const spin = output.spinner('Creating project proposal...');
    spin.start();

    try {
      const ctx = await getWriteContext(argv);
      const taskManagerAddr = requireModule(ctx.modules, 'taskManagerAddress');
      const hybridVotingAddr = ctx.modules.hybridVotingAddress;
      if (!hybridVotingAddr) {
        throw new CliError('No HybridVoting found for this org', EXIT.PRECONDITION, 'This org cannot run governance proposals.');
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
      const createHats = parseBigNumberList(argv.createHats as string);
      const claimHats = parseBigNumberList(argv.claimHats as string);
      const reviewHats = parseBigNumberList(argv.reviewHats as string);
      const assignHats = parseBigNumberList(argv.assignHats as string);

      const projectStruct = [
        titleBytes, metaHash, cap,
        [],          // managers (hat-based instead)
        createHats, claimHats, reviewHats, assignHats,
        [],          // bountyTokens
        [],          // bountyCaps
      ];

      // Encode the createProject call the executor performs if the vote passes
      const taskManagerAbi = loadAbi('TaskManagerNew');
      const iface = new ethers.utils.Interface(taskManagerAbi);
      const calldata = iface.encodeFunctionData('createProject', [projectStruct]);

      // Build proposal metadata
      const proposalMeta = {
        description: `Create project "${argv.name}"${argv.description ? ': ' + argv.description : ''}. PT cap: ${argv.cap || 'unlimited'}. If this proposal passes, the project will be created automatically via execution call.`,
        optionNames: [`Create "${argv.name}"`, 'Do not create'],
        createdAt: Date.now(),
      };

      // Build execution batches: option 0 = create project, option 1 = do nothing
      const batches = [
        [[taskManagerAddr, ethers.BigNumber.from(0), calldata]],
        [],
      ];

      // ── Pre-flight (skippable with --no-preflight) ────────────────────
      await runPreflight(ctx.provider, [checkGasBalance(ctx.address)], { skip: !argv.preflight });
      spin.stop();

      await confirmWrite(argv, {
        project: argv.name,
        cap: argv.cap ? `${argv.cap} PT` : 'unlimited',
        target: `TaskManager ${formatAddress(taskManagerAddr)}`,
        via: `HybridVoting proposal (${argv.duration} min vote)`,
        org: argv.org,
        chain: ctx.networkName,
      }, { actionLabel: 'Propose project creation' });

      const txSpin = output.spinner('Pinning metadata + creating proposal...');
      txSpin.start();
      const proposalCid = await pinJson(JSON.stringify(proposalMeta));
      const descriptionHash = ipfsCidToBytes32(proposalCid);
      const proposalTitle = stringToBytes(`Create project: ${argv.name}`);

      const contract = createWriteContract(hybridVotingAddr, 'HybridVotingNew', ctx.signer);
      const result = await executeTx(
        contract,
        'createProposal',
        [proposalTitle, descriptionHash, argv.duration, 2, batches, []],
        { dryRun: argv.dryRun }
      );
      txSpin.stop();

      const proposalEvent = result.logs?.find(l => l.name === 'NewProposal' || l.name === 'NewHatProposal');
      const proposalId = proposalEvent?.args?.id?.toString();

      finishWrite(result, {
        successMsg: proposalId !== undefined
          ? `Project proposal #${proposalId} created — needs a vote to take effect`
          : 'Project proposal created — needs a vote to take effect',
        fields: {
          proposalId,
          project: argv.name,
          cap: argv.cap ? `${argv.cap} PT` : 'unlimited',
          voteDuration: `${argv.duration} minutes`,
          ipfsCid: proposalCid,
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
