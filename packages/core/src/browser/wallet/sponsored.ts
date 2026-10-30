import { requireRawUint } from '../../amounts';
import { hashUserOperationV07, packUserOperationV07, UserOperationV07 } from '../../accounts/userop-v07';
import type { SubmissionRecoveryReaders } from '../../execute/recovery';
import { guardWalletAction, normalizeWalletScope, UnsignedCall, WalletActionOptions, WalletScope, WalletSendOptions } from './index';

export interface SponsoredOperationPreparation {
  operation: UserOperationV07; entryPoint: string; fromBlock: string;
}
export interface PreparedSponsoredCall {
  readonly kind: 'user-operation';
  readonly call: Readonly<UnsignedCall>; readonly nonce: string; readonly fromBlock: string;
  readonly entryPoint: string; readonly computedHash: string;
}
export interface SponsoredWalletSendOptions extends WalletSendOptions {
  /** Explicit send consent and current authorization must already be established.
   * This hook revalidates them immediately before a signing/biometric prompt. */
  beforeSign: () => unknown | Promise<unknown>;
}
export interface SponsoredExecutionPorts {
  getIdentity(options?: { signal?: AbortSignal }): Promise<WalletScope>;
  getNonce(scope: WalletScope): Promise<string>;
  /** Pure synchronous encoding for the exact account contract being used. */
  encodeCall(call: Readonly<UnsignedCall>): string;
  /** Explicit host-sponsored gas/nonce/factory preparation; never imported implicitly. */
  prepareOperation(input: WalletActionOptions & { scope: WalletScope; call: Readonly<UnsignedCall> }): Promise<SponsoredOperationPreparation>;
  signHash(hash: string, input: WalletActionOptions & { scope: WalletScope }): Promise<string>;
  /** Must immediately enter the bundler boundary with this exact immutable op. */
  dispatchSignedOperation(operation: Readonly<UserOperationV07>, entryPoint: string): Promise<string>;
  recoveryReaders: SubmissionRecoveryReaders;
  subscribeScopeChange?: (changed: () => void) => () => void;
}
const same = (a: WalletScope, b: WalletScope) => a.chainId === b.chainId && a.accountAddress === b.accountAddress;
const hex = (value: string) => typeof value === 'string' && /^0x(?:[\da-f]{2})*$/i.test(value);
const addr = (value: string) => normalizeWalletScope({ chainId: 1, accountAddress: value }).accountAddress;
function snapshotOperation(op: UserOperationV07): Readonly<UserOperationV07> {
  // Core validates paired factory/paymaster fields and every packed bound.
  packUserOperationV07(op);
  const result: UserOperationV07 = { sender: addr(op.sender), nonce: requireRawUint(op.nonce), callData: op.callData.toLowerCase(),
    callGasLimit: requireRawUint(op.callGasLimit, 128), verificationGasLimit: requireRawUint(op.verificationGasLimit, 128), preVerificationGas: requireRawUint(op.preVerificationGas),
    maxFeePerGas: requireRawUint(op.maxFeePerGas, 128), maxPriorityFeePerGas: requireRawUint(op.maxPriorityFeePerGas, 128) };
  if (op.factory !== undefined) { result.factory = addr(op.factory); result.factoryData = op.factoryData!.toLowerCase(); }
  if (op.paymaster !== undefined) {
    result.paymaster = addr(op.paymaster); result.paymasterVerificationGasLimit = requireRawUint(op.paymasterVerificationGasLimit!, 128);
    result.paymasterPostOpGasLimit = requireRawUint(op.paymasterPostOpGasLimit!, 128); result.paymasterData = (op.paymasterData ?? '0x').toLowerCase();
  }
  return Object.freeze(result);
}
/** Guarded v0.7 execution seam for an explicitly injected account encoder,
 * sponsor, signer and bundler. It provides no network, credentials or automatic
 * fallback. The opaque signed operation is held in memory only. */
