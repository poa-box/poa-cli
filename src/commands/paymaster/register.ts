/**
 * pop paymaster register — register an org with the PaymasterHub.
 *
 * Gate — VERIFIED against contracts origin/main src/PaymasterHub.sol:
 * registerOrg / registerAndConfigureOrg are registrar-gated (_onlyRegistrar:
 * msg.sender must be the PoaManager CONTRACT or the orgRegistrar, i.e. the
 * OrgDeployer). No EOA can ever call them directly. The two real paths are:
 *
 *   1. Org deploy time — OrgDeployer calls registerAndConfigureOrg when
 *      `pop org deploy` is run with a paymaster config block (the normal path).
 *   2. After the fact — the PoaManager OWNER routes the call through
 *      PoaManager.adminCall(target, data) (verified onlyOwner passthrough
 *      whose doc comment names PaymasterHub explicitly).
 *
 * So this command: if the signer IS the PoaManager owner it sends the
 * adminCall directly; otherwise it prints the exact target + calldata (both
 * raw and adminCall-wrapped) for the registrar owner to execute. adminCall is
 * NOT payable, so --deposit always executes as a separate, permissionless
 * depositForOrg transaction after registration.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import * as fs from 'fs';
import { createReadContract, createWriteContract, loadAbi } from '../../lib/contracts';
import { executeTx } from '../../lib/tx';
import { formatToken } from '../../lib/format';
import { formatAddress } from '../../lib/encoding';
import { getWriteContext, confirmWrite, finishWrite } from '../../lib/command';
import { runPreflight, checkGasBalance } from '../../lib/preflight';
import { resolvePaymasterInfra, readPaymasterOrgConfig } from './helpers';
import { parseDepositAmount } from './deposit';
import { CliError, PreconditionError } from '../../lib/errors';
import { EXIT } from '../../lib/exit-codes';
import * as output from '../../lib/output';

interface RegisterArgs {
  org: string;
  'admin-hat': string;
  'operator-hat'?: string;
  config?: string;
  deposit?: string;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
  'dry-run'?: boolean;
  yes?: boolean;
  preflight?: boolean;
}

/** DeployConfig struct shape — verified against PaymasterHub.sol origin/main. */
const DEPLOY_CONFIG_TUPLE =
  'tuple(uint256 operatorHatId, uint256 maxFeePerGas, uint256 maxPriorityFeePerGas, '
  + 'uint32 maxCallGas, uint32 maxVerificationGas, uint32 maxPreVerificationGas, '
  + 'address[] ruleTargets, bytes4[] ruleSelectors, bool[] ruleAllowed, uint32[] ruleMaxCallGasHints, '
  + 'bytes32[] budgetSubjectKeys, uint128[] budgetCapsPerEpoch, uint32[] budgetEpochLens)';

const REGISTER_IFACE = new ethers.utils.Interface([
  'function registerOrg(bytes32 orgId, uint256 adminHatId, uint256 operatorHatId)',
  `function registerAndConfigureOrg(bytes32 orgId, uint256 adminHatId, ${DEPLOY_CONFIG_TUPLE} config) payable`,
]);

function parseHatId(input: string, flag: string): ethers.BigNumber {
  try {
    return ethers.BigNumber.from(String(input).trim());
  } catch {
    throw new CliError(`Invalid ${flag} "${input}".`, EXIT.USAGE, 'Pass the hat ID as a decimal or 0x-hex integer (see pop org roles).');
  }
}

interface ConfigFile {
  operatorHatId?: string | number;
  maxFeePerGas?: string | number; // gwei (matches the org deploy config convention)
  maxPriorityFeePerGas?: string | number; // gwei
  maxCallGas?: number;
  maxVerificationGas?: number;
  maxPreVerificationGas?: number;
  rules?: Array<{ target: string; selector: string; allowed: boolean; maxCallGasHint?: number }>;
  budgets?: Array<{ subjectKey?: string; hatId?: string | number; capPerEpoch: string | number; epochLen: number }>;
}

/**
 * Build the registerOrg / registerAndConfigureOrg calldata from flags + the
 * optional --config JSON (gwei fee caps + ether budget caps, matching the
 * `pop org deploy` paymaster block conventions).
 */
