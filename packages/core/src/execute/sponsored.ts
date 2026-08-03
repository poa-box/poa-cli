/**
 * EIP-7702 Gas Sponsorship
 *
 * Uses the org PaymasterHub to sponsor agent transaction gas.
 * Flow: Agent EOA → EIP-7702 delegation → UserOp via Pimlico bundler → PaymasterHub pays gas.
 *
 * Based on the poa-frontend EOA7702TransactionManager + userOpBuilder implementation.
 *
 * Prerequisites:
 * - Agent registered in UniversalAccountRegistry
 * - Agent wears a hat in the org
 * - `pimlicoApiKey` or `bundlerUrl` provided via SponsoredSendOptions
 *   (the CLI passes PIMLICO_API_KEY / POP_BUNDLER_URL from env)
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
  encodeAbiParameters,
  parseAbiParameters,
  keccak256,
  type Hex,
  type Address,
  type Abi,
  concat,
  pad,
  toHex,
} from 'viem';
import { gnosis } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { createPimlicoClient } from 'permissionless/clients/pimlico';
import {
  entryPoint07Address,
  entryPoint07Abi,
  type EntryPointVersion,
} from 'viem/account-abstraction';

// Contract addresses (Gnosis)
export const EOA_DELEGATION = '0x776ec88A88E86e38d54a985983377f1A2A25ef8b' as Address;
export const PAYMASTER_HUB = '0xdEf1038C297493c0b5f82F0CDB49e929B53B4108' as Address;
export const ENTRY_POINT = entryPoint07Address;

const GAS_BUFFER_PERCENT = 10n;
const DUMMY_ECDSA_SIGNATURE = ('0x' + 'ff'.repeat(65)) as Hex;

/**
 * Options for sendSponsored. Bundler routing is injected here — core never
 * reads env. The CLI maps POP_BUNDLER_URL → bundlerUrl and
 * PIMLICO_API_KEY → pimlicoApiKey.
 */
export interface SponsoredSendOptions {
  rpcUrl?: string;
  value?: bigint;
  pimlicoApiKey?: string;
  bundlerUrl?: string;
}

/**
 * Encode paymaster data for the PaymasterHub.
 * Format: version(1) | orgId(32) | subjectType=0x01(1) | hatId(32) | ruleId(4) | mailboxCommit(8)
 * Total: 78 bytes (must match frontend encoding exactly)
 */
export function encodePaymasterData(orgId: Hex, hatId: bigint): Hex {
  const version = toHex(0x01, { size: 1 });
  const paddedOrgId = pad(orgId as Hex, { size: 32 });
  const subjectType = toHex(0x01, { size: 1 }); // HAT
  const paddedHatId = toHex(hatId, { size: 32 });
  const ruleId = toHex(0, { size: 4 });
  const mailboxCommit = toHex(0n, { size: 8 });

  return concat([version, paddedOrgId, subjectType, paddedHatId, ruleId, mailboxCommit]) as Hex;
}

/**
 * Check if an EOA has already delegated to EOADelegation.
 */
export async function isDelegated(address: Address, rpcUrl?: string): Promise<boolean> {
  const client = createPublicClient({
    chain: gnosis,
    transport: http(rpcUrl || 'https://rpc.gnosischain.com'),
  });

  const code = await client.getCode({ address });
  return code !== undefined && code !== '0x' && code.startsWith('0xef0100');
}

/**
 * Sign EIP-7702 authorization to delegate EOA to EOADelegation contract.
 * This is a one-time setup — after delegation, the EOA can receive UserOps.
 */
export async function delegateEOA(privateKey: Hex, rpcUrl?: string): Promise<Hex> {
  const account = privateKeyToAccount(privateKey);
  const walletClient = createWalletClient({
    account,
    chain: gnosis,
    transport: http(rpcUrl || 'https://rpc.gnosischain.com'),
  });

  const authorization = await walletClient.signAuthorization({
    contractAddress: EOA_DELEGATION,
    executor: 'self',
  });

  const hash = await walletClient.sendTransaction({
    authorizationList: [authorization],
    to: account.address,
    data: '0x' as Hex,
  });

  return hash;
}

/**
 * Pack two uint128 values into a single bytes32.
 * high128 || low128
 */
function packUint128Pair(high: bigint, low: bigint): Hex {
  return pad(toHex((BigInt(high) << 128n) | BigInt(low)), { size: 32 });
}

function applyBuffer(value: bigint): bigint {
  return (BigInt(value) * (100n + GAS_BUFFER_PERCENT)) / 100n;
}

