import { ethers } from 'ethers';
import { knownFact, SourceSnapshot, PlanScope } from '../../../src/data/facts';
import { bytes32ToCidV0 } from '../../../src/encoding/cid';
import { submissionIntentKey } from '../../../src/execute/recovery';
import type { BrowserJournal, JournalEnvelope } from '../../../src/browser/storage';
import type { UnsignedCall } from '../../../src/browser/wallet';
import type { WorkflowHost, WorkflowScope } from '../../../src/workflows';

export const addr = (byte: string) => `0x${byte.repeat(40)}`;
export const hash = (byte: string) => `0x${byte.repeat(64)}`;
export const scope: WorkflowScope = { chainId: 100, orgId: 'synthetic', account: addr('1'), contracts: {
  membershipAuthority: addr('2'), hybridVoting: addr('3'), directDemocracyVoting: addr('4'), executor: addr('5'),
  taskManager: addr('6'), quickJoin: addr('7'), accountRegistry: addr('8'), passkeyFactory: addr('9'),
} };
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
export const coverage = { status: 'complete' as const, expectedKeys: ['all'], receivedKeys: ['all'], missingIds: [], failedIds: [], issues: [] };
export function fixture() {
  const control = { now: 1000, current: true, account: scope.account, chainId: 100, approve: true, lostAck: false,
    mined: false, sends: 0, publishes: 0, simulations: 0, writes: 0, database: null as JournalEnvelope<unknown> | null,
    approvals: [] as string[], beforeWrite: undefined as undefined | ((data: unknown) => void | Promise<void>),
    afterWrite: undefined as undefined | ((data: unknown) => void | Promise<void>),
    walletSetup: undefined as undefined | (() => void | Promise<void>),
    beforeRead: undefined as undefined | (() => void | Promise<void>),
    logs: [] as { address: string; topics: readonly string[]; data: string }[],
    simulateAllowed: true, simulateAccount: scope.account, publicationLost: false, lockRevoked: false };
  const snapshot = <T>(data: T, contract: string, indexed = false, account = false): SourceSnapshot<T> => ({ data: clone(data), coverage: clone(coverage),
    source: { ...clone(scope), account: account ? control.account : undefined, contract, indexed, endpoint: indexed ? 'indexed:fixture' : 'rpc:fixture',
      method: 'synthetic-scoped-observation', snapshot: 'pinned', block: { number: '100', hash: hash('a'), timestamp: String(control.now) }, observedAt: control.now } });
  let held = false;
  const journal: BrowserJournal<unknown> = { async withAccountLock(account, run) {
    if (held) throw new Error('ACCOUNT_ACTION_IN_PROGRESS'); held = true;
    try { return await run({ assertActive() { if (!held || control.lockRevoked) throw new Error('JOURNAL_SESSION_EXPIRED'); }, async read() { return clone(control.database); }, async compareAndSwap(expected, data) {
      if (JSON.stringify(expected) !== JSON.stringify(control.database)) throw new Error('STALE_JOURNAL_OWNER');
      await control.beforeWrite?.(data); control.writes++;
      control.database = { version: 1, scope: clone(account), revision: (expected?.revision ?? -1) + 1, data: clone(data) };
      await control.afterWrite?.(data); return clone(control.database);
    } }); } finally { held = false; }
  } };
  let sent: UnsignedCall | undefined;
  const txHash = hash('b'), blockHash = hash('c');
  const transaction = () => sent && ({ hash: txHash, from: host.scope.account, nonce: '0', to: sent.to, data: sent.data, value: sent.value,
    chainId: '100', blockNumber: control.mined ? '101' : null, blockHash: control.mined ? blockHash : null });
  const documentBytes = new Map<string, unknown>();
  const host: WorkflowHost = { workflowId: 'workflow-test', scope: clone(scope), sources: { rpcEndpoint: 'rpc:fixture', indexedEndpoint: 'indexed:fixture', now: () => control.now }, journal,
    isCurrent: () => control.current,
    confirm: async approval => { control.approvals.push(approval.kind); return control.approve; },
    simulate: async call => {
      control.simulations++;
      const observed = snapshot({ callKey: submissionIntentKey([call]), succeeds: knownFact(control.simulateAllowed) }, call.to, false, true);
      observed.source.account = control.simulateAccount; return observed;
    },
    documents: { async publish(document) {
      control.publishes++; const cid = bytes32ToCidV0(ethers.utils.id(document.json)); documentBytes.set(cid, JSON.parse(document.json));
      if (control.publicationLost) throw new Error('SYNTHETIC_PUBLICATION_ACK_LOST'); return { cid };
    }, async fetch(cid) { return documentBytes.get(cid); } },
    wallet: { async getIdentity() { return { chainId: control.chainId, accountAddress: control.account }; },
      async prepare({ call }) { return Object.freeze({ call, nonce: '0', fromBlock: '100' }); },
      async send(prepared, options) {
        try { await control.walletSetup?.(); await options.beforeSend(); }
        catch (cause) { throw Object.assign(new Error('SYNTHETIC_REFUSAL', { cause }), { dispatched: false }); }
        control.sends++; sent = clone(prepared.call);
        if (control.lostAck) throw new Error('SYNTHETIC_ACK_LOST'); return { txHash };
      }, dispose() {},
      recoveryReaders: { getChainId: async () => 100, getBlockNumber: async () => 101,
        getTransaction: async hash => hash === txHash ? transaction() ?? null : null,
        getTransactionReceipt: async hash => hash === txHash && control.mined ? { status: 1, transactionHash: txHash, blockNumber: '101', blockHash, logs: clone(control.logs) } : null,
        getBlock: async number => ({ number, hash: number === '101' ? blockHash : hash('a') }),
        getBlockTransactions: async number => number === '101' && control.mined && transaction() ? [transaction()!] : [],
      },
    },
  };
  return { control, host, snapshot, txHash, documentBytes };
}
export const authorityData = (permKey: string, word: string, ctx = ethers.constants.HashZero) => ({ subjects: [{ subjectId: '1', kind: 'Role' as const, name: 'Synthetic role' }], groupEdges: [],
  permissions: [{ id: 'permission', subjectId: '1', permKey, ctx, word }] });
export const memberData = [{ subjectId: '1', isMember: knownFact(true), acceptedAt: knownFact('1'), seededWhilePaused: knownFact(false) }];
export function assertReady<T>(result: { status: string; data?: T; codes?: readonly string[] }): T {
  if (result.status !== 'ready' || result.data === undefined) throw new Error(JSON.stringify(result)); return result.data;
}
