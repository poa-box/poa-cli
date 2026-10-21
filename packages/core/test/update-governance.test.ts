import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ethers } from 'ethers';
import { buildSchema, parse, validate, visit, graphql, Kind } from 'graphql';
import * as documents from '../src/graph/documents/voting';
import * as classDocuments from '../src/graph/documents/voting-classes';
import { knownFact, unknownFact, SourceRef, SourceSnapshot, Fact, requireCompleteSnapshot, PlanResult } from '../src/data/facts';
import { GOVERNANCE_LIMITS, CONFIG_CAPABILITIES, votingLaneForBatches, requireLiveGovernanceConfigKey, validateGovernanceBatches } from '../src/governance/capabilities';
import { buildGovernanceProposal, ExecutionCall } from '../src/tx/governance';
import { calculateClassRawPower, calculateOptionContribution, deriveClassEligibility, derivePersonalVotingShare, deriveWeightedTally, integerSquareRoot, PowerClass, ProposalPowerSnapshot, projectProposalPowerSnapshot, rankAllocationWeights } from '../src/governance/power';
import { planRoleConfiguration, RolePlanningInput, validateRolePlanFreshness, requirePlanningFact, planRoleCreation, planExistingRoleConfiguration, validateRoleCreationFreshness, validateExistingRolePlanFreshness } from '../src/governance/role-planning';
import { planElection, planRoleRemovals, validateRemovalPreflights, readRemovalPreflights, ElectionPlanningInput, electionPlanningFingerprint } from '../src/governance/elections';
import { buildProposalMetadata, prepareProposalMetadata, serializeProposalMetadata } from '../src/metadata/proposal';
import { parseAnnounceReceiptLogs, parseProposalReceiptOutcome, createProposalIntent, proposeConfigIntent, proposeQuorumIntent } from '../src/tx/vote';
import { readProposalArchive, readProposalDetailFacts, selectProposalClassSnapshotFacts } from '../src/reads/vote';
import { encodeIntent } from '../src/tx/intent';
import { mergeVerifiedAllowlist } from '../src/email/allowlist';
import { bytes32ToCidV0 } from '../src/encoding/cid';
import { permissionKey } from '../src/tx/authority';
import { AuthorityPermissionData } from '../src/authority/permissions';
import { ActivationMembership } from '../src/authority/activation';
import type { PopContext } from '../src/context';
import { pinJson } from '../src/ipfs';
import { resolveOrgModules } from '../src/reads/resolve';

vi.mock('../src/ipfs', async original => ({ ...await original<typeof import('../src/ipfs')>(), pinJson: vi.fn() }));
vi.mock('../src/reads/resolve', async original => ({ ...await original<typeof import('../src/reads/resolve')>(), resolveOrgModules: vi.fn() }));
const fixture = (name: string) => readFileSync(new URL(`./fixtures/core-update/governance/${name}`, import.meta.url), 'utf8');
const oracleCache = new Map<string, ethers.utils.Interface>();
const oracle = (name: string) => {
  if (!oracleCache.has(name)) {
    const abi = JSON.parse(fixture(`${name}.abi.json`));
    if (name === 'HybridVoting') abi.push(...JSON.parse(fixture('HybridVotingCore.abi.json')).filter((f: { type: string }) => f.type === 'event'));
    const unique = new Map<string, ethers.utils.Fragment>();
    for (const entry of abi) if (['event','error','function'].includes(entry.type)) {
      const fragment = ethers.utils.Fragment.from(entry);unique.set(fragment.format('full'),fragment);
    }
    oracleCache.set(name,new ethers.utils.Interface([...unique.values()]));
  }
  return oracleCache.get(name)!;
};
const AUTH = '0x0000000000000000000000000000000000000011';
const HV = '0x0000000000000000000000000000000000000022', DD = '0x0000000000000000000000000000000000000033';
const TM = '0x0000000000000000000000000000000000000044', REG = '0x0000000000000000000000000000000000000055';
const PM = '0x0000000000000000000000000000000000000066', EMAIL = '0x0000000000000000000000000000000000000077';
const EXEC = '0x0000000000000000000000000000000000000088', ASSET = '0x0000000000000000000000000000000000000099';
const A = '0x00000000000000000000000000000000000000aa', B = '0x00000000000000000000000000000000000000bb', C = '0x00000000000000000000000000000000000000cc';
const ORG = '0x' + 'ab'.repeat(32), HASH = '0x' + '11'.repeat(32), HASH2 = '0x' + '22'.repeat(32), CID = bytes32ToCidV0(HASH);
const scope = { chainId: 100, orgId: ORG, contract: AUTH };
const liveSource = (contract = AUTH, method = 'fixture-live'): SourceRef => ({ ...scope, contract, endpoint: 'fixture://rpc', method, indexed: false, snapshot: 'pinned', block: { number: '100', hash: HASH }, observedAt: 1000 });
const graphSource = (contract = HV): SourceRef => ({ ...scope, contract, endpoint: 'fixture://graph', method: 'fixture-index', indexed: true, snapshot: 'pinned', block: { number: '100', hash: HASH }, observedAt: 1000 });
const snapshot = <T>(data: T, source = liveSource()): SourceSnapshot<T> => ({ source, data, coverage: { status: 'complete', receivedKeys: [], missingIds: [], failedIds: [], issues: [] } });
const ready = <T>(result: PlanResult<T>): T => { expect(result.status, JSON.stringify(result)).toBe('ready'); if (result.status !== 'ready') throw new Error('blocked'); return result.data; };
const code = (result: PlanResult<unknown>, value: string) => { expect(result.status).toBe('blocked'); if (result.status === 'blocked') expect(result.codes).toContain(value); };
const raw = <T>(fact: Fact<T>): T => { expect(fact.state).toBe('known'); if (fact.state !== 'known') throw new Error(fact.code); return fact.value; };
const call = (value = '0'): ExecutionCall => ({ target: A, value, calldata: '0x' });
const wrap = (batches: ExecutionCall[][], lane: 'hybrid' | 'dd' = 'hybrid') => buildGovernanceProposal({ votingAddress: lane === 'hybrid' ? HV : DD,
  votingAbiName: lane === 'hybrid' ? 'HybridVotingNew' : 'DirectDemocracyVotingNew', title: 'fixture', descriptionHash: HASH,
  durationMinutes: 60, numOptions: 2, batches });

describe('contract/schema oracle integrity and governance capabilities', () => {
  it('pins portable inspected contract and ABI snapshots without research directory dependencies', () => {
    const p = JSON.parse(fixture('provenance.json'));
    for (const row of [...p.contracts, ...p.abiOracles]) expect(createHash('sha256').update(fixture(row.fixture)).digest('hex')).toBe(row.sha256);
    expect(fixture('HybridVotingCore.sol.txt')).toContain('return power * 100;');
    expect(fixture('HybridVotingCore.sol.txt')).toContain('if (!VotingMath.fitsUint128(newVal))');
    expect(fixture('MembershipAuthority.sol.txt')).toContain('if (ban) return (AccessV2Types.ActionReason.Ok, 0)');
    expect(fixture('MembershipAuthorityLogic.sol.txt')).toContain('return l.userSubjectList[user].length > 0');
    expect(createHash('sha256').update(fixture('schema.graphql')).digest('hex')).toBe(p.schema.sha256);
  });
  it('fully validates every exported voting document against independent generated serving argument positions', () => {
    const schema = buildSchema(fixture('schema.graphql'));
    const ballotSchema = buildSchema(readFileSync(new URL('./fixtures/core-update/authority/display-ballots-serving-schema.graphql', import.meta.url), 'utf8'));
    const ballotDocuments = new Set([classDocuments.FETCH_HYBRID_PROPOSAL_BALLOTS_PAGE, classDocuments.FETCH_DD_PROPOSAL_BALLOTS_PAGE]);
    for (const doc of Object.values({ ...documents, ...classDocuments })) if (typeof doc === 'string' && doc.includes('query ')) {
      expect(validate(ballotDocuments.has(doc) ? ballotSchema : schema, parse(doc))).toEqual([]);
    }
    const rootProjection = JSON.parse(fixture('organization-binding-schema.json'));
    for (const row of rootProjection.rows) expect(row.queryField.args.find((a: any) => a.name === 'block').type).toMatchObject({kind:'INPUT_OBJECT',name:'Block_height'});
    const invalid = documents.FETCH_HYBRID_PROPOSALS_PAGE.replace('$voting: String!', '$voting: ID!');
    expect(validate(schema, parse(invalid)).map(e => e.message).join()).toContain('String');
    expect(documents.FETCH_VOTING_DATA).toContain('$orgId: ID!');
    expect(documents.FETCH_VOTING_DATA).toContain('first: 50');
  });
  it.each(['poll', 'config', 'election'])('%s intent labels cannot select executing DD; empty polls retain ABI parity', () => {
    expect(votingLaneForBatches([[], []])).toBe('dd');
    expect(votingLaneForBatches([],'hybrid')).toBe('hybrid');
    expect(votingLaneForBatches([[], [call()]])).toBe('hybrid');
    expect(() => wrap([[], [call()]], 'dd')).toThrow('EXECUTING_BATCH_REQUIRES_HYBRID');
    for (const batches of [[], [[], []]]) {
      const intent = wrap(batches, 'dd');
      const expected = oracle('DirectDemocracyVoting').encodeFunctionData('createProposal', [ethers.utils.toUtf8Bytes('fixture'), HASH, 60, 2, batches, []]);
      expect(encodeIntent(intent).data).toBe(expected);
    }
  });
  it('accepts exactly 20 calls per option, rejects 21 and malformed/negative/unsafe amounts before content effects', () => {
    expect(() => wrap([Array.from({ length: 20 }, () => call('9007199254740993')), []])).not.toThrow();
    expect(() => wrap([Array.from({ length: 21 }, () => call()), []])).toThrow('TOO_MANY_CALLS');
    expect(() => validateGovernanceBatches([[call()], [call()]], 3)).toThrow('INVALID_OPTION_BATCH_COUNT');
    for (const value of ['-1', '1.1']) expect(() => validateGovernanceBatches([[call(value)]])).toThrow();
    expect(() => validateGovernanceBatches([[{ ...call(), value: 9007199254740992 }]])).toThrow();
    expect(() => validateGovernanceBatches([[{ ...call(), calldata: '0x0' }]])).toThrow();
    expect(GOVERNANCE_LIMITS.minDurationMinutes).toBe(10);
    expect(() => buildGovernanceProposal({ ...wrap([], 'dd').meta, votingAddress: DD, votingAbiName: 'DirectDemocracyVotingNew', title: 'fixture', descriptionHash: HASH, durationMinutes: 9, numOptions: 2, batches: [] })).toThrow('DURATION_OUT_OF_RANGE');
  });
  it('marks only deprecated Hybrid target allowance no-op while preserving live keys and DD retired refusal', () => {
    expect(CONFIG_CAPABILITIES.hybrid.filter(c => c.status === 'live').map(c => c.key)).toEqual([0, 2, 3]);
    expect(() => requireLiveGovernanceConfigKey('hybrid',1)).toThrow('DEPRECATED_CONFIG_NOOP');
    expect(() => requireLiveGovernanceConfigKey('dd',3)).toThrow('UNSUPPORTED_CONFIG_KEY');
    for (const key of [0, 2, 3]) expect(() => requireLiveGovernanceConfigKey('hybrid',key)).not.toThrow();
    expect(CONFIG_CAPABILITIES.hybrid.find(c => c.key === 3)?.units).toBe('voter-count');
  });
});

