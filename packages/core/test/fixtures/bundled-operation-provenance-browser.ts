import { exactTransactionCall, readCanonicalTransaction } from '../../src/reads/provenance';
import { readRoleContinuation, readRoleConfigurationOutcome } from '../../src/governance/role-continuation';
import { ACCOUNT, AUTH, EXECTX, HV, OTHER, TX, configurationFixture, fixture, operation, operationIdentity } from './bundled-operation-provenance';

// Actual ethers browser ESM classes. All canonical provider/index observations are
// local fixture functions; this does not launch a browser or contact an endpoint.
async function run() {
  const cases: { name: string; passed: boolean; error?: string }[] = [];
  const assert = (ok: boolean, detail: string) => { if (!ok) throw new Error(detail); };
  const check = async (name: string, work: () => Promise<void>) => {
    try { await work(); cases.push({ name, passed: true }); }
    catch (error) { cases.push({ name, passed: false, error: (error as Error).message }); }
  };
  for (const position of [0, 1, 2]) await check('isolated role creation/execution at position ' + position, async () => {
    const f = fixture(position === 1 ? 'Group' : 'Role');
    const selected = operation(ACCOUNT, '9', HV, f.txs[TX].data, true, f.creationLogs);
    const ops = [operation(OTHER, '10', AUTH, '0x11223344', false), operation(ACCOUNT, '11', AUTH, '0x11223344')];
    ops.splice(position, 0, selected); f.bundle(TX, ops, f.creationLogs);
    const execution = operation(OTHER, '20', HV, f.txs[EXECTX].data, true, f.executionLogs);
    f.bundle(EXECTX, [operation(ACCOUNT, '21', AUTH, '0x11223344'), execution], f.executionLogs, f.executionLogs);
    const result = await readRoleContinuation(f.input);
    assert(result.state === 'created' && result.subjectId === f.subjectId, JSON.stringify(result));
  });
  await check('ambiguous same-account calls require hash then select exact event', async () => {
    const f = fixture(), first = operation(ACCOUNT, '9', HV, f.txs[TX].data, true, f.creationLogs), second = operation(ACCOUNT, '10', HV, f.txs[TX].data, true, f.creationLogs);
    f.bundle(TX, [first, second]);
    try { await readRoleContinuation(f.input); throw new Error('Unsafe ambiguity accepted'); }
    catch (error) { assert((error as Error).message === 'EXACT_OPERATION_IDENTITY_REQUIRED', String(error)); }
    f.input.creationOperation = operationIdentity(first);
    assert((await readRoleContinuation(f.input)).state === 'created', 'Missing exact created subject');
  });
  await check('exact configuration creation and independently co-bundled announcement', async () => {
    const f = configurationFixture(), creation = operation(ACCOUNT, '9', HV, f.txs[TX].data, true, f.creationLogs), execution = operation(OTHER, '20', HV, f.txs[EXECTX].data, true, f.executionLogs);
    f.bundle(TX, [operation(OTHER, '10', AUTH, '0x11223344'), creation]);
    f.bundle(EXECTX, [execution, operation(OTHER, '21', AUTH, '0x11223344')], f.executionLogs);
    assert((await readRoleConfigurationOutcome(f.input)).state === 'executed', 'Missing exact configuration outcome');
  });
  for (const mode of ['failed', 'foreign terminal', 'duplicate terminal', 'validation only', 'clone']) await check('rejects ' + mode, async () => {
    const f = fixture(), op = operation(ACCOUNT, '9', HV, f.txs[TX].data, mode !== 'failed', mode === 'validation only' ? [] : f.creationLogs);
    f.bundle(TX, [op], f.creationLogs);
    if (mode === 'foreign terminal') f.receipts[TX].logs[f.receipts[TX].logs.length - 1].address = OTHER;
    if (mode === 'duplicate terminal') { const last = f.receipts[TX].logs[f.receipts[TX].logs.length - 1]; f.receipts[TX].logs.push({ ...last, logIndex: last.logIndex + 1 }); }
    if (mode === 'clone') {
      const proof = await readCanonicalTransaction({ source: f.input.rpcSource, provider: f.input.provider, transactionHash: TX, freshness: f.input.freshness });
      try { exactTransactionCall({ ...proof.data }, 100, {}); throw new Error('Unsafe clone accepted'); }
      catch (error) { assert((error as Error).message === 'CANONICAL_TRANSACTION_CHAIN_PROOF_REQUIRED', String(error)); }
    } else {
      let rejected = false;
      try { await readRoleContinuation(f.input); } catch { rejected = true; }
      assert(rejected, 'Unsafe proof accepted: ' + mode);
    }
  });
  return { cases };
}
(globalThis as any).runBundledOperationProvenanceBrowser = run;
