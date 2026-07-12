/**
 * pop org deploy-config — generate an org deploy config file (local only,
 * no transactions). Overwriting an EXISTING file is treated as destructive:
 * interactive sessions are prompted, non-TTY sessions must pass --yes.
 * Writing a fresh file stays silent for non-TTY (agent) sessions.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import * as fs from 'fs';
import { confirmWrite } from '../../lib/command';
import { CliError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';

interface DeployConfigArgs {
  name: string;
  description?: string;
  username: string;
  output: string;
  template?: string;
  yes?: boolean;
}

export const deployConfigHandler = {
  builder: (yargs: Argv) => yargs
    .option('name', { type: 'string', demandOption: true, describe: 'Organization name' })
    .option('description', { type: 'string', default: '', describe: 'Organization description' })
    .option('username', { type: 'string', demandOption: true, describe: 'Deployer username' })
    .option('output', { type: 'string', default: 'org-deploy-config.json', describe: 'Output file path' })
    .option('template', { type: 'string', choices: ['standard', 'minimal'], default: 'standard', describe: 'Config template' })
    .example('pop org deploy-config --name "My Org" --username alice', 'Write org-deploy-config.json from the standard template')
    .example('pop org deploy-config --name "My Org" --username alice --template minimal --output my-org.json', 'Minimal single-role template to a custom path'),

  handler: async (argv: ArgumentsCamelCase<DeployConfigArgs>) => {
    try {
      const config = argv.template === 'minimal'
        ? buildMinimalConfig(argv.name, argv.description || '', argv.username)
        : buildStandardConfig(argv.name, argv.description || '', argv.username);

      const outPath = argv.output as string;

      // Overwriting an existing config is destructive; a fresh file is not.
      if (fs.existsSync(outPath)) {
        await confirmWrite(argv, {
          file: outPath,
          template: argv.template,
          org: argv.name,
        }, { destructive: true, actionLabel: 'About to OVERWRITE an existing config file' });
      }

      fs.writeFileSync(outPath, JSON.stringify(config, null, 2) + '\n');

      if (output.isJsonMode()) {
        output.json({ path: outPath, template: argv.template, orgName: argv.name });
      } else {
        console.log('');
        console.log(`  Deploy config written to ${outPath}`);
        console.log(`  Template: ${argv.template}`);
        console.log(`  Org: ${argv.name}`);
        console.log('');
        console.log('  Review and edit the config, then deploy:');
        console.log(`    pop org deploy --config ${outPath}`);
        console.log('');
      }
    } catch (err: any) {
      if (err instanceof CliError) {
        output.error(err.message, { suggestion: err.suggestion });
        process.exit(err.code);
      }
      output.error(err?.message || String(err));
      process.exit(EXIT.USAGE);
    }
  },
};

function buildStandardConfig(name: string, description: string, username: string) {
  return {
    orgName: name,
    deployerUsername: username,
    description,
    links: [],
    autoUpgrade: true,
    hybridVoting: {
      thresholdPct: 51,
      classes: [
        {
          strategy: 'DIRECT',
          slicePct: 80,
          quadratic: false,
          hatIds: [],
        },
        {
          strategy: 'ERC20_BAL',
          slicePct: 20,
          quadratic: true,
          minBalance: '1',
          hatIds: [],
        },
      ],
    },
    directDemocracy: {
      thresholdPct: 51,
    },
    roles: [
      {
        name: 'Member',
        canVote: true,
        vouching: {
          enabled: true,
          quorum: 1,
          voucherRoleIndex: 0,
          combineWithHierarchy: true,
        },
        defaults: { eligible: true, standing: true },
        distribution: { mintToDeployer: true },
        hatConfig: { maxSupply: 50, mutableHat: true },
      },
      {
        name: 'Contributor',
        canVote: false,
        vouching: {
          enabled: true,
          quorum: 1,
          voucherRoleIndex: 0,
          combineWithHierarchy: true,
        },
        defaults: { eligible: true, standing: true },
        distribution: { mintToDeployer: false },
        hatConfig: { maxSupply: 200, mutableHat: true },
      },
    ],
    roleAssignments: {
      quickJoinRoles: [],
      tokenMemberRoles: [0, 1],
      tokenApproverRoles: [0],
      taskCreatorRoles: [0],
      educationCreatorRoles: [0],
      educationMemberRoles: [0, 1],
      hybridProposalCreatorRoles: [0],
      ddVotingRoles: [0, 1],
      ddCreatorRoles: [0],
    },
    metadataAdminRoleIndex: 0,
    educationHub: { enabled: true },
    paymaster: {
      operatorRoleIndex: 0,
      maxFeePerGas: '20',
      maxPriorityFeePerGas: '5',
      defaultBudgetCapPerEpoch: '1',
      defaultBudgetEpochLen: 604800,
      funding: '1',
    },
  };
}

function buildMinimalConfig(name: string, description: string, username: string) {
  return {
    orgName: name,
    deployerUsername: username,
    description,
    links: [],
    autoUpgrade: true,
    hybridVoting: {
      thresholdPct: 51,
      classes: [
        { strategy: 'DIRECT', slicePct: 100, quadratic: false, hatIds: [] },
      ],
    },
    directDemocracy: { thresholdPct: 51 },
    roles: [
      {
        name: 'Member',
        canVote: true,
        vouching: { enabled: true, quorum: 1, voucherRoleIndex: 0, combineWithHierarchy: true },
        defaults: { eligible: true, standing: true },
        distribution: { mintToDeployer: true },
        hatConfig: { maxSupply: 50, mutableHat: true },
      },
    ],
    roleAssignments: {
      quickJoinRoles: [],
      tokenMemberRoles: [0],
      tokenApproverRoles: [0],
      taskCreatorRoles: [0],
      educationCreatorRoles: [0],
      educationMemberRoles: [0],
      hybridProposalCreatorRoles: [0],
      ddVotingRoles: [0],
      ddCreatorRoles: [0],
    },
    metadataAdminRoleIndex: 0,
    educationHub: { enabled: true },
  };
}