const powerClass = (patch: Partial<PowerClass> = {}): PowerClass => ({ strategy: 'DIRECT', slicePct: 100, quadratic: false, minBalance: '0', asset: ASSET, hatIds: [], subjectId: knownFact('0'), ...patch });
function eligibilityInput(cls = powerClass()) {
  const authorityData: AuthorityPermissionData = { subjects: [{ subjectId: '7', kind: 'Role', name:'R7' }, { subjectId: '8', kind: 'Role', name:'R8' }, { subjectId: '9', kind: 'Group', name:'G9' }],
    groupEdges: [{ id:'9-7',groupSubjectId: '9', roleSubjectId: '7', isActive: true }, { id:'9-8',groupSubjectId: '9', roleSubjectId: '8', isActive: false }], permissions: [] };
  const memberships: ActivationMembership[] = [{ subjectId: '7', isMember: knownFact(true), acceptedAt: knownFact('900'), seededWhilePaused: knownFact(false) },
    { subjectId: '8', isMember: knownFact(true), acceptedAt: knownFact('1100'), seededWhilePaused: knownFact(false) }];
  return { scope: { ...scope, contract: HV, account: A }, classIndex: 0, viewerIsExecutor: knownFact(false),
    proposal: snapshot<ProposalPowerSnapshot>({ createdAt: knownFact('1000'), restrictedSubjectIds: knownFact<readonly string[]>([]), classes: [cls] }, graphSource()),
    authority: snapshot(authorityData), memberships: snapshot(memberships, { ...liveSource(), account: A }) };
}
describe('raw voting strategy, immutable subjects, activation and exact shares', () => {
  it('normalizes frozen contract enum rows through a concrete adapter and preserves unknown immutable bindings',()=>{
    const hv=oracle('HybridVoting');const encoded=hv.encodeFunctionResult('getProposalClasses',[[[0,100,false,'0',ASSET,['8']]]]);const [rows]=hv.decodeFunctionResult('getProposalClasses',encoded);
    const classes=rows.map((r:any)=>({strategy:r.strategy,slicePct:r.slicePct,quadratic:r.quadratic,minBalance:r.minBalance.toString(),asset:r.asset,hatIds:r.hatIds.map((id:any)=>id.toString())}));
    const data={classes:knownFact(classes),proposalClassSubjects:unknownFact<readonly string[]>('IMMUTABLE_BINDINGS_UNREAD'),createdAt:knownFact('1000'),restrictedSubjectIds:knownFact<readonly string[]>([])};
    const input=eligibilityInput();input.proposal=raw(projectProposalPowerSnapshot({snapshot:snapshot(data,graphSource()),scope:{...scope,contract:HV}}));expect(input.proposal.data.classes[0].subjectId.state).toBe('unknown');expect(deriveClassEligibility(input).state).toBe('unknown');
    data.proposalClassSubjects=knownFact(['9']);input.proposal=raw(projectProposalPowerSnapshot({snapshot:snapshot(data,graphSource()),scope:{...scope,contract:HV}}));expect(raw(deriveClassEligibility(input))).toBe(true);
    data.proposalClassSubjects=knownFact([]);expect(projectProposalPowerSnapshot({snapshot:snapshot(data,graphSource()),scope:{...scope,contract:HV}}).state).toBe('unknown');
  });
  it('DIRECT is 100 independent of decimal conventions and requires no token balance', () => {
    expect(raw(calculateClassRawPower({ classConfig: knownFact(powerClass()), eligible: knownFact(true), balance: unknownFact('missing') }))).toBe('100');
  });
  it.each(['0','999999999999999999','1000000000000000000','4000000000000000000','9007199254740993'])('linear/quadratic use raw balance %s with raw 1e18 minimum', balance => {
    const linear = calculateClassRawPower({ classConfig: knownFact(powerClass({ strategy: 'ERC20_BAL', minBalance: '1000000000000000000' })), eligible: knownFact(true), balance: knownFact(balance) });
    const quadratic = calculateClassRawPower({ classConfig: knownFact(powerClass({ strategy: 'ERC20_BAL', minBalance: '1000000000000000000', quadratic: true })), eligible: knownFact(true), balance: knownFact(balance) });
    const expected: Record<string, [string,string]> = { '0': ['0','0'], '999999999999999999': ['0','0'], '1000000000000000000': ['100000000000000000000','100000000000'], '4000000000000000000': ['400000000000000000000','200000000000'], '9007199254740993': ['0','0'] };
    expect([raw(linear),raw(quadratic)]).toEqual(expected[balance]);
  });
  it('sqrt respects neighboring squares beyond Number precision; no floating sqrt and no uint256/uint128 wrapping', () => {
    const n = 9007199254740993n;
    expect([integerSquareRoot((n*n-1n).toString()),integerSquareRoot((n*n).toString()),integerSquareRoot((n*n+1n).toString())]).toEqual([(n-1n).toString(),n.toString(),n.toString()]);
    const max = (1n << 256n)-1n;
    const input = { classConfig: knownFact(powerClass({ strategy: 'ERC20_BAL' })), eligible: knownFact(true), balance: knownFact(max.toString()) };
    expect(calculateClassRawPower(input).state).toBe('unknown');
    expect(raw(calculateClassRawPower({ ...input, balance: knownFact((max/100n).toString()) }))).toBe((max/100n*100n).toString());
    expect(calculateOptionContribution(knownFact(max.toString()),100,knownFact('0')).state).toBe('unknown');
    expect(calculateOptionContribution(knownFact((1n<<128n).toString()),100,knownFact('0')).state).toBe('unknown');
    expect(raw(calculateOptionContribution(knownFact('101'),33,knownFact('0')))).toBe('33');
    expect(calculateOptionContribution(knownFact('100'),1,knownFact(((1n<<128n)-1n).toString())).state).toBe('unknown');
  });
  it('nonzero immutable subject replaces adopted hats; groups use only active edges and creation-time activation', () => {
    const input = eligibilityInput(powerClass({ subjectId: knownFact('9'), hatIds: ['8'] }));
    expect(raw(deriveClassEligibility(input))).toBe(true);
    input.memberships.data[0].acceptedAt = knownFact('1001');
    expect(raw(deriveClassEligibility(input))).toBe(false);
    input.proposal.data.classes[0].subjectId = knownFact('0');
    input.proposal.data.classes[0].hatIds = ['7'];
    input.memberships.data[0].acceptedAt = knownFact('1000');
    expect(raw(deriveClassEligibility(input))).toBe(true);
    input.proposal.data.classes[0].subjectId = unknownFact('INDEX_DOES_NOT_POPULATE_IMMUTABLE_BINDING');
    expect(deriveClassEligibility(input).state).toBe('unknown');
  });
  it('executor bypass applies class membership after poll restrictions, never bypassing restricted late joining', () => {
    const input = eligibilityInput(powerClass({ subjectId: knownFact('8') }));
    input.viewerIsExecutor = knownFact(true);
    expect(raw(deriveClassEligibility(input))).toBe(true);
    input.proposal.data.restrictedSubjectIds = knownFact(['8']);
    expect(raw(deriveClassEligibility(input))).toBe(false);
    input.memberships.data[1].acceptedAt = unknownFact('MISSING_ACTIVATION');
    expect(deriveClassEligibility(input).state).toBe('unknown');
  });
  it('unknown snapshots/balances and wrong asset/account scope remain unknown; known ineligible remains zero', () => {
    const input = eligibilityInput(); input.proposal.coverage.status = 'incomplete';
    expect(deriveClassEligibility(input).state).toBe('unknown');
    const p = { classConfig: knownFact(powerClass({strategy:'ERC20_BAL'})), eligible: knownFact(true), balance: unknownFact<string>('unread') };
    expect(calculateClassRawPower(p).state).toBe('unknown');
    expect(raw(calculateClassRawPower({ ...p, eligible: knownFact(false) }))).toBe('0');
    expect(calculateClassRawPower({ ...p, balance: knownFact('1',liveSource(ASSET)), balanceScope: { chainId:100, account:A } }).state).toBe('unknown');
  });
  it('attached wrong-chain/current-block proposal facts cannot supply activation certainty, while exact asset/account balance can',()=>{
    const input=eligibilityInput();input.proposal.data.createdAt=knownFact('1000',{...graphSource(),chainId:42161});expect(deriveClassEligibility(input).state).toBe('unknown');
    const balanceScope={chainId:100,account:A};
    expect(raw(calculateClassRawPower({classConfig:knownFact(powerClass({strategy:'ERC20_BAL'})),eligible:knownFact(true),balance:knownFact('9007199254740993',{...liveSource(ASSET),account:A}),balanceScope}))).toBe('900719925474099300');
  });
  it('retains exact rational personal shares, approximate denominators, zero-class totals and allocation/tally separation', () => {
    const input = { rawPower: knownFact('1'), totalRawPower: knownFact('3'), slicePct:50, denominatorKind:'estimate' as const };
    expect(raw(derivePersonalVotingShare(input))).toMatchObject({ percentNumerator:'50',percentDenominator:'3',approximate:true });
    expect(derivePersonalVotingShare({ ...input, totalRawPower:unknownFact('restricted-total') }).state).toBe('unknown');
    expect(derivePersonalVotingShare({ ...input, totalRawPower:knownFact('0') }).state).toBe('unknown');
    // Independent saved tally: DIRECT tie=25 each; ERC20 1000/1001 and 1/1001.
    expect(raw(deriveWeightedTally({ perOptionClassRaw:[['100','1000'],['100','1']],totalsRaw:['200','1001'],slices:[50,50] }))).toEqual(['749500','250499']);
    expect(raw(deriveWeightedTally({ perOptionClassRaw:[['0','50'],['0','50']],totalsRaw:['0','100'],slices:[50,50] }))).toEqual(['250000','250000']);
    expect(rankAllocationWeights(['1','2','2']).map(r=>[r.optionIndex,r.tied])).toEqual([[1,true],[2,true],[0,false]]);
  });
});