export function buildRegisterCalldata(
  orgId: string,
  adminHatId: ethers.BigNumber,
  operatorHatId: ethers.BigNumber,
  config?: ConfigFile
): { method: string; data: string } {
  if (!config) {
    return {
      method: 'registerOrg',
      data: REGISTER_IFACE.encodeFunctionData('registerOrg', [orgId, adminHatId, operatorHatId]),
    };
  }

  const rules = config.rules ?? [];
  const budgets = (config.budgets ?? []).map((b) => {
    const subjectKey = b.subjectKey
      ?? (b.hatId !== undefined
        ? ethers.utils.hexZeroPad(ethers.BigNumber.from(String(b.hatId)).toHexString(), 32)
        : undefined);
    if (!subjectKey) {
      throw new CliError('Each budget entry needs "subjectKey" (bytes32) or "hatId".', EXIT.USAGE);
    }
    return {
      subjectKey,
      capPerEpoch: ethers.utils.parseEther(String(b.capPerEpoch)),
      epochLen: b.epochLen,
    };
  });

  const deployConfig = {
    operatorHatId: config.operatorHatId !== undefined
      ? ethers.BigNumber.from(String(config.operatorHatId))
      : operatorHatId,
    maxFeePerGas: config.maxFeePerGas !== undefined ? ethers.utils.parseUnits(String(config.maxFeePerGas), 'gwei') : 0,
    maxPriorityFeePerGas: config.maxPriorityFeePerGas !== undefined
      ? ethers.utils.parseUnits(String(config.maxPriorityFeePerGas), 'gwei')
      : 0,
    maxCallGas: config.maxCallGas ?? 0,
    maxVerificationGas: config.maxVerificationGas ?? 0,
    maxPreVerificationGas: config.maxPreVerificationGas ?? 0,
    ruleTargets: rules.map(r => r.target),
    ruleSelectors: rules.map(r => r.selector),
    ruleAllowed: rules.map(r => Boolean(r.allowed)),
    ruleMaxCallGasHints: rules.map(r => r.maxCallGasHint ?? 0),
    budgetSubjectKeys: budgets.map(b => b.subjectKey),
    budgetCapsPerEpoch: budgets.map(b => b.capPerEpoch),
    budgetEpochLens: budgets.map(b => b.epochLen),
  };

  return {
    method: 'registerAndConfigureOrg',
    data: REGISTER_IFACE.encodeFunctionData('registerAndConfigureOrg', [orgId, adminHatId, deployConfig]),
  };
}

