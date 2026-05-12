/**
 * pop treasury health — read-only treasury runway + yield projection.
 *
 * Project A (Sprint 21 priority A, Hudson HB#644 follow-up #1) D2 deliverable.
 * Scope: HB#645 brain.shared draft. Closes the "agent doesn't see treasury
 * state at decision-time" gap that lets gas-low warnings repeat for hours.
 *
 * v1 metrics:
 * - Current xDAI balance + WXDAI + sDAI (via existing treasury balance probe)
 * - sDAI yield projection (balance × ~7% APY, configurable)
 * - Runway estimate (xDAI + WXDAI / configured-burn-rate, default 0.05 xDAI/day)
 * - Status flag: HEALTHY / WARN / CRITICAL based on runway thresholds
 *
 * v1 LIMITATIONS:
 * - Burn rate is a CONFIGURED CONSTANT, not measured from history. Honest:
 *   measuring burn rate accurately requires scanning Transfer events on
 *   Executor + PaymentManager + agent wallets, which is a Sprint 22+
 *   deliverable.
 * - sDAI APY is hardcoded at 0.07 (real DSR rate fluctuates ~5-8%).
 *
 * Meta banner per HB#648 pattern: emit toolingVersion + active filters
 * + warnings on non-default config.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { resolveOrgModules } from '../../lib/resolve';
import { resolveNetworkConfig, getNetworkByChainId } from '../../config/networks';
import * as output from '../../lib/output';

interface HealthArgs {
  org?: string;
  chain?: number;
  burnRateXdaiPerDay?: number;
  sdaiApy?: number;
  warnRunwayDays?: number;
  criticalRunwayDays?: number;
  json?: boolean;
}

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

const TOOLING_VERSION = 'HB#659-1 (v1 — configured-burn-rate, hardcoded DSR APY)';

interface HealthMeta {
  toolingVersion: string;
  filters: {
    burnRateXdaiPerDay: number;
    sdaiApy: number;
    warnRunwayDays: number;
    criticalRunwayDays: number;
  };
  warnings: string[];
}

export const healthHandler = {
  builder: (yargs: Argv) =>
    yargs
      .option('burn-rate-xdai-per-day', {
        type: 'number',
        default: 0.05,
        describe:
          'Estimated xDAI/day burn rate (default 0.05 ≈ 0.0021/h). v1 is a CONFIGURED CONSTANT, not measured. Override for org-specific tuning. Sprint 22+ will measure from on-chain history.',
      })
      .option('sdai-apy', {
        type: 'number',
        default: 0.07,
        describe:
          'Annualized sDAI yield rate as decimal (default 0.07 = 7%; real Dai Savings Rate fluctuates 5-8%). Used for yield projection only; sDAI balance is read on-chain.',
      })
      .option('warn-runway-days', {
        type: 'number',
        default: 90,
        describe: 'Runway threshold below which status flag becomes WARN (default 90 days)',
      })
      .option('critical-runway-days', {
        type: 'number',
        default: 30,
        describe: 'Runway threshold below which status flag becomes CRITICAL (default 30 days)',
      })
      .option('json', { type: 'boolean', default: false, describe: 'Machine-readable JSON output' }),

  handler: async (argv: ArgumentsCamelCase<HealthArgs>) => {
    const burnRate = Number(argv.burnRateXdaiPerDay ?? (argv as any)['burn-rate-xdai-per-day']) || 0.05;
    const sdaiApy = Number(argv.sdaiApy ?? (argv as any)['sdai-apy']) || 0.07;
    const warnDays = Number(argv.warnRunwayDays ?? (argv as any)['warn-runway-days']) || 90;
    const critDays = Number(argv.criticalRunwayDays ?? (argv as any)['critical-runway-days']) || 30;
    const wantJson = Boolean(argv.json);

    const meta: HealthMeta = {
      toolingVersion: TOOLING_VERSION,
      filters: {
        burnRateXdaiPerDay: burnRate,
        sdaiApy,
        warnRunwayDays: warnDays,
        criticalRunwayDays: critDays,
      },
      warnings: [],
    };
    if (burnRate !== 0.05) {
      meta.warnings.push(
        `burn-rate-xdai-per-day=${burnRate} differs from default (0.05). v1 is configured-constant, not measured; verify the override matches recent observed spend.`,
      );
    }
    if (sdaiApy !== 0.07) {
      meta.warnings.push(
        `sdai-apy=${sdaiApy} differs from default (0.07). Real DSR rate fluctuates 5-8%; verify the override against current sDAI contract state.`,
      );
    }

    const spin = wantJson ? null : output.spinner('Fetching treasury health...');
    spin?.start();

    try {
      const modules = await resolveOrgModules(argv.org, argv.chain);
      const networkConfig = resolveNetworkConfig(argv.chain);
      const provider = new ethers.providers.JsonRpcProvider(networkConfig.resolvedRpc);
      const network = getNetworkByChainId(networkConfig.chainId);

      const executorAddr = modules.executorAddress;
      const paymentManagerAddr = modules.paymentManagerAddress;
      const bountyTokens = network?.bountyTokens || {};

      // Native balance
      const [execNative, pmNative] = await Promise.all([
        executorAddr ? provider.getBalance(executorAddr) : ethers.BigNumber.from(0),
        paymentManagerAddr ? provider.getBalance(paymentManagerAddr) : ethers.BigNumber.from(0),
      ]);
      const xDaiTotal = parseFloat(ethers.utils.formatEther(execNative.add(pmNative)));

      // ERC20s of interest: WXDAI + sDAI (others are not gas-equivalent)
      const wxdaiAddr = bountyTokens.WXDAI;
      const sdaiAddr = bountyTokens.sDAI;
      let wxdaiTotal = 0;
      let sdaiTotal = 0;
      if (wxdaiAddr) {
        const c = new ethers.Contract(wxdaiAddr, ERC20_ABI, provider);
        const [eb, pb, dec] = await Promise.all([
          executorAddr ? c.balanceOf(executorAddr) : ethers.BigNumber.from(0),
          paymentManagerAddr ? c.balanceOf(paymentManagerAddr) : ethers.BigNumber.from(0),
          c.decimals(),
        ]);
        wxdaiTotal = parseFloat(ethers.utils.formatUnits(eb.add(pb), dec));
      }
      if (sdaiAddr) {
        const c = new ethers.Contract(sdaiAddr, ERC20_ABI, provider);
        const [eb, pb, dec] = await Promise.all([
          executorAddr ? c.balanceOf(executorAddr) : ethers.BigNumber.from(0),
          paymentManagerAddr ? c.balanceOf(paymentManagerAddr) : ethers.BigNumber.from(0),
          c.decimals(),
        ]);
        sdaiTotal = parseFloat(ethers.utils.formatUnits(eb.add(pb), dec));
      }

      // Spendable runway treats xDAI + WXDAI as immediately spendable; sDAI as reserve.
      const liquidGas = xDaiTotal + wxdaiTotal;
      const runwayDays = burnRate > 0 ? liquidGas / burnRate : Infinity;
      const sdaiYieldPerYear = sdaiTotal * sdaiApy;
      const sdaiYieldPerDay = sdaiYieldPerYear / 365;
      // Effective runway: liquid + accrued sDAI yield until depleted
      // (Simple model — assumes yield isn't re-deposited; conservative.)
      const effectiveRunwayDays =
        burnRate > 0 ? (liquidGas + sdaiTotal) / burnRate : Infinity;

      let status: 'HEALTHY' | 'WARN' | 'CRITICAL';
      if (runwayDays < critDays) status = 'CRITICAL';
      else if (runwayDays < warnDays) status = 'WARN';
      else status = 'HEALTHY';

      spin?.succeed(`status=${status} liquid-runway=${runwayDays.toFixed(1)}d`);

      if (wantJson) {
        console.log(
          JSON.stringify(
            {
              meta,
              status,
              balances: {
                xDai: xDaiTotal,
                wxDai: wxdaiTotal,
                sDai: sdaiTotal,
                liquidGas,
              },
              runway: {
                liquidDays: runwayDays,
                effectiveDays: effectiveRunwayDays,
                burnRateXdaiPerDay: burnRate,
              },
              yield: {
                sdaiApy,
                sdaiYieldPerYear,
                sdaiYieldPerDay,
              },
              thresholds: {
                warnDays,
                critDays,
              },
            },
            null,
            2,
          ),
        );
        return;
      }

      // Human-readable
      console.log('');
      console.log(`  Treasury health: ${status}  · ${meta.toolingVersion}`);
      for (const w of meta.warnings) console.log(`  ⚠ ${w}`);
      console.log('');
      console.log(`  Balances:`);
      console.log(`    xDAI:  ${xDaiTotal.toFixed(4)}`);
      console.log(`    WXDAI: ${wxdaiTotal.toFixed(4)}`);
      console.log(`    sDAI:  ${sdaiTotal.toFixed(4)} (yield-bearing reserve)`);
      console.log('');
      console.log(`  Runway:`);
      console.log(`    Liquid (xDAI+WXDAI):     ${liquidGas.toFixed(4)} xDAI`);
      console.log(`    Liquid-only days:        ${runwayDays.toFixed(1)}  (at ${burnRate} xDAI/day)`);
      console.log(`    Effective (incl. sDAI):  ${effectiveRunwayDays.toFixed(1)}`);
      console.log('');
      console.log(`  Yield (sDAI @ ${(sdaiApy * 100).toFixed(1)}% APY):`);
      console.log(`    Per year: ${sdaiYieldPerYear.toFixed(4)} xDAI`);
      console.log(`    Per day:  ${sdaiYieldPerDay.toFixed(4)} xDAI`);
      console.log('');
      if (status === 'CRITICAL') {
        console.log(
          `  🚨 CRITICAL: runway < ${critDays} days. File treasury refuel proposal immediately.`,
        );
      } else if (status === 'WARN') {
        console.log(
          `  ⚠ WARN: runway < ${warnDays} days. Consider sDAI redemption or distribution adjustment.`,
        );
      } else {
        console.log(`  ✓ HEALTHY: runway ≥ ${warnDays} days. No action required.`);
      }
      console.log('');
    } catch (err) {
      spin?.fail((err as Error).message);
      if (wantJson) {
        console.log(JSON.stringify({ meta, error: (err as Error).message }, null, 2));
      }
      throw err;
    }
  },
};