function roleInput(): RolePlanningInput {
  const id = (n: number) => ((17n<<64n)+BigInt(n)).toString();
  const data = { readiness:{membershipAuthority:{id:AUTH,isRouterBound:true,cutoverAt:'1'}}, executorAuthorized:knownFact(true),
    subjects:[{subjectId:id(7),kind:'Role' as const,metadataPointer:ethers.constants.HashZero,imageURI:''},{subjectId:id(8),kind:'Group' as const,metadataPointer:ethers.constants.HashZero,imageURI:''},{subjectId:id(9),kind:'Role' as const}],groupEdges:[],
    accounts:[{account:A,acceptedAnywhere:knownFact(true)},{account:B,acceptedAnywhere:knownFact(false)}],
    taskManager:{address:TM,executorAuthorized:knownFact(true)},hybrid:{address:HV,executorAuthorized:knownFact(true),classes:[{classIndex:0}]},
    registry:{address:REG,executorAuthorized:knownFact(true),currentAdminSubject:knownFact(id(7))},
    sponsorship:{address:PM,operatorAuthorized:knownFact(true),claimBudgetExists:knownFact(false)},
    email:{address:EMAIL,enabled:knownFact(true),authorityMatches:knownFact(true),minterAuthorized:knownFact(false),domainEnabled:knownFact(true),emailEnabled:knownFact(true),currentRoot:knownFact(ethers.constants.HashZero),executorAddress:EXEC} };
  const merged = mergeVerifiedAllowlist({orgId:ORG,currentRoot:ethers.constants.HashZero,entries:[{type:'domain',identifier:'example.org',hatIds:[id(10)]}]});
  return { scope:{...scope},freshness:{now:1000,maxAgeSeconds:30,block:{number:'100',hash:HASH}},context:snapshot(data,{...liveSource(),contracts:{taskManager:TM,hybridVoting:HV,registry:REG,paymaster:PM,email:EMAIL,executor:EXEC}}),allocations:snapshot([{subjectId:id(7)},{subjectId:id(8)},{subjectId:id(9)}]),proposals:snapshot([],{...graphSource(),contract:HV}),
    request:{kind:'Role',name:'Stewards',maxMembers:'1',defaultAllow:true,groupIds:[id(8)],permissions:[{key:permissionKey('poa.perm.dd.vote'),value:'1'},{key:permissionKey('poa.perm.tm.perms',1),value:'9007199254740993',projectId:'0',inheritGlobal:true}],
      vouch:{quorum:'2',voucherSubjectId:id(7)},manager:{managerSubjectId:id(9),caps:3,delaySeconds:'900'},holders:[{account:A,sticky:false},{account:B,sticky:true}],taskGrants:{creator:true,organizer:true},bindingClassIndex:0,editOrgDetails:true,
      sponsorship:{capRaw:'1000000000000001',epochSeconds:'86400',supportPasskeys:true,initializeClaimBudget:true},email:{additions:[{type:'domain',identifier:'example.org'}],preparedRoot:merged.root,cid:CID} } };
}
const abiByTarget: Record<string,string> = {[AUTH]:'MembershipAuthority',[TM]:'TaskManager',[HV]:'HybridVoting',[REG]:'OrgRegistry',[PM]:'PaymasterHub',[EMAIL]:'ZkEmailInvites',[EXEC]:'Executor'};
const decode = (calls: readonly ExecutionCall[]) => calls.map(c => oracle(abiByTarget[c.target.toLowerCase()]).parseTransaction({data:c.calldata,value:c.value}));
function configuredEmailSponsorshipInput(): RolePlanningInput {
  const input = roleInput();
  input.request = { kind: 'Role', name: 'Builders', sponsorship: { capRaw: '250000000000000000', epochSeconds: '2592000', supportPasskeys: true, includeConfiguredEmailRules: true } };
  input.context.data.email!.minterAuthorized = knownFact(true);
  input.context.data.email!.currentRoot = knownFact(HASH);
  input.context.data.sponsorship!.claimBudgetExists = knownFact(true);
  return input;
}
describe('ROLE-PLAN: configured-org email rules without role email additions', () => {
  it.each([[true, true], [true, false], [false, true]])('includes only verified enabled modes: domain=%s email=%s', (domain, email) => {
    const i = configuredEmailSponsorshipInput();
    i.context.data.email!.domainEnabled = knownFact(domain); i.context.data.email!.emailEnabled = knownFact(email);
    const result = planRoleConfiguration(i), plan = ready(result), calls = decode(plan.batch);
    expect(calls.map(c => c.name)).toEqual(['createRole', 'setBudget', 'setRulesBatch']);
    const rules = calls[2].args, indices = rules[1].map((target: string, index: number) => target.toLowerCase() === EMAIL ? index : -1).filter((index: number) => index >= 0);
    const names = [domain && 'claimRoleByDomain', email && 'claimRoleByEmail', domain && 'registerAndClaimByDomainWithPasskey', email && 'registerAndClaimByEmailWithPasskey'].filter(Boolean) as string[];
    expect(indices.map((index: number) => rules[2][index])).toEqual(names.map(name => oracle('ZkEmailInvites').getSighash(name)));
    expect(indices.map((index: number) => rules[3][index])).toEqual(names.map(() => true));
    expect(indices.map((index: number) => rules[4][index])).toEqual(names.map(name => name.startsWith('register') ? 1200000 : 800000));
    expect(rules[1]).toHaveLength(10 + names.length);
    expect(i.request.email).toBeUndefined();
    expect(result.consequences.some(c => c.code === 'ALLOWLIST_EXECUTION_RACE' || c.code === 'INITIALIZE_EMAIL_CLAIM_BUDGET')).toBe(false);
  });
  it('does not infer opt-in from module presence, while the original role-email branch retains four selectors', () => {
    const i = configuredEmailSponsorshipInput(); delete i.request.sponsorship!.includeConfiguredEmailRules;
    delete i.context.data.email;
    expect(decode(ready(planRoleConfiguration(i)).batch).find(c => c.name === 'setRulesBatch')!.args[1]).toHaveLength(10);
    const old = decode(ready(planRoleConfiguration(roleInput())).batch).find(c => c.name === 'setRulesBatch')!.args;
    const selectors = old[1].flatMap((target: string, index: number) => target.toLowerCase() === EMAIL ? [old[2][index]] : []);
    expect(selectors).toEqual(['claimRoleByDomain', 'claimRoleByEmail', 'registerAndClaimByDomainWithPasskey', 'registerAndClaimByEmailWithPasskey'].map(name => oracle('ZkEmailInvites').getSighash(name)));
  });
  it('requires explicit separate claim-budget consent and reports its consequence', () => {
    const i = configuredEmailSponsorshipInput(); i.context.data.sponsorship!.claimBudgetExists = knownFact(false);
    code(planRoleConfiguration(i), 'CLAIM_BUDGET_INITIALIZATION_REQUIRED');
    i.request.sponsorship!.initializeClaimBudget = true;
    const result = planRoleConfiguration(i), calls = decode(ready(result).batch);
    expect(calls.map(c => c.name)).toEqual(['createRole', 'setBudget', 'setRulesBatch', 'setBudget']);
    expect(calls[3].args[1]).toBe(ethers.utils.solidityKeccak256(['uint8', 'bytes32'], [5, ethers.utils.hexZeroPad(EMAIL, 32)]));
    expect(result.consequences).toContainEqual({ code: 'INITIALIZE_EMAIL_CLAIM_BUDGET', values: { email: EMAIL, capRaw: '250000000000000000', epochSeconds: '2592000' } });
    i.context.data.sponsorship!.claimBudgetExists = knownFact(true);
    expect(decode(ready(planRoleConfiguration(i)).batch).filter(c => c.name === 'setBudget')).toHaveLength(1);
  });
  const invalid: [string, (i: RolePlanningInput) => void][] = [
    ['missing module', i => { delete i.context.data.email; }],
    ['disabled module', i => { i.context.data.email!.enabled = knownFact(false); }],
    ['missing enabled', i => { i.context.data.email!.enabled = unknownFact('missing'); }],
    ['wrong authority', i => { i.context.data.email!.authorityMatches = knownFact(false); }],
    ['missing authority', i => { i.context.data.email!.authorityMatches = unknownFact('missing'); }],
    ['no minter authorization', i => { i.context.data.email!.minterAuthorized = knownFact(false); }],
    ['unknown minter', i => { i.context.data.email!.minterAuthorized = unknownFact('missing'); }],
    ['unknown domain mode', i => { i.context.data.email!.domainEnabled = unknownFact('missing'); }],
    ['unknown email mode', i => { i.context.data.email!.emailEnabled = unknownFact('missing'); }],
    ['both modes disabled', i => { i.context.data.email!.domainEnabled = knownFact(false); i.context.data.email!.emailEnabled = knownFact(false); }],
    ['zero root', i => { i.context.data.email!.currentRoot = knownFact(ethers.constants.HashZero); }],
    ['malformed root', i => { i.context.data.email!.currentRoot = knownFact('bad'); }],
    ['missing root', i => { i.context.data.email!.currentRoot = unknownFact('missing'); }],
    ['unknown claim budget', i => { i.context.data.sponsorship!.claimBudgetExists = unknownFact('missing'); }],
    ['no sponsor authorization', i => { i.context.data.sponsorship!.operatorAuthorized = knownFact(false); }],
    ['missing sponsor authorization', i => { i.context.data.sponsorship!.operatorAuthorized = unknownFact('missing'); }],
    ['unbound email module', i => { delete i.context.source.contracts!.email; }],
    ['wrong email module', i => { i.context.source.contracts!.email = B; }],
    ['wrong expected module', i => { i.scope.contracts = { email: B }; }],
    ['wrong executor', i => { i.context.source.contracts!.executor = B; }],
    ['wrong field org', i => { i.context.data.email!.enabled = knownFact(true, { ...liveSource(EMAIL), orgId: HASH2 }); }],
    ['wrong field contract', i => { i.context.data.email!.authorityMatches = knownFact(true, liveSource(B)); }],
    ['wrong field chain', i => { i.context.data.email!.domainEnabled = knownFact(true, { ...liveSource(EMAIL), chainId: 42161 }); }],
    ['wrong field block', i => { i.context.data.email!.emailEnabled = knownFact(true, { ...liveSource(EMAIL), block: { number: '99', hash: HASH2 } }); }],
    ['stale context', i => { i.context.source.observedAt = 900; }],
    ['unready authority', i => { i.context.data.readiness.membershipAuthority!.isRouterBound = false; }],
    ['missing passkey opt-in', i => { i.request.sponsorship!.supportPasskeys = false; }],
    ['malformed opt-in', i => { (i.request.sponsorship as any).includeConfiguredEmailRules = 'true'; }],
  ];
  it.each(invalid)('blocks atomically for %s', (_name, change) => {
    const i = configuredEmailSponsorshipInput(); change(i);
    const result = planRoleConfiguration(i); expect(result.status).toBe('blocked'); expect(result).not.toHaveProperty('data');
  });
  it('includes attached scoped facts and rechecks configured modes before submission', () => {
    const i = configuredEmailSponsorshipInput(), email = i.context.data.email!;
    for (const key of ['enabled', 'authorityMatches', 'domainEnabled', 'emailEnabled', 'currentRoot'] as const) {
      (email as any)[key] = knownFact((email[key] as any).value, liveSource(EMAIL));
    }
    email.minterAuthorized = knownFact(true, liveSource(EXEC));
    i.context.data.sponsorship!.operatorAuthorized = knownFact(true, liveSource(PM));
    i.context.data.sponsorship!.claimBudgetExists = knownFact(true, liveSource(PM));
    const plan = ready(planRoleConfiguration(i)); expect(validateRolePlanFreshness(plan, i).status).toBe('ready');
    email.emailEnabled = knownFact(false, liveSource(EMAIL)); code(validateRolePlanFreshness(plan, i), 'STALE_ROLE_PLAN');
  });
});
describe('ordered compound role/group configuration', () => {
  it('golden role preserves authority/composition/permission/vouch/manager/holders -> TM -> class -> admin -> sponsor -> email order', () => {
    const plan=ready(planRoleConfiguration(roleInput())),decoded=decode(plan.batch);
    expect(plan.subjectId).toBe('313594649253062377482');
    expect(decoded.map(d=>d.name)).toEqual(['createRole','setSubjectDefault','addRoleToGroup','setPerm','setPerm','configureVouchAttestor','setManagerConfig','grant','offer','setConfig','setConfig','addHatToClass','setOrgMetadataAdminHat','setBudget','setRulesBatch','setBudget','setHatMinterAuthorization','setActiveAllowlist']);
    expect(decoded[7].args[2]).toBe(true);expect(decoded[8].args[2]).toBe(false);
    expect(decoded[9].args[0]).toBe(1);expect(decoded[10].args[0]).toBe(7);
    expect(ethers.utils.defaultAbiCoder.decode(['uint256','bool'],decoded[9].args[1])[0].toString()).toBe(plan.subjectId);
    expect(decoded[4].args[2]).toBe(ethers.utils.hexZeroPad('0x01',32));
    const word=BigInt(decoded[4].args[3].toString());expect(word & ((1n<<254n)-1n)).toBe(9007199254740993n);
    expect(decoded[13].args[1]).toBe(ethers.utils.solidityKeccak256(['uint8','bytes32'],[1,ethers.utils.hexZeroPad(ethers.BigNumber.from(plan.subjectId).toHexString(),32)]));
    expect(decoded[13].args[2].toString()).toBe('1000000000000001');
    expect(plan.createsSubject).toBe(true);
  });
  it('group manager follows group create/composition/permissions, before live TM grants', () => {
    const i=roleInput();i.request={kind:'Group',name:'Council',memberRoleIds:[i.context.data.subjects[0].subjectId],permissions:[{key:permissionKey('poa.perm.dd.vote'),value:'1'}],manager:{managerSubjectId:i.context.data.subjects[2].subjectId,caps:3,delaySeconds:'0'},taskGrants:{creator:true,organizer:false}};
    expect(decode(ready(planRoleConfiguration(i)).batch).map(d=>d.name)).toEqual(['createGroup','setPerm','setManagerConfig','setConfig']);
    i.request.manager!.managerSubjectId=i.request.memberRoleIds![0];code(planRoleConfiguration(i),'SELF_MANAGED_GROUP_CYCLE');
    i.request.holders=[{account:A,sticky:false}];code(planRoleConfiguration(i),'GROUP_HAS_ROLE_ONLY_REQUESTS');
  });
  it.each(['taskManager','hybrid','registry','sponsorship','email'] as const)('missing requested %s context refuses the whole plan', key => {
    const i=roleInput();delete i.context.data[key];expect(planRoleConfiguration(i).status).toBe('blocked');
  });
  it('unread admin/minter/operator/allowlist/holder facts never silently omit requested grants', () => {
    const cases: ((i:RolePlanningInput)=>void)[]=[i=>{i.context.data.registry!.currentAdminSubject=unknownFact('unread');},i=>{i.context.data.email!.minterAuthorized=unknownFact('unread');},i=>{i.context.data.email!.currentRoot=unknownFact('unread');},i=>{i.context.data.sponsorship!.operatorAuthorized=unknownFact('unread');},i=>{i.context.data.accounts[0].acceptedAnywhere=unknownFact('unread');},i=>{i.context.data.sponsorship!.claimBudgetExists=unknownFact('unread');}];
    for(const change of cases){const i=roleInput();change(i);expect(planRoleConfiguration(i).status).toBe('blocked');}
    const i=roleInput();i.context.data.email!.currentRoot=knownFact(HASH);expect(planRoleConfiguration(i).status).toBe('blocked');
  });
  it('20/21 compound calls, invalid/duplicate holders, stale allocation/proposal evidence and changed plan are explicit refusals', () => {
    const i=roleInput();for(let j=0;j<2;j++)i.request.permissions=[...i.request.permissions!,{key:permissionKey('extra'+j),value:'1'}];
    expect(ready(planRoleConfiguration(i)).batch).toHaveLength(20);
    i.request.permissions=[...i.request.permissions!,{key:permissionKey('extra2'),value:'1'}];code(planRoleConfiguration(i),'TOO_MANY_CALLS');
    const duplicate=roleInput();duplicate.request.holders=[...duplicate.request.holders!,duplicate.request.holders![0]];code(planRoleConfiguration(duplicate),'INVALID_OR_DUPLICATE_HOLDER');
    const current=roleInput(),plan=ready(planRoleConfiguration(current));current.context.data.registry!.currentAdminSubject=knownFact('8');code(validateRolePlanFreshness(plan,current),'STALE_ROLE_PLAN');
    const stale=roleInput();stale.context.source.observedAt=900;code(planRoleConfiguration(stale),'LIVE_EVIDENCE_STALE');
    stale.context.source.observedAt=1000;stale.allocations.coverage.status='incomplete';code(planRoleConfiguration(stale),'INCOMPLETE_SNAPSHOT');
    const racing=roleInput();racing.proposals.data=[{id:'another',createsSubject:true,executed:false}];code(planRoleConfiguration(racing),'COMPETING_SUBJECT_CREATION');
    const unknown=roleInput();unknown.proposals.data=[{id:'unpopulated'}];code(planRoleConfiguration(unknown),'PROPOSAL_HISTORY_UNAVAILABLE');
  });
  it('known disabled branches are omitted intentionally; enabled branches require matching module/account scope and allocation state',()=>{
    const minimal=roleInput();minimal.request={kind:'Role',name:'Minimal'};delete minimal.context.data.email;delete minimal.context.data.sponsorship;
    expect(decode(ready(planRoleConfiguration(minimal)).batch).map(d=>d.name)).toEqual(['createRole']);
    const mismatch=roleInput();mismatch.context.source.contracts={...mismatch.context.source.contracts,taskManager:B};code(planRoleConfiguration(mismatch),'SCOPE_MISMATCH');
    const scoped=roleInput();scoped.context.data.taskManager!.executorAuthorized=knownFact(true,liveSource(TM));expect(planRoleConfiguration(scoped).status).toBe('ready');
    scoped.context.data.accounts[0].acceptedAnywhere=knownFact(true,{...liveSource(),account:B});code(planRoleConfiguration(scoped),'SCOPE_MISMATCH');
    const moved=roleInput();moved.context.data.subjects[0].subjectId='313594649253062377473';code(planRoleConfiguration(moved),'ALLOCATION_CONTEXT_CHANGED');
    const malformed=roleInput();(malformed.request as unknown as {editOrgDetails:string}).editOrgDetails='false';code(planRoleConfiguration(malformed),'INVALID_ROLE_BOOLEAN');
  });
  it('private verified email leaves are retained by deterministic role additions and stale prepared roots refuse',()=>{
    const i=roleInput();const current=mergeVerifiedAllowlist({orgId:ORG,currentRoot:ethers.constants.HashZero,entries:[{type:'email',identifier:'private@example.org',hatIds:[i.context.data.subjects[0].subjectId]}]});
    i.context.data.email!.currentRoot=knownFact(current.root);i.request.email!.current=current.verified;
    const prepared=mergeVerifiedAllowlist({orgId:ORG,currentRoot:current.root,current:current.verified,entries:[{type:'domain',identifier:'example.org',hatIds:['313594649253062377482']}]});i.request.email!.preparedRoot=prepared.root;
    const plan=ready(planRoleConfiguration(i));expect(decode(plan.batch).at(-1)!.args[0]).toBe(prepared.root);
    expect(prepared.doc.entries.find(e=>e.type==='email')!.identifier).toBe('');expect(prepared.verified.leaves.find(e=>e.type==='email')!.id).toBe(current.verified.leaves[0].id);
    i.request.email!.preparedRoot=HASH;code(planRoleConfiguration(i),'PREPARED_ALLOWLIST_CHANGED');
  });
});

