import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { createSigner } from '@poa/cli/lib/signer';
import { pinJson } from '@poa/cli/lib/ipfs';
import { resolveNetworkConfig } from '@poa/cli/config/networks';
import * as output from '@poa/cli/lib/output';

interface RegisterArgs {
  name: string;
  description?: string;
  capabilities?: string;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
}

// ERC-8004 Identity Registry — same address on all chains
const IDENTITY_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const REGISTRY_ABI = [
  'function register(string agentURI) external returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
];

export const registerHandler = {
  builder: (yargs: Argv) => yargs
    .option('name', { type: 'string', demandOption: true, describe: 'Agent name' })
    .option('description', { type: 'string', default: '', describe: 'Agent description' })
    .option('capabilities', { type: 'string', describe: 'Comma-separated capabilities (e.g. "governance,code-review,treasury")' }),

  handler: async (argv: ArgumentsCamelCase<RegisterArgs>) => {
    const spin = output.spinner('Registering agent on ERC-8004...');
    spin.start();

    try {
      const networkConfig = resolveNetworkConfig(argv.chain);
      const { signer } = createSigner({ privateKey: argv.privateKey as string, chainId: argv.chain, rpcUrl: argv.rpc as string });

      // Check if already registered
      const provider = new ethers.providers.JsonRpcProvider(networkConfig.resolvedRpc);
      const registry = new ethers.Contract(IDENTITY_REGISTRY, REGISTRY_ABI, provider);
      const balance = await registry.balanceOf(signer.address);
      if (balance.gt(0)) {
        spin.stop();
        output.info(`Already registered (${balance.toString()} identity NFT${balance.gt(1) ? 's' : ''})`);
        return;
      }

      // Build registration file
      const capabilities = argv.capabilities
        ? (argv.capabilities as string).split(',').map(s => s.trim())
        : ['governance', 'task-completion'];

      const regFile = {
        name: argv.name,
        description: argv.description || `AI agent operating on ${networkConfig.name}`,
        services: [
          { type: 'wallet', address: signer.address, chain: `eip155:${networkConfig.chainId}` },
        ],
        capabilities,
        active: true,
        registeredAt: new Date().toISOString(),
      };

      // Pin to IPFS
      spin.text = 'Pinning registration file to IPFS...';
      const cid = await pinJson(JSON.stringify(regFile));
      const uri = `https://ipfs.io/ipfs/${cid}`;

      if (argv.dryRun) {
        spin.stop();
        output.success('Registration prepared (dry-run)', { uri, cid, address: signer.address });
        return;
      }

      // Register on-chain
      spin.text = 'Sending registration transaction...';
      const registryWrite = new ethers.Contract(IDENTITY_REGISTRY, REGISTRY_ABI, signer);
      const tx = await registryWrite.register(uri);
      const receipt = await tx.wait();

      // Extract agent ID from Transfer event
      const transferLog = receipt.logs.find((l: any) => l.topics.length === 4);
      const agentId = transferLog
        ? ethers.BigNumber.from(transferLog.topics[3]).toString()
        : 'unknown';

      spin.stop();
      output.success(`Agent registered as #${agentId}`, {
        agentId,
        txHash: receipt.transactionHash,
        explorerUrl: `${networkConfig.blockExplorer}/tx/${receipt.transactionHash}`,
        registrationUri: uri,
        registry: IDENTITY_REGISTRY,
      });
    } catch (err: any) {
      spin.stop();
      output.error(err.message);
      process.exit(1);
    }
  },
};