export const registerHandler = {
  builder: (yargs: Argv) => yargs
    .option('admin-hat', { type: 'string', demandOption: true, describe: 'Hat ID that will administer the org\'s paymaster config (usually the org top hat)' })
    .option('operator-hat', { type: 'string', describe: 'Optional hat ID allowed to manage budgets/rules (0 = none)' })
    .option('config', { type: 'string', describe: 'JSON file with initial fee caps (gwei), rules, and budgets (ether caps) — uses registerAndConfigureOrg' })
    .option('deposit', { type: 'string', describe: 'Also deposit this amount (ether units) after registration via permissionless depositForOrg' })
    .example('pop paymaster register --admin-hat 26959946667150639794667015087019630673637144422540572481103610249216', 'Register the org (sends directly when your key owns the PoaManager; otherwise prints the exact registrar call)')
    .example('pop paymaster register --admin-hat 0x1a2b... --deposit 0.1', 'Register and then fund the sponsorship balance')
    .epilogue(
      'Registration is registrar-gated on-chain: only the PoaManager or the OrgDeployer may call it. '
      + 'New orgs are registered automatically when deployed with a paymaster block (pop org deploy). '
      + 'For existing orgs, the PoaManager owner executes the printed adminCall.'
    ),

  handler: async (argv: ArgumentsCamelCase<RegisterArgs>) => {
    const spin = output.spinner('Checking paymaster registration...');
    spin.start();

    try {
      const adminHatId = parseHatId(argv.adminHat as string, '--admin-hat');
      const operatorHatId = argv.operatorHat !== undefined
        ? parseHatId(argv.operatorHat as string, '--operator-hat')
        : ethers.BigNumber.from(0);
      if (adminHatId.isZero()) {
        throw new CliError('--admin-hat cannot be 0 (the contract treats adminHatId==0 as unregistered).', EXIT.USAGE);
      }

      let configFile: ConfigFile | undefined;
      if (argv.config) {
        if (!fs.existsSync(argv.config)) {
          throw new CliError(`Config file not found: ${argv.config}`, EXIT.USAGE);
        }
        configFile = JSON.parse(fs.readFileSync(argv.config, 'utf8'));
      }
      const depositWei = argv.deposit !== undefined ? parseDepositAmount(argv.deposit) : undefined;

      const ctx = await getWriteContext(argv);
      const { paymasterHubAddress, poaManagerAddress } = await resolvePaymasterInfra(argv.chain);

      // Already registered? (authoritative on-chain read)
      const orgConfig = await readPaymasterOrgConfig(ctx.provider, paymasterHubAddress, ctx.orgId);
      if (orgConfig.registered) {
        spin.stop();
        const fields = {
          org: argv.org,
          orgId: ctx.orgId,
          adminHatId: orgConfig.adminHatId.toString(),
          operatorHatId: orgConfig.operatorHatId.isZero() ? 'none' : orgConfig.operatorHatId.toString(),
        };
        if (output.isJsonMode()) {
          output.json({ registered: true, alreadyRegistered: true, ...fields, paymasterHub: paymasterHubAddress });
        } else {
          output.success('Org is already registered with the PaymasterHub', { ...fields, registered: 'yes' });
          if (depositWei) {
            output.info(`To fund it, run: pop paymaster deposit --amount ${argv.deposit} --org ${argv.org}`);
          }
        }
        return;
      }

      const { method, data } = buildRegisterCalldata(ctx.orgId, adminHatId, operatorHatId, configFile);
      const adminCallData = new ethers.utils.Interface(loadAbi('PoaManager'))
        .encodeFunctionData('adminCall', [paymasterHubAddress, data]);

      // Is the signer the PoaManager owner? (the only key that can route
      // the registrar-gated call, via PoaManager.adminCall)
      let poaOwner: string | null = null;
      if (poaManagerAddress) {
        try {
          poaOwner = await createReadContract(poaManagerAddress, 'PoaManager', ctx.provider).owner();
        } catch {
          poaOwner = null; // owner() unreadable — fall through to guidance
        }
      }
      const signerIsOwner = !!poaOwner && poaOwner.toLowerCase() === ctx.address.toLowerCase();

      if (!signerIsOwner || !poaManagerAddress) {
        // Guidance path: registration is registrar-gated — emit the exact
        // calls instead of sending a transaction that must revert.
        spin.stop();
        const payload = {
          registered: false,
          reason: 'registerOrg is registrar-gated: only the PoaManager or OrgDeployer contract may call it',
          signer: ctx.address,
          poaManager: poaManagerAddress,
          poaManagerOwner: poaOwner,
          paymasterHub: paymasterHubAddress,
          method,
          registerCalldata: data,
          adminCallTarget: poaManagerAddress,
          adminCallCalldata: adminCallData,
          nextSteps: [
            'New orgs: deploy with a paymaster block — pop org deploy (OrgDeployer registers automatically)',
            `Existing orgs: the PoaManager owner (${poaOwner ?? 'unknown'}) sends adminCall with the calldata above`,
            depositWei ? `After registration, anyone can fund it: pop paymaster deposit --amount ${argv.deposit} --org ${argv.org}` : undefined,
          ].filter(Boolean),
        };
        if (output.isJsonMode()) {
          output.json(payload);
          return;
        }
        output.warn('This org is not registered with the PaymasterHub, and registration is registrar-gated on-chain.');
        output.keyValueBlock('Exact call for the registrar owner', {
          'PaymasterHub (target)': paymasterHubAddress,
          [`${method} calldata`]: data,
          'PoaManager (adminCall route)': poaManagerAddress ?? 'unknown',
          'PoaManager owner': poaOwner ?? 'unknown',
          'adminCall calldata': adminCallData,
        });
        output.info('New orgs register automatically when deployed with a paymaster config block (pop org deploy).');
        if (depositWei) {
          output.info(`Once registered, fund it with: pop paymaster deposit --amount ${argv.deposit} --org ${argv.org}`);
        }
        return;
      }

      // Owner path: route the registrar-gated call through PoaManager.adminCall.
      await runPreflight(ctx.provider, [
        checkGasBalance(ctx.address, depositWei ? depositWei.add(ethers.utils.parseEther('0.0001')) : undefined),
      ], { skip: !argv.preflight });
      spin.stop();

      await confirmWrite(argv, {
        org: argv.org,
        adminHat: adminHatId.toString(),
        operatorHat: operatorHatId.isZero() ? 'none' : operatorHatId.toString(),
        config: configFile ? `${argv.config} (registerAndConfigureOrg)` : undefined,
        via: `PoaManager.adminCall @ ${formatAddress(poaManagerAddress)}`,
        deposit: depositWei ? `${formatToken(depositWei)} (separate depositForOrg tx)` : undefined,
        chain: ctx.networkName,
      }, { actionLabel: 'About to register the org with the PaymasterHub' });

      const txSpin = output.spinner('Registering org via PoaManager.adminCall...');
      txSpin.start();
      const poaManager = createWriteContract(poaManagerAddress, 'PoaManager', ctx.signer);
      const result = await executeTx(poaManager, 'adminCall', [paymasterHubAddress, data], { dryRun: argv.dryRun });

      // Optional follow-up deposit (adminCall is not payable — verified — so
      // the deposit is always its own permissionless depositForOrg tx).
      let depositResult: { txHash?: string } | undefined;
      if (depositWei && result.success && !result.dryRun) {
        txSpin.text = 'Depositing initial sponsorship funds...';
        const hub = createWriteContract(paymasterHubAddress, 'PaymasterHub', ctx.signer);
        const dep = await executeTx(hub, 'depositForOrg', [ctx.orgId], { value: depositWei });
        if (dep.success) {
          depositResult = { txHash: dep.txHash };
        } else {
          txSpin.stop();
          output.warn(`Registration succeeded but the deposit failed: ${dep.error ?? 'unknown error'}. Retry with: pop paymaster deposit --amount ${argv.deposit} --org ${argv.org}`);
        }
      }
      txSpin.stop();

      finishWrite(result, {
        successMsg: `Org registered with the PaymasterHub (${method})`,
        fields: {
          org: argv.org,
          orgId: ctx.orgId,
          adminHatId: adminHatId.toString(),
          operatorHatId: operatorHatId.isZero() ? undefined : operatorHatId.toString(),
          paymasterHub: paymasterHubAddress,
          depositTxHash: depositResult?.txHash,
          deposit: depositWei && depositResult ? formatToken(depositWei) : undefined,
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