function electionInput(): ElectionPlanningInput {
  const status=(account:string,accepted:boolean,eligible=accepted)=>({account,accepted,eligible,acceptedAt:accepted?'900':'0',ruleKind:accepted?1:0});
  return {scope:{...scope},freshness:{now:1000,maxAgeSeconds:30,block:{number:'100',hash:HASH}},subjectId:'7',candidates:[A,B],includeNoOneOption:true,stickyWinner:true,
    removals:[{account:A,ban:false,expectedReason:0,expectedSourceSet:0}],confirmedBans:[],
    preflights:snapshot([{subjectId:'7',account:A,ban:false,reason:0,sourceSet:0}],liveSource(AUTH,'canRemove(false)')),
    context:snapshot({readiness:{membershipAuthority:{id:AUTH,isRouterBound:true,cutoverAt:'1'}},executorAuthorized:knownFact(true),paused:knownFact(false),
      subjects:[{subjectId:'7',kind:'Role',maxMembers:'1',memberCount:'1',statuses:[status(A,true,false),status(B,false)],rulesRevision:'r1'},
        {subjectId:'8',kind:'Role',maxMembers:'2',memberCount:'0',statuses:[status(A,false),status(B,false)],rulesRevision:'r1'}],
      accounts:[{account:A,acceptedAnywhere:knownFact(true),acceptedSubjectIds:knownFact(['7'])},{account:B,acceptedAnywhere:knownFact(false),acceptedSubjectIds:knownFact([])}]})};
}
describe('election review fingerprint observation independence', () => {
  it('accepts fresh identical protocol values but rejects changed values, foreign scope and stale evidence', () => {
    const input = electionInput();
    input.context.data.executorAuthorized = knownFact(true, liveSource());
    input.context.data.accounts[0].acceptedAnywhere = knownFact(true, { ...liveSource(), account: A });
    const fingerprint = electionPlanningFingerprint(input.context.data, input.preflights.data);
    const next = structuredClone(input);
    const block = { number: '101', hash: HASH2 };
    next.freshness = { now: 1002, maxAgeSeconds: 30, block };
    next.context.source = { ...next.context.source, block, observedAt: 1002 };
    next.preflights.source = { ...next.preflights.source, block, observedAt: 1002 };
    next.context.data.executorAuthorized = knownFact(true, { ...liveSource(), block, observedAt: 1002 });
    next.context.data.accounts[0].acceptedAnywhere = knownFact(true, { ...liveSource(), account: A, block, observedAt: 1002 });
    next.expectedFingerprint = fingerprint;
    expect(electionPlanningFingerprint(next.context.data, next.preflights.data)).toBe(fingerprint);
    expect(planElection(next).status).toBe('ready');
    const changed = structuredClone(next);
    changed.context.data.subjects[0].rulesRevision = 'changed';
    code(planElection(changed), 'STALE_ELECTION_PLAN');
    const foreign = structuredClone(next);
    foreign.context.data.executorAuthorized = knownFact(true, { ...liveSource(HV), block, observedAt: 1002 });
    expect(planElection(foreign).status).toBe('blocked');
    code(planElection({ ...next, freshness: { ...next.freshness, now: 2000 } }), 'LIVE_EVIDENCE_STALE');
  });
});
describe('staged role/group creation without irrelevant history', () => {
  it.each(['creation', 'configuration'])('accepts the same %s values at a fresh attributed block while still rejecting changed values and invalid evidence', mode => {
    const input = roleInput();
    const subjectId = input.context.data.subjects[1].subjectId;
    Object.assign(input.context.data.subjects[1], { metadataPointer: ethers.constants.HashZero, imageURI: '' });
    input.context.data.indexedAuthoritySource = graphSource(AUTH);
    input.context.data.executorAuthorized = knownFact(true, liveSource());
    const request = { kind: 'Group' as const, name: 'Unchanged reviewed group' };
    const current = { scope: input.scope, freshness: input.freshness, context: input.context, request, subjectId };
    const planner = mode === 'creation' ? planRoleCreation : planExistingRoleConfiguration;
    const validate = mode === 'creation' ? validateRoleCreationFreshness : validateExistingRolePlanFreshness;
    const plan = ready(planner(current));
    const next = structuredClone(current);
    const block = { number: '101', hash: HASH2 };
    next.freshness = { ...next.freshness, now: 1002, block };
    next.context.source = { ...next.context.source, observedAt: 1002, block };
    next.context.data.indexedAuthoritySource = { ...next.context.data.indexedAuthoritySource!, observedAt: 1002, block };
    next.context.data.executorAuthorized = knownFact(true, { ...liveSource(), observedAt: 1002, block });
    expect(ready(validate(plan, next)).fingerprint).toBe(plan.fingerprint);
    code(validate(plan, { ...next, request: { ...request, name: 'Changed reviewed name' } }), 'STALE_ROLE_PLAN');
    code(validate(plan, { ...next, freshness: { ...next.freshness, now: 2000 } }), 'LIVE_EVIDENCE_STALE');
    const wrongSource = structuredClone(next);
    wrongSource.context.data.indexedAuthoritySource!.block = { number: '100', hash: HASH };
    expect(validate(plan, wrongSource).status).toBe('blocked');
    const wrongFact = structuredClone(next);
    wrongFact.context.data.executorAuthorized = knownFact(true, { ...liveSource(HV), observedAt: 1002, block });
    expect(validate(plan, wrongFact).status).toBe('blocked');
    const changedFact = structuredClone(next);
    changedFact.context.data.executorAuthorized = knownFact(false, { ...liveSource(), observedAt: 1002, block });
    code(validate(plan, changedFact), 'EXECUTOR_AUTHORIZATION_REQUIRED');
  });

  it('creates one subject with no predicted ID, allocation enumeration or proposal history', () => {
    const { scope, freshness, context } = roleInput();
    const result = ready(planRoleCreation({ scope, freshness, context, request: { kind: 'Role', name: 'New role', maxMembers: '2' } }));
    expect(result).not.toHaveProperty('subjectId');
    expect(decode(result.batch).map(d => d.name)).toEqual(['createRole']);
    const legacy = roleInput(); legacy.request = { kind: 'Role', name: 'Single create' };
    legacy.proposals.coverage.status = 'unavailable'; legacy.proposals.data = [{ id: 'unresolved' }, { id: 'known-creation', createsSubject: true }];
    expect(planRoleConfiguration(legacy).status).toBe('ready');
    // Dependent calls still require complete semantics, including an unknown competitor.
    legacy.request.defaultAllow = true;
    code(planRoleConfiguration(legacy), 'INCOMPLETE_SNAPSHOT');
    legacy.proposals.coverage.status = 'complete';
    code(planRoleConfiguration(legacy), 'PROPOSAL_HISTORY_UNAVAILABLE');
  });
  it('creates a group with existing members atomically, but never discards dependent configuration', () => {
    const { scope, freshness, context } = roleInput();
    const request = { kind: 'Group' as const, name: 'New team', memberRoleIds: [context.data.subjects[0].subjectId] };
    const plan = ready(planRoleCreation({ scope, freshness, context, request }));
    const decoded = decode(plan.batch)[0]; expect(decoded.name).toBe('createGroup');
    expect(decoded.args[3].map(String)).toEqual(request.memberRoleIds);
    code(planRoleCreation({ scope, freshness, context, request: { ...request, permissions: [{ key: HASH, value: '1' }] } as any }), 'CREATION_HAS_DEPENDENT_CONFIGURATION');
  });
  it('configures the observed allocated role, grants existing members and offers newcomers without history', () => {
    const input = roleInput();
    // Model the first stage having executed: the authority chose sequence 10.
    // An unrelated creation may already have consumed sequence 11; neither shifts this ID.
    const subjectId = '313594649253062377482';
    input.context.data.subjects = [...input.context.data.subjects, { subjectId, kind: 'Role', maxMembers: '1', memberCount: '0', metadataPointer: ethers.constants.HashZero, imageURI: '' } as any,
      { subjectId: '313594649253062377483', kind: 'Role' }];
    const existing = { scope: input.scope, freshness: input.freshness, context: input.context, subjectId, request: input.request };
    const plan = ready(planExistingRoleConfiguration(existing));
    expect(plan).toMatchObject({ subjectId, createsSubject: false });
    const decoded = decode(plan.batch);
    expect(decoded.map(d => d.name)).toEqual(['renameSubject','setMaxMembers','setSubjectDefault','addRoleToGroup','setPerm','setPerm','configureVouchAttestor','setManagerConfig','grant','offer','setConfig','setConfig','addHatToClass','setOrgMetadataAdminHat','setBudget','setRulesBatch','setBudget','setHatMinterAuthorization','setActiveAllowlist']);
    for (const name of ['grant', 'offer', 'setPerm', 'setManagerConfig']) expect(decoded.find(d => d.name === name)!.args[0].toString()).toBe(subjectId);
    expect(decoded.find(d => d.name === 'setManagerConfig')!.args[1].toString()).toBe(input.request.manager!.managerSubjectId);
    expect(decoded.find(d => d.name === 'grant')!.args[2]).toBe(true);
    expect(decoded.find(d => d.name === 'offer')!.args[2]).toBe(false);
    input.context.data.accounts[0].acceptedAnywhere = knownFact(false);
    code(validateExistingRolePlanFreshness(plan, existing), 'STALE_ROLE_PLAN');
  });
  it('requires live exact allocated kind/capacity and does not configure a prediction', () => {
    const input = roleInput(), subjectId = input.context.data.subjects[0].subjectId;
    const existing = { scope: input.scope, freshness: input.freshness, context: input.context, subjectId,
      request: { kind: 'Role' as const, name: 'Observed role', holders: [{ account: A, sticky: false }] } };
    code(planExistingRoleConfiguration({ ...existing, subjectId: '313594649253062377482' }), 'EXISTING_SUBJECT_UNAVAILABLE');
    code(planExistingRoleConfiguration({ ...existing, request: { kind: 'Group', name: 'Wrong kind' } }), 'EXISTING_SUBJECT_UNAVAILABLE');
    code(planExistingRoleConfiguration(existing), 'EXISTING_CAPACITY_UNAVAILABLE');
    Object.assign(input.context.data.subjects[0], { maxMembers: '1', memberCount: '1' });
    code(planExistingRoleConfiguration(existing), 'SUBJECT_CAPACITY_EXCEEDED');
    input.context.source.observedAt = 900;
    code(planExistingRoleConfiguration(existing), 'LIVE_EVIDENCE_STALE');
  });
  it('revalidates creation facts and existing group composition without duplicate links', () => {
    const input = roleInput(), subjectId = input.context.data.subjects[1].subjectId, role = input.context.data.subjects[0].subjectId;
    input.context.data.groupEdges = [{ roleSubjectId: role, groupSubjectId: subjectId, isActive: true }];
    const existing = { scope: input.scope, freshness: input.freshness, context: input.context, subjectId,
      request: { kind: 'Group' as const, name: 'Observed group', memberRoleIds: [role], permissions: [{ key: HASH, value: '1' }] } };
    expect(decode(ready(planExistingRoleConfiguration(existing)).batch).map(d => d.name)).toEqual(['renameSubject','setPerm']);
    const create = { scope: input.scope, freshness: input.freshness, context: input.context, request: { kind: 'Role' as const, name: 'New' } };
    const plan = ready(planRoleCreation(create));
    create.context.data.executorAuthorized = knownFact(false);
    code(validateRoleCreationFreshness(plan, create), 'EXECUTOR_AUTHORIZATION_REQUIRED');
  });
});