/**
 * Compute the UserOp hash per EIP-4337 v0.7 (PackedUserOperation) spec.
 * Ported from poa-frontend userOpBuilder.js getUserOpHash().
 */
export function getUserOpHash(userOp: any, entryPoint: Address, chainId: number): Hex {
  // Reconstruct paymasterAndData
  let paymasterAndData: Hex = '0x';
  if (userOp.paymaster) {
    const pmVerGas = pad(toHex(userOp.paymasterVerificationGasLimit || 0n), { size: 16 });
    const pmPostGas = pad(toHex(userOp.paymasterPostOpGasLimit || 0n), { size: 16 });
    if (userOp.paymasterData && userOp.paymasterData !== '0x') {
      paymasterAndData = concat([userOp.paymaster, pmVerGas, pmPostGas, userOp.paymasterData]) as Hex;
    } else {
      paymasterAndData = concat([userOp.paymaster, pmVerGas, pmPostGas]) as Hex;
    }
  }

  const accountGasLimits = packUint128Pair(
    userOp.verificationGasLimit,
    userOp.callGasLimit,
  );
  const gasFees = packUint128Pair(
    userOp.maxPriorityFeePerGas,
    userOp.maxFeePerGas,
  );

  const packed = encodeAbiParameters(
    parseAbiParameters('address, uint256, bytes32, bytes32, bytes32, uint256, bytes32, bytes32'),
    [
      userOp.sender,
      userOp.nonce,
      keccak256('0x' as Hex) as Hex, // no initCode for already-deployed EOA
      keccak256(userOp.callData as Hex) as Hex,
      accountGasLimits,
      userOp.preVerificationGas,
      gasFees,
      keccak256(paymasterAndData) as Hex,
    ]
  );

  const userOpPacked = keccak256(packed as Hex) as Hex;

  return keccak256(
    encodeAbiParameters(
      parseAbiParameters('bytes32, address, uint256'),
      [userOpPacked, entryPoint, BigInt(chainId)]
    ) as Hex
  ) as Hex;
}

/**
 * Send a sponsored transaction via Pimlico bundler.
 * The PaymasterHub pays for gas — agent pays nothing.
 *
 * Follows the same flow as poa-frontend EOA7702TransactionManager:
 * 1. Encode call in EOADelegation.execute() wrapper
 * 2. Build UserOp with paymaster data and dummy signature
 * 3. Estimate gas via bundler
 * 4. Compute UserOp hash (EIP-4337 v0.7 packed format)
 * 5. Sign with wallet (ECDSA via signMessage — EIP-191 prefix)
 * 6. Submit to bundler and wait for receipt
 */
