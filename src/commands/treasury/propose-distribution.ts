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
import { buildDistributionClaimsDocument, distributionClaimsDiscoveryMarker } from '@poa-box/core/metadata/distribution';
import { readTreasuryPlanningState, treasuryAvailability } from '../../lib/treasury-planning';
import * as fs from 'fs';
import { createReadContract, createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { pinWriteMetadata } from '../../lib/write-metadata';
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
  maxRounds?: number;
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
    .option('max-rounds', { type: 'number', default: 1000, describe: 'Maximum complete distribution enumeration for reservations' })
    .option('duration', { type: 'number', default: 1440, describe: 'Vote duration in minutes' })
    .example('pop treasury compute-merkle --amount 40 --token 0xToken... && pop treasury propose-distribution --merkle-file merkle-distribution.json', 'Compute allocations, then put the distribution to a 24h vote')
    .epilogue('createDistribution is executor-only on-chain, so opening a distribution requires a governance vote.'),

  handler: async (argv: ArgumentsCamelCase<ProposeDistributionArgs>) => {
    const spin = output.spinner('Creating distribution proposal...');
    spin.start();

    try {
      if (!Number.isSafeInteger(argv.duration) || argv.duration <= 0) throw new CliError('Vote duration must be a positive integer number of minutes.', EXIT.USAGE);
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

      if (merkleData.chainId !== undefined && merkleData.chainId !== ctx.chainId
        || merkleData.orgId !== undefined && merkleData.orgId.toLowerCase() !== ctx.orgId.toLowerCase()
        || merkleData.paymentManager !== undefined && merkleData.paymentManager.toLowerCase() !== paymentManagerAddr.toLowerCase()) {
        throw new PreconditionError('Merkle file belongs to a different chain, organization or PaymentManager.');
      }
      if (merkleData.optOutCheck && merkleData.optOutCheck !== 'ok') throw new PreconditionError('Regenerate this distribution: the opt-out snapshot is incomplete.');
      const claims = merkleData.claims ?? Object.fromEntries((allocations ?? []).map((a: any) => [a.address, { amount: a.allocation, proof: a.proof }]));
      const claimsDocument = buildDistributionClaimsDocument({ token: tokenAddress, tokenSymbol: token.symbol, totalAmount: amountWei.toString(),
        checkpointBlock, merkleRoot, claims, createdAt: merkleData.createdAt ?? Date.now() });
      if (memberCount !== Object.keys(claimsDocument.claims).length || amountWei.lte(0)) throw new PreconditionError('Merkle member count or total is invalid.');
      const snapshot = await readTreasuryPlanningState({ provider: ctx.provider, chainId: ctx.chainId, orgId: ctx.orgId,
        paymentManager: paymentManagerAddr, asset: { chainId: ctx.chainId, address: token.address, decimals: token.decimals }, maxRounds: argv.maxRounds });
      const availability = treasuryAvailability(snapshot);
      if (availability.status !== 'ready') throw new PreconditionError(`Treasury availability is unproven: ${availability.codes.join(', ')}`);
      if (amountWei.gt(availability.data.spendableRaw)) throw new PreconditionError('Distribution exceeds spendable PaymentManager funds after existing reservations.');
      if (BigInt(String(checkpointBlock)) >= BigInt(snapshot.source.block!.number)) throw new PreconditionError('Distribution checkpoint must precede its proposal planning block.');
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

      const claimsCid = await pinWriteMetadata(JSON.stringify(claimsDocument), argv.dryRun);
      const marker = distributionClaimsDiscoveryMarker({ chainId: ctx.chainId, orgId: ctx.orgId, paymentManager: paymentManagerAddr,
        cid: claimsCid, merkleRoot, token: tokenAddress, totalAmount: amountWei.toString(), checkpointBlock: String(checkpointBlock) });
      const proposalMeta = {
        description: `Create distribution of ${totalHuman} tokens to ${memberCount} members proportional to PT holdings. Allocations: ${allocationSummary}. Merkle root: ${merkleRoot}. Checkpoint block: ${checkpointBlock}. ${marker}`,
        optionNames: [`Distribute ${totalHuman} tokens`, 'Do not distribute'],
        createdAt: Date.now(),
      };

      const txSpin = output.spinner('Pinning proposal metadata...');
      txSpin.start();
      const cid = await pinWriteMetadata(JSON.stringify(proposalMeta), argv.dryRun);
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
          claimsCid,
          planningBlock: snapshot.source.block,
          availability: availability.data,
          revalidateBeforeExecution: true,
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