describe('election and role removal safety', () => {
  it('injected preflight observer calls non-banning canRemove and fresh getStatus at exact scope; partial failures and changed status block',async()=>{
    const i=electionInput(),source=liveSource(AUTH,'removal-preflight');
    const canRemove=vi.fn(async(request:{account:string;ban:false;source:SourceRef})=>{
      expect(request.ban).toBe(false);expect(request.source.block).toEqual({number:'100',hash:HASH});return snapshot({reason:0,sourceSet:0},{...source,method:'canRemove',account:request.account});
    });
    const getStatus=vi.fn(async(request:{account:string})=>snapshot({accepted:true,eligible:false,acceptedAt:'900',ruleKind:1},{...source,method:'getStatus',account:request.account}));
    i.preflights=await readRemovalPreflights({source,subjectId:'7',accounts:[A],reader:{canRemove,getStatus}});expect(canRemove).toHaveBeenCalledTimes(1);expect(getStatus).toHaveBeenCalledTimes(1);expect(planElection(i).status).toBe('ready');
    i.preflights.data[0].status!.acceptedAt='901';code(planElection(i),'REMOVAL_STATUS_CHANGED');
    const partial=await readRemovalPreflights({source,subjectId:'7',accounts:[A,C],reader:{canRemove,getStatus:async request=>{if(request.account===C)throw new Error('mock RPC failure');return getStatus(request);}}});expect(partial.coverage.status).toBe('incomplete');expect(partial.coverage.failedIds).toEqual([C]);expect(partial.data).toHaveLength(1);expect(()=>requireCompleteSnapshot(partial)).toThrow();
    const wrong=await readRemovalPreflights({source,subjectId:'7',accounts:[A],reader:{canRemove,getStatus:async()=>snapshot({accepted:true,eligible:false,acceptedAt:'900',ruleKind:1},{...source,account:B})}});expect(wrong.coverage.status).toBe('unavailable');
  });
  it('maxMembers=1 removes losers before outsider offers; accepted-ineligible incumbent is no-op and No One empty', () => {
    const batches=ready(planElection(electionInput()));expect(batches[0]).toEqual([]);expect(batches[2]).toEqual([]);
    const d=decode(batches[1]);expect(d.map(x=>x.name)).toEqual(['remove','offer']);expect(d[0].args[1].toLowerCase()).toBe(A);expect(d[1].args[2]).toBe(false);
  });
  it('accepted anywhere grants the sticky winner; fallback offers follow removals, remain delegable and precede winner', () => {
    const i=electionInput();i.fallbackSubjectId='8';i.context.data.accounts[1].acceptedAnywhere=knownFact(true);i.context.data.accounts[1].acceptedSubjectIds=knownFact(['9']);
    const d=decode(ready(planElection(i))[1]);expect(d.map(x=>x.name)).toEqual(['remove','offer','grant']);
    expect(d[1].args[0].toString()).toBe('8');expect(d[1].args[2]).toBe(true);expect(d[2].args[2]).toBe(false);
  });
  it('fallback grant uses surviving acceptance elsewhere; already accepted but ineligible fallback holder gets no grant', () => {
    const i=electionInput();i.fallbackSubjectId='8';i.context.data.accounts[0].acceptedSubjectIds=knownFact(['7','9']);
    expect(decode(ready(planElection(i))[1]).map(x=>x.name)).toEqual(['remove','grant','offer']);
    i.context.data.subjects[1].statuses[0].accepted=true;i.context.data.subjects[1].statuses[0].eligible=false;i.context.data.subjects[1].memberCount='1';
    expect(decode(ready(planElection(i))[1]).map(x=>x.name)).toEqual(['remove','offer']);
  });
  it('canRemove(false) requiring ban produces exact consequences and never infers consent', () => {
    const i=electionInput();i.preflights.data[0].reason=7;i.preflights.data[0].sourceSet=5;i.removals=[{account:A,ban:false,expectedReason:7,expectedSourceSet:5}];
    const refused=validateRemovalPreflights(i);code(refused,'BAN_REQUIRED');expect(refused.consequences[0]).toMatchObject({code:'DURABLE_GOVERNANCE_BAN',values:{account:A,subjectId:'7',sourceSet:'5',preventsReclaim:true}});
    i.removals[0].ban=true;code(planRoleRemovals(i),'EXACT_BAN_CONSENT_REQUIRED');
    i.confirmedBans=[{subjectId:'7',account:A,reason:7,sourceSet:5}];expect(decode(ready(planRoleRemovals(i))[0])[0].args[2]).toBe(true);
    i.preflights.data[0].reason=0;i.preflights.data[0].sourceSet=0;code(planRoleRemovals(i),'REMOVAL_REASON_CHANGED');
    i.removals[0].expectedReason=0;i.removals[0].expectedSourceSet=0;code(planRoleRemovals(i),'BAN_NO_LONGER_REQUIRED');
  });
  it('changed roster/reason/source set/rules/capacity/acceptedAt and missing/incorrect preflight evidence block stale plans', () => {
    for(const change of [ (i:ElectionPlanningInput)=>{i.context.data.subjects[0].rulesRevision='r2';},(i:ElectionPlanningInput)=>{i.context.data.subjects[0].statuses[0].acceptedAt='901';},(i:ElectionPlanningInput)=>{i.context.data.subjects[0].maxMembers='2';}]){
      const i=electionInput();i.expectedFingerprint=electionPlanningFingerprint(i.context.data,i.preflights.data);change(i);code(planElection(i),'STALE_ELECTION_PLAN');
    }
    const missing=electionInput();missing.preflights.coverage.status='incomplete';code(planElection(missing),'INCOMPLETE_SNAPSHOT');
    const changed=electionInput();changed.preflights.data[0].sourceSet=1;code(planElection(changed),'REMOVAL_REASON_CHANGED');
    const banned=electionInput();(banned.preflights.data[0] as {ban:boolean}).ban=true;code(planElection(banned),'INVALID_REMOVAL_PREFLIGHT');
    const mismatch=electionInput();mismatch.preflights.source.block={number:'101',hash:HASH2};code(planElection(mismatch),'BLOCK_MISMATCH');
    const roster=electionInput();roster.context.data.subjects[0].statuses[0].accepted=false;roster.context.data.subjects[0].memberCount='0';code(planElection(roster),'REMOVAL_ROSTER_CHANGED');
  });
  it('malformed, duplicate, stale candidate/status/fallback and capacity inputs do not silently shrink a requested election', () => {
    const duplicate=electionInput();duplicate.candidates=[A,A];code(planElection(duplicate),'DUPLICATE_ELECTION_CANDIDATE');
    const malformed=electionInput();malformed.candidates=['bad'];code(planElection(malformed),'INVALID_ELECTION_ACCOUNT');
    const absent=electionInput();absent.candidates=[C];code(planElection(absent),'GET_STATUS_UNAVAILABLE');
    const fallback=electionInput();fallback.fallbackSubjectId='7';code(planElection(fallback),'INVALID_FALLBACK_SUBJECT');
    const full=electionInput();full.removals=[];full.context.data.accounts[1].acceptedAnywhere=knownFact(true);code(planElection(full),'ELECTION_CAPACITY_EXCEEDED');
    const incomplete=electionInput();incomplete.context.data.subjects[0].memberCount='2';code(planElection(incomplete),'INCOMPLETE_ACCEPTED_ROSTER');
    const choice=electionInput();(choice as unknown as {includeNoOneOption:string}).includeNoOneOption='false';code(planElection(choice),'INVALID_ELECTION_REQUEST');
  });
  it('standalone removal and election batches honor exact 20/21 ceilings without dropping selected people',()=>{
    const i=electionInput();i.candidates=[B];i.context.data.subjects[0].maxMembers='0';
    const accounts=Array.from({length:20},(_,n)=>'0x'+(1000+n).toString(16).padStart(40,'0'));
    i.context.data.subjects[0].statuses=accounts.map(account=>({account,accepted:true,eligible:true,acceptedAt:'900',ruleKind:1})).concat([{account:B,accepted:false,eligible:false,acceptedAt:'0',ruleKind:0}]);i.context.data.subjects[0].memberCount='20';
    i.removals=accounts.map(account=>({account,ban:false,expectedReason:0,expectedSourceSet:0}));i.preflights.data=accounts.map(account=>({subjectId:'7',account,ban:false,reason:0,sourceSet:0}));
    expect(ready(planRoleRemovals(i))[0]).toHaveLength(20);code(planElection(i),'TOO_MANY_CALLS');
    const extra='0x'+(1021).toString(16).padStart(40,'0');i.context.data.subjects[0].statuses=[...i.context.data.subjects[0].statuses,{account:extra,accepted:true,eligible:true,acceptedAt:'900',ruleKind:1}];i.context.data.subjects[0].memberCount='21';i.removals=[...i.removals,{account:extra,ban:false,expectedReason:0,expectedSourceSet:0}];i.preflights.data=[...i.preflights.data,{subjectId:'7',account:extra,ban:false,reason:0,sourceSet:0}];code(planRoleRemovals(i),'TOO_MANY_CALLS');
  });
  it('wrong-chain, stale, paused, absent status and missing post-removal acceptance cannot become empty successful plans',()=>{
    for(const change of [(i:ElectionPlanningInput)=>{i.context.source.chainId=42161;},(i:ElectionPlanningInput)=>{i.context.source.observedAt=900;},(i:ElectionPlanningInput)=>{i.context.data.paused=knownFact(true);},(i:ElectionPlanningInput)=>{i.context.data.accounts[1].acceptedAnywhere=unknownFact('missing');}]){const i=electionInput();change(i);expect(planElection(i).status).toBe('blocked');}
    const i=electionInput();i.fallbackSubjectId='8';i.context.data.accounts[0].acceptedSubjectIds=unknownFact('missing');code(planElection(i),'POST_REMOVAL_ACCEPTANCE_UNPROVEN');
    const historical=electionInput();historical.freshness.block={number:'101',hash:HASH2};code(planElection(historical),'BLOCK_MISMATCH');
  });
});

