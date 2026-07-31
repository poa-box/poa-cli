import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { queryWithFieldFallback } from '../../lib/subgraph';
import { resolveOrgModules } from '../../lib/resolve';
import { createProvider } from '../../lib/signer';
import { createReadContract } from '../../lib/contracts';
import { tryAggregate } from '../../lib/multicall';
import {
  FETCH_ROLES_MEMBERS_AND_VOUCH,
  FETCH_ROLES_AND_MEMBERS,
} from '../../queries/roles';
import * as output from '../../lib/output';

interface RolesArgs {
  org?: string;
  chain?: number;
  rpc?: string;
}

interface VouchSummary {
  enabled: boolean;
  quorum: string;
}

export const rolesHandler = {
  builder: (yargs: Argv) => yargs,

  handler: async (argv: ArgumentsCamelCase<RolesArgs>) => {
    const spin = output.spinner('Fetching roles...');
    spin.start();

    try {
      const modules = await resolveOrgModules(argv.org, argv.chain);

      // Tier 0 carries Role.hat.vouchConfig (present + populated on Gnosis and
      // Arbitrum). Tier 1 is the pre-vouchConfig schema; GraphQL validates the
      // whole document, so the unknown-field fallback is what keeps older
      // deployments working.
      const { data: result, tierIndex } = await queryWithFieldFallback<any>(
        [
          { query: FETCH_ROLES_MEMBERS_AND_VOUCH, variables: { id: modules.orgId } },
          { query: FETCH_ROLES_AND_MEMBERS, variables: { id: modules.orgId } },
        ],
        { chainId: argv.chain }
      );
      const org = result.organization;

      if (!org) throw new Error('Organization not found');

      const roles = org.roles || [];
      const users = org.users || [];
      const eligibilityAddr = org.eligibilityModule?.id;

      const vouchConfigs: Record<string, VouchSummary> = {};

      // Subgraph-first. handleVouchConfigSet rewrites the row on every
      // VouchConfigSet event (enable AND disable), and a null vouchConfig means
      // vouching was never configured for that hat — verified on-chain to be
      // isVouchingEnabled()==false / quorum==0, which is exactly what the '0'
      // below renders. Roles resolved here cost zero eth_calls.
      const needsRpc: any[] = [];
      for (const r of roles) {
        if (tierIndex === 0 && r.hat) {
          const vc = r.hat.vouchConfig;
          vouchConfigs[r.hatId] = {
            enabled: vc?.enabled === true,
            quorum: vc ? String(vc.quorum) : '0',
          };
        } else {
          needsRpc.push(r);
        }
      }

      // Fallback: only for roles the subgraph could not answer (old schema, or
      // a role with no Hat entity). Batched through Multicall3 — one RPC
      // round-trip for all 2N reads instead of 2N awaited calls.
      if (needsRpc.length && eligibilityAddr) {
        try {
          const provider = createProvider({ chainId: argv.chain, rpcUrl: argv.rpc as string });
          const contract = createReadContract(eligibilityAddr, 'EligibilityModuleNew', provider);
          const iface = contract.interface;

          const calls = needsRpc.flatMap((r: any) => [
            { to: eligibilityAddr, data: iface.encodeFunctionData('isVouchingEnabled', [r.hatId]) },
            { to: eligibilityAddr, data: iface.encodeFunctionData('vouchConfigs', [r.hatId]) },
          ]);
          const results = await tryAggregate(provider, calls);

          needsRpc.forEach((r: any, i: number) => {
            const enabledRes = results[i * 2];
            const configRes = results[i * 2 + 1];
            try {
              if (!enabledRes?.success || !configRes?.success) throw new Error('call reverted');
              const isEnabled = iface.decodeFunctionResult('isVouchingEnabled', enabledRes.returnData)[0];
              const config: any = iface.decodeFunctionResult('vouchConfigs', configRes.returnData)[0];
              vouchConfigs[r.hatId] = {
                enabled: Boolean(isEnabled),
                quorum: config?.quorum !== undefined && config?.quorum !== null
                  ? ethers.BigNumber.from(config.quorum).toString()
                  : '0',
              };
            } catch {
              vouchConfigs[r.hatId] = { enabled: false, quorum: '?' };
            }
          });
        } catch {
          // Eligibility module read failed — continue without vouch data
        }
      }

      // Map wearers to roles
      const roleData = roles.map((r: any) => {
        const wearers = users
          .filter((u: any) => u.currentHatIds?.includes(r.hatId) && u.membershipStatus === 'Active')
          .map((u: any) => ({
            address: u.address,
            username: u.account?.username || null,
            pt: ethers.utils.formatEther(u.participationTokenBalance || '0'),
          }));

        const vc = vouchConfigs[r.hatId];

        return {
          hatId: r.hatId,
          name: r.name || 'Unnamed',
          canVote: r.canVote,
          vouchRequired: vc?.enabled || false,
          vouchQuorum: vc?.quorum || '?',
          wearers: wearers.length,
          wearerList: wearers,
        };
      });

      spin.stop();

      if (output.isJsonMode()) {
        output.json(roleData);
      } else {
        console.log('');
        console.log('  Org Roles');
        console.log('  ─────────');
        for (const r of roleData) {
          console.log('');
          console.log(`  ${r.name}`);
          console.log(`    Hat ID:    ${r.hatId}`);
          console.log(`    Can vote:  ${r.canVote ? 'yes' : 'no'}`);
          console.log(`    Vouching:  ${r.vouchRequired ? `yes (quorum: ${r.vouchQuorum})` : 'no'}`);
          console.log(`    Wearers:   ${r.wearers}`);
          for (const w of r.wearerList) {
            const label = w.username || w.address.slice(0, 12) + '...';
            console.log(`      - ${label} (${w.pt} PT)`);
          }
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
