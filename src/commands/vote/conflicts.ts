import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { query } from '../../lib/subgraph';
import { resolveOrgModules } from '../../lib/resolve';
import { resolveNetworkConfig } from '../../config/networks';
import { getTokenBySymbol } from '../../config/tokens';
import * as output from '../../lib/output';

interface ConflictsArgs {
  org: string;
  chain?: number;
  rpc?: string;
}

interface ResourceClaim {
  proposalId: string;
  title: string;
  token: string;
  amount: number;
  votes: number;
  endTimestamp: number;
}

/**
 * Parse common treasury operations from proposal titles.
 * This is a heuristic — the subgraph does not expose the raw execution calls.
 * We match patterns like "Bridge 0.4 xDAI", "Distribute 2.0 BREAD", "Swap 15 BREAD".
 */
export function parseResourceClaims(title: string): { token: string; amount: number } | null {
  // Normalize
  const t = title.toLowerCase();

  // Extract "<verb> <amount> <TOKEN>" patterns
  // Supports: bridge, swap, deposit, distribute, send, withdraw, wrap, unwrap
  const verbPattern = /(bridge|swap|deposit|distribute|send|withdraw|wrap|unwrap)\s+([\d.]+)\s+(xdai|wxdai|bread|sdai|usdc|eth|grt)/i;
  const match = title.match(verbPattern);
  if (!match) return null;

  const amount = parseFloat(match[2]);
  let token = match[3].toUpperCase();
  if (isNaN(amount)) return null;

  // Normalize token symbol
  if (token === 'XDAI') token = 'xDAI';
  return { token, amount };
}

export const conflictsHandler = {
  builder: (yargs: Argv) => yargs
    .option('token', { type: 'string', describe: 'Filter by specific token (e.g. xDAI, BREAD)' }),

  handler: async (argv: ArgumentsCamelCase<ConflictsArgs & { token?: string }>) => {
    const spin = output.spinner('Scanning active proposals for conflicts...');
    spin.start();

    try {
      const modules = await resolveOrgModules(argv.org, argv.chain);
      if (!modules.hybridVotingAddress) {
        throw new Error('No HybridVoting contract found for this org');
      }

      // Query active hybrid proposals
      const result = await query<any>(`
        query ActiveProposals($votingId: String!) {
          proposals(
            where: { hybridVoting: $votingId, status: "Active" }
            orderBy: endTimestamp
            orderDirection: asc
            first: 50
          ) {
            proposalId
            title
            endTimestamp
            votes { voter }
          }
        }
      `, { votingId: modules.hybridVotingAddress }, argv.chain);

      const proposals = result.proposals || [];

      // Parse resource claims from titles
      const claims: ResourceClaim[] = [];
      const unparsed: Array<{ proposalId: string; title: string }> = [];

      for (const p of proposals) {
        const claim = parseResourceClaims(p.title || '');
        if (claim) {
          if (argv.token && claim.token.toLowerCase() !== argv.token.toLowerCase()) continue;
          claims.push({
            proposalId: p.proposalId,
            title: p.title,
            token: claim.token,
            amount: claim.amount,
            votes: (p.votes || []).length,
            endTimestamp: Number(p.endTimestamp),
          });
        } else {
          unparsed.push({ proposalId: p.proposalId, title: p.title });
        }
      }

      // Group by token and compute total claims
      const byToken: Record<string, { claims: ResourceClaim[]; total: number }> = {};
      for (const c of claims) {
        if (!byToken[c.token]) byToken[c.token] = { claims: [], total: 0 };
        byToken[c.token].claims.push(c);
        byToken[c.token].total += c.amount;
      }

      // Fetch current treasury balances
      spin.text = 'Fetching treasury balances...';
      const config = resolveNetworkConfig(argv.chain);
      const provider = new ethers.providers.JsonRpcProvider(
        (argv.rpc as string) || config.resolvedRpc,
        config.chainId
      );
      const executor = modules.executorAddress || '0x9116bb47ef766cd867151fee8823e662da3bdad9';

      const balances: Record<string, number> = {};
      // Native xDAI
      const nativeBal = await provider.getBalance(executor);
      balances['xDAI'] = parseFloat(ethers.utils.formatEther(nativeBal));
      // ERC20 tokens we might care about
      const erc20Abi = ['function balanceOf(address) view returns (uint256)'];
      const tokensToCheck = Object.keys(byToken).filter(t => t !== 'xDAI');
      for (const sym of tokensToCheck) {
        const info = getTokenBySymbol(sym);
        if (!info) continue;
        try {
          const c = new ethers.Contract(info.address, erc20Abi, provider);
          const bal = await c.balanceOf(executor);
          balances[sym] = parseFloat(ethers.utils.formatUnits(bal, info.decimals));
        } catch {
          balances[sym] = 0;
        }
      }

      // Detect conflicts
      const conflicts: Array<{ token: string; balance: number; claimed: number; deficit: number; proposals: string[] }> = [];
      for (const [token, { claims, total }] of Object.entries(byToken)) {
        const balance = balances[token] ?? 0;
        if (total > balance) {
          conflicts.push({
            token,
            balance,
            claimed: total,
            deficit: total - balance,
            proposals: claims.map(c => `#${c.proposalId} (${c.amount})`),
          });
        }
      }

      spin.stop();

      const report: any = {
        activeProposals: proposals.length,
        parsed: claims.length,
        unparsed: unparsed.length,
        claims,
        byToken: Object.fromEntries(
          Object.entries(byToken).map(([t, v]) => [t, {
            total: v.total,
            balance: balances[t] ?? 0,
            conflict: (balances[t] ?? 0) < v.total,
            proposals: v.claims.map(c => ({ id: c.proposalId, amount: c.amount, title: c.title })),
          }])
        ),
        conflicts,
        balances,
        unparsedProposals: unparsed,
      };

      if (argv.json) {
        output.json(report);
      } else {
        console.log(`\n  Resource Conflict Scan — ${proposals.length} active proposals`);
        console.log('  ' + '═'.repeat(60));
        console.log(`  Parsed: ${claims.length} | Unparsed: ${unparsed.length}\n`);

        if (Object.keys(byToken).length === 0) {
          console.log('  No resource-claiming proposals detected.\n');
        } else {
          for (const [token, data] of Object.entries(byToken)) {
            const bal = balances[token] ?? 0;
            const flag = data.total > bal ? '⚠ CONFLICT' : '✓ safe';
            console.log(`  ${token}: ${data.total.toFixed(4)} claimed / ${bal.toFixed(4)} available  ${flag}`);
            for (const c of data.claims) {
              console.log(`    #${c.proposalId} (${c.amount} ${token}) — ${c.title.slice(0, 60)}`);
            }
            console.log('');
          }
        }

        if (conflicts.length > 0) {
          console.log('  ⚠ CONFLICTS DETECTED:');
          for (const c of conflicts) {
            console.log(`    ${c.token}: ${c.claimed} claimed, ${c.balance} available, deficit ${c.deficit.toFixed(4)}`);
            console.log(`      Proposals: ${c.proposals.join(', ')}`);
          }
          console.log('');
        }

        if (unparsed.length > 0) {
          console.log('  Unparsed proposals (could not extract token+amount from title):');
          for (const u of unparsed.slice(0, 5)) {
            console.log(`    #${u.proposalId} — ${u.title.slice(0, 60)}`);
          }
          if (unparsed.length > 5) console.log(`    ... and ${unparsed.length - 5} more.`);
          console.log('');
        }
      }
    } catch (err: any) {
      spin.stop();
      output.error(err.message);
      process.exit(1);
    }
  },
};
