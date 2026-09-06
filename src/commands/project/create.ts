/**
 * pop project create — create a project directly on the TaskManager.
 *
 * Gate — VERIFIED against contracts origin/main src/TaskManager.sol:
 * createProject(BootstrapProjectConfig) calls _requireCreator(), so a
 * creator subject member or the executor can send this as a direct tx (no
 * governance needed; use `pop project propose` for the governance path).
 * Permissions are not pre-checked — masks are not readable per-wearer
 * on-chain, so a decoded Unauthorized revert is the authority.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { pinJson } from '../../lib/ipfs';
import { stringToBytes, ipfsCidToBytes32 } from '../../lib/encoding';
import { getWriteContext, confirmWrite, finishWrite } from '../../lib/command';
import { runPreflight, checkGasBalance } from '../../lib/preflight';
import { requireModule } from '../../lib/resolve';
import { CliError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';

interface CreateArgs {
  org: string;
  name: string;
  cap: number;
  managers?: string;
  description?: string;
  'bounty-tokens'?: string;
  'bounty-caps'?: string;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
}

function parseCommaList(val?: string): string[] {
  if (!val) return [];
  return val.split(',').map(s => s.trim()).filter(Boolean);
}

function parseBigNumberList(val?: string): ethers.BigNumber[] {
  if (!val) return [];
  return val.split(',').map(s => ethers.BigNumber.from(s.trim()));
}

export const createHandler = {
  builder: (yargs: Argv) => yargs
    .option('name', { type: 'string', demandOption: true, describe: 'Project name' })
    .option('cap', { type: 'number', default: 0, describe: 'PT cap (0 = unlimited)' })
    .option('managers', { type: 'string', describe: 'Comma-separated project manager addresses' })
    .option('description', { type: 'string', describe: 'Project description' })
    .option('bounty-tokens', { type: 'string', describe: 'Comma-separated bounty token addresses' })
    .option('bounty-caps', { type: 'string', describe: 'Comma-separated bounty caps (wei)' })
    .example('pop project create --name "Protocol Work" --cap 500', 'Create a project with a 500 PT budget cap')
    .epilogue('Configure project permissions with pop task perms set after creation.'),

  handler: async (argv: ArgumentsCamelCase<CreateArgs>) => {
    const spin = output.spinner('Preparing project...');
    spin.start();

    try {
      const ctx = await getWriteContext(argv);
      const taskManagerAddress = requireModule(ctx.modules, 'taskManagerAddress');

      // Upload metadata if description provided
      let metaHash = ethers.constants.HashZero;
      let metaCid: string | undefined;
      if (argv.description && !argv.dryRun) {
        const metadata = { description: argv.description };
        spin.text = 'Pinning metadata to IPFS...';
        metaCid = await pinJson(JSON.stringify(metadata));
        metaHash = ipfsCidToBytes32(metaCid);
      }

      const titleBytes = stringToBytes(argv.name);
      const cap = argv.cap ? ethers.utils.parseUnits(argv.cap.toString(), 18) : 0;
      const managers = parseCommaList(argv.managers);
      const createHats: any[] = [];
      const claimHats: any[] = [];
      const reviewHats: any[] = [];
      const assignHats: any[] = [];

      // Build BootstrapProjectConfig struct
      const projectStruct = [
        titleBytes,
        metaHash,
        cap,
        managers,
        createHats,
        claimHats,
        reviewHats,
        assignHats,
        parseCommaList(argv.bountyTokens as string),  // address[]
        parseBigNumberList(argv.bountyCaps as string), // uint256[] (wei)
      ];

      // ── Pre-flight (skippable with --no-preflight) ────────────────────
      await runPreflight(ctx.provider, [checkGasBalance(ctx.address)], { skip: !argv.preflight });
      spin.stop();

      await confirmWrite(argv, {
        project: argv.name,
        cap: argv.cap ? `${argv.cap} PT` : 'unlimited',
        managers: managers.length ? managers.join(', ') : undefined,
        permissionHats: [createHats, claimHats, reviewHats, assignHats].some(h => h.length)
          ? `create:[${createHats.join(',')}] claim:[${claimHats.join(',')}] review:[${reviewHats.join(',')}] assign:[${assignHats.join(',')}]`
          : undefined,
        org: argv.org,
        chain: ctx.networkName,
      }, { actionLabel: 'About to create project' });

      const txSpin = output.spinner('Creating project...');
      txSpin.start();
      const contract = createWriteContract(taskManagerAddress, 'TaskManagerNew', ctx.signer);
      const result = await executeTx(contract, 'createProject', [projectStruct], { dryRun: argv.dryRun });
      txSpin.stop();

      const projectEvent = result.logs?.find(l => l.name === 'ProjectCreated');
      const projectId = projectEvent?.args?.id?.toString();
      finishWrite(result, {
        successMsg: 'Project created',
        fields: {
          projectId,
          project: argv.name,
          cap: argv.cap ? `${argv.cap} PT` : 'unlimited',
          ipfsCid: metaCid,
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
