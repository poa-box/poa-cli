import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { buildSchema, execute, parse, validate } from 'graphql';
import { ethers } from 'ethers';
import { effectiveTaskDeadlineSeconds, deriveClaimState, decodeProjectBudget, decodeBountyBudget, decodeOrganizerSubjects } from '../src/task-lens';
import { decideTaskActions, decideTaskRelease, decideProjectBudget, projectTaskPermissionMask, TaskPolicyFacts, TaskPolicyInput } from '../src/tasks/policy';
import { knownFact, unknownFact, SourceRef, SourceSnapshot } from '../src/data/facts';
import { parseDecimalAmountToRaw } from '../src/amounts';
import { metadataPointerToBytes32 } from '../src/encoding/cid';
import { encodeIntent } from '../src/tx/intent';
import { AUTHORITY_KEYS, projectContext } from '../src/tx/authority';
import { getAbi } from '../src/contracts';
import { buildCreateTask, buildCreateTaskRaw, buildCreateAndAssignTask, buildCreateAndAssignTaskRaw, buildUpdateTask, taskConfigCall,
  buildSetFolders, createTaskIntent, createTasksBatchIntents, updateTaskIntent, editTaskMetadataIntent, applyForTaskIntent, projectTaskWriteOutcomes } from '../src/tx/task';
import { buildCreateProject, buildCreateProjectRaw } from '../src/tx/project';
import { buildTaskMetadata, mergeTaskMetadataFinal, serializeTaskMetadata, buildTaskApplicationMetadata, serializeTaskApplicationMetadata } from '../src/metadata/task';
import { makeEmptyFolderDoc, serializeFolderDoc, validateFolderDoc, FolderDocument } from '../src/metadata/folders';
import { parseTaskCreatedReceipt, TaskCreationEvidence } from '../src/tasks/receipts';
import { listProjectsComplete, listProjectManagersComplete, projectManagerFact, listProjects } from '../src/reads/project';
import { listTasksComplete, listTaskClaimExpiriesComplete, fetchProjectsData } from '../src/reads/task';
import { listEducationModulesComplete, listCompletionsComplete, listEducationModules, FETCH_EDUCATION_DATA } from '../src/reads/education';
import * as taskDocs from '../src/graph/documents/task';
import * as educationDocs from '../src/graph/documents/education';
import { assertServingCapabilities } from './fixtures/core-update/identity/serving-capability';
import type { PopContext } from '../src/context';
import type { ProtocolQuery, IndexedRow } from '../src/reads/protocol';

const TM = '0x1111111111111111111111111111111111111111';
const A = '0x2222222222222222222222222222222222222222';
const B = '0x3333333333333333333333333333333333333333';
const ORG = '0x' + '44'.repeat(32), HASH = '0x' + '55'.repeat(32), ZERO = ethers.constants.HashZero;
const CID = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
const MAX128 = '340282366920938463463374607431768211455';
const source = (overrides: Partial<SourceRef> = {}): SourceRef => ({ chainId: 100, endpoint: 'fixture://work', method: 'work', indexed: true,
  snapshot: 'latest', orgId: ORG, contract: TM, account: A, ...overrides });
const snapshot = <T>(data: T, ref = source()): SourceSnapshot<T> => ({ source: ref, data,
  coverage: { status: 'complete', receivedKeys: [], missingIds: [], failedIds: [], issues: [] } });
const policy = (changes: Partial<TaskPolicyFacts> = {}, ref = source()): TaskPolicyInput => ({ projectId: ZERO, scope: { chainId: 100, orgId: ORG, contract: TM, account: A }, now: 1100,
  snapshot: snapshot({ projectId: knownFact(ZERO), actor: knownFact(A), executor: knownFact(false), projectManager: knownFact(false), permissionMask: knownFact('0'), projectExists: knownFact(true),
    creator: knownFact(false), taskExists: knownFact(true), status: knownFact(1), claimer: knownFact(A), absoluteDeadline: knownFact(1000),
    claimDeadline: knownFact(2000), requiresApplication: knownFact(false), alreadyApplied: knownFact(false), ...changes }, ref) });
const fixture = (name: string) => readFileSync(new URL(`./fixtures/core-update/work/${name}`, import.meta.url), 'utf8');
const provenance = JSON.parse(fixture('provenance.json'));
const iface = new ethers.utils.Interface(getAbi('TaskManagerNew'));
const rawTask = { taskManagerAddress: TM, payoutRaw: '1', title: 'One wei', metadataHash: HASH, projectId: ZERO, features: { deadlines: true } };
const hexId = (id: number | string) => ethers.utils.hexZeroPad(ethers.BigNumber.from(id).toHexString(), 32);

// Portable independent snapshot: tests never read research checkouts or use a live provider.
describe('portable contract and serving schema oracles', () => {
  it('pins copied contract and schema provenance', () => {
    for (const row of provenance.contractSnapshot.files) expect(createHash('sha256').update(fixture(row.fixture)).digest('hex')).toBe(row.sha256);
    expect(createHash('sha256').update(fixture('schema.graphql')).digest('hex')).toBe(provenance.servingSchema.sha256);
    expect(provenance.servingSchema.fullIntrospectionSha256).toBe('2fefb5c645d84d3a8c65f1f8522fe016ef6a64cca2441b21bcfabb43c14b3047');
  });
  const schema = buildSchema(fixture('serving-schema.graphql'));
  for (const [name, doc] of Object.entries({ ...taskDocs, ...educationDocs })) {
    if (typeof doc !== 'string' || !['FETCH_PROJECTS_PAGE','FETCH_PROJECT_MANAGERS_PAGE','FETCH_TASKS_PAGE','FETCH_TASKS_PAGE_LEGACY','FETCH_TASK_CLAIM_EXPIRIES_PAGE','FETCH_MODULES_PAGE','FETCH_COMPLETIONS_PAGE'].includes(name)) continue;
    it(`${name} validates all variable argument positions against serving schema`, () => {
      expect(validate(schema, parse(doc)).map(e => e.message)).toEqual([]);
    });
  }
  it('rejects output-scalar guesses for relation inputs', () => {
    expect(validate(schema, parse(taskDocs.FETCH_PROJECT_MANAGERS_PAGE.replace('$taskManager: String!', '$taskManager: Bytes!'))).length).toBeGreaterThan(0);
    expect(parse(taskDocs.FETCH_PROJECTS_DATA).definitions[0]).toMatchObject({ variableDefinitions: [ { type: { type: { name: { value: 'ID' } } } }, expect.anything() ] });
    expect(FETCH_EDUCATION_DATA).toContain('$orgId: ID!');
  });
  it('anchors contract permissions, strict expiry, cap and atomic parameter oracles', () => {
    const contract = fixture('TaskManager.sol.txt');
    expect(contract).toContain('cd != 0 && block.timestamp > cd');
    expect(contract).toContain('ad != 0 && block.timestamp > ad');
    expect(contract).toContain('if (t.status != Status.CLAIMED) revert BadStatus();');
    expect(contract).toContain('if (!hasCreateAndAssign && !_isPM(pid, sender))');
    expect(contract).toContain('no project-manager bypass');
    expect(fixture('ValidationLib.sol.txt')).toContain('cap == type(uint128).max');
  });
});