const installedBinding={id:ORG,hybridVoting:{id:HV},directDemocracyVoting:{id:DD}};
const blockProof={organization:installedBinding,_meta:{block:{number:100,hash:HASH,timestamp:null}}};
function proposalRow(lane:'hybrid'|'dd',id:string,patch:Record<string,unknown>={}) {
  const contract=lane==='hybrid'?HV:DD;
  return {id:`${contract}-${id}`,proposalId:id,title:'saved',createdAtBlock:'90',status:'Ended',classesVersion:'90',isHatRestricted:false,
    metadata:{id:HASH,description:'saved',optionNames:['Yes','No'],createdAt:'1234567890000',actionSummaries:['Create the role “Stewards”'],promotedFrom:'old-dd-3'},
    [lane==='hybrid'?'hybridVoting':'directDemocracyVoting']:{id:contract,organization:{id:ORG}},...patch};
}
const classChange=(id='emission-1')=>({id,version:'90',numClasses:1,hybridVoting:{id:HV,organization:{id:ORG}},
  votingClasses:[{id:id+'-0',change:{id},version:'90',classIndex:0,strategy:'DIRECT',slicePct:100,quadratic:false,minBalance:'0',asset:ASSET,hatIds:['7'],isActive:false}]});
describe('independent cursor archives, composite details and exact emission evidence',()=>{
  it.each(['hybrid','dd'] as const)('reads 51 %s proposals plus uint256 IDs without numeric loss, retaining markers and old detail',async lane=>{
    const rows=Array.from({length:51},(_,i)=>proposalRow(lane,String(i+1))).concat([proposalRow(lane,'9007199254740993')]).sort((a,b)=>a.id.localeCompare(b.id));
    const cursors:string[]=[];const source=graphSource(lane==='hybrid'?HV:DD);
    const result=await readProposalArchive({source,lane,pageSize:20,maxPages:10,query:async(_doc,v,s)=>{expect(s).toBe(source);expect(v.block).toEqual({hash:HASH});expect(v.voting).toBe(source.contract);cursors.push(String(v.cursor));return{...blockProof,[lane==='hybrid'?'proposals':'ddvproposals']:rows.filter(r=>r.id>String(v.cursor)).slice(0,Number(v.first))};}});
    expect(result.coverage.status).toBe('complete');expect(result.data).toHaveLength(52);expect(cursors).toHaveLength(3);
    expect(result.data.some(r=>r.proposalId==='9007199254740993')).toBe(true);
    const detail=await readProposalDetailFacts({source,lane,compositeId:rows.at(-1)!.id,query:async(_doc,v)=>{expect(v.compositeId).toBe(rows.at(-1)!.id);return{...blockProof,proposals:lane==='hybrid'?[rows.at(-1)!]:[],ddvproposals:lane==='dd'?[rows.at(-1)!]:[]};}});
    expect(raw(detail.data.proposal)?.proposalId).toBe(rows.at(-1)!.proposalId);expect(raw(detail.data.actionSummaries)).toEqual(['Create the role “Stewards”']);expect(raw(detail.data.promotedFrom)).toBe('old-dd-3');expect(raw(detail.data.createdAtBlock)).toBe('90');
  });
  it('uses only serving-compatible root filters and executes full documents on generated schema fixture',async()=>{
    const schema=buildSchema(fixture('schema.graphql'));const first=proposalRow('dd','1',{descriptionHash:HASH,numOptions:2,startTimestamp:'900',endTimestamp:'1000',winningOption:'0',isValid:false,executionFailed:false,executionError:null,restrictedHatIds:[],proposer:A,proposerUsername:null,transactionHash:HASH});
    const result=await graphql({schema,source:documents.FETCH_DD_PROPOSALS_PAGE,variableValues:{orgId:ORG,voting:DD,cursor:'',first:10,block:{hash:HASH}},rootValue:{organization:(args:any)=>{expect(args.id).toBe(ORG);expect(args.block).toEqual({hash:HASH});return installedBinding;},ddvproposals:(args:any)=>{expect(args.where).toEqual({directDemocracyVoting:DD,id_gt:''});expect(args.orderBy).toBe('id');expect(Object.keys(args.where).some(k=>k.endsWith('_'))).toBe(false);return[first];},_meta:()=>blockProof._meta}});
    expect(result.errors,JSON.stringify(result.errors)).toBeUndefined();expect((result.data?.ddvproposals as any[])[0].winningOption).toBe('0');
    for(const doc of [documents.FETCH_HYBRID_PROPOSALS_PAGE,documents.FETCH_DD_PROPOSALS_PAGE,documents.FETCH_PROPOSAL_DETAIL])visit(parse(doc),{Argument(n){if(n.name.value==='where')expect(JSON.stringify(n.value)).not.toContain('hybridVoting_');}});
  });
  it('caps, failed/missing/duplicate pages and wrong org/lane/provenance are incomplete or unavailable, never empty success',async()=>{
    const source=graphSource();const rows=[proposalRow('hybrid','1'),proposalRow('hybrid','2')];
    const capped=await readProposalArchive({source,lane:'hybrid',pageSize:2,maxPages:1,query:async()=>({...blockProof,proposals:rows})});expect(capped.coverage.status).toBe('incomplete');expect(capped.data).toHaveLength(2);
    const missing=await readProposalArchive({source,lane:'hybrid',query:async()=>({...blockProof})});expect(missing.coverage.status).toBe('unavailable');
    const wrong=await readProposalArchive({source,lane:'hybrid',query:async()=>({...blockProof,proposals:[proposalRow('hybrid','1',{hybridVoting:{id:HV,organization:{id:HASH}}})]})});expect(wrong.coverage.status).toBe('incomplete');
    const unproven=await readProposalArchive({source,lane:'hybrid',query:async()=>({proposals:[]})});expect(unproven.source.snapshot).toBe('unknown');expect(unproven.coverage.status).toBe('unavailable');
    const mismatched=await readProposalArchive({source,lane:'hybrid',query:async()=>({_meta:{block:{number:100,hash:HASH2}},proposals:[]})});expect(mismatched.coverage.status).toBe('unavailable');
    let pages=0;const duplicate=await readProposalArchive({source,lane:'hybrid',pageSize:2,maxPages:3,query:async()=>{pages++;return{...blockProof,proposals:rows};}});expect(duplicate.coverage.status).toBe('incomplete');expect(pages).toBe(2);
    let attempt=0;const failed=await readProposalArchive({source,lane:'hybrid',pageSize:2,query:async()=>{if(attempt++)throw new Error('network');return{...blockProof,proposals:rows};}});expect(failed.coverage.status).toBe('incomplete');expect(failed.data).toHaveLength(2);
    let proof=0;const numeric={...source,block:{number:'100'}};const mixed=await readProposalArchive({source:numeric,lane:'hybrid',pageSize:2,query:async()=>({organization:installedBinding,_meta:{block:{number:100,hash:proof++?HASH:null}},proposals:proof===1?rows:[]})});expect(mixed.coverage.issues.some(e=>e.code==='PAGE_SOURCE_MISMATCH')).toBe(true);expect(mixed.source.block?.hash).toBeUndefined();expect(()=>requireCompleteSnapshot(mixed)).toThrow();
  });
  it('two same-version emissions never blend; restricted/missing/incomplete snapshots explicitly request org-chain fallback',async()=>{
    const source=graphSource(),row=proposalRow('hybrid','9007199254740993',{classesChange:classChange('second')});
    const exact=selectProposalClassSnapshotFacts(snapshot(row,source),source);expect(raw(exact.classes).map(c=>c.id)).toEqual(['second-0']);
    for(const changed of [proposalRow('hybrid','1'),{...row,isHatRestricted:true},{...row,classesChange:{...classChange(),numClasses:2}},{...row,classesChange:{...classChange(),votingClasses:[...classChange().votingClasses,...classChange('second').votingClasses]}}]){
      const facts=selectProposalClassSnapshotFacts(snapshot(changed,source),source);expect(facts.classes.state).toBe('unknown');expect(facts.fallback).toMatchObject({chainId:100,orgId:ORG,votingAddress:HV,method:'getProposalClasses'});
    }
    const missing=await readProposalDetailFacts({source,lane:'hybrid',compositeId:HV+'-999',query:async()=>({...blockProof,proposals:[],ddvproposals:[]})});expect(raw(missing.data.proposal)).toBe(null);expect(missing.data.classSnapshot.fallback?.proposalId).toBe('999');expect(missing.data.actionSummaries.state).toBe('unknown');
  });
  it('composite lookup ignores wallet chain, refuses conflicting org/lane and keeps absent metadata unknown',async()=>{
    const source=graphSource();const query=vi.fn(async()=>({...blockProof,proposals:[proposalRow('hybrid','0',{metadata:null,winningOption:'0',isValid:false})],ddvproposals:[]}));
    const result=await readProposalDetailFacts({source,lane:'hybrid',compositeId:HV+'-0',query});expect(raw(result.data.proposal)?.winningOption).toBe('0');expect(raw(result.data.proposal)?.isValid).toBe(false);expect(result.data.actionSummaries.state).toBe('unknown');
    await expect(readProposalDetailFacts({source,lane:'hybrid',compositeId:DD+'-0',query})).rejects.toThrow('Composite proposal source mismatch');expect(query).toHaveBeenCalledTimes(1);
    const wrong=await readProposalDetailFacts({source,lane:'dd',compositeId:HV+'-0',query});expect(wrong.data.proposal.state).toBe('unknown');expect(wrong.coverage.status).toBe('incomplete');
  });
});

