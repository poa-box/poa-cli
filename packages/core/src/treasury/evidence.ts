import { assertPlanScope, type PlanScope } from '../data/facts';

/** Internal binding check: an own-module observation need not repeat a full
 * organization map, but any explicit expected entry must agree. Callers keep
 * the fact's own contract/account/block checks separate (ERC20 is not the PM). */
export function assertTreasuryModuleBindings(actual: PlanScope, ...expected: readonly PlanScope[]): void {
  for (const scope of expected) {
    for (const [key, contract] of Object.entries(scope.contracts ?? {})) {
      if (actual.contracts?.[key] !== undefined) assertPlanScope(actual, { chainId: scope.chainId, contracts: { [key]: contract } });
    }
  }
}
