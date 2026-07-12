import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { createSigner } from '../../lib/signer';
import { createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { pinJson } from '../../lib/ipfs';
import { stringToBytes, ipfsCidToBytes32 } from '../../lib/encoding';
import { resolveOrgId } from '../../lib/resolve';
import { finishWrite, withIdempotency } from '../../lib/command';
import * as output from '../../lib/output';
import { resolveVotingContracts } from './helpers';

/**
 * setConfig keys for quorum (contracts origin/main, v6):
 *   HybridVoting: key 3 (QUORUM)
 *   DirectDemocracyVoting: key 4 (QUORUM)
 *
 * The voting contracts use setConfig(uint8, bytes) instead of a direct
 * setter, and decode the value as uint32. Since PR #119 quorum is a
 * minimum voter COUNT (0 disables), not a percentage.
 */
const HYBRID_QUORUM_KEY = 3;
const DD_QUORUM_KEY = 4;

interface ProposeQuorumArgs {
  org: string;
  quorum: number;
  duration: number;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  'idempotency-key'?: string;
  'no-idempotency'?: boolean;
}

export const proposeQuorumHandler = {
  builder: (yargs: Argv) => yargs
    .option('quorum', { type: 'number', demandOption: true, describe: 'New quorum value (minimum voter COUNT, not a percentage)' })
    .option('duration', { type: 'number', default: 60, describe: 'Vote duration in minutes' })
    .option('idempotency-key', { type: 'string', describe: 'Explicit idempotency key (default: derived from argv).' })
    .option('no-idempotency', { type: 'boolean', default: false, describe: 'Bypass the idempotency cache and always submit.' }),

  handler: async (argv: ArgumentsCamelCase<ProposeQuorumArgs>) => {
    const spin = output.spinner('Creating quorum change proposal...');
    spin.start();

    try {
      const newQuorum = argv.quorum as number;
      if (newQuorum < 1) throw new Error('Quorum must be at least 1');

      const contracts = await resolveVotingContracts(argv.org, argv.chain);
      const { signer } = createSigner({ privateKey: argv.privateKey as string, chainId: argv.chain, rpcUrl: argv.rpc as string });

      if (!contracts.hybridVotingAddress) throw new Error('HybridVoting not deployed');

      // Encode setConfig calls for both voting contracts
      const iface = new ethers.utils.Interface(['function setConfig(uint8 key, bytes value)']);
      const encodedValue = ethers.utils.defaultAbiCoder.encode(['uint32'], [newQuorum]);

      const hybridCall = iface.encodeFunctionData('setConfig', [HYBRID_QUORUM_KEY, encodedValue]);

      const batches: any[][] = [];
      const option0Batch: any[] = [
        [contracts.hybridVotingAddress, ethers.BigNumber.from(0), hybridCall],
      ];

      // Add DD voting if it exists
      if (contracts.ddVotingAddress) {
        const ddCall = iface.encodeFunctionData('setConfig', [DD_QUORUM_KEY, encodedValue]);
        option0Batch.push([contracts.ddVotingAddress, ethers.BigNumber.from(0), ddCall]);
      }

      batches.push(option0Batch);
      batches.push([]); // option 1 (keep current) has no calls

      // Pin metadata
      const metadata = {
        description: `Change voting quorum to ${newQuorum}. Updates both Hybrid (setConfig key ${HYBRID_QUORUM_KEY}) and DD (setConfig key ${DD_QUORUM_KEY}) voting contracts via execution calls.`,
        optionNames: [`Set quorum to ${newQuorum}`, 'Keep current quorum'],
        createdAt: Date.now(),
      };

      const hybridVotingAddress = contracts.hybridVotingAddress;
      const contractList = contracts.ddVotingAddress ? 'Hybrid + DD' : 'Hybrid only';
      const resolvedOrgId = await resolveOrgId(argv.org, argv.chain);
      spin.stop();

      const run = async (): Promise<Record<string, any>> => {
        const txSpin = output.spinner('Pinning metadata...');
        txSpin.start();
        const cid = await pinJson(JSON.stringify(metadata));
        const descriptionHash = ipfsCidToBytes32(cid);
        const titleBytes = stringToBytes(`Set voting quorum to ${newQuorum}`);

        txSpin.text = 'Sending transaction...';
        const contract = createWriteContract(hybridVotingAddress, 'HybridVotingNew', signer);
        const result = await executeTx(
          contract,
          'createProposal',
          [titleBytes, descriptionHash, argv.duration, 2, batches, []],
          { dryRun: argv.dryRun }
        );
        txSpin.stop();

        const proposalEvent = result.logs?.find(l => l.name === 'NewProposal' || l.name === 'NewHatProposal');
        const proposalId = proposalEvent?.args?.id?.toString();

        finishWrite(result, {
          successMsg: 'Quorum change proposal created',
          fields: {
            proposalId,
            newQuorum,
            duration: `${argv.duration} minutes`,
            contracts: contractList,
            ipfsCid: cid,
          },
        });
        return { proposalId, txHash: result.txHash, ipfsCid: cid };
      };

      // Dry runs simulate unconditionally — no idempotency consult/record.
      if (argv.dryRun) {
        await run();
      } else {
        await withIdempotency(argv, resolvedOrgId, 'vote.propose-quorum', run);
      }
    } catch (err: any) {
      spin.stop();
      output.error(err.message);
      process.exit(1);
    }
  },
};
