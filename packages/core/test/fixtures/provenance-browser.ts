import { ethers } from 'ethers';
import { getAbi } from '../../src/contracts';
import { decodeCanonicalCall } from '../../src/reads/provenance';
import { readSubjectCreationProvenance } from '../../src/governance/provenance';

// Runs unchanged in an actual browser and the retained browser-bundle regression.
// Every transport is an exact offline fixture; no provider/network is constructed.
const VOTING = '0x1111111111111111111111111111111111111111';
const AUTHORITY = '0x2222222222222222222222222222222222222222';
const ACCOUNT = '0x3333333333333333333333333333333333333333';
const TX = '0x' + 'a1'.repeat(32), HASH = '0x' + 'b2'.repeat(32), OLD = '0x' + 'c3'.repeat(32), META = '0x' + 'd4'.repeat(32);
const voting = new ethers.utils.Interface([
  'function createProposal(bytes title,bytes32 descriptionHash,uint32 minutesDuration,uint8 numOptions,(address target,uint256 value,bytes data)[][] batches,uint256[] hatIds)',
  'function createProposalV2(bytes title,bytes32 descriptionHash,uint32 minutesDuration,uint8 numOptions,(address target,uint256 value,bytes data)[][] batches,uint256[] hatIds,uint32 quorumOverride,bool equalWeight)',
  'event NewProposal(uint256 id,bytes title,bytes32 descriptionHash,uint8 numOptions,uint64 endTs,uint64 created)',
  'event NewHatProposal(uint256 id,bytes title,bytes32 descriptionHash,uint8 numOptions,uint64 endTs,uint64 created,uint256[] hatIds)',
]);
const authority = new ethers.utils.Interface(getAbi('MembershipAuthority'));
function fixture(restricted = false, v2 = false) {
  const title = ethers.utils.hexlify(ethers.utils.toUtf8Bytes('Browser historical role'));
  const hats = restricted ? ['9007199254740993'] : [];
  const action = authority.encodeFunctionData('createRole', ['Stewards', META, '', 0]);
  const args = [title, META, 10, 2, [[[AUTHORITY, 0, action]], []], hats, ...(v2 ? [0, false] : [])];
  const tx = { hash: TX, blockNumber: 50, blockHash: OLD, from: ACCOUNT, to: VOTING,
    data: voting.encodeFunctionData(v2 ? 'createProposalV2' : 'createProposal', args), value: ethers.BigNumber.from(0), chainId: 100 };
  const event = voting.encodeEventLog(voting.getEvent(restricted ? 'NewHatProposal' : 'NewProposal'), [7, title, META, 2, 1600, 1000, ...(restricted ? [hats] : [])]);
  const receipt = { status: 1, transactionHash: TX, blockNumber: 50, blockHash: OLD,
    logs: [{ ...event, address: VOTING, transactionHash: TX, blockNumber: 50, blockHash: OLD, removed: false }] };
  const scope = { chainId: 100, orgId: 'browser-org', contract: VOTING, contracts: { membershipAuthority: AUTHORITY } };
  const source = { ...scope, endpoint: 'mock://browser-index', method: 'exact-proposal', indexed: true,
    snapshot: 'pinned' as const, block: { number: '100', hash: HASH, timestamp: '1900' }, observedAt: 2000 };
  const row = { id: VOTING + '-7', proposalId: '7', title: 'Browser historical role', descriptionHash: META, numOptions: 2,
    transactionHash: TX, createdAtBlock: '50', hybridVoting: { id: VOTING, organization: { id: scope.orgId } } };
  const response = { _meta: { block: { number: 100, hash: HASH, timestamp: 1900 } },
    organization: { id: scope.orgId, membershipAuthority: { id: AUTHORITY }, hybridVoting: { id: VOTING } }, proposals: [row] };
  const provider = { getNetwork: async () => ({ chainId: 100 }), getTransaction: async () => tx,
    getTransactionReceipt: async () => receipt, getBlock: async (tag: string) => tag === '0x32'
      ? { number: 50, hash: OLD, timestamp: 1000 } : { number: 100, hash: HASH, timestamp: 1900 } };
  return { tx, receipt, input: { scope, source, rpcSource: { ...source, endpoint: 'mock://browser-rpc', indexed: false },
    proposalId: '7', query: async () => response, provider: provider as any, freshness: { now: 2000, maxAgeSeconds: 0 } } };
}
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function run() {
  const cases: { name: string; passed: boolean; error?: string; result?: unknown }[] = [];
  const check = async (name: string, work: () => unknown) => {
    try { cases.push({ name, passed: true, result: await work() }); }
    catch (e) { cases.push({ name, passed: false, error: (e as Error).message }); }
  };
  const overloaded = new ethers.utils.Interface(['function act(uint256 value)', 'function act(bytes32 value)',
    'event Act(uint256 value)', 'event Act(bytes32 value)']);
  const fn = overloaded.parseTransaction({ data: overloaded.encodeFunctionData('act(uint256)', [7]) });
  const log = overloaded.encodeEventLog(overloaded.getEvent('Act(uint256)'), [7]);
  const ev = overloaded.parseLog(log);
  // Demonstrate the actual ESM prototype difference independently for both sites.
  const diagnostics = { functionParsedFormat: typeof fn.functionFragment.format, functionOriginalFormat: typeof overloaded.getFunction(fn.signature).format,
    eventParsedFormat: typeof ev.eventFragment.format, eventOriginalFormat: typeof overloaded.getEvent(ev.signature).format,
    originalParsedFunctionError: '', originalParsedEventError: '' };
  try { overloaded.encodeFunctionData(fn.functionFragment, fn.args); } catch (e) { diagnostics.originalParsedFunctionError = (e as Error).message; }
  try { overloaded.encodeEventLog(ev.eventFragment, ev.args); } catch (e) { diagnostics.originalParsedEventError = (e as Error).message; }
  for (const signature of ['act(uint256)', 'act(bytes32)']) await check('canonical overloaded ' + signature, () => {
    const data = overloaded.encodeFunctionData(signature, [signature.includes('bytes32') ? META : 7]);
    const parsed = decodeCanonicalCall(overloaded, data);
    assert(parsed.signature === signature, 'Wrong overload');
    return parsed.signature;
  });
  for (const signature of ['Act(uint256)', 'Act(bytes32)']) await check('exact overloaded event ' + signature, () => {
    const encoded = overloaded.encodeEventLog(overloaded.getEvent(signature), [signature.includes('bytes32') ? META : 7]);
    const parsed = overloaded.parseLog(encoded), reencoded = overloaded.encodeEventLog(parsed.signature, parsed.args);
    assert(parsed.signature === signature && reencoded.data === encoded.data && reencoded.topics.join() === encoded.topics.join(), 'Wrong event overload');
  });
  for (const [restricted, v2] of [[false, false], [true, false], [true, true]]) await check(`real core canonical proof restricted=${restricted} v2=${v2}`, async () => {
    const result = await readSubjectCreationProvenance(fixture(restricted, v2).input);
    assert(result.status === 'ready', JSON.stringify(result));
    assert(result.data.createsSubject && result.data.creations.length === 1 && result.data.creations[0].kind === 'Role', 'Missing exact role proof');
    return { status: result.status, createsSubject: result.data.createsSubject };
  });
  const mutations: [string, (f: ReturnType<typeof fixture>) => void, string?][] = [
    ['trailing calldata', f => { f.tx.data += '00'; }, 'NONCANONICAL_PROVENANCE_CALLDATA'],
    ['malformed calldata', f => { f.tx.data = f.tx.data.slice(0, -2); }],
    ['trailing event data', f => { f.receipt.logs[0].data += '00'; }, 'PROPOSAL_EVENT_MISMATCH'],
    ['extra event topic', f => { f.receipt.logs[0].topics.push(META); }, 'PROPOSAL_EVENT_MISMATCH'],
    ['wrong event ID', f => { const p = voting.parseLog(f.receipt.logs[0]); Object.assign(f.receipt.logs[0], voting.encodeEventLog(p.signature, [8, ...p.args.slice(1)])); }, 'PROPOSAL_EVENT_MISMATCH'],
    ['mixed transaction log', f => { f.receipt.logs[0].transactionHash = META; }, 'RECEIPT_LOG_PROVENANCE_MISMATCH'],
    ['mixed inclusion log', f => { f.receipt.logs[0].blockHash = HASH; }, 'RECEIPT_LOG_PROVENANCE_MISMATCH'],
    ['wrong event emitter', f => { f.receipt.logs[0].address = ACCOUNT; }, 'EXACT_PROPOSAL_EVENT_REQUIRED'],
    ['duplicate exact event', f => { f.receipt.logs.push({ ...f.receipt.logs[0] }); }, 'EXACT_PROPOSAL_EVENT_REQUIRED'],
  ];
  for (const [name, mutate, code] of mutations) await check('rejects ' + name, async () => {
    const f = fixture(); mutate(f);
    const result = await readSubjectCreationProvenance(f.input);
    assert(result.status === 'blocked', 'Unsafe proof accepted');
    if (code) assert(result.codes.includes(code), JSON.stringify(result));
    return result.codes;
  });
  return { diagnostics, cases, networkCalls: 0 };
}
(globalThis as any).runProvenanceBrowserRegression = run;
