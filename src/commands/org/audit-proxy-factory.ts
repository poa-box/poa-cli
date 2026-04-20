/**
 * pop org audit-proxy-factory — detect E-proxy identity-obfuscating patterns.
 *
 * Task #473 (sentinel HB#811 claim). Sprint 20 rank-3 per Proposal #65.
 *
 * E-proxy identity-obfuscating is the v2.0-canonical sub-pattern where
 * end-user voter identities are hidden behind intermediary proxy contracts.
 * Classic example: Maker DSChief factory — each user deploys their own
 * DSProxy, voting through it masks the end-user EOA from the governance
 * contract's perspective (voter.address is the proxy, not the owner).
 *
 * Detection approach (MVP scaffold):
 *   1. Given a governance contract address + chain, identify top-N recent
 *      voter addresses (via Snapshot or on-chain event scan).
 *   2. For each voter, check `eth_getCode(voter) != 0x` (= voter is contract,
 *      not EOA). Contract-voters are proxy-CANDIDATES.
 *   3. Count proxy-share = proxy-voters / total top-N voters.
 *   4. Classify DAO as E-proxy identity-obfuscating if proxy-share > 50%.
 *
 * Future extensions (v2+):
 *   - Resolve proxy → end-user via ownership reads (DSProxy `owner()`,
 *     OpenZeppelin Ownable, CREATE2 salt inversion)
 *   - Detect specific factory patterns (Clone factory, CREATE2, DSProxy)
 *   - Cross-reference against known factories (dsproxy-registry, Safe factory)
 *
 * Scope of initial ship (HB#811 scaffold):
 *   - Command registered + --help surfaces flags
 *   - Pure helper functions exported for tests
 *   - Integration with Snapshot-voter-list OR explicit --voters flag
 *   - Contract-vs-EOA classifier via eth_getCode
 *   - JSON output shape settled
 *   - Unit tests for pure helpers
 *   - Real Snapshot integration + factory-pattern detection lands in HB#812+.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { resolveNetworkConfig } from '../../config/networks';
import * as output from '../../lib/output';

export type VoterClass = 'eoa' | 'proxy-candidate' | 'unknown';

interface AuditProxyFactoryArgs {
  address?: string;
  space?: string;
  voters?: string;
  chain?: number;
  rpc?: string;
  json?: boolean;
}

export interface ProxyFactoryAuditResult {
  target: string;
  chainId: number;
  status: 'scaffold' | 'partial' | 'complete';
  note?: string;
  voters?: Array<{ address: string; class: VoterClass; codeSize?: number }>;
  classSummary?: Record<VoterClass, number>;
  proxyShare?: number;
  classification?: 'E-proxy-identity-obfuscating' | 'not-E-proxy' | 'inconclusive';
}

/**
 * Classify a single voter as EOA vs proxy-candidate via code-presence check.
 * Exported for unit testing.
 *
 * @param code raw bytecode returned by eth_getCode (e.g. "0x" for EOA)
 * @returns classification
 */
export function classifyVoterByCode(code: string): VoterClass {
  if (!code || code === '0x' || code === '0x0') return 'eoa';
  // Minimal proxy bytecode (EIP-1167) is ~45 bytes; any code > 2 chars ("0x") is contract.
  if (code.length > 2) return 'proxy-candidate';
  return 'unknown';
}

/**
 * Aggregate per-voter classifications into a proxy-share percentage.
 * proxy-share = proxy-candidate count / total classified voters.
 * Exported for unit testing.
 */
export function computeProxyShare(classes: VoterClass[]): {
  summary: Record<VoterClass, number>;
  proxyShare: number;
} {
  const summary: Record<VoterClass, number> = { eoa: 0, 'proxy-candidate': 0, unknown: 0 };
  for (const c of classes) summary[c]++;
  const total = summary.eoa + summary['proxy-candidate'];
  const proxyShare = total > 0 ? summary['proxy-candidate'] / total : 0;
  return { summary, proxyShare: parseFloat(proxyShare.toFixed(3)) };
}

