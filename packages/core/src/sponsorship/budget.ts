import { requireRawUint, RawUintInput } from '../amounts';

export interface PrefundV07Input {
  callGasLimit: RawUintInput;
  verificationGasLimit: RawUintInput;
  preVerificationGas: RawUintInput;
  paymasterVerificationGasLimit: RawUintInput;
  paymasterPostOpGasLimit: RawUintInput;
  maxFeePerGas: RawUintInput;
}

/** Supply the FINAL estimated/buffered operation, including explicit zero PM gas. */
export function requiredPrefundV07(op: PrefundV07Input): string {
  const gas = ['callGasLimit', 'verificationGasLimit', 'preVerificationGas', 'paymasterVerificationGasLimit', 'paymasterPostOpGasLimit'] as const;
  const sum = gas.reduce((n, key) => n + BigInt(requireRawUint(op[key], key === 'preVerificationGas' ? 256 : 128)), 0n);
  return requireRawUint(sum * BigInt(requireRawUint(op.maxFeePerGas, 128)));
}

export interface SponsorshipBudget {
  capPerEpoch: RawUintInput;
  usedInEpoch: RawUintInput;
  epochLen: RawUintInput;
  epochStart: RawUintInput;
}

/** PaymasterHub._checkBudget lazy roll, including epochStart=0; no clock/grace defaults. */
export function remainingBudget(budget: SponsorshipBudget, nowSeconds: RawUintInput): string {
  const cap = BigInt(requireRawUint(budget.capPerEpoch, 128));
  const used = BigInt(requireRawUint(budget.usedInEpoch, 128));
  const len = BigInt(requireRawUint(budget.epochLen, 32));
  const start = BigInt(requireRawUint(budget.epochStart, 32));
  const now = BigInt(requireRawUint(nowSeconds));
  // Solidity's checked uint32 epochStart+epochLen would revert here.
  requireRawUint(start + len, 32);
  if (len > 0n && now >= start + len) {
    const epochs = ((now - start) / len) & ((1n << 32n) - 1n);
    requireRawUint(epochs * len, 32);
    requireRawUint(start + epochs * len, 32);
    return cap.toString();
  }
  return (cap > used ? cap - used : 0n).toString();
}
