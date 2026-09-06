/** Identity and historical token balances with current MembershipAuthority standing.
 * Membership requires the authority index; account and token RPC fallbacks do not restore legacy membership.
 */
import type { Argv, ArgumentsCamelCase } from 'yargs';
import { readAuthorityRows, FETCH_AUTHORITY_MEMBERSHIPS } from '@poa-box/core/reads/authority';
import { subgraphModuleClient } from '../../lib/subgraph-module-client';
import { ethers } from 'ethers';
import { createProvider, resolveIdentityAddress } from '../../lib/signer';
import { resolveNetworkConfig } from '../../config/networks';
import { resolveOrgModules, OrgModules } from '../../lib/resolve';
import { tryAggregate, Call, CallResult } from '../../lib/multicall';
import { formatToken } from '../../lib/format';
import { getNetworkByChainId, HOME_CHAIN_ID } from '../../config/networks';
import { query } from '../../lib/subgraph';
import {
  FETCH_WHOAMI_ORG_DATA,
  FETCH_ACCOUNT_USERNAME,
  isAccountAuthoritative,
  IndexedAccount,
  IndexedQuickJoin,
} from '../../queries/user';
import { FETCH_INFRASTRUCTURE_ADDRESSES } from '../../queries/infrastructure';
import type { InfrastructureAddresses } from '../../queries/infrastructure';
import { CliError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';

interface WhoamiArgs {
  org?: string;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
}

const QUICKJOIN_IFACE = new ethers.utils.Interface([
  'function accountRegistry() view returns (address)',
]);
const UAR_IFACE = new ethers.utils.Interface([
  'function getUsername(address user) view returns (string)',
]);
const ERC20_IFACE = new ethers.utils.Interface([
  'function balanceOf(address owner) view returns (uint256)',
]);

function decodeOrNull<T>(fn: () => T, result: CallResult): T | null {
  if (!result?.success || !result.returnData || result.returnData === '0x') return null;
  try {
    return fn();
  } catch {
    return null;
  }
}

export const whoamiHandler = {
  builder: (yargs: Argv) => yargs

    .example('pop user whoami', 'Identity, balance and org standing for the configured signer')
    .example('pop user whoami --json', 'Machine-readable identity snapshot')
    .epilogue('Membership comes from the authority index; retired organizations are unavailable.'),

  handler: async (argv: ArgumentsCamelCase<WhoamiArgs>) => {
    const spin = output.spinner('Reading identity...');
    spin.start();

    try {
      // whoami is the identity-scoped READ par excellence: it needs an
      // ADDRESS and a PROVIDER, never a signer. Under POP_READONLY (or with
      // just POP_ADDRESS set) it must still answer.
      const address = resolveIdentityAddress(argv, { required: true, purpose: 'whoami' })!;
      const provider = createProvider({ chainId: argv.chain, rpcUrl: argv.rpc });
      const chainId = resolveNetworkConfig(argv.chain).chainId;
      const network = getNetworkByChainId(chainId);
      const nativeSymbol = network?.nativeCurrency.symbol ?? 'ETH';

      // Org modules — best-effort: whoami must still answer without an org.
      let modules: OrgModules | null = null;
      let orgResolutionError: string | undefined;
      if (argv.org) {
        try {
          modules = await resolveOrgModules(argv.org, argv.chain);
        } catch (err: any) {
          orgResolutionError = err?.message || String(err);
        }
      }

      // ── Native gas balance ‖ subgraph snapshot (concurrent) ─────────────
      // The gas balance is the only value the indexer cannot serve, so it is
      // the only RPC call on the happy path — and it must not gate the
      // subgraph query.
      const balancePromise: Promise<ethers.BigNumber | null> = Promise.resolve()
        .then(() => provider.getBalance(address))
        .catch(() => null);

      const orgDataPromise: Promise<any | null> = modules
        ? query<any>(FETCH_WHOAMI_ORG_DATA, {
            orgId: modules.orgId,
            orgUserID: `${modules.orgId}-${address.toLowerCase()}`,
            tokenAddress: modules.participationTokenAddress || ethers.constants.AddressZero,
            userAddress: address.toLowerCase(),
            quickJoinAddress: (modules.quickJoinAddress || ethers.constants.AddressZero).toLowerCase(),
            accountID: address.toLowerCase(),
            tokenBalanceID: `${(modules.participationTokenAddress || ethers.constants.AddressZero).toLowerCase()}-${address.toLowerCase()}`,
          }, argv.chain).catch(() => null)
        : Promise.resolve(null);

      // Without an org the username is HOME-CHAIN account-registry state —
      // that's where `pop user register` writes and `pop user profile` reads
      // — so read it from the home-chain subgraph, independent of --chain.
      const homeAccountPromise: Promise<IndexedAccount | null> = modules
        ? Promise.resolve(null)
        : query<{ account: IndexedAccount | null }>(
            FETCH_ACCOUNT_USERNAME,
            { accountID: address.toLowerCase() },
            HOME_CHAIN_ID
          ).then(r => r?.account ?? null).catch(() => null);

      const [nativeBalance, orgData, homeAccount] = await Promise.all([
        balancePromise,
        orgDataPromise,
        homeAccountPromise,
      ]);

      const quickJoin: IndexedQuickJoin | null = orgData?.quickJoinContract ?? null;
      // Subgraph-served QuickJoin pointers (byte-verified against the live
      // accountRegistry() eth_calls on Gnosis + Arbitrum).
      let registryAddr: string | null = quickJoin?.accountRegistry ?? null;

      // ── Username ────────────────────────────────────────────────────────
      const indexedAccount: IndexedAccount | null = modules
        ? (orgData?.account ?? null)
        : homeAccount;
      // In the org case the indexed account only answers for the registry
      // THIS org's QuickJoin consults; in the no-org case the subgraph's own
      // registry is the home registry by construction.
      let username: string | null = isAccountAuthoritative(indexedAccount, modules ? registryAddr : undefined)
        ? indexedAccount!.username
        : null;

      // Fallback: no usable indexed account (never registered, indexer
      // lagging a fresh `pop user register`, or a legacy org pointing at a
      // registry this subgraph does not index) → ask the chain, exactly as
      // before. This is also where the second (home-chain) provider now
      // lives; the happy path never builds it.
      let usernameProvider = provider;
      if (username === null) {
        if (!registryAddr) {
          if (modules?.quickJoinAddress) {
            // QuickJoin is not indexed — read its registry pointer directly.
            const qjResults = await tryAggregate(provider, [
              { to: modules.quickJoinAddress, data: QUICKJOIN_IFACE.encodeFunctionData('accountRegistry') },
            ]);
            registryAddr = decodeOrNull<string>(
              () => QUICKJOIN_IFACE.decodeFunctionResult('accountRegistry', qjResults[0].returnData)[0],
              qjResults[0]
            );
          }
          if (!registryAddr) {
            if (HOME_CHAIN_ID !== chainId) {
              // --rpc targets the selected chain; the home-chain provider
              // resolves its endpoint from the home-chain env/defaults.
              usernameProvider = createProvider({ chainId: HOME_CHAIN_ID });
            }
            try {
              const infra = await query<InfrastructureAddresses>(FETCH_INFRASTRUCTURE_ADDRESSES, {}, HOME_CHAIN_ID);
              registryAddr = infra.universalAccountRegistries?.[0]?.id
                || infra.poaManagerContracts?.[0]?.globalAccountRegistryProxy
                || null;
            } catch {
              // No registry reachable — username shows as unavailable.
            }
          }
        }
        if (registryAddr) {
          try {
            const nameResults = await tryAggregate(usernameProvider, [
              { to: registryAddr, data: UAR_IFACE.encodeFunctionData('getUsername', [address]) },
            ]);
            username = decodeOrNull<string>(
              () => UAR_IFACE.decodeFunctionResult('getUsername', nameResults[0].returnData)[0],
              nameResults[0]
            );
          } catch {
            username = null;
          }
        }
      }

      // ── Membership + PT balance ─────────────────────────────────────────
      const wornHats: Array<{ hatId: string; name?: string }> = [];

      let member: boolean | undefined;
      let memberSource: string | undefined;
      if (modules) {
        try {
        const memberships = await readAuthorityRows(subgraphModuleClient(), modules.orgId,
          FETCH_AUTHORITY_MEMBERSHIPS, 'subjectMemberships', argv.chain);
        const mine = memberships.filter(m => m.user.toLowerCase() === address.toLowerCase());
        member = mine.some(m => m.isMember);
        memberSource = 'membership-authority subgraph';
        wornHats.splice(0, wornHats.length, ...mine.filter(m => m.isMember).map(m => ({ hatId: m.subject.subjectId, name: m.subject.name })));
        } catch (err: any) {
          wornHats.splice(0);
          memberSource = 'authority index unavailable';
          orgResolutionError = err?.message ?? String(err);
        }
      }

      // TokenBalance mirrors every ERC-20 Transfer (mint, burn and peer
      // transfer) and exists even for an address with no org User entity, so
      // it is preferred over User.participationTokenBalance, which the
      // mapping only updates when a User row already exists. Both were
      // byte-compared against balanceOf on live Gnosis data.
      let effectivePtBalance: ethers.BigNumber | null = null;
      if (orgData?.tokenBalance?.balance !== undefined && orgData?.tokenBalance?.balance !== null) {
        effectivePtBalance = ethers.BigNumber.from(orgData.tokenBalance.balance);
      } else if (orgData?.user?.participationTokenBalance) {
        effectivePtBalance = ethers.BigNumber.from(orgData.user.participationTokenBalance);
      } else if (modules?.participationTokenAddress) {
        const ptResults = await tryAggregate(provider, [
          { to: modules.participationTokenAddress, data: ERC20_IFACE.encodeFunctionData('balanceOf', [address]) },
        ]);
        effectivePtBalance = decodeOrNull<ethers.BigNumber>(
          () => ERC20_IFACE.decodeFunctionResult('balanceOf', ptResults[0].returnData)[0],
          ptResults[0]
        );
      }

      const pendingTokenRequests: number | undefined = orgData ? (orgData.tokenRequests || []).length : undefined;

      spin.stop();

      if (output.isJsonMode()) {
        output.json({
          address,
          username: username && username.length > 0 ? username : null,
          chainId,
          network: network?.name ?? `chain ${chainId}`,
          balance: nativeBalance ? {
            wei: nativeBalance.toString(),
            formatted: formatToken(nativeBalance, 18, nativeSymbol),
            symbol: nativeSymbol,
          } : null,
          org: modules ? {
            id: modules.orgId,
            name: orgData?.organization?.name,
            member: member ?? null,
            memberSource,
            ptBalance: effectivePtBalance ? {
              wei: effectivePtBalance.toString(),
              formatted: formatToken(effectivePtBalance, 18, 'PT'),
            } : null,
            hats: wornHats,
            pendingTokenRequests: pendingTokenRequests ?? null,
          } : undefined,
          orgError: orgResolutionError,
        });
        return;
      }

      const identity: Record<string, string | number | undefined> = {
        address,
        username: username && username.length > 0
          ? username
          : 'not registered (pop user register --username <name>)',
        network: `${network?.name ?? `chain ${chainId}`} (${chainId})`,
        balance: nativeBalance ? formatToken(nativeBalance, 18, nativeSymbol) : '(unavailable)',
      };
      console.log('');
      output.keyValueBlock('Who am I', identity);

      if (orgResolutionError) {
        output.warn(`Org "${argv.org}" could not be resolved: ${orgResolutionError}`);
      } else if (modules) {
        const orgFields: Record<string, string | number | undefined> = {
          org: orgData?.organization?.name
            ? `${orgData.organization.name} (${modules.orgId})`
            : modules.orgId,
          member: member === undefined ? '(unknown — authority index unavailable)' : `${member ? 'yes' : 'no'} (${memberSource})`,
          'PT balance': effectivePtBalance ? formatToken(effectivePtBalance, 18, 'PT') : '(unavailable)',
          hats: wornHats.length > 0
            ? wornHats.map(h => h.name ? `${h.name} (${h.hatId})` : h.hatId).join(', ')
            : 'none',
          'pending token requests': pendingTokenRequests ?? '(unavailable)',
        };
        console.log('');
        output.keyValueBlock('Org standing', orgFields);
      }
      console.log('');
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
