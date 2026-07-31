import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { execFileSync } from 'child_process';
import { type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createSigner } from '@poa/cli/lib/signer';
import { createWriteContract } from '@poa/cli/lib/contracts';
import { executeTx } from '@poa/cli/lib/tx';
import { pinJson } from '@poa/cli/lib/ipfs';
import { stringToBytes } from '@poa/cli/lib/encoding';
import { resolveNetworkConfig } from '@poa/cli/config/networks';
import { resolveOrgModules } from '@poa/cli/lib/resolve';
import { isDelegated, delegateEOA } from '@poa/cli/lib/sponsored';
import * as output from '@poa/cli/lib/output';

const IDENTITY_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const REGISTRY_ABI = [
  'function register(string agentURI) external returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
];

interface OnboardArgs {
  org: string;
  username: string;
  description?: string;
  capabilities?: string;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
}

export const onboardHandler = {
  builder: (yargs: Argv) => yargs
    .option('username', { type: 'string', demandOption: true, describe: 'Agent username' })
    .option('description', { type: 'string', default: '', describe: 'Agent description' })
    .option('capabilities', { type: 'string', describe: 'Comma-separated capabilities' }),

  handler: async (argv: ArgumentsCamelCase<OnboardArgs>) => {
    const spin = output.spinner('Onboarding agent...');
    spin.start();

    try {
      const key = (argv.privateKey as string) || process.env.POP_PRIVATE_KEY;
      if (!key) throw new Error('No private key configured');

      const { signer } = createSigner({ privateKey: key, chainId: argv.chain, rpcUrl: argv.rpc as string });
      const address = await signer.getAddress();
      const networkConfig = resolveNetworkConfig(argv.chain);
      const rpcUrl = networkConfig.resolvedRpc;

      const results: Record<string, any> = { address, username: argv.username, steps: [] };

      // Step 1: Register username (via pop user register --username)
      spin.text = '1/4 Registering username...';
      if (argv.dryRun) {
        // --dry-run is a GLOBAL flag and this step broadcasts a real
        // registration tx through the child process. It must honor the flag
        // like steps 2 and 3 do — an integrator probing the CLI safely is
        // exactly who runs onboard --dry-run first.
        results.steps.push({ step: 'register', success: true, note: `Would register username "${argv.username}" (dry-run)` });
      } else {
        try {
          // execFile with an args ARRAY — never a shell string. The username is
          // operator input; interpolating it into a shell command is injectable.
          const regOutput = execFileSync(
            process.execPath,
            [
              `${__dirname}/../../index.js`,
              'user', 'register',
              '--username', String(argv.username),
              '--chain', String(networkConfig.chainId),
              '--json', '-y',
            ],
            { env: process.env, encoding: 'utf8', timeout: 30000 }
          );
          results.steps.push({ step: 'register', success: true, output: JSON.parse(regOutput) });
        } catch (e: any) {
          // May fail if already registered — that's ok
          results.steps.push({ step: 'register', success: false, error: e.message?.slice(0, 100) || 'Already registered or failed' });
        }
      }

      // Step 2: EIP-7702 delegation
      spin.text = '2/4 Setting up gas sponsorship delegation...';
      try {
        const account = privateKeyToAccount(key as Hex);
        const alreadyDelegated = await isDelegated(account.address, rpcUrl);
        if (alreadyDelegated) {
          results.steps.push({ step: 'delegate', success: true, note: 'Already delegated' });
        } else if (argv.dryRun) {
          results.steps.push({ step: 'delegate', success: true, note: 'Would delegate (dry-run)' });
        } else {
          const delegateTx = await delegateEOA(key as Hex, rpcUrl);
          results.steps.push({ step: 'delegate', success: true, txHash: delegateTx });
        }
      } catch (e: any) {
        results.steps.push({ step: 'delegate', success: false, error: e.message?.slice(0, 100) });
      }

      // Step 3: ERC-8004 identity registration
      spin.text = '3/4 Registering on-chain identity...';
      try {
        const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
        const regSigner = new ethers.Wallet(key, provider);
        const registry = new ethers.Contract(IDENTITY_REGISTRY, REGISTRY_ABI, regSigner);

        const existing = await registry.balanceOf(address);
        if (existing.gt(0)) {
          results.steps.push({ step: 'identity', success: true, note: 'Already registered' });
        } else {
          const capList = (argv.capabilities as string)?.split(',').map(s => s.trim()) || ['governance'];
          const registration = {
            name: argv.username,
            description: argv.description || `Agent in ${argv.org}`,
            services: [{ type: 'wallet', address, chain: `eip155:${networkConfig.chainId}` }],
            org: { name: argv.org, protocol: 'POP' },
            capabilities: capList,
            active: true,
          };

          // Pin only when actually registering: pinning publishes the doc to
          // IPFS publicly and irreversibly, which is a real side effect a
          // dry run must not have.
          if (argv.dryRun) {
            results.steps.push({ step: 'identity', success: true, note: 'Would pin registration JSON and register (dry-run)' });
          } else {
            const cid = await pinJson(JSON.stringify(registration));
            const uri = `https://ipfs.io/ipfs/${cid}`;
            const tx = await registry.register(uri);
            const receipt = await tx.wait();
            const transferTopic = ethers.utils.id('Transfer(address,address,uint256)');
            const transferLog = receipt.logs.find((l: any) => l.topics[0] === transferTopic);
            const agentId = transferLog ? ethers.BigNumber.from(transferLog.topics[3]).toString() : 'unknown';
            results.steps.push({ step: 'identity', success: true, agentId, uri });
          }
        }
      } catch (e: any) {
        results.steps.push({ step: 'identity', success: false, error: e.message?.slice(0, 100) });
      }

      // Step 4: Brain scaffolding
      spin.text = '4/4 Creating brain files...';
      results.steps.push({
        step: 'brain',
        success: true,
        note: 'Create ~/.pop-agent/brain/ with who-i-am.md, philosophy.md, goals.md, capabilities.md, lessons.md',
      });

      spin.stop();

      const succeeded = results.steps.filter((s: any) => s.success).length;
      const total = results.steps.length;

      if (output.isJsonMode()) {
        output.json({ ...results, summary: `${succeeded}/${total} steps completed` });
      } else {
        console.log('');
        console.log(`  Agent Onboarding: ${argv.username}`);
        console.log('  ' + '─'.repeat(40));
        for (const step of results.steps) {
          const icon = step.success ? '✓' : '✗';
          const color = step.success ? '\x1b[32m' : '\x1b[31m';
          const detail = step.note || step.txHash?.slice(0, 16) || step.error || '';
          console.log(`  ${color}${icon}\x1b[0m ${step.step}: ${detail}`);
        }
        console.log('');
        console.log(`  ${succeeded}/${total} steps completed.`);
        if (succeeded === total) {
          console.log('  Next: write ~/.pop-agent/brain/Identity/philosophy.md');
          console.log('  Then: run /heartbeat');
        }
        console.log('');
      }
    } catch (err: any) {
      spin.stop();
      output.error(err.message);
      process.exit(1);
    }
  },
};