export async function sendSponsored(
  privateKey: Hex,
  to: Address,
  data: Hex,
  orgId: Hex,
  hatId: bigint,
  options?: SponsoredSendOptions
): Promise<{ txHash: Hex; userOpHash: Hex }> {
  // Task #425: bundlerUrl (CLI: POP_BUNDLER_URL) for self-hosted bundler support.
  // When set, uses the local bundler (e.g. Skandha at localhost:14337).
  // When unset, falls back to Pimlico. Zero-downtime migration path.
  const bundlerOverride = options?.bundlerUrl;
  const apiKey = bundlerOverride ? null : options?.pimlicoApiKey;
  if (!bundlerOverride && !apiKey) {
    throw new Error('Set bundlerUrl (env: POP_BUNDLER_URL) for self-hosted bundler or pimlicoApiKey (env: PIMLICO_API_KEY) for Pimlico. See reports/research/self-hosted-bundler-research.md.');
  }

  const rpcUrl = options?.rpcUrl || 'https://rpc.gnosischain.com';
  const account = privateKeyToAccount(privateKey);
  const pimlicoUrl = bundlerOverride || `https://api.pimlico.io/v2/${gnosis.id}/rpc?apikey=${apiKey}`;

  // Check delegation
  const delegated = await isDelegated(account.address, rpcUrl);
  if (!delegated) {
    throw new Error(
      `EOA ${account.address} not delegated to EOADelegation. ` +
      `Run 'pop agent delegate' first to set up EIP-7702 delegation.`
    );
  }

  const walletClient = createWalletClient({
    account,
    chain: gnosis,
    transport: http(rpcUrl),
  });

  const publicClient = createPublicClient({
    chain: gnosis,
    transport: http(rpcUrl),
  });

  const pimlicoClient = createPimlicoClient({
    chain: gnosis,
    transport: http(pimlicoUrl),
    entryPoint: {
      address: ENTRY_POINT,
      version: '0.7' as EntryPointVersion,
    },
  });

  // Encode paymaster data
  const paymasterData = encodePaymasterData(orgId, hatId);

  // EOADelegation.execute(target, value, data) — same ABI as PasskeyAccount.execute
  const executeAbi = [{
    name: 'execute',
    type: 'function',
    inputs: [
      { name: 'target', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  }] as const;

  const callData = encodeFunctionData({
    abi: executeAbi,
    functionName: 'execute',
    args: [to, options?.value || 0n, data],
  });

  // Fetch nonce and gas prices in parallel
  const [nonce, gasPrices] = await Promise.all([
    publicClient.readContract({
      address: ENTRY_POINT,
      abi: entryPoint07Abi,
      functionName: 'getNonce',
      args: [account.address, 0n],
    }),
    pimlicoClient.getUserOperationGasPrice(),
  ]);

  // Sign 7702 authorization (bundler includes it in the type-4 tx)
  const authorization = await walletClient.signAuthorization({
    contractAddress: EOA_DELEGATION,
  });

  // Build UserOp with dummy signature for gas estimation
  // Gas limits must stay within PaymasterHub fee caps (maxCallGas, maxVerificationGas, maxPreVerificationGas)
  const userOp: any = {
    sender: account.address,
    nonce,
    callData,
    callGasLimit: 300_000n,
    verificationGasLimit: 300_000n,
    preVerificationGas: 80_000n,
    maxFeePerGas: gasPrices.fast.maxFeePerGas,
    maxPriorityFeePerGas: gasPrices.fast.maxPriorityFeePerGas,
    paymaster: PAYMASTER_HUB,
    paymasterVerificationGasLimit: 200_000n,
    paymasterPostOpGasLimit: 200_000n,
    paymasterData,
    authorization,
    signature: DUMMY_ECDSA_SIGNATURE,
  };

  // Estimate gas via bundler — catch validateUserOp errors from dummy signature
  try {
    const gasEstimate = await pimlicoClient.estimateUserOperationGas({
      ...userOp,
      entryPointAddress: ENTRY_POINT,
    } as any);

    // Apply gas estimates with buffer
    userOp.callGasLimit = applyBuffer(gasEstimate.callGasLimit);
    userOp.preVerificationGas = applyBuffer(gasEstimate.preVerificationGas);

    // ECDSA verification is cheap (~3k gas), but enforce a minimum
    const estimatedVerification = applyBuffer(gasEstimate.verificationGasLimit);
    userOp.verificationGasLimit = estimatedVerification < 100_000n ? 100_000n : estimatedVerification;

    if (gasEstimate.paymasterVerificationGasLimit) {
      userOp.paymasterVerificationGasLimit = applyBuffer(gasEstimate.paymasterVerificationGasLimit);
    }
    if (gasEstimate.paymasterPostOpGasLimit) {
      userOp.paymasterPostOpGasLimit = applyBuffer(gasEstimate.paymasterPostOpGasLimit);
    }
  } catch (estimateError: any) {
    const msg = estimateError.message || '';
    // Paymaster rejections should propagate — caller needs to know
    if (msg.includes('AA31') || msg.includes('AA32') || msg.includes('AA33')) {
      throw estimateError;
    }
    // validateUserOp fails with dummy sig — use generous defaults
    // (same pattern as poa-frontend estimateGas() fallback)
  }

  // Compute UserOp hash (EIP-4337 v0.7 packed format)
  const computedHash = getUserOpHash(userOp, ENTRY_POINT, gnosis.id);

  // Sign with wallet — EOADelegation validates via toEthSignedMessageHash(userOpHash)
  const signature = await walletClient.signMessage({
    message: { raw: computedHash },
  });
  userOp.signature = signature;

  // Submit to bundler
  const submittedHash = await pimlicoClient.sendUserOperation({
    ...userOp,
    entryPointAddress: ENTRY_POINT,
  } as any);

  // Wait for receipt
  const receipt = await pimlicoClient.waitForUserOperationReceipt({
    hash: submittedHash,
    timeout: 120_000,
  });

  return {
    txHash: receipt.receipt.transactionHash as Hex,
    userOpHash: submittedHash as Hex,
  };
}

/**
 * Helper: encode a contract function call for use with sendSponsored.
 */
export function encodeCall(abi: Abi, functionName: string, args: any[]): Hex {
  return encodeFunctionData({ abi, functionName, args });
}
