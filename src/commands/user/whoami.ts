/**
 * pop user whoami — one-shot identity + org standing for the current signer.
 *
 * Shows the signer address, registered username, native gas balance, and —
 * when a default org is configured — membership, PT balance, hats worn
 * (names resolved from the org's role data), and the count of pending
 * participation-token requests.
 *
 * SUBGRAPH-FIRST (this is the agent hot path). One subgraph round-trip
 * answers everything except the native gas balance, which is the only value
 * no indexer holds; it is fetched with eth_getBalance CONCURRENTLY with the
 * subgraph query, never before it. The old shape cost up to six eth_calls
 * across two Multicall3 phases plus a second JsonRpcProvider built purely to
 * read a username off the home chain — that second provider is now only
 * constructed on the fallback path, i.e. when the subgraph has no account for
 * the signer at all.
 *
 * Every RPC read it replaced is retained as a fallback, so a stale/empty
 * subgraph degrades to the old behaviour instead of lying:
 *   - username        → registry.getUsername when the indexed account is
 *                       missing, deleted, or belongs to a different registry
 *                       than the one this org's QuickJoin consults
 *   - PT balance      → ERC20.balanceOf when neither TokenBalance nor the
 *                       org User entity is indexed
 *   - membership      → Hats.balanceOf over the QuickJoin member hats, when
 *                       the subgraph has no User entity, or on demand with
 *                       --on-chain
 *
 * Note for the orchestrator: a top-level `pop whoami` alias needs a
 * registration in src/index.ts (owned by another agent) — until then the
 * command lives at `pop user whoami` only.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { createSigner, createProvider } from '../../lib/signer';
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
  'on-chain'?: boolean;
}

const QUICKJOIN_IFACE = new ethers.utils.Interface([
  'function accountRegistry() view returns (address)',
  'function memberHatIds() view returns (uint256[])',
  'function hats() view returns (address)',
]);
const UAR_IFACE = new ethers.utils.Interface([
  'function getUsername(address user) view returns (string)',
]);
const ERC20_IFACE = new ethers.utils.Interface([
  'function balanceOf(address owner) view returns (uint256)',
]);
const HATS_IFACE = new ethers.utils.Interface([
  'function balanceOf(address wearer, uint256 hatId) view returns (uint256)',
]);

function decodeOrNull<T>(fn: () => T, result: CallResult): T | null {
  if (!result?.success || !result.returnData || result.returnData === '0x') return null;
  try {
    return fn();
  } catch {
    return null;
  }
}

/** Match a worn hat ID against org role entries (decimal/hex tolerant). */
export function resolveHatName(hatId: string, roles: Array<{ hatId: string; name?: string }>): string | undefined {
  for (const role of roles) {
    if (role.hatId === hatId) return role.name;
    try {
      if (ethers.BigNumber.from(role.hatId).eq(ethers.BigNumber.from(hatId))) return role.name;
    } catch {
      // Non-numeric role hatId — skip
    }
  }
  return undefined;
}

/**
 * Do any of the hats worn match any of the org's member hats?
 * Both lists are uint256 strings, so compare as BigNumbers — a string
 * compare would miss a decimal/hex spelling difference. Unparseable entries
 * are skipped rather than throwing.
 */
export function wearsAnyMemberHat(wornHatIds: string[], memberHatIds: string[]): boolean {
  for (const worn of wornHatIds) {
    let wornBn: ethers.BigNumber;
    try {
      wornBn = ethers.BigNumber.from(worn);
    } catch {
      continue;
    }
    for (const member of memberHatIds) {
      try {
        if (wornBn.eq(ethers.BigNumber.from(member))) return true;
      } catch {
        // Non-numeric member hat entry — skip
      }
    }
  }
  return false;
}