const ctx={chainId:100,client:{},ipfs:{readonly:true}} as unknown as PopContext;
beforeEach(()=>{vi.mocked(resolveOrgModules).mockResolvedValue({orgId:ORG,hybridVotingAddress:HV,ddVotingAddress:DD} as Awaited<ReturnType<typeof resolveOrgModules>>);vi.mocked(pinJson).mockReset().mockResolvedValue(CID);});
describe('metadata publication boundary and additive target selection',()=>{
  it('basic fixed-ms bytes are identical; deterministic extensions/creation markers survive serialize/reload',()=>{
    const base={description:'d',optionNames:['Yes','No'],createdAt:1234567890000};expect(serializeProposalMetadata(buildProposalMetadata(base))).toBe('{"description":"d","optionNames":["Yes","No"],"createdAt":1234567890000}');
    const doc=prepareProposalMetadata({...base,actionSummaries:['Create the role “Stewards”'],promotedFrom:'dd-0',createsSubject:true,extensions:{z:0,a:{y:false,x:'preserved'}}});
    expect(serializeProposalMetadata(doc)).toBe('{"description":"d","optionNames":["Yes","No"],"createdAt":1234567890000,"actionSummaries":["Create the role “Stewards”"],"promotedFrom":"dd-0","createsSubject":true,"extensions":{"a":{"x":"preserved","y":false},"z":0}}');
    expect(prepareProposalMetadata(JSON.parse(serializeProposalMetadata(doc)))).toEqual(doc);
    for(const bad of [{description:'',optionNames:[],createdAt:1},{...base,schemaVersion:2},{...base,extensions:{bad:undefined}},{...base,createsSubject:'true'}])expect(()=>prepareProposalMetadata(bad)).toThrow();
  });
  it('prepared metadata is validated before pin; failures and malformed upload CIDs return no transaction intent',async()=>{
    const p={org:'org',type:'hybrid' as const,name:'fixture',description:'d',durationMinutes:60,optionNames:['Yes','No'],createdAt:1234567890000,actionSummaries:['Create the role “Stewards”'],promotedFrom:'dd-0',createsSubject:true};
    const intent=await createProposalIntent(ctx,p);expect(intent.meta.ipfs?.metadata).toMatchObject({actionSummaries:p.actionSummaries,promotedFrom:'dd-0',createsSubject:true,createdAt:1234567890000});expect(vi.mocked(pinJson).mock.calls[0][0]).toContain('promotedFrom');
    vi.mocked(pinJson).mockClear();await expect(createProposalIntent(ctx,{...p,metadata:{description:'d',optionNames:['No','Yes'],createdAt:1}})).rejects.toThrow('PROPOSAL_METADATA_OPTIONS_MISMATCH');expect(pinJson).not.toHaveBeenCalled();
    await expect(createProposalIntent(ctx,{...p,type:'dd',calls:[{target:A,data:'0x',value:'0'}]})).rejects.toThrow('EXECUTING_BATCH_REQUIRES_HYBRID');expect(pinJson).not.toHaveBeenCalled();
    vi.mocked(pinJson).mockResolvedValueOnce('not-a-cid');await expect(createProposalIntent(ctx,p)).rejects.toThrow();
    vi.mocked(pinJson).mockRejectedValueOnce(new Error('mock pin failed'));await expect(createProposalIntent(ctx,p)).rejects.toThrow('mock pin failed');
  });
  it.each(['hybrid','dd','both'] as const)('quorum/config target %s changes only requested modules while default remains both',async target=>{
    const quorum=await proposeQuorumIntent(ctx,{org:'org',quorum:2,target,createdAt:1});const config=await proposeConfigIntent(ctx,{org:'org',key:'threshold',value:'66',target,createdAt:1});
    const expected=target==='both'?[HV,DD]:target==='hybrid'?[HV]:[DD];
    for(const i of [quorum,config]){
      const decoded=oracle('HybridVoting').parseTransaction({data:encodeIntent(i).data});expect(decoded.args[4][0].map((c:any)=>c.target.toLowerCase())).toEqual(expected);expect(decoded.args[2]).toBe(60);
    }
    const defaults=await proposeQuorumIntent(ctx,{org:'org',quorum:0,createdAt:1});expect((defaults.args[4] as any[][])[0]).toHaveLength(2);
  });
  it('no-op selector and missing requested DD refuse before pin while live raw keys remain available',async()=>{
    await expect(proposeConfigIntent(ctx,{org:'org',key:'target-allowed',value:A+',true',target:'hybrid'})).rejects.toThrow('DEPRECATED_CONFIG_NOOP');expect(pinJson).not.toHaveBeenCalled();
    const dd=await proposeConfigIntent(ctx,{org:'org',key:'target-allowed',value:A+',true',target:'dd',createdAt:1});expect((dd.args[4] as any[][])[0]).toHaveLength(1);
    vi.mocked(pinJson).mockClear();vi.mocked(resolveOrgModules).mockResolvedValue({orgId:ORG,hybridVotingAddress:HV} as Awaited<ReturnType<typeof resolveOrgModules>>);
    await expect(proposeQuorumIntent(ctx,{org:'org',quorum:1,target:'dd'})).rejects.toThrow('DD_TARGET_UNAVAILABLE');expect(pinJson).not.toHaveBeenCalled();
  });
  it('all resolved governance wrappers reject invalid targets/durations before publishing and preserve old both-lane metadata bytes',async()=>{
    vi.mocked(resolveOrgModules).mockResolvedValue({orgId:ORG,hybridVotingAddress:ethers.constants.AddressZero,ddVotingAddress:DD} as Awaited<ReturnType<typeof resolveOrgModules>>);
    await expect(proposeQuorumIntent(ctx,{org:'org',quorum:1})).rejects.toThrow('INVALID_EXECUTION_CALL');await expect(proposeConfigIntent(ctx,{org:'org',key:'quorum',value:'1'})).rejects.toThrow('INVALID_EXECUTION_CALL');expect(pinJson).not.toHaveBeenCalled();
    await expect(proposeQuorumIntent(ctx,{org:'org',quorum:1,durationMinutes:9})).rejects.toThrow('DURATION_OUT_OF_RANGE');expect(pinJson).not.toHaveBeenCalled();
    vi.mocked(resolveOrgModules).mockResolvedValue({orgId:ORG,hybridVotingAddress:HV,ddVotingAddress:DD} as Awaited<ReturnType<typeof resolveOrgModules>>);
    await proposeQuorumIntent(ctx,{org:'org',quorum:0,createdAt:1234567890000});expect(vi.mocked(pinJson).mock.calls[0][0]).toBe('{"description":"Change voting quorum to 0. Updates both Hybrid (setConfig key 3) and DD (setConfig key 4) voting contracts via execution calls.","optionNames":["Set quorum to 0","Keep current quorum"],"createdAt":1234567890000}');
  });
  it('published extended metadata survives literal retrieval and shared composite feed reload',async()=>{
    const params={org:'org',type:'hybrid' as const,name:'proposal',description:'prepared',durationMinutes:60,optionNames:['Yes','No'],metadata:{description:'prepared',optionNames:['Yes','No'],createdAt:1234567890000,actionSummaries:['Create the role “Stewards”'],promotedFrom:'old-dd-0',createsSubject:true}};
    await createProposalIntent(ctx,params);const stored=JSON.parse(vi.mocked(pinJson).mock.calls[0][0]);
    const detail=await readProposalDetailFacts({source:graphSource(),lane:'hybrid',compositeId:HV+'-91',query:async()=>({...blockProof,proposals:[proposalRow('hybrid','91',{metadata:{...stored,id:HASH}})],ddvproposals:[]})});
    expect(raw(detail.data.actionSummaries)).toEqual(stored.actionSummaries);expect(raw(detail.data.promotedFrom)).toBe('old-dd-0');expect(stored.createdAt).toBe(1234567890000);expect(stored.createsSubject).toBe(true);
  });
});

describe('raw receipt identity and nested inner execution outcomes',()=>{
  const event=(iface:ethers.utils.Interface,name:string,args:unknown[],address:string,logIndex:number)=>({address,...iface.encodeEventLog(iface.getEvent(name),args),logIndex,transactionHash:HASH});
  it.each(['string','panic','custom'] as const)('outer success can contain CallFailed(index2) and %s reason with exact nested provenance',kind=>{
    const hv=oracle('HybridVoting'),ex=oracle('Executor');
    const inner=kind==='string'?'0x08c379a0'+ethers.utils.defaultAbiCoder.encode(['string'],['fixture refusal']).slice(2):kind==='panic'?'0x4e487b71'+ethers.utils.defaultAbiCoder.encode(['uint256'],[0x11]).slice(2):oracle('MembershipAuthority').encodeErrorResult('AlreadyMember',[]);
    const reason=ex.encodeErrorResult('CallFailed',[2,inner]);
    const logs=[event(hv,'ProposalExecutionFailed',[7,0,reason],HV,10),event(hv,'Winner',[7,0,true,false,1000],HV,11),event(hv,'Winner',[8,1,true,true,1000],HV,12),event(hv,'Winner',[7,1,true,true,1000],B,13)];
    const outcome=parseProposalReceiptOutcome(logs,{votingAddress:HV,executorAddress:EXEC,proposalId:'7',calls:[call(),call(),{...call(),target:C}]});
    expect(raw(outcome.winningOption)).toBe('0');expect(raw(outcome.valid)).toBe(true);expect(raw(outcome.execution)).toBe('failed');expect(outcome.failures).toHaveLength(1);expect(outcome.failures[0]).toMatchObject({reason,callIndex:'2',target:C,emitter:HV,logIndex:10,transactionHash:HASH,tree:{name:'CallFailed',inner:{kind}}});
    expect(parseAnnounceReceiptLogs([{name:'ProposalExecutionFailed',args:{reason}}]).executionFailureReason).toBe(reason);
  });
  it('retains valid=false and winner0; missing/foreign execution evidence is unknown and matched executor success is separate',()=>{
    const dd=oracle('DirectDemocracyVoting');const win=event(dd,'Winner',[0,0,false],DD,0);
    const unknown=parseProposalReceiptOutcome([win],{votingAddress:DD,executorAddress:EXEC,proposalId:'0'});expect(raw(unknown.winningOption)).toBe('0');expect(raw(unknown.valid)).toBe(false);expect(unknown.execution.state).toBe('unknown');
    const success=event(oracle('Executor'),'BatchExecuted',[0,1],EXEC,1);expect(raw(parseProposalReceiptOutcome([win,success],{votingAddress:DD,executorAddress:EXEC,proposalId:'0'}).execution)).toBe('succeeded');
    expect(parseProposalReceiptOutcome([{...success,address:B}],{votingAddress:DD,executorAddress:EXEC,proposalId:'0'}).execution.state).toBe('unknown');
    expect(parseAnnounceReceiptLogs([{name:'Winner',args:{winningIdx:0,valid:false}}])).toMatchObject({winningOption:'0',valid:false});
  });
});