describe('TASK-DEADLINE earliest contract cutoff', () => {
  it('covers every finite status/deadline/equality boundary from the work order', () => {
    for (const status of [0,1,2,3,4]) for (const claimDeadline of [0,1000,2000]) for (const absoluteDeadline of [0,1000,2000]) for (const now of [999,1000,1001,1100,2000,2001]) {
      const cutoff = claimDeadline === 0 ? absoluteDeadline : absoluteDeadline === 0 ? claimDeadline : Math.min(claimDeadline, absoluteDeadline);
      const expected = status !== 1 || cutoff === 0 ? 'none' : now > cutoff ? 'expired-claimable' : 'expiring-soon';
      expect(deriveClaimState({ status, claimDeadline, absoluteDeadline }, now), JSON.stringify({status,claimDeadline,absoluteDeadline,now})).toBe(expected);
      expect(effectiveTaskDeadlineSeconds({ claimDeadline, absoluteDeadline })).toBe(cutoff || undefined);
    }
  });
  it('2000/1000/1100 expires; equality and delivered work do not', () => {
    expect(deriveClaimState({ status:1,claimDeadline:2000,absoluteDeadline:1000 },1100)).toBe('expired-claimable');
    expect(deriveClaimState({ status:1,claimDeadline:2000,absoluteDeadline:1000 },1000)).toBe('expiring-soon');
    for(const status of [2,3]) expect(deriveClaimState({status,claimDeadline:1000,absoluteDeadline:1000},1100)).toBe('none');
  });
  it('keeps optimistic window fallback and display skew out of contract facts', () => {
    expect(effectiveTaskDeadlineSeconds({ claimDeadline:0, absoluteDeadline:0 })).toBeUndefined();
    expect(deriveClaimState({status:1,claimDeadline:100000,absoluteDeadline:0},1000)).toBe('on-track');
    expect(effectiveTaskDeadlineSeconds({claimDeadline:0,absoluteDeadline:1000})).toBe(1000);
  });
});

describe('TASK-POLICY contract action guards', () => {
  it('checks the complete actor/mask/status/equality policy grid against contract predicates', () => {
    for (const actor of ['manager','nonmanager','claimer','outsider']) for (const mask of [0,1,8,9,4,16,32]) for (const status of [0,1,2,3,4]) for (const now of [1000,1100]) {
      const pm = actor === 'manager', self = actor === 'claimer';
      const input = {...policy({projectManager:knownFact(pm),permissionMask:knownFact(String(mask)),status:knownFact(status),claimer:knownFact(self?A:B)}),now};
      const result = decideTaskActions(input);
      const label = JSON.stringify({actor,mask,status,now});
      expect(result.createAndAssign.state,label).toBe(pm || ((mask & 1)!==0 && (mask & 8)!==0) ? 'allowed':'denied');
      expect(result.budget.state,label).toBe((mask & 32)!==0 ? 'allowed':'denied');
      expect(result.complete.state,label).toBe(status===2 && (pm || (mask & 4)!==0) && (!self || pm || (mask & 16)!==0) ? 'allowed':'denied');
      expect(result.release.state,label).toBe(status===1 && (self || (pm || (mask & 8)!==0) && now>1000) ? 'allowed':'denied');
      expect(result.submit.state,label).toBe(status===1 && self ? 'allowed':'denied');
    }
  });
  it('PM bypass excludes BUDGET for every specified mask', () => {
    for(const mask of [0,1,8,9,4,16,32]) {
      const result = decideTaskActions(policy({projectManager:knownFact(true),permissionMask:knownFact(String(mask)),status:knownFact(2)}));
      expect(result.createAndAssign.state).toBe('allowed');
      expect(result.complete.state).toBe('allowed');
      expect(result.budget.state).toBe(mask === 32 ? 'allowed' : 'denied');
    }
    expect(decideProjectBudget(policy({executor:knownFact(true)})).state).toBe('allowed');
  });
  it('requires CREATE AND ASSIGN, REVIEW AND SELF_REVIEW, and EDIT_FULL implies metadata', () => {
    for(const [mask,allowed] of [[0,false],[1,false],[8,false],[9,true]]) expect(decideTaskActions(policy({permissionMask:knownFact(String(mask))})).createAndAssign.state).toBe(allowed?'allowed':'denied');
    for(const [mask,allowed] of [[0,false],[4,false],[16,false],[20,true]]) expect(decideTaskActions(policy({permissionMask:knownFact(String(mask)),status:knownFact(2)})).complete.state).toBe(allowed?'allowed':'denied');
    const result=decideTaskActions(policy({permissionMask:knownFact('128')}));
    expect(result.editFull.state).toBe('allowed'); expect(result.editMetadata.state).toBe('allowed');
    expect(decideTaskActions(policy({permissionMask:knownFact('64')})).editFull.state).toBe('denied');
  });
  it('revoked-role own release needs no permission; submitted refusal precedes ownership or role', () => {
    for(const mask of [knownFact('0'),unknownFact<string>('revoked')]) expect(decideTaskRelease(policy({permissionMask:mask,projectManager:unknownFact('missing')})).state).toBe('allowed');
    for(const status of [0,2,3,4]) expect(decideTaskRelease(policy({status:knownFact(status),projectManager:knownFact(true)}))).toMatchObject({state:'denied',reasons:['BAD_STATUS']});
  });
  it('outsider release needs ASSIGN and strict expiry; no deadlines and equality refuse', () => {
    expect(decideTaskRelease(policy({claimer:knownFact(B),permissionMask:knownFact('8')})).state).toBe('allowed');
    expect(decideTaskRelease({...policy({claimer:knownFact(B),permissionMask:knownFact('8')}),now:1000}).state).toBe('denied');
    expect(decideTaskRelease(policy({claimer:knownFact(B)})).state).toBe('denied');
    expect(decideTaskRelease(policy({claimer:knownFact(B),permissionMask:knownFact('8'),absoluteDeadline:knownFact(0),claimDeadline:knownFact(0)})).state).toBe('denied');
  });
  it('covers claim/application/submit/cancel/edit status gates without deadline blocking submission', () => {
    for(const status of [0,1,2,3,4]) {
      const result=decideTaskActions(policy({status:knownFact(status),permissionMask:knownFact('255')}));
      expect(result.claim.state).toBe(status<2?'allowed':'denied');
      expect(result.assign.state).toBe(status<2?'allowed':'denied');
      expect(result.submit.state).toBe(status===1?'allowed':'denied');
      expect(result.cancel.state).toBe(status===0?'allowed':'denied');
      expect(result.editFull.state).toBe(status<3?'allowed':'denied');
    }
    const app=policy({permissionMask:knownFact('2'),requiresApplication:knownFact(true)});
    expect(decideTaskActions(app).claim.state).toBe('denied'); expect(decideTaskActions(app).apply.state).toBe('allowed');
    expect(decideTaskActions(policy({requiresApplication:knownFact(true),alreadyApplied:knownFact(true),permissionMask:knownFact('2')})).apply.reasons).toContain('ALREADY_APPLIED');
  });
  it('unknown manager/creator/identity/mask/current task facts never invent authority', () => {
    expect(decideTaskActions(policy({projectManager:unknownFact('missing')})).create.state).toBe('unknown');
    expect(decideTaskActions(policy({creator:unknownFact('missing')})).deleteProject.state).toBe('unknown');
    expect(decideTaskActions(policy({actor:unknownFact('missing'),permissionMask:knownFact('255')})).create.state).toBe('unknown');
    expect(decideProjectBudget(policy({permissionMask:unknownFact('missing'),projectManager:knownFact(true)})).state).toBe('unknown');
    expect(decideTaskActions(policy({claimer:unknownFact('missing'),permissionMask:knownFact('4'),status:knownFact(2)})).complete.state).toBe('unknown');
    expect(decideTaskActions(policy({status:unknownFact('missing'),projectManager:knownFact(true)})).assign.state).toBe('unknown');
  });
  it('consumes current authority USER projection without Number truncation or wrong project context', () => {
    const authoritySource = source({ contract: B });
    const permission = { permKey: AUTHORITY_KEYS.TM_PERMS, ctx: projectContext(ZERO), value: knownFact('265', authoritySource), enabled: knownFact(true), contributions: [] };
    const mask = projectTaskPermissionMask(permission, ZERO);
    expect(mask).toMatchObject({state:'known',value:'9'});
    const input = policy({permissionMask:mask});
    input.scope.contracts = {membershipAuthority:B}; input.snapshot.source.contracts = {membershipAuthority:B};
    expect(decideTaskActions(input).createAndAssign.state).toBe('allowed');
    expect(projectTaskPermissionMask(permission, HASH).state).toBe('unknown');
    expect(decideTaskActions(policy({projectId:knownFact(HASH),projectManager:knownFact(true)})).create.state).toBe('unknown');
    expect(decideTaskActions(policy({projectId:unknownFact('missing'),projectManager:knownFact(true)})).create.state).toBe('unknown');
  });
  it('blocks incomplete, stale-block, cross-chain/org/account facts and unsafe masks before decisions', () => {
    const incomplete=policy(); incomplete.snapshot.coverage.status='incomplete';
    expect(decideTaskRelease(incomplete).state).toBe('unknown');
    for(const ref of [source({chainId:42161}),source({orgId:ZERO}),source({account:B})]) expect(decideTaskRelease(policy({},ref)).state).toBe('unknown');
    const pinned=source({snapshot:'pinned',block:{number:'50'}});
    expect(decideTaskRelease(policy({projectManager:knownFact(true,source({snapshot:'pinned',block:{number:'51'}}))},pinned)).state).toBe('unknown');
    expect(decideTaskActions(policy({permissionMask:knownFact('256')})).create.state).toBe('unknown');
  });
});

