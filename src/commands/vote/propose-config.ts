import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { createSigner } from '../../lib/signer';
import { createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { pinJson } from '../../lib/ipfs';
import { stringToBytes, ipfsCidToBytes32 } from '../../lib/encoding';
import { resolveOrgId } from '../../lib/resolve';
import { finishWrite, withIdempotency } from '../../lib/command';
import { CliError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';
import { resolveVotingContracts } from './helpers';

/**
 * ConfigKey mapping for HybridVoting (contracts origin/main, v6):
 *   0: THRESHOLD (uint8 — support threshold percentage, 1-100)
 *   1: TARGET_ALLOWED (deprecated — setConfig silently ignores this branch)
 *   2: EXECUTOR (address — change the executor contract)
 *   3: QUORUM (uint32 — minimum voter count for validity, 0 disables)
 *
 * ConfigKey mapping for DirectDemocracyVoting (v6):
 *   0: THRESHOLD (uint8 — support threshold percentage, 1-100)
 *   1: EXECUTOR (address)
 *   2: TARGET_ALLOWED (address, bool — whitelist execution targets)
 *   3: HAT_ALLOWED (uint256, bool — restrict voting to specific hats)
 *   4: QUORUM (uint32 — minimum voter count for validity, 0 disables)
 *
 * Note: since PR #119 quorum is a voter COUNT, not a percentage.
 */

interface ConfigParam {
  name: string;
  hybridKey: number; // -1 = not applicable to Hybrid
  ddKey: number | null; // null = not applicable to DD
  valueType: string;
  description: string;
  encode: (value: string) => string;
  validate: (value: string) => void;
  hybridUnavailableReason?: string; // shown when hybridKey < 0 and no DD contract exists
}

const CONFIG_PARAMS: Record<string, ConfigParam> = {
  threshold: {
    name: 'threshold',
    hybridKey: 0,
    ddKey: 0,
    valueType: 'uint8',
    description: 'Support threshold percentage (1-100)',
    encode: (v) => ethers.utils.defaultAbiCoder.encode(['uint8'], [parseInt(v, 10)]),
    validate: (v) => {
      const n = parseInt(v, 10);
      if (isNaN(n) || n < 1 || n > 100) throw new Error('Threshold must be 1-100');
    },
  },
  quorum: {
    name: 'quorum',
    hybridKey: 3,
    ddKey: 4,
    valueType: 'uint32',
    description: 'Minimum voter count for validity (0 disables)',
    encode: (v) => ethers.utils.defaultAbiCoder.encode(['uint32'], [parseInt(v, 10)]),
    validate: (v) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 4294967295) {
        throw new Error('Quorum must be an integer >= 0 (uint32 voter count, 0 disables)');
      }
    },
  },
  'target-allowed': {
    name: 'target-allowed',
    hybridKey: -1, // deprecated no-op on HybridVoting v6 — setConfig silently ignores it
    ddKey: 2,
    valueType: 'address,bool',
    description: 'Allow/disallow an execution target address on DD voting (format: 0xaddr,true/false)',
    hybridUnavailableReason:
      'TARGET_ALLOWED is a deprecated no-op on HybridVoting (setConfig silently ignores it); this key only applies to DirectDemocracyVoting',
    encode: (v) => {
      const [addr, allowed] = v.split(',');
      return ethers.utils.defaultAbiCoder.encode(['address', 'bool'], [addr.trim(), allowed.trim() === 'true']);
    },
    validate: (v) => {
      const parts = v.split(',');
      if (parts.length !== 2) throw new Error('Format: 0xaddress,true/false');
      if (!ethers.utils.isAddress(parts[0].trim())) throw new Error('Invalid address');
      if (!['true', 'false'].includes(parts[1].trim())) throw new Error('Second value must be true or false');
    },
  },
  executor: {
    name: 'executor',
    hybridKey: 2,
    ddKey: 1,
    valueType: 'address',
    description: 'Change the executor contract address',
    encode: (v) => ethers.utils.defaultAbiCoder.encode(['address'], [v.trim()]),
    validate: (v) => {
      if (!ethers.utils.isAddress(v.trim())) throw new Error('Invalid address');
      if (v.trim() === ethers.constants.AddressZero) throw new Error('Cannot set executor to zero address');
    },
  },

};

interface ProposeConfigArgs {
  org: string;
  key: string;
  value: string;
  duration: number;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  'idempotency-key'?: string;
  'no-idempotency'?: boolean;
}

