/**
 * PaymasterHub Queries
 *
 * Everything here was verified field-by-field against BOTH live deployments
 * (poa-gnosis-v-1 hub 0xdef1…4108, poa-arb-v-1 hub 0xd665…8a11) by comparing the
 * indexed value to the same value read straight off the contract. Only the
 * fields that matched EXACTLY are requested:
 *
 *   entryPoint            == PaymasterHub.ENTRY_POINT()      (both chains)
 *   adminHatId/operatorHatId/isPaused/registeredAt/isBannedFromSolidarity
 *                         == PaymasterHub.getOrgConfig()     (5 orgs, both chains)
 *   feeCaps.*             == PaymasterHub.getFeeCaps()       (Argus; and a null
 *                            `feeCaps` edge always corresponded to an all-zero
 *                            on-chain struct on 5 further orgs, which is the
 *                            contract's "never configured" default)
 *   budgets.*             == PaymasterHub.getBudget()        (9 budgets, 4 orgs,
 *                            both chains — cap, used, epochLen and epochStart
 *                            matched to the wei)
 *
 * DELIBERATELY NOT REQUESTED (schema has them, the values are WRONG):
 *   PaymasterOrgConfig.totalSpent / .depositBalance — the indexer accumulates the
 *     gas cost but not the solidarity fee the hub also debits, so it runs exactly
 *     1/1.01 of the contract's `spent`. Proven on Gnosis (1251669883200000000 ×
 *     1.01 == 1264186582032000000 == on-chain spent, to the wei) and on Arbitrum
 *     (141261159757737 × 1.01 == 142673771355313). `available = deposited - spent`
 *     is the number that decides whether sponsorship still works, so it stays on
 *     getOrgFinancials().
 *   PaymasterHubContract.solidarityBalance — matches on Arbitrum but is
 *     6376552300000000 wei HIGH on Gnosis (5115224471702250000 indexed vs
 *     5108847919402250000 on-chain).
 *   PaymasterHubContract.solidarityDistributionPaused — reads `false` on Arbitrum
 *     while the contract reports `true`. The pause toggle is not indexed.
 *
 * `numActiveOrgs`, `feePercentageBps`, `solidarityUsedThisPeriod` and
 * `periodStart` have no field at all. See docs in commands/paymaster/status.ts.
 */

/**
 * Hub-wide immutables + one org's paymaster configuration, in a single document.
 *
 * Filtered on `orgId` only rather than the `<hub>-<orgId>` composite entity id:
 * the id-construction convention is a subgraph implementation detail, and there
 * is exactly one PaymasterHubContract per chain. Callers still cross-check
 * `paymasterHub.id` against the hub address they resolved independently and
 * fall back to RPC on a mismatch.
 */
export const FETCH_PAYMASTER_STATE = `
  query FetchPaymasterState($orgId: Bytes!) {
    paymasterHubContracts(first: 1) {
      id
      entryPoint
    }
    paymasterOrgConfigs(first: 1, where: { orgId: $orgId }) {
      id
      orgId
      paymasterHub {
        id
      }
      adminHatId
      operatorHatId
      isPaused
      isBannedFromSolidarity
      registeredAt
      feeCaps {
        maxFeePerGas
        maxPriorityFeePerGas
        maxCallGas
        maxVerificationGas
        maxPreVerificationGas
      }
      budgets(first: 500, orderBy: setAt, orderDirection: asc) {
        subjectKey
        capPerEpoch
        usedInEpoch
        epochLen
        epochStart
        totalUsed
      }
    }
  }
`;

/**
 * Same document without `PaymasterBudget.totalUsed`.
 *
 * totalUsed is the one field here with no getter counterpart (getBudget() returns
 * only the four in-epoch numbers), which makes it the field most likely to be
 * missing from an older deployment. GraphQL validates a document as a whole, so
 * one unknown field would fail the ENTIRE query and drop `pop paymaster status`
 * back to the full RPC path — hence the tier rather than a bare query.
 *
 * Derived from the modern tier by deletion so the two cannot drift; the
 * derivation is line-based, which test/queries/paymaster-tiers.test.ts pins.
 */
export const FETCH_PAYMASTER_STATE_LEGACY = FETCH_PAYMASTER_STATE
  .split('\n')
  .filter(line => line.trim() !== 'totalUsed')
  .join('\n');

/** Modern tier first; the pre-totalUsed shape as the fallback. */
export const FETCH_PAYMASTER_STATE_TIERS = [FETCH_PAYMASTER_STATE, FETCH_PAYMASTER_STATE_LEGACY];

export interface PaymasterStateResponse {
  paymasterHubContracts: Array<{
    id: string;
    entryPoint: string;
  }>;
  paymasterOrgConfigs: Array<{
    id: string;
    orgId: string;
    paymasterHub: { id: string };
    adminHatId: string;
    operatorHatId: string;
    isPaused: boolean;
    isBannedFromSolidarity: boolean;
    registeredAt: string;
    feeCaps: {
      maxFeePerGas: string;
      maxPriorityFeePerGas: string;
      maxCallGas: number;
      maxVerificationGas: number;
      maxPreVerificationGas: number;
    } | null;
    budgets: Array<{
      subjectKey: string;
      capPerEpoch: string;
      usedInEpoch: string;
      epochLen: number;
      epochStart: number;
      /** Absent on the legacy tier. */
      totalUsed?: string;
    }>;
  }>;
}