describe('EXACT-BOUNDARIES and TASK-EXTRA-CALLS calldata', () => {
  it('one wei raw create stays one; old human create/project defaults scale once', () => {
    const raw=iface.decodeFunctionData('createTask',encodeIntent(buildCreateTaskRaw(rawTask)).data);
    expect(raw[0].toString()).toBe('1');
    const human=iface.decodeFunctionData('createTask',encodeIntent(buildCreateTask({...rawTask,payout:'0.000000000000000001'})).data);
    expect(human[0].toString()).toBe('1');
    const project=iface.decodeFunctionData('createProject',encodeIntent(buildCreateProject({taskManagerAddress:TM,name:'P',cap:'100'})).data)[0];
    expect(project[2].toString()).toBe('100000000000000000000');
  });
  it('large raw caps and UINT128_MAX do not rescale; retired role arrays stay empty', () => {
    for(const capRaw of ['1','100000000000000000000','1000000000000000000000000',MAX128,'0']) {
      const p=iface.decodeFunctionData('createProject',encodeIntent(buildCreateProjectRaw({taskManagerAddress:TM,name:'P',capRaw,bountyTokens:[B],bountyCapsRaw:[MAX128]})).data)[0];
      expect(p[2].toString()).toBe(capRaw); expect(p[9][0].toString()).toBe(MAX128);
      for(const index of [4,5,6,7])expect(p[index]).toEqual([]);
    }
    expect(()=>buildCreateProjectRaw({taskManagerAddress:TM,name:'P',capRaw:'1000000000000000000000001'})).toThrow();
    expect(()=>buildCreateProjectRaw({taskManagerAddress:TM,name:'P',capRaw:(1n<<128n).toString()})).toThrow();
    expect(()=>buildCreateProjectRaw({taskManagerAddress:TM,name:'P',createHats:['1']})).toThrow('removed');
  });
  it('atomic createAndAssign uses ten positional args and assignee at index4 against independent signature', () => {
    const intent=buildCreateAndAssignTaskRaw({...rawTask,assignee:B});
    const oracle=new ethers.utils.Interface(['function createAndAssignTask(uint256,bytes,bytes32,bytes32,address,address,uint256,bool,uint48,uint32)']);
    const expected=oracle.encodeFunctionData('createAndAssignTask',['1',ethers.utils.toUtf8Bytes('One wei'),HASH,ZERO,B,ethers.constants.AddressZero,'0',false,0,0]);
    expect(encodeIntent(intent).data).toBe(expected);
    expect(intent.args).toHaveLength(10);expect(String(intent.args[4]).toLowerCase()).toBe(B);
  });
  it('explicit USDC6 bounty and Shares18 remain exact and reject lossy inputs', () => {
    const intent=buildCreateAndAssignTask({...rawTask,assignee:B,payout:'0.000000000000000001',bountyToken:B,bountyAmount:'1.000001',bountyDecimals:6});
    const decoded=iface.decodeFunctionData('createAndAssignTask',encodeIntent(intent).data);
    expect(decoded[0].toString()).toBe('1');expect(decoded[6].toString()).toBe('1000001');
    for(const bad of ['-1','+1','1e2','NaN','Infinity',' 1','1.0000001']) expect(()=>parseDecimalAmountToRaw(bad,6)).toThrow();
    expect(()=>buildCreateAndAssignTask({...rawTask,assignee:B,payout:'1',bountyAmount:'1'})).toThrow('Explicit');
    for(const bad of [-1,1.5,Number.MAX_SAFE_INTEGER+1,'1e3'])expect(()=>buildCreateTaskRaw({...rawTask,payoutRaw:bad})).toThrow();
    expect(()=>buildCreateTaskRaw({...rawTask,bountyToken:B})).toThrow();
    expect(()=>buildCreateTaskRaw({...rawTask,metadataHash:'arbitrary text'})).toThrow();
  });
  it('raw update payout and bounty stay raw and an edited past absolute deadline remains permitted', () => {
    const intent=buildUpdateTask({taskManagerAddress:TM,taskId:'9007199254740993',payoutWei:'1',title:'Edited',metadataHash:HASH,bountyToken:B,bountyPayoutWei:'1000001',absoluteDeadline:1000,completionWindow:0});
    const decoded=iface.decodeFunctionData('updateTask',encodeIntent(intent).data);
    expect(decoded[0].toString()).toBe('9007199254740993');expect(decoded[1].toString()).toBe('1');expect(decoded[5].toString()).toBe('1000001');expect(decoded[6].toString()).toBe('1000');
  });
  it('typed config and budget lens preserve raw unlimited and organizer uint256 values', () => {
    const intent=taskConfigCall(TM,{key:'PROJECT_CAP',projectId:ZERO,capRaw:MAX128});
    const decoded=iface.decodeFunctionData('setConfig',encodeIntent(intent).data);
    expect(decoded[0]).toBe(6);expect(ethers.utils.defaultAbiCoder.decode(['bytes32','uint256'],decoded[1])[1].toString()).toBe(MAX128);
    const data=ethers.utils.defaultAbiCoder.encode(['uint128','uint128','bool'],[MAX128,'1',true]);
    expect(decodeProjectBudget(data).cap.toString()).toBe(MAX128);expect(decodeProjectBudget(data).spent.toString()).toBe('1');
    expect(decodeBountyBudget(ethers.utils.defaultAbiCoder.encode(['uint128','uint128'],['0','0'])).cap.toString()).toBe('0');
    expect(decodeOrganizerSubjects(ethers.utils.defaultAbiCoder.encode(['uint256[]'],[['9007199254740993']]))).toEqual(['9007199254740993']);
    expect(()=>taskConfigCall(TM,{key:'ROLE_PERM'} as any)).toThrow('retired');
  });
  it('separate task and cap outcomes retain successful task while refusing false atomic success', () => {
    expect(decideProjectBudget(policy({projectManager:knownFact(true)})).state).toBe('denied');
    const result=projectTaskWriteOutcomes(knownFact({taskId:'17'}),unknownFact('CAP_REVERTED'));
    expect(result).toEqual({task:{state:'known',value:{taskId:'17'}},cap:{state:'unknown',code:'CAP_REVERTED'},complete:false});
  });
});

