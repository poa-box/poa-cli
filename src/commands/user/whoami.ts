/**
 * pop user whoami — one-shot identity + org standing for the current signer.
 *
 * Shows the signer address, registered username, native gas balance, and —
 * when a default org is configured — membership (authoritative on-chain hat
 * check against quickJoin.memberHatIds when readable, subgraph fallback),
 * PT balance, hats worn (names resolved from the org's role data), and the
 * count of pending participation-token requests.
 *
 * Reads batch through Multicall3 (two phases: the second depends on the
 * registry / member-hat addresses returned by the first); the subgraph
 * snapshot runs concurrently with phase 2. Every section degrades
 * gracefully — a dead subgraph or missing module never hides the identity
 * fields.
 *
 * Note for the orchestrator: a top-level `pop whoami` alias needs a
 * registration in src/index.ts (owned by another agent) — until then the
 * command lives at `pop user whoami` only.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { createSigner, createProvider } from '../../lib/signer';
import { resolveOrgModules, OrgModules } from '../../lib/resolve';
import { tryAggregate, getEthBalanceCall, decodeEthBalance, Call, CallResult } from '../../lib/multicall';
import { formatToken } from '../../lib/format';
import { getNetworkByChainId, HOME_CHAIN_ID } from '../../config/networks';
import { query } from '../../lib/subgraph';
import { FETCH_WHOAMI_ORG_DATA } from '../../queries/user';
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

export const whoamiHandler = {
  builder: (yargs: Argv) => yargs
    .example('pop user whoami', 'Identity, balance and org standing for the configured signer')
    .example('pop user whoami --json', 'Machine-readable identity snapshot'),

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

      // ── Phase 1: native balance + org module pointers (one round-trip) ──
      const phase1: Call[] = [getEthBalanceCall(address)];
      let qjBase = -1;
      let ptIndex = -1;
      if (modules?.quickJoinAddress) {
        qjBase = phase1.length;
        phase1.push(
          { to: modules.quickJoinAddress, data: QUICKJOIN_IFACE.encodeFunctionData('accountRegistry') },
          { to: modules.quickJoinAddress, data: QUICKJOIN_IFACE.encodeFunctionData('memberHatIds') },
          { to: modules.quickJoinAddress, data: QUICKJOIN_IFACE.encodeFunctionData('hats') },
        );
      }
      if (modules?.participationTokenAddress) {
        ptIndex = phase1.length;
        phase1.push({ to: modules.participationTokenAddress, data: ERC20_IFACE.encodeFunctionData('balanceOf', [address]) });
      }
      const phase1Results = await tryAggregate(provider, phase1);

      const nativeBalance = decodeOrNull(
        () => decodeEthBalance(phase1Results[0].returnData),
        phase1Results[0]
      );
      let registryAddr = qjBase >= 0
        ? decodeOrNull<string>(
            () => QUICKJOIN_IFACE.decodeFunctionResult('accountRegistry', phase1Results[qjBase].returnData)[0],
            phase1Results[qjBase]
          )
        : null;
      const memberHatIds = qjBase >= 0
        ? decodeOrNull<ethers.BigNumber[]>(
            () => QUICKJOIN_IFACE.decodeFunctionResult('memberHatIds', phase1Results[qjBase + 1].returnData)[0],
            phase1Results[qjBase + 1]
          )
        : null;
      const hatsAddr = qjBase >= 0
        ? decodeOrNull<string>(
            () => QUICKJOIN_IFACE.decodeFunctionResult('hats', phase1Results[qjBase + 2].returnData)[0],
            phase1Results[qjBase + 2]
          )
        : null;
      const ptBalance = ptIndex >= 0
        ? decodeOrNull<ethers.BigNumber>(
            () => ERC20_IFACE.decodeFunctionResult('balanceOf', phase1Results[ptIndex].returnData)[0],
            phase1Results[ptIndex]
          )
        : null;

      // Where the username lives. An org QuickJoin points at its own registry
      // on the selected chain (read via the selected-chain multicall below).
      // Without an org, the account registry is HOME-CHAIN state — that's
      // where `pop user register` writes and `pop user profile` reads — so
      // resolve + read it on the home chain, independent of the selected
      // --chain (which still drives the balance/org/PT/hat checks). Otherwise
      // a home-chain registration reads as "not registered" whenever the
      // default chain is an org chain.
      let usernameProvider = provider;
      if (!registryAddr) {
        if (HOME_CHAIN_ID !== chainId) {
          // --rpc targets the selected chain; the home-chain provider resolves
          // its endpoint from the home-chain env/defaults.
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
      const usernameOnSelectedChain = usernameProvider === provider;

      // ── Phase 2 (chain) + subgraph snapshot, concurrently ──────────────
      const phase2: Call[] = [];
      let usernameIndex = -1;
      let hatBalanceBase = -1;
      // Batch getUsername into the selected-chain multicall only when the
      // registry is on that chain; the home-chain fallback reads separately.
      if (registryAddr && usernameOnSelectedChain) {
        usernameIndex = phase2.length;
        phase2.push({ to: registryAddr, data: UAR_IFACE.encodeFunctionData('getUsername', [address]) });
      }
      const homeUsernamePromise: Promise<string | null> = (registryAddr && !usernameOnSelectedChain)
        ? tryAggregate(usernameProvider, [
            { to: registryAddr, data: UAR_IFACE.encodeFunctionData('getUsername', [address]) },
          ])
            .then((r) => decodeOrNull<string>(
              () => UAR_IFACE.decodeFunctionResult('getUsername', r[0].returnData)[0],
              r[0]
            ))
            .catch(() => null)
        : Promise.resolve(null);
      if (hatsAddr && memberHatIds && memberHatIds.length > 0) {
        hatBalanceBase = phase2.length;
        for (const hatId of memberHatIds) {
          phase2.push({ to: hatsAddr, data: HATS_IFACE.encodeFunctionData('balanceOf', [address, hatId]) });
        }
      }

      const subgraphPromise: Promise<any | null> = modules
        ? query<any>(FETCH_WHOAMI_ORG_DATA, {
            orgId: modules.orgId,
            orgUserID: `${modules.orgId}-${address.toLowerCase()}`,
            tokenAddress: modules.participationTokenAddress || ethers.constants.AddressZero,
            userAddress: address.toLowerCase(),
          }, argv.chain).catch(() => null)
        : Promise.resolve(null);

      const [phase2Results, orgData, homeUsername] = await Promise.all([
        tryAggregate(provider, phase2),
        subgraphPromise,
        homeUsernamePromise,
      ]);

      const username = usernameIndex >= 0
        ? decodeOrNull<string>(
            () => UAR_IFACE.decodeFunctionResult('getUsername', phase2Results[usernameIndex].returnData)[0],
            phase2Results[usernameIndex]
          )
        : homeUsername;

      // Membership: authoritative on-chain member-hat check when readable,
      // else the subgraph's membershipStatus.
      let member: boolean | undefined;
      let memberSource: string | undefined;
      if (hatBalanceBase >= 0 && memberHatIds) {
        const balances = memberHatIds.map((_, i) => decodeOrNull<ethers.BigNumber>(
          () => HATS_IFACE.decodeFunctionResult('balanceOf', phase2Results[hatBalanceBase + i].returnData)[0],
          phase2Results[hatBalanceBase + i]
        ));
        if (balances.some(balance => balance !== null)) {
          member = balances.some(balance => balance !== null && !balance.isZero());
          memberSource = 'on-chain hat check';
        }
      }
      if (member === undefined && orgData?.user) {
        // membershipStatus is the subgraph enum 'Active' | 'Inactive' — a
        // truthiness check would call every indexed user a member.
        member = orgData.user.membershipStatus === 'Active';
        memberSource = 'subgraph';
      }

      const roles: Array<{ hatId: string; name?: string }> =
        (orgData?.organization?.roles || []).map((r: any) => ({ hatId: String(r.hatId), name: r.name }));
      const wornHatIds: string[] = (orgData?.user?.currentHatIds || []).map(String);
      const wornHats = wornHatIds.map(hatId => ({ hatId, name: resolveHatName(hatId, roles) }));

      const effectivePtBalance = ptBalance ?? (orgData?.user?.participationTokenBalance
        ? ethers.BigNumber.from(orgData.user.participationTokenBalance)
        : null);
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