// Terminal repair probes: negative cases are paired with independently decoded
// valid plans/known absence and retained literal reviewer results.
describe('terminal governance provenance and contract boundary repairs', () => {
  it('retains exact root probe bytes and the original failed and resolved controls', () => {
    const retained = JSON.parse(fixture('review-originals/provenance.json'));
    for (const row of retained.files) expect(createHash('sha256').update(readFileSync(new URL('./fixtures/core-update/governance/' + row.retainedPath.split('/governance/')[1], import.meta.url))).digest('hex')).toBe(row.sha256);
    const original = JSON.parse(fixture('review-originals/module-bindings-final-api.json'));
    expect(original.find((r: any) => r.which === 'authority-binding-mismatch').result).toMatchObject({ state: 'known', value: true });
    expect(original.find((r: any) => r.which === 'module-target-mismatch').result.status).toBe('blocked');
    expect(original.find((r: any) => r.which === 'module-attached-minimal-own-contract').result.status).toBe('blocked');
  });
  it('honors expected authority while historical proposal and current activation sources differ', () => {
    const i = eligibilityInput(powerClass({ subjectId: knownFact('7') }));
    i.scope = { ...i.scope, contracts: { membershipAuthority: AUTH } } as typeof i.scope;
    i.proposal.source = { ...graphSource(), contracts: { membershipAuthority: AUTH }, block: { number: '90', hash: HASH2 }, method: 'historical-proposal' };
    i.proposal.data.createdAt = knownFact('1000', i.proposal.source);
    i.proposal.data.restrictedSubjectIds = knownFact(['7'], i.proposal.source);
    i.proposal.data.classes[0].subjectId = knownFact('7', i.proposal.source);
    i.authority.source.method = 'current-authority'; i.memberships.source.method = 'current-membership';
    expect(raw(deriveClassEligibility(i))).toBe(true);
    // Parent metadata still claims A while actual observations use B: cannot
    // satisfy an expected contract by copying the expected contracts map.
    i.authority.source = { ...i.authority.source, contract: B, contracts: { membershipAuthority: AUTH } };
    i.memberships.source = { ...i.memberships.source, contract: B, contracts: { membershipAuthority: AUTH } };
    expect(deriveClassEligibility(i).state).toBe('unknown');
  });
  it.each(['createdAt', 'restrictions', 'classSubject'] as const)('rejects attached %s contradictions even for empty/open gates', field => {
    const changes: ((s: SourceRef) => SourceRef)[] = [s => ({ ...s, chainId: 42161 }), s => ({ ...s, orgId: HASH2 }), s => ({ ...s, contract: DD }), s => ({ ...s, block: { number: '101', hash: HASH2 } }), s => ({ ...s, block: undefined, snapshot: 'latest' }), s => ({ ...s, method: '' })];
    for (const change of changes) {
      const i = eligibilityInput(), foreign = change(graphSource());
      if (field === 'createdAt') i.proposal.data.createdAt = knownFact('1000', foreign);
      if (field === 'restrictions') i.proposal.data.restrictedSubjectIds = knownFact([], foreign);
      if (field === 'classSubject') i.proposal.data.classes[0].subjectId = knownFact('0', foreign);
      expect(deriveClassEligibility(i).state, field + JSON.stringify(foreign)).toBe('unknown');
    }
    expect(raw(deriveClassEligibility(eligibilityInput()))).toBe(true);
  });
  it('rejects explicit contradictory authority maps and foreign current account evidence', () => {
    for (const target of ['authority', 'memberships', 'proposalField'] as const) {
      const i = eligibilityInput(powerClass({ subjectId: knownFact('7') }));
      i.scope = { ...i.scope, contracts: { membershipAuthority: AUTH } } as typeof i.scope;
      i.proposal.source.contracts = { membershipAuthority: AUTH };
      if (target === 'proposalField') i.proposal.data.createdAt = knownFact('1000', { ...graphSource(), contracts: { membershipAuthority: B } });
      else i[target].source.contracts = { membershipAuthority: B };
      expect(deriveClassEligibility(i).state).toBe('unknown');
    }
    for (const change of [(s: SourceRef) => ({ ...s, account: B }), (s: SourceRef) => ({ ...s, orgId: HASH2 }), (s: SourceRef) => ({ ...s, chainId: 42161 })]) {
      const i = eligibilityInput(powerClass({ subjectId: knownFact('7') })); i.memberships.source = change(i.memberships.source);
      expect(deriveClassEligibility(i).state).toBe('unknown');
    }
  });
  it('mixed attached current membership evidence retains own authority/account/block requirements', () => {
    const control = eligibilityInput(powerClass({subjectId:knownFact('7')}));
    control.scope = {...control.scope,contracts:{membershipAuthority:AUTH}} as typeof control.scope;
    control.proposal.source.contracts = {membershipAuthority:AUTH};
    for (const m of control.memberships.data) {
      m.isMember = knownFact(true,{...liveSource(),account:A});
      m.acceptedAt = knownFact(m.subjectId === '7' ? '900' : '1100',{...liveSource(),account:A});
      m.seededWhilePaused = knownFact(false,{...liveSource(),account:A});
    }
    expect(raw(deriveClassEligibility(control))).toBe(true);
    for (const patch of [{account:B},{contract:TM},{chainId:42161},{orgId:HASH2},{contracts:{membershipAuthority:B}},{method:''},{block:undefined,snapshot:'latest' as const}]) {
      control.memberships.data[0].isMember = knownFact(true,{...liveSource(),account:A,...patch});
      expect(deriveClassEligibility(control).state).toBe('unknown');
    }
    control.memberships.data[0].isMember = unknownFact('missing'); expect(deriveClassEligibility(control).state).toBe('unknown');
  });
  it('keeps mathematical sqrt exact but refuses inspected unchecked-add division by zero', () => {
    const max = (1n << 256n) - 1n;
    // Independent literal Solidity model, retained in the review fixture; no
    // production helper is used to derive its expected result.
    const contractSqrt = (x: bigint): bigint => {
      if (x === 0n) return 0n; if (x <= 3n) return 1n;
      let y = x, z = ((x + 1n) & max) / 2n;
      while (z < y) { y = z; z = ((x / z + z) & max) / 2n; }
      return y;
    };
    expect(fixture('VotingMath.sol.txt')).toContain('(x + 1) / 2');
    expect(() => contractSqrt(max)).toThrow();
    expect(integerSquareRoot(max.toString())).toBe('340282366920938463463374607431768211455');
    const p = { classConfig: knownFact(powerClass({ strategy: 'ERC20_BAL', quadratic: true })), eligible: knownFact(true), balance: knownFact(max.toString()) };
    expect(calculateClassRawPower(p).state).toBe('unknown');
    expect(raw(calculateClassRawPower({ ...p, balance: knownFact((max - 1n).toString()) }))).toBe((contractSqrt(max - 1n) * 100n).toString());
    for (const n of [0n, 1n, 3n, 4n, 15n, 16n, 17n, 9007199254740993n]) expect(raw(calculateClassRawPower({ ...p, balance: knownFact(n.toString()) }))).toBe((contractSqrt(n) * 100n).toString());
    expect(raw(calculateClassRawPower({ ...p, classConfig: knownFact(powerClass({ strategy: 'ERC20_BAL' })), balance: knownFact('17') }))).toBe('1700');
    expect(raw(calculateClassRawPower({ ...p, eligible: knownFact(false) }))).toBe('0');
  });
  it('supports minimal own-module facts across the full ordered multi-module plan', () => {
    const i = roleInput(); i.scope = { ...i.scope, contracts: { ...i.context.source.contracts, membershipAuthority: AUTH } };
    i.context.source.contracts = { ...i.context.source.contracts, membershipAuthority: AUTH };
    i.allocations.source.contracts = i.context.source.contracts;
    const attach = <T>(f: Fact<T>, contract: string): Fact<T> => f.state === 'known' ? knownFact(f.value, liveSource(contract, 'own-module-read')) : f;
    const c = i.context.data;
    c.executorAuthorized = attach(c.executorAuthorized, AUTH);
    c.taskManager!.executorAuthorized = attach(c.taskManager!.executorAuthorized, TM);
    c.hybrid!.executorAuthorized = attach(c.hybrid!.executorAuthorized, HV);
    c.registry!.executorAuthorized = attach(c.registry!.executorAuthorized, REG); c.registry!.currentAdminSubject = attach(c.registry!.currentAdminSubject, REG);
    c.sponsorship!.operatorAuthorized = attach(c.sponsorship!.operatorAuthorized, PM); c.sponsorship!.claimBudgetExists = attach(c.sponsorship!.claimBudgetExists, PM);
    for (const key of ['enabled', 'authorityMatches', 'domainEnabled', 'emailEnabled'] as const) c.email![key] = attach(c.email![key], EMAIL);
    c.email!.currentRoot = attach(c.email!.currentRoot, EMAIL); c.email!.minterAuthorized = attach(c.email!.minterAuthorized, EXEC);
    for (const a of c.accounts) a.acceptedAnywhere = a.acceptedAnywhere.state === 'known' ? knownFact(a.acceptedAnywhere.value, { ...liveSource(), account: a.account }) : a.acceptedAnywhere;
    const plan = ready(planRoleConfiguration(i));
    expect(decode(plan.batch).map(d => d.name)).toEqual(decode(ready(planRoleConfiguration(roleInput())).batch).map(d => d.name));
    expect(plan.batch.map(c => c.target)).toEqual(ready(planRoleConfiguration(roleInput())).batch.map(c => c.target));
    expect(plan.batch).toHaveLength(18);
  });
  it.each(['taskManager', 'hybridVoting', 'registry', 'paymaster', 'email', 'executor'] as const)('refuses expected-vs-actual %s targets and attached conflicting bindings', key => {
    const control = roleInput(); control.scope.contracts = control.context.source.contracts;
    control.allocations.source.contracts = control.context.source.contracts;
    expect(planRoleConfiguration(control).status).toBe('ready');
    const wrong = roleInput(); wrong.scope.contracts = wrong.context.source.contracts; wrong.allocations.source.contracts = wrong.context.source.contracts;
    const c = wrong.context.data;
    if (key === 'taskManager') c.taskManager!.address = B;
    if (key === 'hybridVoting') c.hybrid!.address = B;
    if (key === 'registry') c.registry!.address = B;
    if (key === 'paymaster') c.sponsorship!.address = B;
    if (key === 'email') c.email!.address = B;
    if (key === 'executor') c.email!.executorAddress = B;
    code(planRoleConfiguration(wrong), 'SCOPE_MISMATCH');
    const attached = roleInput(); attached.scope.contracts = attached.context.source.contracts; attached.allocations.source.contracts = attached.context.source.contracts;
    const contract = attached.context.source.contracts![key];
    const s = { ...liveSource(contract), contracts: { [key]: B } };
    const d = attached.context.data;
    if (key === 'taskManager') d.taskManager!.executorAuthorized = knownFact(true, s);
    if (key === 'hybridVoting') d.hybrid!.executorAuthorized = knownFact(true, s);
    if (key === 'registry') d.registry!.currentAdminSubject = knownFact('7', s);
    if (key === 'paymaster') d.sponsorship!.operatorAuthorized = knownFact(true, s);
    if (key === 'email') d.email!.currentRoot = knownFact(ethers.constants.HashZero, s);
    if (key === 'executor') d.email!.minterAuthorized = knownFact(false, s);
    code(planRoleConfiguration(attached), 'SCOPE_MISMATCH');
  });
  it('minimal field provenance still requires own contract, authority account, kind and exact live block', () => {
    const i = roleInput(); i.scope.contracts = i.context.source.contracts; i.allocations.source.contracts = i.context.source.contracts;
    const changes: ((s: SourceRef) => SourceRef)[] = [s => ({ ...s, contract: AUTH }), s => ({ ...s, contract: undefined }), s => ({ ...s, orgId: undefined }), s => ({ ...s, chainId: 42161 }), s => ({ ...s, orgId: HASH2 }), s => ({ ...s, indexed: true }), s => ({ ...s, block: undefined, snapshot: 'latest' }), s => ({ ...s, block: { number: '101', hash: HASH2 } }), s => ({ ...s, method: '' })];
    for (const change of changes) { i.context.data.taskManager!.executorAuthorized = knownFact(true, change(liveSource(TM))); expect(planRoleConfiguration(i).status).toBe('blocked'); }
    expect(() => requirePlanningFact(knownFact(true, liveSource(TM)), i.context, scope, 'UNAVAILABLE')).toThrow();
    for (const source of [liveSource(), { ...liveSource(), account: C }, liveSource(TM)]) {
      const e = electionInput(); e.context.data.accounts[1].acceptedAnywhere = knownFact(false, source);
      expect(planElection(e).status).toBe('blocked');
    }
    const e = electionInput(); e.context.data.accounts[1].acceptedAnywhere = knownFact(false, { ...liveSource(), account: B });
    expect(planElection(e).status).toBe('ready');
    const foreignAuthority = electionInput(); foreignAuthority.context.source.contracts = {membershipAuthority:C};
    code(planElection(foreignAuthority), 'SCOPE_MISMATCH');
    const correct = electionInput(); correct.context.source.contracts = {membershipAuthority:AUTH};
    expect(planElection(correct).status).toBe('ready');
  });
});


describe('same-response installed proposal module binding', () => {
  it.each(['hybrid', 'dd'] as const)('proves valid empty %s archive and null detail with exact observed block', async lane => {
    const source = graphSource(lane === 'hybrid' ? HV : DD);
    const query = vi.fn(async (_doc: string, v: Record<string, unknown>) => { expect(v.orgId).toBe(ORG); expect(v.block).toEqual({hash:HASH}); return { ...blockProof, proposals: [], ddvproposals: [] }; });
    const archive = await readProposalArchive({ source, query, lane });
    expect(archive.coverage.status).toBe('complete'); expect(archive.data).toEqual([]); expect(archive.source.block).toEqual({number:'100',hash:HASH});
    const detail = await readProposalDetailFacts({ source, query, lane, compositeId: source.contract + '-999' });
    expect(detail.coverage.status).toBe('complete'); expect(raw(detail.data.proposal)).toBe(null);
    expect(detail.data.actionSummaries.state).toBe('unknown'); expect(detail.source.block).toEqual(archive.source.block);
    expect(query).toHaveBeenCalledTimes(2);
  });
  it.each(['hybrid', 'dd'] as const)('refuses missing/malformed/foreign/wrong-lane %s binding even when rows are empty', async lane => {
    const source = graphSource(lane === 'hybrid' ? HV : DD);
    const bindings = [undefined, null, {}, { ...installedBinding, id: HASH2 }, { id: ORG }, { ...installedBinding, [lane === 'hybrid' ? 'hybridVoting' : 'directDemocracyVoting']: null }, { ...installedBinding, [lane === 'hybrid' ? 'hybridVoting' : 'directDemocracyVoting']: {id:B} }, { id: ORG, [lane === 'hybrid' ? 'directDemocracyVoting' : 'hybridVoting']: {id:source.contract} }];
    for (const organization of bindings) {
      const query = async () => ({ ...blockProof, organization, proposals: [], ddvproposals: [] });
      const archive = await readProposalArchive({ source, query, lane });
      expect(archive.coverage.status, JSON.stringify(organization)).not.toBe('complete'); expect(() => requireCompleteSnapshot(archive)).toThrow();
      const detail = await readProposalDetailFacts({ source, query, lane, compositeId: source.contract + '-999' });
      expect(detail.coverage.status, JSON.stringify(organization)).not.toBe('complete'); expect(detail.data.proposal.state).toBe('unknown');
    }
  });
  it('requires binding on terminal empty pages, retaining preceding rows and independent lane cursors', async () => {
    const cursors: Record<string, string[]> = {hybrid:[],dd:[]};
    for (const lane of ['hybrid','dd'] as const) {
      const source = graphSource(lane === 'hybrid' ? HV : DD), collection = lane === 'hybrid' ? 'proposals' : 'ddvproposals';
      const rows = [proposalRow(lane,'1'),proposalRow(lane,'2')];
      const archive = await readProposalArchive({source,lane,pageSize:2,maxPages:3,query:async (_doc,v)=>{
        cursors[lane].push(String(v.cursor)); return {...blockProof,organization:v.cursor === '' ? installedBinding : null,[collection]:v.cursor === '' ? rows : []};
      }});
      expect(archive.coverage.status).toBe('incomplete'); expect(archive.data).toEqual(rows); expect(() => requireCompleteSnapshot(archive)).toThrow();
      expect(cursors[lane]).toEqual(['',rows[1].id]);
    }
    expect(cursors.hybrid[1]).not.toBe(cursors.dd[1]);
  });
  it('installed binding cannot replace missing or contradictory same-response block proof', async () => {
    for (const response of [{organization:installedBinding,proposals:[],ddvproposals:[]},{...blockProof,_meta:{block:{number:100,hash:HASH2}},proposals:[],ddvproposals:[]}]) {
      const query = async () => response, source = graphSource();
      const archive = await readProposalArchive({source,query,lane:'hybrid'}); expect(archive.coverage.status).toBe('unavailable');
      const detail = await readProposalDetailFacts({source,query,lane:'hybrid',compositeId:HV+'-999'}); expect(detail.coverage.status).toBe('unavailable'); expect(detail.data.proposal.state).toBe('unknown');
    }
  });
});