const finalDoc = { name:'Current',description:'Before',location:'Here',difficulty:'medium',estHours:'2.5',submission:'ipfs://delivered',dueDate:1770000000 };
const features = {deadlines:true,batchCreate:true,editMeta:true,folders:true,legacyCreate7:false,unclaim:true};
function context(base: unknown = finalDoc) {
  const pin = vi.fn(async (_text: string)=>CID);
  const query = vi.fn(async()=>({organization:{id:ORG,taskManager:{id:TM},membershipAuthority:{id:B,isRouterBound:true,cutoverAt:'1'},metadata:null}}));
  const queryWithFieldFallback = vi.fn(async()=>({data:{task:{id:`${TM}-7`,title:'Current',metadataHash:HASH,metadata:base}},tierIndex:0}));
  const payload=ethers.utils.defaultAbiCoder.encode(['bytes32','uint96','address','uint96','bool','uint8','address','uint48','uint32','uint48'],[ZERO,'1',A,'0',false,1,ethers.constants.AddressZero,0,0,0]);
  const call=vi.fn(async()=>iface.encodeFunctionResult('getLensData',[payload]));
  const ctx={chainId:100,client:{query,queryWithFieldFallback},provider:{call},ipfs:{service:{pinJson:pin,pinFile:vi.fn(),fetchJson:vi.fn(async()=>null)}}} as unknown as PopContext;
  return {ctx,pin,query,call};
}
describe('TASK-RESOLVED-METADATA complete editor documents', () => {
  it('preserves exact legacy bytes and optional dueDate/appliedAt last', () => {
    expect(serializeTaskMetadata(buildTaskMetadata({name:'N',description:'D',location:'',difficulty:'medium',estHours:0,submission:''}))).toBe('{"name":"N","description":"D","location":"","difficulty":"medium","estHours":0,"submission":""}');
    expect(serializeTaskMetadata(buildTaskMetadata({...finalDoc}))).toBe('{"name":"Current","description":"Before","location":"Here","difficulty":"medium","estHours":"2.5","submission":"ipfs://delivered","dueDate":1770000000}');
    expect(serializeTaskApplicationMetadata(buildTaskApplicationMetadata({notes:'n',experience:'e'}))).toBe('{"notes":"n","experience":"e"}');
    expect(serializeTaskApplicationMetadata(buildTaskApplicationMetadata({notes:'n',experience:'e',appliedAt:'2026-01-01T00:00:00.000Z'}))).toBe('{"notes":"n","experience":"e","appliedAt":"2026-01-01T00:00:00.000Z"}');
  });
  it('omitted submission retains delivered CID; explicit empty clears; incomplete base refuses', () => {
    expect(mergeTaskMetadataFinal(finalDoc,{description:'After'}).submission).toBe('ipfs://delivered');
    expect(mergeTaskMetadataFinal(finalDoc,{submission:''}).submission).toBe('');
    expect(mergeTaskMetadataFinal(finalDoc,{dueDate:0}).dueDate).toBe(0);
    expect(mergeTaskMetadataFinal({...finalDoc,dueDate:'1770000000'},{description:'After'}).dueDate).toBe(1770000000);
    expect(mergeTaskMetadataFinal({...finalDoc,dueDate:null} as any,{description:'After'}).dueDate).toBeUndefined();
    expect(()=>mergeTaskMetadataFinal({...finalDoc,dueDate:'9007199254740993'},{description:'After'})).toThrow('dueDate');
    expect(()=>mergeTaskMetadataFinal({name:'N',description:'D'},{description:'After'})).toThrow('requires');
  });
  it('resolved create pins complete dueDate/submission exactly once and preserves raw one wei', async () => {
    const {ctx,pin}=context();
    const intent=await createTaskIntent(ctx,{org:ORG,project:ZERO,name:'Current',description:'Before',payout:'0.000000000000000001',features,
      location:'Here',estHours:'2.5',submission:'ipfs://delivered',dueDate:1770000000});
    expect(pin).toHaveBeenCalledTimes(1);expect(pin.mock.calls[0][0]).toBe(serializeTaskMetadata(finalDoc));
    expect(iface.decodeFunctionData('createTask',encodeIntent(intent).data)[0].toString()).toBe('1');
    expect(iface.decodeFunctionData('createTask',encodeIntent(intent).data)[2]).toBe(metadataPointerToBytes32(CID));
  });
  it('prepared pointer skips uploads; document without pointer gets one injected pin', async () => {
    for(const pointer of [HASH,undefined]) {
      const {ctx,pin}=context();
      const intent=await createTaskIntent(ctx,{org:ORG,project:ZERO,name:'Current',description:'Before',payout:1,features,preparedMetadata:{document:finalDoc,pointer}});
      expect(pin).toHaveBeenCalledTimes(pointer?0:1);
      expect(intent.meta.ipfs?.metadata).toEqual(finalDoc);
    }
  });
  it('batch prevalidates every row before any pin and retains dueDate in ordered complete documents', async () => {
    const {ctx,pin}=context();
    const rows=[{name:'Current',description:'Before',payout:1,location:'Here',estHours:'2.5',submission:'ipfs://delivered',dueDate:1770000000},
      {name:'Second',description:'Next',payout:2,dueDate:1770000001}];
    const intents=await createTasksBatchIntents(ctx,{org:ORG,project:ZERO,tasks:rows,features});
    expect(intents).toHaveLength(1);expect(pin).toHaveBeenCalledTimes(2);
    expect(JSON.parse(pin.mock.calls[0][0])).toEqual(finalDoc);
    expect(JSON.parse(pin.mock.calls[1][0]).dueDate).toBe(1770000001);
    const invalid=context();
    await expect(createTasksBatchIntents(invalid.ctx,{org:ORG,project:ZERO,features,tasks:[rows[0],{name:'Bad',description:'Bad',payout:'1e3'}]})).rejects.toThrow();
    expect(invalid.pin).not.toHaveBeenCalled();
  });
  it('full and metadata edits preserve submission and explicit clear across before/after fixtures', async () => {
    for(const edit of [updateTaskIntent,editTaskMetadataIntent]) for(const submission of [undefined,'']) {
      const {ctx,pin}=context({...finalDoc,dueDate:'1770000000'});
      const intent=await edit(ctx,{org:ORG,task:'7',features,description:'After',location:'Elsewhere',...(submission!==undefined?{submission}:{})});
      expect(intent).not.toBeNull();expect(pin).toHaveBeenCalledTimes(1);
      expect(pin.mock.calls[0][0]).toBe(`{"name":"Current","description":"After","location":"Elsewhere","difficulty":"medium","estHours":"2.5","submission":"${submission??'ipfs://delivered'}","dueDate":1770000000}`);
    }
  });
  it('prepared full/meta edits need no indexed base and optional application timestamp survives resolved pin', async () => {
    for(const edit of [updateTaskIntent,editTaskMetadataIntent]) {
      const {ctx,pin}=context(null);
      const intent=await edit(ctx,{org:ORG,task:'7',features,preparedMetadata:{document:finalDoc,pointer:HASH}});
      expect(intent).not.toBeNull();expect(pin).not.toHaveBeenCalled();
    }
    const {ctx,pin}=context();await applyForTaskIntent(ctx,{org:ORG,task:'7',notes:'n',experience:'e',appliedAt:'2026-01-01T00:00:00.000Z'});
    expect(pin.mock.calls[0][0]).toBe('{"notes":"n","experience":"e","appliedAt":"2026-01-01T00:00:00.000Z"}');
  });
  it('unrelated legacy edit keeps submission/defaults and same-value edit stays a no-op', async () => {
    const {ctx,pin}=context();expect(await editTaskMetadataIntent(ctx,{org:ORG,task:'7',features,description:'Before'})).toBeNull();expect(pin).not.toHaveBeenCalled();
    await updateTaskIntent(ctx,{org:ORG,task:'7',features,description:'After'});
    expect(JSON.parse(pin.mock.calls[0][0]).submission).toBe('ipfs://delivered');
  });
  it('invalid contract creation/edit values refuse before any pin', async () => {
    for (const fields of [{name:''},{payout:'1000001'},{bountyToken:B,bountyAmount:'0'}]) {
      const {ctx,pin} = context();
      await expect(createTaskIntent(ctx,{org:ORG,project:ZERO,name:'N',description:'D',payout:1,features,...fields})).rejects.toThrow();
      expect(pin).not.toHaveBeenCalled();
    }
    for (const edit of [updateTaskIntent,editTaskMetadataIntent]) {
      const {ctx,pin} = context();
      await expect(edit(ctx,{org:ORG,task:'7',name:'',features})).rejects.toThrow('Title');
      expect(pin).not.toHaveBeenCalled();
    }
  });
  it('malformed prepared documents, conflicts and unsafe editor merges refuse before content callbacks', async () => {
    for(const preparedMetadata of [{document:{...finalDoc,submission:undefined}}, {document:finalDoc,pointer:'text'}]) {
      const {ctx,pin,query}=context();
      await expect(createTaskIntent(ctx,{org:ORG,project:ZERO,name:'Current',description:'Before',payout:1,features,preparedMetadata} as any)).rejects.toThrow();
      expect(pin).not.toHaveBeenCalled();expect(query).not.toHaveBeenCalled();
    }
    const missing=context({...finalDoc,submission:undefined});
    await expect(editTaskMetadataIntent(missing.ctx,{org:ORG,task:'7',features,location:'Elsewhere'})).rejects.toThrow('submission');
    expect(missing.pin).not.toHaveBeenCalled();
  });
});

