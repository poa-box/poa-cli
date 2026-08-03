/**
 * Paymaster transaction builders — ports of `pop paymaster *` write paths
 * (src/commands/paymaster/).
 *
 *   buildDepositForOrg / depositForOrgIntent — pop paymaster deposit
 *     (PaymasterHub.depositForOrg(bytes32) payable — permissionless)
 *   buildRegisterCalldata / buildAdminCallRegister / registerOrgIntent —
 *     pop paymaster register (PoaManager.adminCall wrapping the
 *     registrar-gated registerOrg / registerAndConfigureOrg)
 *
 * Registration gate — VERIFIED against contracts origin/main
 * src/PaymasterHub.sol: registerOrg / registerAndConfigureOrg are
 * registrar-gated (_onlyRegistrar: msg.sender must be the PoaManager CONTRACT
 * or the orgRegistrar, i.e. the OrgDeployer). No EOA can ever call them
 * directly — the after-the-fact path is the PoaManager OWNER routing the call
 * through PoaManager.adminCall(target, data). adminCall is NOT payable, so an
 * initial deposit is always its own, separate depositForOrg transaction.
 */

import { ethers } from 'ethers';
import type { TxIntent } from './intent';
import { getAbi } from '../contracts';
import type { PopContext } from '../context';
import { resolveOrgId } from '../reads/resolve';
import {
  resolvePaymasterInfra,
  readPaymasterOrgConfig,
  readPaymasterOrgConfigPreferSubgraph,
  fetchPaymasterSubgraphState,
  subgraphMatchesHub,
} from '../reads/paymaster';
import { CliError, PreconditionError } from '../errors';
import { EXIT } from '../exit-codes';

// ---------------------------------------------------------------------------
// Encoding — identical fragments/conversions to src/commands/paymaster/register.ts
// ---------------------------------------------------------------------------

/** DeployConfig struct shape — verified against PaymasterHub.sol origin/main. */
export const DEPLOY_CONFIG_TUPLE =
  'tuple(uint256 operatorHatId, uint256 maxFeePerGas, uint256 maxPriorityFeePerGas, '
  + 'uint32 maxCallGas, uint32 maxVerificationGas, uint32 maxPreVerificationGas, '
  + 'address[] ruleTargets, bytes4[] ruleSelectors, bool[] ruleAllowed, uint32[] ruleMaxCallGasHints, '
  + 'bytes32[] budgetSubjectKeys, uint128[] budgetCapsPerEpoch, uint32[] budgetEpochLens)';

const REGISTER_IFACE = new ethers.utils.Interface([
  'function registerOrg(bytes32 orgId, uint256 adminHatId, uint256 operatorHatId)',
  `function registerAndConfigureOrg(bytes32 orgId, uint256 adminHatId, ${DEPLOY_CONFIG_TUPLE} config) payable`,
]);

/**
 * Optional --config JSON for registerAndConfigureOrg. Fee caps are GWEI and
 * budget caps are ETHER units, matching the `pop org deploy` paymaster block
 * conventions.
 */
export interface PaymasterRegisterConfig {
  operatorHatId?: string | number;
  maxFeePerGas?: string | number; // gwei (matches the org deploy config convention)
  maxPriorityFeePerGas?: string | number; // gwei
  maxCallGas?: number;
  maxVerificationGas?: number;
  maxPreVerificationGas?: number;
  rules?: Array<{ target: string; selector: string; allowed: boolean; maxCallGasHint?: number }>;
  budgets?: Array<{ subjectKey?: string; hatId?: string | number; capPerEpoch: string | number; epochLen: number }>;
}

/** Parse a hat ID flag — BigNumber, never parseInt (Hats IDs exceed 2^53). */
export function parsePaymasterHatId(input: string | number, flag: string): ethers.BigNumber {
  try {
    return ethers.BigNumber.from(String(input).trim());
  } catch {
    throw new CliError(`Invalid ${flag} "${input}".`, EXIT.USAGE, 'Pass the hat ID as a decimal or 0x-hex integer (see pop org roles).');
  }
}

/** Parse an amount in ether units of the native gas token — port of parseDepositAmount in src/commands/paymaster/deposit.ts. */
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

