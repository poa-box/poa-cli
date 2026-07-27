/**
 * pop paymaster deposit — fund an org's gas sponsorship balance.
 *
 * Calls PaymasterHub.depositForOrg(bytes32 orgId) payable — VERIFIED against
 * contracts origin/main src/PaymasterHub.sol: the function is PERMISSIONLESS
 * ("Anyone can deposit to any org to support them"); it reverts ZeroAmount on
 * msg.value == 0 and OrgNotRegistered when the org has no paymaster config
 * (adminHatId == 0). Both are pre-checked here so predictable failures
 * surface before gas is spent.
 *
 * There is NO withdraw path: withdrawFromOrg does not exist on the deployed
 * PaymasterHub (verified against origin/main). Deposits draw down only as
 * sponsored UserOperations consume them.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { createWriteContract } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { formatToken } from '../../lib/format';
import { getWriteContext, confirmWrite, finishWrite } from '../../lib/command';
import { runPreflight, checkGasBalance } from '../../lib/preflight';
import { resolvePaymasterInfra, readPaymasterOrgConfig } from './helpers';
import { CliError, PreconditionError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';

interface DepositArgs {
  org: string;
  amount: string;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
}

/** Parse --amount as ether units (the chain's native gas token). */
export function parseDepositAmount(input: string | number): ethers.BigNumber {
  let wei: ethers.BigNumber;
  try {
    wei = ethers.utils.parseEther(String(input).trim());
  } catch {
    throw new CliError(
      `Invalid --amount "${input}".`,
      EXIT.USAGE,
      'Pass the amount in ether units of the native gas token, e.g. --amount 0.05'
    );
  }
  if (wei.lte(0)) {
    throw new CliError(
      'Deposit amount must be greater than zero (the contract reverts ZeroAmount).',
      EXIT.USAGE
    );
  }
  return wei;
}

export const depositHandler = {
  builder: (yargs: Argv) => yargs
    .option('amount', {
      type: 'string',
      demandOption: true,
      describe: 'Amount to deposit, in ether units of the native gas token (e.g. 0.05 = 0.05 xDAI on Gnosis)',
    })
    .example('pop paymaster deposit --amount 0.05', 'Top up the default org\'s sponsorship balance by 0.05 xDAI')
    .example('pop paymaster deposit --amount 0.1 --org someorg', 'Fund another org — depositForOrg is permissionless')
    .epilogue(
      'Deposits are one-way: the PaymasterHub has no withdraw function. Funds draw down '
      + 'as sponsored UserOperations consume them. Check the balance with: pop paymaster status'
    ),

  handler: async (argv: ArgumentsCamelCase<DepositArgs>) => {
    const spin = output.spinner('Preparing paymaster deposit...');
    spin.start();

    try {
      const amountWei = parseDepositAmount(argv.amount);

      const ctx = await getWriteContext(argv);
      const { paymasterHubAddress } = await resolvePaymasterInfra(argv.chain);

      // ── Pre-flight (skippable with --no-preflight) ────────────────────
      // depositForOrg reverts OrgNotRegistered for unregistered orgs — read
      // the hub's OrgConfig first so this fails fast with a next step.
      if (argv.preflight !== false) {
        const orgConfig = await readPaymasterOrgConfig(ctx.provider, paymasterHubAddress, ctx.orgId);
        if (!orgConfig.registered) {
          throw new PreconditionError(
            `Org ${argv.org} is not registered with the PaymasterHub — depositForOrg would revert OrgNotRegistered.`,
            'Register it first: pop paymaster register --admin-hat <hatId>'
          );
        }
      }
      // The wallet must cover the deposit VALUE plus gas headroom.
      await runPreflight(ctx.provider, [
        checkGasBalance(ctx.address, amountWei.add(ethers.utils.parseEther('0.0001'))),
      ], { skip: !argv.preflight });

      spin.stop();

      await confirmWrite(argv, {
        deposit: formatToken(amountWei, 18, '(native gas token)'),
        org: argv.org,
        paymasterHub: paymasterHubAddress,
        chain: ctx.networkName,
        note: 'one-way: no withdraw — funds draw down via gas sponsorship',
      }, { actionLabel: 'About to deposit to the org\'s gas sponsorship balance' });

      const txSpin = output.spinner('Depositing to PaymasterHub...');
      txSpin.start();
      const hub = createWriteContract(paymasterHubAddress, 'PaymasterHub', ctx.signer);
      const result = await executeTx(hub, 'depositForOrg', [ctx.orgId], {
        dryRun: argv.dryRun,
        value: amountWei,
      });
      txSpin.stop();

      finishWrite(result, {
        successMsg: `Deposited ${formatToken(amountWei)} to the org's sponsorship balance`,
        fields: {
          org: argv.org,
          orgId: ctx.orgId,
          amount: formatToken(amountWei),
          amountWei: amountWei.toString(),
          paymasterHub: paymasterHubAddress,
        },
      });
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