describe('FOLDER-SCHEMA interoperability and CAS', () => {
  const nested: FolderDocument={schemaVersion:1,folders:[{id:'f0',name:'',parentId:null,sortOrder:2,projectIds:[`${TM}-0`],color:'blue'},
    {id:'f1',name:'Child',parentId:'f0',sortOrder:10,projectIds:[`${TM}-9007199254740993`]}],extension:{retained:true}};
  it('empty/nested docs preserve array order and compatible extensions exactly', () => {
    expect(serializeFolderDoc(makeEmptyFolderDoc())).toBe('{"schemaVersion":1,"folders":[]}');
    expect(serializeFolderDoc(nested)).toBe(JSON.stringify(nested));
    expect(validateFolderDoc({schemaVersion:1,folders:[{...nested.folders[0],projectIds:[ZERO]}]}).valid).toBe(true);
  });
  it('rejects nonfinite/string sorting, orphans/cycles, duplicates, malformed records and future version', () => {
    const invalid: unknown[]=[null,[],{...nested,schemaVersion:2},{...nested,schemaVersion:0},{...nested,folders:[null]},
      ...[NaN,Infinity,'2'].map(sortOrder=>({...nested,folders:[{...nested.folders[0],sortOrder}]})),
      {...nested,folders:[{...nested.folders[0],parentId:'missing'}]},
      {...nested,folders:[{...nested.folders[0],parentId:'f1'},nested.folders[1]]},
      {...nested,folders:[nested.folders[0],nested.folders[0]]},
      {...nested,folders:[nested.folders[0],{...nested.folders[1],projectIds:[`${TM}-00`]}]},
      ...['TM-0',`${TM}-1.2`,`${TM}-`,`${TM}-${1n<<256n}`].map(pid=>({...nested,folders:[{...nested.folders[0],projectIds:[pid]}]}))];
    for(const doc of invalid)expect(validateFolderDoc(doc).valid,JSON.stringify(doc)).toBe(false);
    expect(()=>serializeFolderDoc({...nested,schemaVersion:2} as any)).toThrow();
  });
  it('loaded expected root stays exact and stale error retains expected/actual values', () => {
    const intent=buildSetFolders({taskManagerAddress:TM,expectedCurrentRoot:HASH,newRoot:ZERO});
    expect([...iface.decodeFunctionData('setFolders',encodeIntent(intent).data)]).toEqual([HASH,ZERO]);
    const error=iface.parseError(iface.encodeErrorResult('FoldersRootStale',[HASH,ZERO]));
    expect(error.args[0]).toBe(HASH);expect(error.args[1]).toBe(ZERO);
  });
});

const projectRow = (id: number): IndexedRow => ({id:`${TM}-${hexId(id)}`,projectId:hexId(id),title:`P${id}`,cap:'1',deleted:false,
  taskManager:{id:TM,organization:{id:ORG}}});