export const proposeConfigHandler = {
  builder: (yargs: Argv) => yargs
    .option('key', {
      type: 'string',
      demandOption: true,
      choices: Object.keys(CONFIG_PARAMS),
      describe: 'Configuration parameter name',
    })
    .option('value', { type: 'string', demandOption: true, describe: 'New value' })
    .option('duration', { type: 'number', default: 60, describe: 'Vote duration in minutes' })
    .option('idempotency-key', { type: 'string', describe: 'Explicit idempotency key (default: derived from argv).' })
    .option('no-idempotency', { type: 'boolean', default: false, describe: 'Bypass the idempotency cache and always submit.' }),

  handler: async (argv: ArgumentsCamelCase<ProposeConfigArgs>) => {
    const spin = output.spinner('Creating config change proposal...');
    spin.start();

    try {
      const paramName = argv.key as string;
      const param = CONFIG_PARAMS[paramName];
      if (!param) throw new Error(`Unknown config key: ${paramName}. Available: ${Object.keys(CONFIG_PARAMS).join(', ')}`);

      param.validate(argv.value as string);

      if (paramName === 'quorum') {
        output.info('Note: quorum is a voter COUNT (changed from percentage in the v6 protocol).');
      }

      const contracts = await resolveVotingContracts(argv.org, argv.chain);
      const { signer } = createSigner({ privateKey: argv.privateKey as string, chainId: argv.chain, rpcUrl: argv.rpc as string });

      if (!contracts.hybridVotingAddress) throw new Error('HybridVoting not deployed');

      const iface = new ethers.utils.Interface(['function setConfig(uint8 key, bytes value)']);
      const encodedValue = param.encode(argv.value as string);

      const option0Batch: any[] = [];

      // Add Hybrid call if applicable
      if (param.hybridKey >= 0) {
        const hybridCall = iface.encodeFunctionData('setConfig', [param.hybridKey, encodedValue]);
        option0Batch.push([contracts.hybridVotingAddress, ethers.BigNumber.from(0), hybridCall]);
      }

      // Add DD call if applicable and contract exists
      if (param.ddKey !== null && contracts.ddVotingAddress) {
        const ddCall = iface.encodeFunctionData('setConfig', [param.ddKey, encodedValue]);
        option0Batch.push([contracts.ddVotingAddress, ethers.BigNumber.from(0), ddCall]);
      }

      if (option0Batch.length === 0) {
        const reason = param.hybridKey < 0 && param.hybridUnavailableReason
          ? ` ${param.hybridUnavailableReason}.`
          : '';
        throw new Error(
          `Config key "${paramName}" has no applicable voting contracts.${reason}` +
          (param.ddKey !== null && !contracts.ddVotingAddress
            ? ' No DirectDemocracyVoting contract is deployed for this org.'
            : '')
        );
      }

      const batches = [option0Batch, []]; // option 0 = change, option 1 = keep current

      // Pin metadata
      const contractList = option0Batch.length > 1 ? 'Hybrid + DD' : (param.hybridKey >= 0 ? 'Hybrid' : 'DD');
      const metadata = {
        description: `Change ${paramName} to ${argv.value}. Updates ${contractList} voting contract(s) via setConfig execution calls.`,
        optionNames: [`Set ${paramName} to ${argv.value}`, 'Keep current value'],
        createdAt: Date.now(),
      };

      const hybridVotingAddress = contracts.hybridVotingAddress;
      const resolvedOrgId = await resolveOrgId(argv.org, argv.chain);
      spin.stop();

      const run = async (): Promise<Record<string, any>> => {
        const txSpin = output.spinner('Pinning metadata...');
        txSpin.start();
        const cid = await pinJson(JSON.stringify(metadata));
        const descriptionHash = ipfsCidToBytes32(cid);
        const titleBytes = stringToBytes(`Set ${paramName} to ${argv.value}`);

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
          successMsg: 'Config change proposal created',
          fields: {
            proposalId,
            key: paramName,
            value: argv.value,
            contracts: contractList,
            duration: `${argv.duration} minutes`,
            ipfsCid: cid,
            sponsored: result.sponsored || false,
          },
        });
        return { proposalId, txHash: result.txHash, ipfsCid: cid };
      };

      // Dry runs simulate unconditionally — no idempotency consult/record.
      if (argv.dryRun) {
        await run();
      } else {
        await withIdempotency(argv, resolvedOrgId, 'vote.propose-config', run);
      }
    } catch (err: any) {
      spin.stop();
      if (err instanceof CliError) {
        output.error(err.message, { suggestion: err.suggestion });
        process.exit(err.code);
      }
      output.error(err.message);
      process.exit(EXIT.USAGE);
    }
  },
};