export const whoamiHandler = {
  builder: (yargs: Argv) => yargs
    .option('on-chain', {
      type: 'boolean',
      default: false,
      describe: 'Re-verify membership with a live Hats.balanceOf call instead of the subgraph\'s indexed hat state (slower; catches a dynamically revoked eligibility that burned no token)',
    })
    .example('pop user whoami', 'Identity, balance and org standing for the configured signer')
    .example('pop user whoami --json', 'Machine-readable identity snapshot')
    .example('pop user whoami --on-chain', 'Confirm membership against Hats Protocol rather than the indexer'),

  handler: async (argv: ArgumentsCamelCase<WhoamiArgs>) => {
    const spin = output.spinner('Reading identity...');
    spin.start();

    try {
      const { address, provider, chainId } = createSigner({
        privateKey: argv['private-key'] as string | undefined,
        chainId: argv.chain,
        rpcUrl: argv.rpc,
      });
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
      // accountRegistry()/hats()/memberHatIds() eth_calls on Gnosis + Arbitrum).
      let registryAddr: string | null = quickJoin?.accountRegistry ?? null;
      let hatsAddr: string | null = quickJoin?.hatsContract ?? null;
      let memberHatIds: string[] | null = quickJoin?.memberHatIds ?? null;

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
      const roles: Array<{ hatId: string; name?: string }> =
        (orgData?.organization?.roles || []).map((r: any) => ({ hatId: String(r.hatId), name: r.name }));
      const wornHatIds: string[] = (orgData?.user?.currentHatIds || []).map(String);
      const wornHats = wornHatIds.map(hatId => ({ hatId, name: resolveHatName(hatId, roles) }));

      // hatId (decimal string) -> Hats Protocol toggle flag, for the org's role hats.
      const hatActiveById = new Map<string, boolean>();
      for (const r of orgData?.organization?.roles || []) {
        if (typeof r?.hat?.active === 'boolean') hatActiveById.set(String(r.hatId), r.hat.active);
      }

      let member: boolean | undefined;
      let memberSource: string | undefined;
      const forceOnChain = argv['on-chain'] === true;

      /** Membership as the indexer sees it, or undefined when it has no User row. */
      const membershipFromSubgraph = (): boolean | undefined => {
        if (!orgData?.user) return undefined;
        if (memberHatIds && memberHatIds.length > 0) {
          // Does the signer wear any of QuickJoin's member hats? User.currentHatIds is
          // driven off the canonical Hats ERC-1155 TransferSingle/Batch stream — but a
          // hat that has been TOGGLED OFF still appears there, because Hats does not
          // burn the token when the toggle flips. Hats.balanceOf (the check this
          // replaces) returns 0 in that state. So restrict the comparison to member
          // hats the indexer says are still active.
          //
          // A member hat whose `active` flag is unknown (not one of the org's indexed
          // roles) is NOT silently treated as active: returning undefined here defers
          // to the authoritative on-chain balanceOf path below rather than guessing.
          const activeMemberHatIds: string[] = [];
          for (const id of memberHatIds) {
            const active = hatActiveById.get(String(id));
            if (active === undefined) return undefined; // unknown -> ask the chain
            if (active) activeMemberHatIds.push(id);
          }
          if (activeMemberHatIds.length === 0) return false; // every member hat toggled off
          return wearsAnyMemberHat(wornHatIds, activeMemberHatIds);
        }
        // No member hats configured (verified genuinely empty on-chain for
        // several live orgs) — fall back to the indexed enum. It is the
        // subgraph enum 'Active' | 'Inactive'; a truthiness check would call
        // every indexed user a member.
        return orgData.user.membershipStatus === 'Active';
      };

      if (!forceOnChain) {
        member = membershipFromSubgraph();
        if (member !== undefined) memberSource = 'subgraph';
      }

      // Fallback (or --on-chain): the authoritative Hats.balanceOf check.
      // Hats.balanceOf folds in DYNAMIC eligibility, which can revoke a hat
      // without burning the token and therefore without an event the indexer
      // can see — the one way the two answers legitimately diverge.
      if (member === undefined || forceOnChain) {
        if (!hatsAddr || !memberHatIds) {
          if (modules?.quickJoinAddress) {
            const qjResults = await tryAggregate(provider, [
              { to: modules.quickJoinAddress, data: QUICKJOIN_IFACE.encodeFunctionData('hats') },
              { to: modules.quickJoinAddress, data: QUICKJOIN_IFACE.encodeFunctionData('memberHatIds') },
            ]);
            hatsAddr = hatsAddr ?? decodeOrNull<string>(
              () => QUICKJOIN_IFACE.decodeFunctionResult('hats', qjResults[0].returnData)[0],
              qjResults[0]
            );
            const decodedHatIds = decodeOrNull<ethers.BigNumber[]>(
              () => QUICKJOIN_IFACE.decodeFunctionResult('memberHatIds', qjResults[1].returnData)[0],
              qjResults[1]
            );
            memberHatIds = memberHatIds ?? (decodedHatIds ? decodedHatIds.map(id => id.toString()) : null);
          }
        }
        if (hatsAddr && memberHatIds && memberHatIds.length > 0) {
          const hatCalls: Call[] = memberHatIds.map(hatId => ({
            to: hatsAddr as string,
            data: HATS_IFACE.encodeFunctionData('balanceOf', [address, ethers.BigNumber.from(hatId)]),
          }));
          const hatResults = await tryAggregate(provider, hatCalls);
          const balances = hatCalls.map((_, i) => decodeOrNull<ethers.BigNumber>(
            () => HATS_IFACE.decodeFunctionResult('balanceOf', hatResults[i].returnData)[0],
            hatResults[i]
          ));
          if (balances.some(balance => balance !== null)) {
            member = balances.some(balance => balance !== null && !balance.isZero());
            memberSource = 'on-chain hat check';
          }
        }
        // --on-chain asked for the chain but the chain could not answer —
        // report the indexer's view rather than "(unknown)".
        if (member === undefined) {
          member = membershipFromSubgraph();
          if (member !== undefined) memberSource = 'subgraph';
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
          member: member === undefined ? '(unknown — subgraph and hat reads unavailable)' : `${member ? 'yes' : 'no'} (${memberSource})`,
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