const managerRow=(id: number, manager=A,isActive=true): IndexedRow => ({id:`manager-${String(id).padStart(5,'0')}`,manager,isActive,project:projectRow(id)});
function paged(collection: string, rows: readonly IndexedRow[], failPage?: number): ProtocolQuery {
  let calls=0;
  return vi.fn(async(_doc,vars)=>{
    if(++calls===failPage)throw new Error('Injected page failure');
    const page=rows.filter(r=>String(r.id)>String(vars.cursor)).slice(0,Number(vars.first));
    return {[collection]:page,organization:{id:ORG,taskManager:{id:TM,organization:{id:ORG}}},_meta:{block:{number:50,hash:HASH,timestamp:1000}}};
  });
}
describe('PROJECT-MANAGER-DOC complete scoped companions', () => {
  it('pages 151 projects, 202 active managers and 1001 tasks independently without indexed creator guesses', async () => {
    const ref=source({account:undefined,snapshot:'pinned',block:{number:'50',hash:HASH,timestamp:'1000'}});
    const projects=Array.from({length:151},(_,i)=>projectRow(i));
    const managers=Array.from({length:202},(_,i)=>({...managerRow(i, i%2?B:A, true),project:projectRow(Math.floor(i/2)+1)}));
    const tasks=Array.from({length:1001},(_,i)=>({id:`task-${String(i).padStart(6,'0')}`,taskId:String(i),taskManager:TM,project:projectRow(0),payout:'1',bountyPayout:'0'}));
    const result=await listProjectsComplete({source:ref,query:paged('projects',projects),pageSize:50});
    const members=await listProjectManagersComplete({source:ref,query:paged('projectManagers',managers),pageSize:50});
    const work=await listTasksComplete({source:ref,query:paged('tasks',tasks),pageSize:1000});
    expect(result.data).toHaveLength(151);expect(members.data).toHaveLength(202);expect(work.data).toHaveLength(1001);
    for(const data of [result,members,work])expect(data.coverage.status).toBe('complete');
    expect(projectManagerFact(members,{chainId:100,orgId:ORG,contract:TM},ZERO,A)).toMatchObject({state:'known',value:false});
    expect(projectManagerFact(members,{chainId:100,orgId:ORG,contract:TM},hexId(1),B)).toMatchObject({state:'known',value:true});
  });
  it('partial manager failure retains rows but cannot grant bypass, including missing/mismatched scopes', async () => {
    const result=await listProjectManagersComplete({source:source(),query:paged('projectManagers',Array.from({length:51},(_,i)=>managerRow(i)),2),pageSize:50});
    expect(result.data).toHaveLength(50);expect(result.coverage.status).toBe('incomplete');
    expect(projectManagerFact(result,{chainId:100,orgId:ORG,contract:TM},ZERO,A).state).toBe('unknown');
    expect(projectManagerFact(snapshot([managerRow(0)]),{chainId:42161,orgId:ORG,contract:TM},ZERO,A).state).toBe('unknown');
  });
  it('reports failure/stalled/missing/capped collections as incomplete or unavailable, never empty success', async () => {
    const rows=Array.from({length:51},(_,i)=>projectRow(i));
    for(const query of [paged('projects',rows,2),vi.fn(async()=>({projects:rows.slice(0,50),organization:{id:ORG,taskManager:{id:TM,organization:{id:ORG}}}}))]) {
      const result=await listProjectsComplete({source:source(),query,pageSize:50});
      expect(result.coverage.status).toBe('incomplete');expect(result.data.length).toBeGreaterThan(0);
    }
    expect((await listProjectsComplete({source:source(),query:async()=>({})})).coverage.status).toBe('unavailable');
    expect((await listProjectsComplete({source:source(),query:paged('projects',rows),pageSize:50,maxPages:1})).coverage.issues).toContainEqual({code:'PAGE_CAP'});
    const wrong=projectRow(0);wrong.taskManager={id:B,organization:{id:ORG}};
    expect((await listProjectsComplete({source:source(),query:paged('projects',[wrong])})).coverage.status).toBe('incomplete');
  });
  it('optional expiry schema failure leaves current board available; old task fields fall back only on exact capability errors', async () => {
    const board=await listTasksComplete({source:source(),query:paged('tasks',[{id:'task-1',taskId:'1',taskManager:TM,project:projectRow(0),payout:'1',bountyPayout:'0'}])});
    const history=await listTaskClaimExpiriesComplete({source:source(),task:'1',query:async()=>{throw new Error('Type `Task` has no field `claimExpiries`');}});
    expect(board.coverage.status).toBe('complete');expect(board.data).toHaveLength(1);expect(history.coverage.status).toBe('unavailable');
    const query=vi.fn(async(doc:string)=>{if(doc===taskDocs.FETCH_TASKS_PAGE)throw {response:{errors:[{message:'Type `Task` has no field `claimDeadline`'}]}};return {tasks:[],organization:{id:ORG,taskManager:{id:TM,organization:{id:ORG}}}};});
    expect((await listTasksComplete({source:source(),query})).coverage.status).toBe('complete');expect(query).toHaveBeenCalledTimes(2);
    const mixed=vi.fn(async()=>{throw {response:{errors:[{message:'Type `Task` has no field `claimDeadline`'},{message:'denied'}]}};});
    expect((await listTasksComplete({source:source(),query:mixed})).coverage.status).toBe('unavailable');expect(mixed).toHaveBeenCalledTimes(1);
  });
  it('forwards exact chain/endpoint/hash pin and refuses absent or mismatched observed block proof', async () => {
    const ref=source({snapshot:'pinned',block:{number:'50',hash:HASH}});
    const query=vi.fn(async(_doc:string,vars:Record<string,unknown>,actual:SourceRef)=>{
      expect(actual.chainId).toBe(100);expect(actual.endpoint).toBe('fixture://work');expect(vars.block).toEqual({hash:HASH});return {projects:[],organization:{id:ORG,taskManager:{id:TM,organization:{id:ORG}}},_meta:{block:{number:50,hash:null}}};
    });
    expect((await listProjectsComplete({source:ref,query})).coverage.status).toBe('complete');
    for(const response of [{projects:[],organization:{id:ORG,taskManager:{id:TM,organization:{id:ORG}}}},{projects:[],organization:{id:ORG,taskManager:{id:TM,organization:{id:ORG}}},_meta:{block:{number:51,hash:HASH}}}]) {
      const bad=await listProjectsComplete({source:ref,query:async()=>response});
      expect(bad.coverage.status).toBe('unavailable');expect(bad.source.block?.hash).toBeUndefined();expect(bad.source.snapshot).toBe('unknown');
    }
  });
  it('pages >50 library modules and >20 learner completions without nested caps or precision loss', async () => {
    const hub={id:TM,organization:{id:ORG}};
    const modules=Array.from({length:51},(_,i)=>({id:`module-${String(i).padStart(5,'0')}`,moduleId:String(i),educationHub:hub,payout:'9007199254740993000000000000001'}));
    const completions=Array.from({length:21},(_,i)=>({id:`completion-${String(i).padStart(5,'0')}`,moduleId:String(i),educationHub:hub,learner:A,completedAt:'1000',completedAtBlock:'50'}));
    const library=await listEducationModulesComplete({source:source(),query:paged('educationModules',modules),pageSize:50});
    const history=await listCompletionsComplete({source:source(),query:paged('moduleCompletions',completions),pageSize:20});
    expect(library.coverage.status).toBe('complete');expect(library.data).toHaveLength(51);expect(library.data[50].payout).toBe('9007199254740993000000000000001');
    expect(history.coverage.status).toBe('complete');expect(history.data).toHaveLength(21);
    const failed=await listCompletionsComplete({source:source(),query:paged('moduleCompletions',completions,2),pageSize:20});
    expect(failed.coverage.status).toBe('incomplete');expect(failed.data).toHaveLength(20);
    expect(()=>listCompletionsComplete({source:source({account:undefined}),query:paged('moduleCompletions',[])})).toThrow('learner');
  });
  it('legacy education first50 default and task indexed application metadata remain compatible', async () => {
    const query=vi.fn(async()=>({organization:{educationHub:{modules:[{id:'legacy'}]}}}));
    expect(await listEducationModules({query} as any,ORG,100)).toEqual([{id:'legacy'}]);expect(query.mock.calls[0]).toEqual([FETCH_EDUCATION_DATA,{orgId:ORG},100]);expect(FETCH_EDUCATION_DATA).toContain('modules(first: 50)');
    const application={applicant:A,metadata:{notes:'Indexed notes',experience:'Indexed experience'}};
    const client={queryWithFieldFallback:vi.fn(async()=>({data:{organization:{id:ORG,taskManager:{id:TM,projects:[{id:'p',title:'P',tasks:[{id:'t',taskId:'1',applications:[application]}]}]}}},tierIndex:0}))};
    const data=await fetchProjectsData(client as any,ORG,100);
    expect(data.data.organization!.taskManager!.projects[0].tasks![0].applications[0]).toEqual(application);
  });
});