/**
 * Classify DAO E-proxy status from proxy-share + voter count.
 * - proxy-share > 0.5 AND voters ≥ 5: E-proxy-identity-obfuscating
 * - proxy-share <= 0.5 AND voters ≥ 5: not-E-proxy
 * - voters < 5: inconclusive (small-sample caveat)
 */
export function classifyDao(
  proxyShare: number,
  totalVoters: number
): 'E-proxy-identity-obfuscating' | 'not-E-proxy' | 'inconclusive' {
  if (totalVoters < 5) return 'inconclusive';
  return proxyShare > 0.5 ? 'E-proxy-identity-obfuscating' : 'not-E-proxy';
}

export const auditProxyFactoryHandler = {
  builder: (yargs: Argv) =>
    yargs
      .option('address', {
        type: 'string',
        describe: 'Governance contract address (e.g. Maker Chief). Exclusive with --space.',
      })
      .option('space', {
        type: 'string',
        describe: 'Snapshot space ID (voter list sourced from Snapshot). Exclusive with --address.',
      })
      .option('voters', {
        type: 'string',
        describe: 'Comma-separated voter addresses to classify (overrides --address/--space voter discovery)',
      })
      .option('chain', {
        type: 'number',
        default: 1,
        describe: 'Chain ID for on-chain code reads (default: 1 = mainnet)',
      })
      .option('rpc', {
        type: 'string',
        describe: 'RPC URL override',
      })
      .check((argv) => {
        if (!argv.address && !argv.space && !argv.voters) {
          throw new Error('Must provide --address, --space, or --voters');
        }
        return true;
      }),

  handler: async (argv: ArgumentsCamelCase<AuditProxyFactoryArgs>) => {
    const spin = output.spinner(`Auditing E-proxy factory patterns...`);
    spin.start();

    try {
      const chainId = (argv.chain as number) || 1;
      const target = argv.address || argv.space || argv.voters || 'unknown';
      const network = resolveNetworkConfig(chainId, argv.rpc);
      const provider = new ethers.providers.JsonRpcProvider(network.rpc);

      // MVP scaffold: if explicit voters provided, classify those directly.
      // Snapshot/on-chain voter discovery deferred to HB#812+ follow-up.
      let voterAddresses: string[] = [];
      if (argv.voters) {
        voterAddresses = argv.voters.split(',').map((a) => a.trim()).filter(Boolean);
      } else {
        spin.stop();
        const result: ProxyFactoryAuditResult = {
          target,
          chainId,
          status: 'scaffold',
          note: 'Voter discovery from --address/--space not yet implemented. Provide --voters with comma-separated addresses to classify directly. HB#812+ adds Snapshot integration.',
        };
        if (argv.json) {
          output.json(result);
        } else {
          output.info('audit-proxy-factory (scaffold)', { ...result });
        }
        return;
      }

      // Classify each voter via eth_getCode
      spin.text = `Classifying ${voterAddresses.length} voters...`;
      const classified = await Promise.all(
        voterAddresses.map(async (addr) => {
          try {
            const code = await provider.getCode(addr);
            const cls = classifyVoterByCode(code);
            return {
              address: addr,
              class: cls,
              codeSize: code ? (code.length - 2) / 2 : 0,
            };
          } catch {
            return { address: addr, class: 'unknown' as VoterClass, codeSize: 0 };
          }
        })
      );

      const { summary, proxyShare } = computeProxyShare(classified.map((v) => v.class));
      const classification = classifyDao(proxyShare, voterAddresses.length);

      const result: ProxyFactoryAuditResult = {
        target,
        chainId,
        status: 'partial',
        voters: classified,
        classSummary: summary,
        proxyShare,
        classification,
      };

      spin.stop();

      if (argv.json) {
        output.json(result);
      } else {
        output.success(`audit-proxy-factory: ${target}`, {
          voters: voterAddresses.length,
          eoa: summary.eoa,
          proxyCandidates: summary['proxy-candidate'],
          proxyShare: `${(proxyShare * 100).toFixed(1)}%`,
          classification,
        });
      }
    } catch (err: any) {
      spin.stop();
      output.error(err.message);
      process.exit(1);
    }
  },
};
