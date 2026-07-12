/**
 * pop paymaster status — org gas-sponsorship state from the PaymasterHub.
 *
 * Getters — VERIFIED against contracts origin/main src/PaymasterHub.sol:
 *   getOrgConfig(orgId)     → (adminHatId, operatorHatId, paused, registeredAt, bannedFromSolidarity)
 *   getOrgFinancials(orgId) → (deposited, spent, solidarityUsedThisPeriod, periodStart) — 90-day periods
 *   getFeeCaps(orgId), getBudget(orgId, subjectKey), getSolidarityFund()
 *
 * Registration is derived exactly like the contract does it: adminHatId != 0.
 * Budget subject keys are bytes32; for hat-scoped budgets the key is the hat
 * ID zero-padded to 32 bytes (the convention used by agent setup-sponsorship).
 * The admin/operator hats are probed automatically; pass --hat to inspect
 * more subjects.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { resolveOrgId } from '../../lib/resolve';
import { createReadContract } from '../../lib/contracts';
import { resolveNetworkConfig } from '../../config/networks';
import { formatToken, formatRelativeTime } from '../../lib/format';
import { resolvePaymasterInfra, hatSubjectKey } from './helpers';
import { CliError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';

interface StatusArgs {
  org?: string;
  chain?: number;
  hat?: Array<string | number>;
}

const NINETY_DAYS = 90 * 86400;

interface BudgetRow {
  subject: string;
  subjectKey: string;
  capPerEpoch: string;
  usedInEpoch: string;
  epochLen: number;
  epochStart: number;
}

export const statusHandler = {
  builder: (yargs: Argv) => yargs
    .option('hat', {
      type: 'string',
      array: true,
      describe: 'Additional hat ID(s) whose sponsorship budgets to show (admin/operator hats are probed automatically)',
    })
    .example('pop paymaster status', 'Sponsorship balance, budgets, and solidarity state for the default org')
    .example('pop paymaster status --hat 123 --json', 'Include hat 123\'s budget in the machine-readable dump'),

  handler: async (argv: ArgumentsCamelCase<StatusArgs>) => {
    const spin = output.spinner('Fetching paymaster status...');
    spin.start();

    try {
      const orgId = await resolveOrgId(argv.org, argv.chain);
      const networkConfig = resolveNetworkConfig(argv.chain);
      const provider = new ethers.providers.JsonRpcProvider(networkConfig.resolvedRpc);

      const { paymasterHubAddress: paymasterAddr } = await resolvePaymasterInfra(argv.chain);

      const paymaster = createReadContract(paymasterAddr, 'PaymasterHub', provider);

      // Query on-chain state
      const [entryPoint, feeCaps, orgConfig, financials, solidarity] = await Promise.all([
        paymaster.ENTRY_POINT(),
        paymaster.getFeeCaps(orgId),
        paymaster.getOrgConfig(orgId),
        paymaster.getOrgFinancials(orgId),
        paymaster.getSolidarityFund(),
      ]);

      // Check EntryPoint deposit
      const ep = new ethers.Contract(
        entryPoint,
        ['function balanceOf(address) view returns (uint256)'],
        provider
      );
      const deposit = await ep.balanceOf(paymasterAddr);

      const adminHatId = ethers.BigNumber.from(orgConfig.adminHatId);
      const operatorHatId = ethers.BigNumber.from(orgConfig.operatorHatId);
      const registered = !adminHatId.isZero();
      // Named field (was positional [4] against a stale struct order — the
      // synced ABI puts `paused` at index 2 and bannedFromSolidarity at 4).
      const isPaused = Boolean(orgConfig.paused);

      const deposited = ethers.BigNumber.from(financials.deposited);
      const spent = ethers.BigNumber.from(financials.spent);
      const available = deposited.gt(spent) ? deposited.sub(spent) : ethers.BigNumber.from(0);
      const periodStart = Number(financials.periodStart);

      // Budgets per subject: admin + operator hats automatically, --hat extras.
      const subjects: Array<{ label: string; key: string }> = [];
      if (registered) subjects.push({ label: `admin hat ${adminHatId.toString()}`, key: hatSubjectKey(adminHatId) });
      if (!operatorHatId.isZero()) subjects.push({ label: `operator hat ${operatorHatId.toString()}`, key: hatSubjectKey(operatorHatId) });
      for (const h of argv.hat ?? []) {
        try {
          const id = ethers.BigNumber.from(String(h).trim());
          subjects.push({ label: `hat ${id.toString()}`, key: hatSubjectKey(id) });
        } catch {
          throw new CliError(`Invalid --hat "${h}".`, EXIT.USAGE, 'Pass hat IDs as decimal or 0x-hex integers.');
        }
      }
      const seen = new Set<string>();
      const uniqueSubjects = subjects.filter(s => !seen.has(s.key) && seen.add(s.key));

      const budgets: BudgetRow[] = [];
      const budgetResults = await Promise.all(uniqueSubjects.map(s => paymaster.getBudget(orgId, s.key)));
      budgetResults.forEach((b, i) => {
        const cap = ethers.BigNumber.from(b.capPerEpoch);
        if (cap.isZero() && ethers.BigNumber.from(b.usedInEpoch).isZero()) return; // unset subject — skip
        budgets.push({
          subject: uniqueSubjects[i].label,
          subjectKey: uniqueSubjects[i].key,
          capPerEpoch: ethers.utils.formatEther(cap),
          usedInEpoch: ethers.utils.formatEther(b.usedInEpoch),
          epochLen: Number(b.epochLen),
          epochStart: Number(b.epochStart),
        });
      });

      spin.stop();

      if (output.isJsonMode()) {
        output.json({
          // Existing fields — unchanged names/formats (additive-only contract)
          paymasterHub: paymasterAddr,
          entryPoint,
          deposit: ethers.utils.formatEther(deposit),
          maxFeePerGas: ethers.utils.formatUnits(feeCaps.maxFeePerGas, 'gwei'),
          maxPriorityFeePerGas: ethers.utils.formatUnits(feeCaps.maxPriorityFeePerGas, 'gwei'),
          paused: isPaused,
          // Additive: registration + financials + solidarity + budgets
          registered,
          adminHatId: registered ? adminHatId.toString() : null,
          operatorHatId: operatorHatId.isZero() ? null : operatorHatId.toString(),
          registeredAt: Number(orgConfig.registeredAt ?? 0) || null,
          bannedFromSolidarity: Boolean(orgConfig.bannedFromSolidarity),
          financials: {
            deposited: ethers.utils.formatEther(deposited),
            spent: ethers.utils.formatEther(spent),
            available: ethers.utils.formatEther(available),
            solidarityUsedThisPeriod: ethers.utils.formatEther(financials.solidarityUsedThisPeriod),
            periodStart: periodStart || null,
            periodEnd: periodStart ? periodStart + NINETY_DAYS : null,
          },
          solidarityFund: {
            balance: ethers.utils.formatEther(solidarity.balance),
            numActiveOrgs: Number(solidarity.numActiveOrgs),
            feePercentageBps: Number(solidarity.feePercentageBps),
            distributionPaused: Boolean(solidarity.distributionPaused),
          },
          budgets,
        });
      } else {
        console.log('');
        console.log('  Paymaster Status');
        console.log('  ' + '─'.repeat(40));
        console.log(`  Hub:          ${paymasterAddr}`);
        console.log(`  EntryPoint:   ${entryPoint}`);
        console.log(`  Deposit:      ${ethers.utils.formatEther(deposit)} xDAI (hub-wide EntryPoint stake)`);
        console.log(`  Max Fee:      ${ethers.utils.formatUnits(feeCaps.maxFeePerGas, 'gwei')} gwei`);
        console.log(`  Max Priority: ${ethers.utils.formatUnits(feeCaps.maxPriorityFeePerGas, 'gwei')} gwei`);
        console.log(`  Paused:       ${isPaused ? 'YES' : 'no'}`);

        console.log('');
        if (!registered) {
          console.log('  Org registration: NOT REGISTERED');
          console.log('  Register with: pop paymaster register --admin-hat <hatId>');
        } else {
          console.log('  Org registration');
          console.log(`    Admin hat:     ${adminHatId.toString()}`);
          console.log(`    Operator hat:  ${operatorHatId.isZero() ? 'none' : operatorHatId.toString()}`);
          if (Number(orgConfig.registeredAt)) {
            console.log(`    Registered:    ${formatRelativeTime(Number(orgConfig.registeredAt))}`);
          }
          if (orgConfig.bannedFromSolidarity) {
            console.log('    Solidarity:    BANNED from the solidarity fund');
          }
          console.log('');
          console.log('  Org financials (90-day solidarity periods)');
          console.log(`    Deposited:     ${formatToken(deposited)} (lifetime)`);
          console.log(`    Spent:         ${formatToken(spent)}`);
          console.log(`    Available:     ${formatToken(available)}`);
          console.log(`    Solidarity used this period: ${formatToken(financials.solidarityUsedThisPeriod)}`);
          if (periodStart) {
            console.log(`    Period:        started ${formatRelativeTime(periodStart)}, resets ${formatRelativeTime(periodStart + NINETY_DAYS)}`);
          }
        }

        console.log('');
        console.log('  Solidarity fund (protocol-wide)');
        console.log(`    Balance:       ${formatToken(solidarity.balance)}`);
        console.log(`    Fee:           ${Number(solidarity.feePercentageBps) / 100}%`);
        console.log(`    Distribution:  ${solidarity.distributionPaused ? 'paused (collection-only)' : 'active'}`);

        if (budgets.length > 0) {
          console.log('');
          console.log('  Budgets per subject:');
          output.table(
            ['Subject', 'Cap/epoch', 'Used', 'Epoch'],
            budgets.map(b => [b.subject, b.capPerEpoch, b.usedInEpoch, `${b.epochLen}s`])
          );
        } else if (registered) {
          console.log('');
          console.log('  Budgets: none set for the probed subjects (admin/operator hats' + ((argv.hat?.length ?? 0) > 0 ? ' + --hat' : '') + ')');
        }

        console.log('');
        console.log('  Note: Gas sponsorship requires ERC-4337 UserOperations.');
        console.log('  CLI uses direct EOA transactions (not sponsored).');
        console.log('  Frontend passkey accounts use the bundler + paymaster flow.');
        console.log('');
      }
    } catch (err: any) {
      spin.stop();
      if (err instanceof CliError) {
        output.error(err.message, { suggestion: err.suggestion });
        process.exit(err.code);
      }
      output.error(err.message);
      process.exit(1);
    }
  },
};