export function createSponsoredExecutionAdapter(ports: SponsoredExecutionPorts) {
  for (const name of ['getIdentity', 'getNonce', 'encodeCall', 'prepareOperation', 'signHash', 'dispatchSignedOperation'] as const) {
    if (typeof ports?.[name] !== 'function') throw new Error('EXPLICIT_SPONSORED_PORTS_REQUIRED');
  }
  const entries = new WeakMap<PreparedSponsoredCall, { scope: WalletScope; operation: Readonly<UserOperationV07>; generation: number; used: boolean }>();
  let generation = 0, disposed = false;
  const unsubscribe = ports.subscribeScopeChange?.(() => { generation++; });
  const guard = (options: WalletActionOptions) => { if (disposed) throw new Error('WALLET_ADAPTER_DISPOSED'); guardWalletAction(options.signal, options.isCurrent); };
  const getIdentity = async (options?: { signal?: AbortSignal }) => normalizeWalletScope(await ports.getIdentity(options));
  return {
    getIdentity,
    recoveryReaders: ports.recoveryReaders,
    async prepare({ scope: inputScope, call: inputCall, ...action }: WalletActionOptions & { scope: WalletScope; call: UnsignedCall }): Promise<PreparedSponsoredCall> {
      guard(action); const scope = Object.freeze(normalizeWalletScope(inputScope)), version = generation;
      if (!inputCall || typeof inputCall.value !== 'string' || !hex(inputCall.data)) throw new Error('EXACT_UNSIGNED_CALL_REQUIRED');
      const call = Object.freeze({ to: addr(inputCall.to), value: requireRawUint(inputCall.value), data: inputCall.data.toLowerCase() });
      if (!same(await getIdentity(action), scope)) throw new Error('WALLET_IDENTITY_MISMATCH');
      guard(action);
      const setup = await ports.prepareOperation({ ...action, scope, call });
      guard(action);
      if (version !== generation || !same(await getIdentity(action), scope)) throw new Error('WALLET_SCOPE_CHANGED');
      guard(action);
      const operation = snapshotOperation(setup.operation), entryPoint = addr(setup.entryPoint), fromBlock = requireRawUint(setup.fromBlock);
      if (operation.sender !== scope.accountAddress || operation.callData !== ports.encodeCall(call).toLowerCase()) throw new Error('SPONSORED_CALL_MISMATCH');
      const computedHash = hashUserOperationV07(operation, entryPoint, scope.chainId);
      const prepared = Object.freeze({ kind: 'user-operation' as const, call, nonce: requireRawUint(operation.nonce), fromBlock, entryPoint, computedHash });
      // Hashing excludes signature: preparation can expose an exact durable
      // recovery identity without prompting for biometric/signing consent.
      entries.set(prepared, { scope, operation, generation: version, used: false });
      return prepared;
    },
    async send(prepared: PreparedSponsoredCall, action: SponsoredWalletSendOptions) {
      let entry: NonNullable<ReturnType<typeof entries.get>>;
      let signedOperation: Readonly<UserOperationV07>;
      try {
        const saved = entries.get(prepared);
        if (!saved || saved.used) throw new Error('FRESH_PREPARED_WALLET_CALL_REQUIRED');
        entry = saved; entry.used = true;
        if (typeof action?.beforeSend !== 'function') throw new Error('FINAL_REVIEW_REQUIRED');
        if (typeof action.beforeSign !== 'function') throw new Error('SIGNING_REVIEW_REQUIRED');
        guard(action);
        if (requireRawUint(await ports.getNonce(entry.scope)) !== prepared.nonce) throw new Error('WALLET_NONCE_CHANGED');
        if (!same(await getIdentity(action), entry.scope)) throw new Error('WALLET_IDENTITY_MISMATCH');
        guard(action);
        if (generation !== entry.generation || hashUserOperationV07(entry.operation, prepared.entryPoint, entry.scope.chainId) !== prepared.computedHash
          || entry.operation.callData !== ports.encodeCall(prepared.call).toLowerCase()) throw new Error('SPONSORED_SCOPE_CHANGED');
        // Workflows obtain explicit send approval before entering send(), then
        // revalidate current protocol policy here immediately before signing.
        await action.beforeSign();
        guard(action);
        if (generation !== entry.generation) throw new Error('WALLET_SCOPE_CHANGED');
        const signature = await ports.signHash(prepared.computedHash, { ...action, scope: entry.scope });
        guard(action);
        if (!hex(signature) || signature === '0x') throw new Error('SPONSORED_SIGNATURE_REQUIRED');
        if (generation !== entry.generation || !same(await getIdentity(action), entry.scope)) throw new Error('WALLET_SCOPE_CHANGED');
        if (requireRawUint(await ports.getNonce(entry.scope)) !== prepared.nonce) throw new Error('WALLET_NONCE_CHANGED');
        guard(action);
        if (generation !== entry.generation) throw new Error('WALLET_SCOPE_CHANGED');
        signedOperation = Object.freeze({ ...entry.operation, signature });
        await action.beforeSend();
        guard(action);
        if (generation !== entry.generation) throw new Error('WALLET_SCOPE_CHANGED');
      } catch (cause) { throw Object.assign(new Error('SPONSORED_HANDOFF_REFUSED', { cause }), { dispatched: false }); }
      try {
        const hash = await ports.dispatchSignedOperation(signedOperation, prepared.entryPoint);
        if (typeof hash !== 'string' || hash.toLowerCase() !== prepared.computedHash.toLowerCase()) throw new Error('SPONSORED_HASH_MISMATCH');
        return { kind: 'user-operation' as const, userOpHash: hash.toLowerCase(), computedHash: prepared.computedHash };
      } catch (cause) {
        throw Object.assign(new Error('SPONSORED_SEND_UNCONFIRMED', { cause }), { dispatched: true, submission: {
          phase: 'submitting', chainId: entry.scope.chainId, accountAddress: entry.scope.accountAddress, entryPoint: prepared.entryPoint,
          computedHash: prepared.computedHash, nonce: prepared.nonce, fromBlock: prepared.fromBlock,
        } });
      }
    },
    dispose() { disposed = true; generation++; unsubscribe?.(); },
  };
}