describe('TASK-OPTIMISTIC-IDS correct-emitter receipts', () => {
  const expected:TaskCreationEvidence={projectId:ZERO,payoutRaw:'1',title:'One wei',metadataHash:HASH,bountyToken:ethers.constants.AddressZero,bountyPayoutRaw:'0',requiresApplication:false};
  const log=(id:string, evidence=expected, emitter=TM)=>({...iface.encodeEventLog(iface.getEvent('TaskCreated'),[id,evidence.projectId,evidence.payoutRaw,evidence.bountyToken,evidence.bountyPayoutRaw,evidence.requiresApplication,ethers.utils.toUtf8Bytes(evidence.title),evidence.metadataHash]),address:emitter});
  it('uses emitted exact IDs despite concurrent creation and preserves draft request order', () => {
    const second={...expected,title:'Second'};
    const result=parseTaskCreatedReceipt({taskManagerAddress:TM,status:1,creations:[second,expected],logs:[log('22',{...expected,title:'Unrelated'}),log('9007199254740993'),log('9007199254740994',second)]});
    expect(result).toEqual({state:'known',value:['9007199254740994','9007199254740993']});
  });
  it('wrong emitter, missing, duplicate, ambiguous and failed receipt are unknown', () => {
    for(const logs of [[],[log('7',expected,B)],[log('7'),log('7')],[log('7'),log('8')]]) expect(parseTaskCreatedReceipt({taskManagerAddress:TM,status:1,creations:[expected],logs}).state).toBe('unknown');
    expect(parseTaskCreatedReceipt({taskManagerAddress:TM,status:0,creations:[expected],logs:[log('7')]}).state).toBe('unknown');
    expect(parseTaskCreatedReceipt({taskManagerAddress:TM,status:1,creations:[expected,{...expected}],logs:[log('7')]}).state).toBe('unknown');
  });
  it('matching title alone cannot reconcile another project, amount, metadata or application flag', () => {
    for(const change of [{projectId:HASH},{payoutRaw:'2'},{metadataHash:ZERO},{requiresApplication:true},{bountyToken:B,bountyPayoutRaw:'1'}]) {
      expect(parseTaskCreatedReceipt({taskManagerAddress:TM,status:1,creations:[expected],logs:[log('7',{...expected,...change})]}).state).toBe('unknown');
    }
  });
});

describe('Graph Node execution capability and binding regressions', () => {
  const schema = buildSchema(fixture('serving-schema.graphql')), binding = { id: ORG, taskManager: { id: TM, organization: { id: ORG } } };
  for (const name of ['FETCH_PROJECT_MANAGERS_PAGE', 'FETCH_TASKS_PAGE', 'FETCH_TASKS_PAGE_LEGACY']) it(`${name}: schema-valid original fails portable planner`, () => {
    const original = fixture(`unsupported-${name.toLowerCase()}.graphql`); expect(validate(schema, parse(original))).toEqual([]);
    for (const s of JSON.parse(fixture('serving-errors.json')).sources) {
      const row = s.errors.find((r: any) => r.name === name); expect(row.errors[0].message).toContain('Child filter nesting not supported by value `taskManager`');
      expect(() => assertServingCapabilities(original, row.variables)).toThrow('Child filter nesting');
    }
    const p = JSON.parse(fixture('serving-plan-provenance.json')); expect(createHash('sha256').update(fixture(p.schemaFixture)).digest('hex')).toBe(p.sha256);
  });
  it('planner rejects child joins supplied through filter variables', () => {
    const doc = 'query Test($where: Task_filter) { tasks(where: $where) { id } }'; expect(validate(schema, parse(doc))).toEqual([]);
    expect(() => assertServingCapabilities(doc, { where: { project_: { taskManager_: { organization: ORG } } } })).toThrow('Child filter nesting');
  });
  it('executes independent streams over 151 projects, 202 active managers and 1205 tasks with exact amounts and exclusions', async () => {
    const projects: any[] = Array.from({ length: 151 }, (_, i) => ({ ...projectRow(i), metadataHash: HASH, metadata: null, createdAt: '1' }));
    projects.push({ ...projects[0], id: 'zz-deleted', deleted: true });
    const managers: any[] = Array.from({ length: 202 }, (_, i) => ({ ...managerRow(i, i % 2 ? B : A), project: projects[Math.floor(i / 2)], addedAt: '1', removedAt: null, lastUpdatedAt: '1' }));
    managers.push({ ...managers[0], id: 'zz-inactive', isActive: false }, { ...managers[0], id: 'zz-deleted', project: projects[151] });
    const tasks: any[] = Array.from({ length: 1205 }, (_, i) => ({ id: `task-${String(i).padStart(6, '0')}`, taskId: String(i), taskManager: TM, project: projects[i % 151], payout: '9007199254740993000001', bountyPayout: '1', bountyToken: B, requiresApplication: false, title: 'T', metadataHash: HASH, metadata: null, status: 'Open', createdAt: '1' }));
    tasks.push({ ...tasks[0], id: 'zz-deleted', project: projects[151] }, { ...tasks[0], id: 'zz-foreign', taskManager: B });
    const roots = { _meta: () => ({ block: { number: 50, hash: HASH, timestamp: 1000 } }), organization: () => binding,
      projects: (a: any) => projects.filter(p => p.id > a.where.id_gt && p.deleted === a.where.deleted && p.taskManager.id === a.where.taskManager).slice(0, a.first),
      projectManagers: (a: any) => managers.filter(m => m.id > a.where.id_gt && m.isActive === a.where.isActive && m.project.deleted === a.where.project_.deleted && m.project.taskManager.id === a.where.project_.taskManager).slice(0, a.first),
      tasks: (a: any) => tasks.filter(t => t.id > a.where.id_gt && t.taskManager === a.where.taskManager && t.project.deleted === a.where.project_.deleted).slice(0, a.first) };
    const query = vi.fn<Parameters<ProtocolQuery>, ReturnType<ProtocolQuery>>(async (doc, vars) => {
      expect(validate(schema, parse(doc))).toEqual([]); assertServingCapabilities(doc, vars);
      const r = await execute({ schema, document: parse(doc), variableValues: vars, rootValue: roots });
      if (r.errors) throw new Error(r.errors.map(e => e.message).join('; ')); return r.data as Record<string, unknown>;
    });
    const ref = source({ account: undefined, snapshot: 'pinned', block: { number: '50', hash: HASH } });
    const p = await listProjectsComplete({ source: ref, query, pageSize: 100 }), m = await listProjectManagersComplete({ source: ref, query, pageSize: 100 }), t = await listTasksComplete({ source: ref, query, pageSize: 1000 });
    expect([p.data.length, m.data.length, t.data.length]).toEqual([151, 202, 1205]); expect([p.coverage.status, m.coverage.status, t.coverage.status]).toEqual(['complete', 'complete', 'complete']);
    expect(t.data[1204].payout).toBe('9007199254740993000001'); expect(query).toHaveBeenCalledTimes(7);
    const legacy = await query(taskDocs.FETCH_TASKS_PAGE_LEGACY, { orgId: ORG, taskManager: TM, cursor: '', first: 1, block: { hash: HASH } }, ref);
    expect((legacy.tasks as IndexedRow[])[0].absoluteDeadline).toBeUndefined(); expect(projectManagerFact(m, { chainId: 100, orgId: ORG, contract: TM }, ZERO, B)).toMatchObject({ state: 'known', value: true });
  });
  const readers = { projects: listProjectsComplete, projectManagers: listProjectManagersComplete, tasks: listTasksComplete };
  for (const [collection, reader] of Object.entries(readers)) for (const chainId of [100, 42161]) {
    const row = () => collection === 'projects' ? projectRow(0) : collection === 'projectManagers' ? managerRow(0) : { id: 'task-0', taskId: '0', taskManager: TM, project: projectRow(0), payout: '1', bountyPayout: '0' };
    it(`${collection} chain ${chainId}: bound empty is complete`, async () => {
      const ref = source({ chainId, snapshot: 'pinned', block: { number: '50', hash: HASH } });
      const result = await reader({ source: ref, query: async (doc, vars, actual) => {
        assertServingCapabilities(doc, vars); expect(validate(schema, parse(doc))).toEqual([]); expect(vars.block).toEqual({ hash: HASH }); expect(actual).toBe(ref);
        return { [collection]: [], organization: binding, _meta: { block: { number: 50, hash: null } } };
      } });
      expect(result.coverage.status).toBe('complete'); expect(result.data).toEqual([]); expect(result.source.block).toEqual(ref.block);
    });
    it.each(['absent-org', 'missing-module', 'null-module', 'foreign-module', 'foreign-org', 'foreign-declared-org'] as const)(`${collection} chain ${chainId}: %s empty cannot prove absence`, async failure => {
      const org: any = { ...binding, taskManager: { ...binding.taskManager, organization: { ...binding.taskManager.organization } } };
      if (failure === 'missing-module') delete org.taskManager;
      if (failure === 'null-module') org.taskManager = null;
      if (failure === 'foreign-module') org.taskManager.id = B;
      if (failure === 'foreign-org') org.id = HASH;
      if (failure === 'foreign-declared-org') org.taskManager.organization.id = HASH;
      const result = await reader({ source: source({ chainId, snapshot: 'pinned', block: { number: '50', hash: HASH } }), query: async () => ({ [collection]: [], organization: failure === 'absent-org' ? null : org, _meta: { block: { number: 50, hash: HASH } } }) });
      expect(result.coverage.status).toBe('unavailable'); expect(result.source.snapshot).toBe('unknown'); expect(result.source.block).toBeUndefined(); expect(result.coverage.issues.some(i => i.code.startsWith('MODULE_BINDING_'))).toBe(true);
    });
    it(`${collection} chain ${chainId}: terminal empty missing binding retains first page as incomplete`, async () => {
      const result = await reader({ source: source({ chainId, snapshot: 'pinned', block: { number: '50', hash: HASH } }), pageSize: 1, query: async (_doc, vars) => ({ [collection]: vars.cursor ? [] : [row()], organization: vars.cursor ? null : binding, _meta: { block: { number: 50, hash: HASH } } }) });
      expect(result.coverage.status).toBe('incomplete'); expect(result.data).toHaveLength(1); expect(result.source.block?.hash).toBe(HASH); expect(result.coverage.issues).toContainEqual({ code: 'MODULE_BINDING_UNAVAILABLE', id: 'page:2' });
    });
    for (const hashes of [[null, HASH], [HASH, null], [HASH, '0x' + '66'.repeat(32)]]) it(`${collection} chain ${chainId}: mixed numeric proof ${hashes} remains incomplete`, async () => {
      const result = await reader({ source: source({ chainId, snapshot: 'pinned', block: { number: '50' } }), pageSize: 1, query: async (_doc, vars) => ({ [collection]: vars.cursor ? [] : [row()], organization: binding, _meta: { block: { number: 50, hash: hashes[vars.cursor ? 1 : 0] } } }) });
      expect(result.coverage.status).toBe('incomplete'); expect(result.coverage.issues).toContainEqual({ code: 'PAGE_SOURCE_MISMATCH', id: 'page:2' }); expect(result.source.block?.hash).toBe(hashes[0] ?? undefined);
    });
    it.each(['missing-id', 'foreign-org', 'foreign-module', 'deleted', 'duplicate', 'stalled', 'cap', 'late-failure'] as const)(`${collection} chain ${chainId}: %s cannot yield complete diagnostic rows`, async failure => {
      const r: any = row(), p: any = collection === 'projects' ? r : r.project;
      if (failure === 'foreign-org') p.taskManager.organization.id = HASH;
      if (failure === 'foreign-module') p.taskManager.id = B;
      if (failure === 'deleted') p.deleted = true;
      if (failure === 'missing-id') delete r.id;
      const result = await reader({ source: source({ chainId }), pageSize: failure === 'duplicate' ? 2 : 1, maxPages: failure === 'cap' ? 1 : 3, query: async (_doc, vars) => {
        if (vars.cursor && failure === 'late-failure') throw new Error('later outage'); return { [collection]: failure === 'duplicate' ? [r, r] : [r], organization: binding };
      } });
      expect(result.coverage.status).toBe('incomplete'); if (failure !== 'missing-id') expect(result.data).toHaveLength(1);
      if (collection === 'projectManagers') expect(projectManagerFact(result, { chainId, orgId: ORG, contract: TM }, ZERO, A).state).toBe('unknown');
    });
  }
  it('inactive manager from nonconforming adapter is incomplete rather than grant a bypass', async () => {
    const result = await listProjectManagersComplete({ source: source(), query: async () => ({ projectManagers: [managerRow(0, A, false)], organization: binding }) });
    expect(result.coverage.status).toBe('incomplete'); expect(result.data).toHaveLength(1); expect(projectManagerFact(result, { chainId: 100, orgId: ORG, contract: TM }, ZERO, A).state).toBe('unknown');
  });
});

