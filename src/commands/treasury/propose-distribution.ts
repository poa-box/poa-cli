/**
 * pop treasury propose-distribution — governance proposal to open a merkle
 * distribution from a compute-merkle output file.
 *
 * Wraps PaymentManager.createDistribution(payoutToken, amount, merkleRoot,
 * checkpointBlock) — an executor-only call (verified against contracts
 * origin/main src/PaymentManager.sol) — in a HybridVoting proposal whose
 * option-0 batch targets the PaymentManager. createDistribution reverts
 * InsufficientFunds at EXECUTION time if the PaymentManager's balance can't
 * cover total committed + this amount, so the current balance is checked
 * here as an advisory warning.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import * as fs from 'fs';
import { createReadContract, createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { pinJson } from '../../lib/ipfs';
import { stringToBytes, ipfsCidToBytes32 } from '../../lib/encoding';
import { getWriteContext, confirmWrite, finishWrite } from '../../lib/command';
import { runPreflight, checkGasBalance } from '../../lib/preflight';
import { requireModule } from '../../lib/resolve';
import { formatToken } from '../../lib/format';
import { resolvePayoutTokenInfo } from './helpers';
import { CliError, PreconditionError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';

interface ProposeDistributionArgs {
  org: string;
  'merkle-file': string;
  duration: number;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
}

const PM_ABI = [
  'function createDistribution(address payoutToken, uint256 amount, bytes32 merkleRoot, uint256 checkpointBlock) returns (uint256)',
];

export const proposeDistributionHandler = {
  builder: (yargs: Argv) => yargs
    .option('merkle-file', { type: 'string', demandOption: true, describe: 'Path to merkle-distribution.json from compute-merkle' })
    .option('duration', { type: 'number', default: 1440, describe: 'Vote duration in minutes' })
    .example('pop treasury compute-merkle --amount 40 --token 0xToken... && pop treasury propose-distribution --merkle-file merkle-distribution.json', 'Compute allocations, then put the distribution to a 24h vote')
    .epilogue('createDistribution is executor-only on-chain, so opening a distribution requires a governance vote.'),

  handler: async (argv: ArgumentsCamelCase<ProposeDistributionArgs>) => {
    const spin = output.spinner('Creating distribution proposal...');
    spin.start();

    try {
      // Read merkle file from compute-merkle output
      const merkleFilePath = argv.merkleFile as string;
      if (!fs.existsSync(merkleFilePath)) {
        throw new CliError(
          `Merkle file not found: ${merkleFilePath}`,
          EXIT.USAGE,
          "Run 'pop treasury compute-merkle' first."
        );
      }

      let merkleData: any;
      try {
        merkleData = JSON.parse(fs.readFileSync(merkleFilePath, 'utf8'));
      } catch {
        throw new CliError(`Could not parse ${merkleFilePath} as JSON.`, EXIT.USAGE);
      }
      const { merkleRoot, totalAmount, tokenAddress, checkpointBlock, memberCount, allocations } = merkleData;

      if (!merkleRoot || !totalAmount || !tokenAddress || !checkpointBlock) {
        throw new CliError(
          'Invalid merkle file — missing required fields (merkleRoot, totalAmount, tokenAddress, checkpointBlock).',
          EXIT.USAGE,
          'Regenerate it with: pop treasury compute-merkle'
        );
      }

      const ctx = await getWriteContext(argv);
      const paymentManagerAddr = requireModule(ctx.modules, 'paymentManagerAddress');
      const hybridVotingAddr = ctx.modules.hybridVotingAddress;
      if (!hybridVotingAddr) {
        throw new PreconditionError('HybridVoting not deployed for this org — cannot create a governance proposal.');
      }

      const amountWei = ethers.BigNumber.from(totalAmount);
      const token = await resolvePayoutTokenInfo(ctx.provider, tokenAddress, ctx.chainId);
      const totalHuman = ethers.utils.formatUnits(amountWei, token.decimals);

      // Advisory: createDistribution checks the PaymentManager's balance at
      // EXECUTION time — warn now if the treasury can't currently cover it.
      if (argv.preflight !== false) {
        try {
          const pmBalance: ethers.BigNumber = token.isNative
            ? await ctx.provider.getBalance(paymentManagerAddr)
            : await createReadContract(tokenAddress, 'ERC20', ctx.provider).balanceOf(paymentManagerAddr);
          if (pmBalance.lt(amountWei)) {
            output.warn(
              `PaymentManager currently holds ${formatToken(pmBalance, token.decimals, token.symbol)} — execution will revert `
              + `InsufficientFunds unless it holds ${formatToken(amountWei, token.decimals, token.symbol)} (plus prior commitments) by the time the vote passes. `
              + `Fund it with: pop treasury deposit --token ${tokenAddress} --amount ${totalHuman}`
            );
          }
        } catch { /* advisory only */ }
      }
      await runPreflight(ctx.provider, [checkGasBalance(ctx.address)], { skip: !argv.preflight });
      spin.stop();

      await confirmWrite(argv, {
        amount: formatToken(amountWei, token.decimals, token.symbol),
        token: tokenAddress,
        recipients: `${memberCount} members (PT-proportional)`,
        merkleRoot,
        checkpointBlock,
        via: `HybridVoting proposal (${argv.duration} min vote)`,
        org: argv.org,
        chain: ctx.networkName,
      }, { destructive: true, actionLabel: 'About to propose a TREASURY DISTRIBUTION' });

      // Encode createDistribution execution call
      const pmIface = new ethers.utils.Interface(PM_ABI);
      const createDistData = pmIface.encodeFunctionData('createDistribution', [
        tokenAddress,
        amountWei,
        merkleRoot,
        checkpointBlock,
      ]);

      const calls = [
        [paymentManagerAddr, ethers.BigNumber.from(0), createDistData],
      ];

      // Build allocation summary for proposal description
      const allocationSummary = (allocations ?? [])
        .map((a: any) => `${a.username || a.address.slice(0, 10) + '...'} (${a.share})`)
        .join(', ');

      const proposalMeta = {
        description: `Create distribution of ${totalHuman} tokens to ${memberCount} members proportional to PT holdings. Allocations: ${allocationSummary}. Merkle root: ${merkleRoot}. Checkpoint block: ${checkpointBlock}.`,
        optionNames: [`Distribute ${totalHuman} tokens`, 'Do not distribute'],
        createdAt: Date.now(),
      };

      const txSpin = output.spinner('Pinning proposal metadata...');
      txSpin.start();
      const cid = await pinJson(JSON.stringify(proposalMeta));
      const descriptionHash = ipfsCidToBytes32(cid);
      const title = stringToBytes(`Distribute ${totalHuman} tokens to ${memberCount} members`);

      const batches = [calls, []]; // option 0 = distribute, option 1 = no-op

      txSpin.text = 'Creating proposal...';
      const contract = createWriteContract(hybridVotingAddr, 'HybridVotingNew', ctx.signer);
      const result = await executeTx(
        contract,
        'createProposal',
        [title, descriptionHash, argv.duration, 2, batches, []],
        { dryRun: argv.dryRun }
      );
      txSpin.stop();

      const proposalEvent = result.logs?.find(l => l.name === 'NewProposal' || l.name === 'NewHatProposal');
      const proposalId = proposalEvent?.args?.id?.toString();

      finishWrite(result, {
        successMsg: 'Distribution proposal created',
        fields: {
          proposalId,
          totalAmount: totalHuman,
          tokenAddress,
          merkleRoot,
          checkpointBlock,
          memberCount,
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
