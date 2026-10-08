import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { createSigner } from '@poa-box/cli/lib/signer';
import { resolveNetworkConfig } from '@poa-box/cli/config/networks';
import { resolveOrgId } from '@poa-box/cli/lib/resolve';
import { refreshAuthorityUsers } from '@poa-box/cli/lib/authority';
import * as output from '@poa-box/cli/lib/output';

interface DeployToOrgArgs {
  'target-org': string;
  chain: number;
  username?: string;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
}

const IDENTITY_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';

export const deployToOrgHandler = {
  builder: (yargs: Argv) => yargs
    .option('target-org', { type: 'string', demandOption: true, describe: 'Target org name' })
    .option('chain', { type: 'number', demandOption: true, describe: 'Target chain ID' })
    .option('username', { type: 'string', describe: 'Username to register (if not already registered)' }),

  handler: async (argv: ArgumentsCamelCase<DeployToOrgArgs>) => {
    const spin = output.spinner('Preparing cross-org deployment...');
    spin.start();

    try {
      const networkConfig = resolveNetworkConfig(argv.chain);
      const { signer } = createSigner({ privateKey: argv.privateKey as string, chainId: argv.chain, rpcUrl: argv.rpc as string });
      const provider = new ethers.providers.JsonRpcProvider(networkConfig.resolvedRpc);

      const steps: Array<{ step: string; status: string; detail?: string }> = [];

      // Step 1: Check wallet balance on target chain
      spin.text = 'Checking wallet balance...';
      const balance = await provider.getBalance(signer.address);
      const balanceEth = ethers.utils.formatEther(balance);
      const hasGas = balance.gt(ethers.utils.parseEther('0.001'));
      steps.push({
        step: 'Wallet balance',
        status: hasGas ? 'OK' : 'NEEDS_FUNDING',
        detail: `${balanceEth} ${networkConfig.nativeCurrency.symbol}`,
      });

      // Step 2: Check ERC-8004 registration on target chain
      spin.text = 'Checking ERC-8004 identity...';
      const registryAbi = ['function balanceOf(address) view returns (uint256)'];
      const registry = new ethers.Contract(IDENTITY_REGISTRY, registryAbi, provider);
      let hasIdentity = false;
      try {
        const idBalance = await registry.balanceOf(signer.address);
        hasIdentity = idBalance.gt(0);
      } catch { /* registry might not exist on this chain */ }
      steps.push({
        step: 'ERC-8004 identity',
        status: hasIdentity ? 'REGISTERED' : 'NOT_REGISTERED',
        detail: hasIdentity ? 'Agent identity exists on target chain' : 'Run pop agent register --chain ' + argv.chain,
      });

      // Step 3: Check delegation
      spin.text = 'Checking EIP-7702 delegation...';
      let isDelegated = false;
      try {
        const code = await provider.getCode(signer.address);
        isDelegated = code.length > 2 && code.startsWith('0xef0100');
      } catch { /* not delegated */ }
      steps.push({
        step: 'EIP-7702 delegation',
        status: isDelegated ? 'DELEGATED' : 'NOT_DELEGATED',
        detail: isDelegated ? 'EOA delegated to EOADelegation' : 'Run pop agent delegate --chain ' + argv.chain,
      });

      // Step 4: Check if org exists on target chain
      spin.text = 'Checking target org...';
      // Resolve only authority-ready organizations on the requested chain. Historical
      // User rows include former members and are not proof of current membership.
      const orgId = await resolveOrgId(argv.targetOrg, argv.chain);
      const org: { users: any[] } = { users: [] };
      await refreshAuthorityUsers(org, orgId, argv.chain);
      const members = org.users.filter(user => user.membershipStatus === 'Active');
      const orgFound = true;
      const orgMembers = members.length;
      const isMember = members.some(user => user.address.toLowerCase() === signer.address.toLowerCase());
      steps.push({
        step: 'Target org',
        status: orgFound ? (isMember ? 'MEMBER' : 'FOUND') : 'NOT_FOUND',
        detail: orgFound ? `${argv.targetOrg} (${orgMembers} members)${isMember ? ' — already a member!' : ''}` : `${argv.targetOrg} not found on chain ${argv.chain}`,
      });

      spin.stop();

      // Summary
      const ready = hasGas && orgFound;
      const needsAction = steps.filter(s => !['OK', 'REGISTERED', 'DELEGATED', 'MEMBER', 'FOUND'].includes(s.status));

      if (output.isJsonMode()) {
        output.json({ targetOrg: argv.targetOrg, chain: argv.chain, address: signer.address, steps, ready, needsAction: needsAction.length });
      } else {
        console.log('');
        console.log(`  Cross-Org Deployment: ${signer.address.slice(0, 10)}... → ${argv.targetOrg}`);
        console.log('  ' + '═'.repeat(50));
        for (const s of steps) {
          const icon = ['OK', 'REGISTERED', 'DELEGATED', 'MEMBER'].includes(s.status) ? '✓' : s.status === 'FOUND' ? '○' : '✗';
          console.log(`  ${icon} ${s.step}: ${s.detail}`);
        }
        console.log('');
        if (isMember) {
          console.log('  ✓ Already a member of this org!');
        } else if (ready) {
          console.log('  Ready to deploy. Next steps:');
          console.log(`    1. Ask a ${argv.targetOrg} member to vouch for you`);
          console.log(`    2. pop vouch claim --subject <role-id> --org ${JSON.stringify(argv.targetOrg)} --chain ${argv.chain}`);
          if (!hasIdentity) console.log(`    3. pop agent register --name <name> --chain ${argv.chain}`);
          if (!isDelegated) console.log(`    ${hasIdentity ? '3' : '4'}. pop agent delegate --chain ${argv.chain}`);
        } else {
          console.log('  Not ready. Fix issues marked ✗ above.');
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