/**
 * Build the registerOrg / registerAndConfigureOrg calldata from the hat IDs +
 * the optional config (gwei fee caps + ether budget caps). Pure port of
 * buildRegisterCalldata in src/commands/paymaster/register.ts — byte-for-byte
 * identical encoding.
 */
export function buildRegisterCalldata(
  orgId: string,
  adminHatId: ethers.BigNumber,
  operatorHatId: ethers.BigNumber,
  config?: PaymasterRegisterConfig
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

// ---------------------------------------------------------------------------
// Level 1 — pure builders
// ---------------------------------------------------------------------------

export interface DepositForOrgArgs {
  paymasterHubAddress: string;
  /** bytes32 org id. */
  orgId: string;
  /** Native value in wei (the function is payable; reverts ZeroAmount on 0). */
  amountWei: ethers.BigNumberish;
}

/**
 * Port of `pop paymaster deposit` — src/commands/paymaster/deposit.ts:
 * PaymasterHub.depositForOrg(bytes32 orgId) payable. PERMISSIONLESS ("anyone
 * can deposit to any org"); reverts ZeroAmount on msg.value == 0 and
 * OrgNotRegistered when the org has no paymaster config (adminHatId == 0).
 * ONE-WAY on the deployed hub: no withdraw exists (PR #185 / audit M-04 not
 * shipped) — funds draw down only as sponsored UserOperations consume them.
 */
export function buildDepositForOrg(a: DepositForOrgArgs): TxIntent {
  return {
    to: a.paymasterHubAddress,
    abi: getAbi('PaymasterHub'),
    method: 'depositForOrg',
    args: [a.orgId],
    value: a.amountWei,
    meta: {
      domain: 'paymaster',
      action: 'deposit',
      orgId: a.orgId,
      summary: { paymasterHub: a.paymasterHubAddress, amountWei: String(a.amountWei) },
    },
  };
}

export interface AdminCallRegisterArgs {
  poaManagerAddress: string;
  paymasterHubAddress: string;
  /** bytes32 org id. */
  orgId: string;
  adminHatId: ethers.BigNumber;
  /** 0 = none. */
  operatorHatId: ethers.BigNumber;
  /** Present → registerAndConfigureOrg; absent → registerOrg. */
  config?: PaymasterRegisterConfig;
}

/**
 * Port of the owner path of `pop paymaster register` —
 * src/commands/paymaster/register.ts: PoaManager.adminCall(paymasterHub,
 * registerCalldata). Only the PoaManager OWNER can send this (adminCall is
 * onlyOwner); any other signer's transaction must revert — the CLI prints the
 * calldata for the owner instead of broadcasting, which hosts can reproduce
 * with buildRegisterCalldata + encodeIntent.
 */
export function buildAdminCallRegister(a: AdminCallRegisterArgs): TxIntent {
  const { method, data } = buildRegisterCalldata(a.orgId, a.adminHatId, a.operatorHatId, a.config);
  return {
    to: a.poaManagerAddress,
    abi: getAbi('PoaManager'),
    method: 'adminCall',
    args: [a.paymasterHubAddress, data],
    meta: {
      domain: 'paymaster',
      action: 'register',
      orgId: a.orgId,
      summary: {
        method,
        paymasterHub: a.paymasterHubAddress,
        adminHatId: a.adminHatId.toString(),
        operatorHatId: a.operatorHatId.toString(),
        registerCalldata: data,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Level 2 — resolved builders
// ---------------------------------------------------------------------------

export interface DepositForOrgParams {
  org: string;
  /** Ether units of the native gas token (e.g. 0.05 = 0.05 xDAI on Gnosis). */
  amount: string | number;
}

/**
 * Resolved port of `pop paymaster deposit` — src/commands/paymaster/deposit.ts.
 * Resolves the org id and the chain's singleton PaymasterHub proxy from the
 * infrastructure subgraph (the hub is NOT in the org's module list). When
 * ctx.provider is present, replicates the CLI's authoritative
 * OrgNotRegistered gate (an eth_call on purpose — subgraph lag in a
 * revert-predicting read means knowingly broadcasting a doomed tx).
 */
export async function depositForOrgIntent(ctx: PopContext, params: DepositForOrgParams): Promise<TxIntent> {
  const amountWei = parseDepositAmount(params.amount);
  const orgId = await resolveOrgId(ctx.client, params.org, ctx.chainId);
  const { paymasterHubAddress } = await resolvePaymasterInfra(ctx.client, ctx.chainId);

  if (ctx.provider) {
    const orgConfig = await readPaymasterOrgConfig(ctx.provider, paymasterHubAddress, orgId);
    if (!orgConfig.registered) {
      throw new PreconditionError(
        `Org ${params.org} is not registered with the PaymasterHub — depositForOrg would revert OrgNotRegistered.`,
        'Register it first: pop paymaster register --admin-hat <hatId>'
      );
    }
  }

  return buildDepositForOrg({ paymasterHubAddress, orgId, amountWei });
}

export interface RegisterOrgParams {
  org: string;
  /** Hat ID that will administer the org's paymaster config (usually the org top hat). */
  adminHat: string | number;
  /** Optional hat ID allowed to manage budgets/rules (0 = none). */
  operatorHat?: string | number;
  /** Initial fee caps (gwei), rules, and budgets (ether caps) — uses registerAndConfigureOrg. */
  config?: PaymasterRegisterConfig;
}

/**
 * Resolved port of `pop paymaster register` —
 * src/commands/paymaster/register.ts (the adminCall route). Resolves the org
 * id + PaymasterHub + PoaManager from the infrastructure subgraph and returns
 * the PoaManager.adminCall intent.
 *
 * Registration check is asymmetric like the CLI: a POSITIVE indexed
 * "registered" answer is trusted; a negative is re-confirmed on chain when
 * ctx.provider is available. An already-registered org throws
 * PreconditionError (the CLI reports it as a no-op success — builder callers
 * need the hard stop, since the intent would be a doomed re-registration).
 *
 * NOTE the on-chain gate the builder cannot check for you: adminCall is
 * onlyOwner on the PoaManager, and PoaManager.owner() has no subgraph field
 * in either live deployment — the CLI reads it via eth_call and prints the
 * calldata instead of broadcasting when the signer is not the owner. Hosts
 * should do the same before executing this intent.
 */
export async function registerOrgIntent(ctx: PopContext, params: RegisterOrgParams): Promise<TxIntent> {
  const adminHatId = parsePaymasterHatId(params.adminHat, '--admin-hat');
  const operatorHatId = params.operatorHat !== undefined
    ? parsePaymasterHatId(params.operatorHat, '--operator-hat')
    : ethers.BigNumber.from(0);
  if (adminHatId.isZero()) {
    throw new CliError('--admin-hat cannot be 0 (the contract treats adminHatId==0 as unregistered).', EXIT.USAGE);
  }

  const orgId = await resolveOrgId(ctx.client, params.org, ctx.chainId);
  const { paymasterHubAddress, poaManagerAddress } = await resolvePaymasterInfra(ctx.client, ctx.chainId);
  if (!poaManagerAddress) {
    throw new PreconditionError(
      'PoaManager not indexed for this chain — cannot route the registrar-gated call through adminCall.',
      'New orgs register automatically when deployed with a paymaster config block (pop org deploy).'
    );
  }

  // Already registered? Subgraph first; only a POSITIVE answer is trusted, a
  // negative is re-confirmed on chain (when a provider is available) — the
  // indexer can lag behind a fresh registration and never invents one.
  let registered: boolean;
  if (ctx.provider) {
    const { config } = await readPaymasterOrgConfigPreferSubgraph(
      ctx.client, ctx.provider, paymasterHubAddress, orgId, ctx.chainId
    );
    registered = config.registered;
  } else {
    // No provider: only the subgraph's positive answer is usable — a negative
    // cannot be re-confirmed, which is exactly the direction that is safe to
    // proceed on (the tx itself re-checks on-chain).
    const state = await fetchPaymasterSubgraphState(ctx.client, orgId, ctx.chainId);
    registered = Boolean(state.orgConfig?.registered && subgraphMatchesHub(state, paymasterHubAddress));
  }
  if (registered) {
    throw new PreconditionError(
      'Org is already registered with the PaymasterHub.',
      'Fund it with: pop paymaster deposit'
    );
  }

  return buildAdminCallRegister({
    poaManagerAddress,
    paymasterHubAddress,
    orgId,
    adminHatId,
    operatorHatId,
    config: params.config,
  });
}
