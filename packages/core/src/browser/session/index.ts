import { normalizeWalletScope, WalletScope } from '../wallet';

export interface AccountSessionSnapshot { readonly scope: Readonly<WalletScope>; readonly generation: number; isCurrent(): boolean; guard(): void; readonly signal: AbortSignal }
/** Generation fences survive an A -> B -> A switch. Stored account hints are
 * intentionally absent: only the host's resolved account may enter this session. */
export function createAccountSession({ initialScope }: { initialScope?: WalletScope } = {}) {
  let generation = 0, scope = initialScope ? Object.freeze(normalizeWalletScope(initialScope)) : null;
  let controller = new AbortController();
  const invalidate = () => { generation++; controller.abort(); controller = new AbortController(); };
  return {
    update(next: WalletScope) {
      const normalized = normalizeWalletScope(next);
      if (scope?.chainId === normalized.chainId && scope.accountAddress === normalized.accountAddress) return;
      invalidate(); scope = Object.freeze(normalized);
    },
    clear() { invalidate(); scope = null; },
    capture(): AccountSessionSnapshot {
      if (!scope) throw new Error('RESOLVED_ACCOUNT_REQUIRED');
      const captured = scope, version = generation, signal = controller.signal;
      const isCurrent = () => !signal.aborted && generation === version && scope === captured;
      return Object.freeze({ scope: captured, generation: version, signal, isCurrent,
        guard() { if (!isCurrent()) throw new Error('ACCOUNT_SESSION_CHANGED'); } });
    },
    get scope() { return scope; },
    get generation() { return generation; },
  };
}