describe('saved real-serving read-only successes and partial proof counterexamples', () => {
  it('pins actually served document bytes on both chains and preserves population/absence distinction', async () => {
    const saved = JSON.parse(fixture('serving-successes.json'));
    for (const s of saved.sources) for (const row of s.documents) {
      expect(row.httpStatus).toBe(200); expect(row.errors).toBeUndefined();
      expect(createHash('sha256').update((taskDocs as Record<string, unknown>)[row.name] as string).digest('hex')).toBe(row.documentSha256);
      if (row.name === 'FETCH_TASKS_PAGE') {
        const source = s.canonicalProof.number.tasks.source;
        // The HTTP request selected first:1. A one-page cap preserves its real row
        // without upgrading this bounded sample to a complete board.
        const result = await listTasksComplete({ source: { ...source, snapshot: 'pinned', block: { number: s.documents[0].variables.block.number.toString() } }, pageSize: 1, maxPages: 1, query: async () => row.data });
        expect(result.coverage.status).toBe(s.test6Present ? 'incomplete' : 'unavailable');
        expect(result.data.length).toBe(s.test6Present ? 1 : 0);
      }
    }
    expect(saved.legitimateEmpty.tasks.coverage.status).toBe('complete'); expect(saved.legitimateEmpty.tasks.data).toEqual([]);
    expect(saved.legitimateEmpty.managers.coverage.status).toBe('complete'); expect(saved.legitimateEmpty.managers.data).toEqual([]);
  });
  for (const [collection, reader] of Object.entries({ projects: listProjectsComplete, projectManagers: listProjectManagersComplete, tasks: listTasksComplete })) {
    it.each(['no-meta', 'wrong-number', 'wrong-hash', 'missing-hash'] as const)(`${collection}: %s response cannot echo caller's pin`, async failure => {
      const meta: any = { block: { number: failure === 'wrong-number' ? 51 : 50, hash: failure === 'wrong-hash' ? '0x' + '66'.repeat(32) : HASH } };
      if (failure === 'missing-hash') delete meta.block.hash;
      const result = await reader({ source: source({ snapshot: 'pinned', block: { number: '50', hash: HASH } }), query: async () => ({ [collection]: [], organization: { id: ORG, taskManager: { id: TM, organization: { id: ORG } } }, ...(failure === 'no-meta' ? {} : { _meta: meta }) }) });
      expect(result.coverage.status).toBe('unavailable'); expect(result.source.snapshot).toBe('unknown'); expect(result.source.block).toBeUndefined();
    });
  }
});


describe('invalid work binding selectors refuse before transport', () => {
  it('rejects zero-module, malformed org and latest-with-block without querying', async () => {
    const query = vi.fn();
    for (const ref of [source({ contract: ethers.constants.AddressZero }), source({ orgId: 'unresolved-name' }), source({ block: { number: '50' } })]) {
      for (const read of [listProjectsComplete, listProjectManagersComplete, listTasksComplete]) expect(() => read({ source: ref, query })).toThrow();
    }
    expect(query).not.toHaveBeenCalled();
  });
});
