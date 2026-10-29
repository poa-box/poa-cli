import { ethers } from 'ethers';
import { requireRawUint, RawUintInput } from '../amounts';

export interface UserOperationV07 {
  sender: string;
  nonce: RawUintInput;
  callData: string;
  callGasLimit: RawUintInput;
  verificationGasLimit: RawUintInput;
  preVerificationGas: RawUintInput;
  maxFeePerGas: RawUintInput;
  maxPriorityFeePerGas: RawUintInput;
  factory?: string;
  factoryData?: string;
  paymaster?: string;
  paymasterVerificationGasLimit?: RawUintInput;
  paymasterPostOpGasLimit?: RawUintInput;
  paymasterData?: string;
  signature?: string;
}

function uint(value: RawUintInput, bits = 256): string {
  return requireRawUint(typeof value === 'string' && /^0x[\da-fA-F]+$/.test(value) ? BigInt(value) : value, bits);
}
function bytes(data: string): string {
  if (typeof data !== 'string' || !/^0x(?:[\da-fA-F]{2})*$/.test(data)) throw new Error('Invalid hex bytes');
  return data;
}
function address(data: string): string {
  const result = ethers.utils.getAddress(data);
  if (result === ethers.constants.AddressZero) throw new Error('Zero operation address');
  return result;
}
function pair(high: RawUintInput, low: RawUintInput): string {
  return ethers.utils.hexZeroPad(ethers.BigNumber.from((BigInt(uint(high, 128)) << 128n) | BigInt(uint(low, 128))).toHexString(), 32);
}

export interface PackedUserOperationV07 {
  sender: string; nonce: string; initCode: string; callData: string; accountGasLimits: string;
  preVerificationGas: string; gasFees: string; paymasterAndData: string; signature: string;
}

/** General v0.7 packing; half factory/paymaster inputs never silently disappear. */
export function packUserOperationV07(op: UserOperationV07): PackedUserOperationV07 {
  if ((op.factory === undefined) !== (op.factoryData === undefined)) throw new Error('factory and factoryData must be paired');
  let paymasterAndData = '0x';
  if (op.paymaster !== undefined) {
    if (op.paymasterVerificationGasLimit === undefined || op.paymasterPostOpGasLimit === undefined) throw new Error('Paymaster gas fields required');
    paymasterAndData = ethers.utils.solidityPack(['address', 'uint128', 'uint128', 'bytes'], [address(op.paymaster), uint(op.paymasterVerificationGasLimit, 128), uint(op.paymasterPostOpGasLimit, 128), bytes(op.paymasterData ?? '0x')]);
  } else if (op.paymasterData !== undefined || op.paymasterVerificationGasLimit !== undefined || op.paymasterPostOpGasLimit !== undefined) throw new Error('Paymaster fields require paymaster');
  return {
    sender: address(op.sender), nonce: uint(op.nonce), initCode: op.factory === undefined ? '0x' : ethers.utils.hexConcat([address(op.factory), bytes(op.factoryData!)]),
    callData: bytes(op.callData), accountGasLimits: pair(op.verificationGasLimit, op.callGasLimit),
    preVerificationGas: uint(op.preVerificationGas), gasFees: pair(op.maxPriorityFeePerGas, op.maxFeePerGas), paymasterAndData, signature: bytes(op.signature ?? '0x'),
  };
}

/** EntryPoint.getUserOpHash oracle: hash excludes signature, binds chain+EntryPoint. */
export function hashUserOperationV07(op: UserOperationV07, entryPoint: string, chainId: RawUintInput): `0x${string}` {
  const packed = packUserOperationV07(op);
  const chain = uint(chainId);
  if (chain === '0') throw new Error('chainId must be positive');
  const digest = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(
    ['address', 'uint256', 'bytes32', 'bytes32', 'bytes32', 'uint256', 'bytes32', 'bytes32'],
    [packed.sender, packed.nonce, ethers.utils.keccak256(packed.initCode), ethers.utils.keccak256(packed.callData), packed.accountGasLimits, packed.preVerificationGas, packed.gasFees, ethers.utils.keccak256(packed.paymasterAndData)]));
  return ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['bytes32', 'address', 'uint256'], [digest, address(entryPoint), chain])) as `0x${string}`;
}
