import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { fetchProjectsData, fetchTaskData, fetchTaskSubmissionHistory, taskEntityId } from '../src/reads/task';

const TM = '0x1111111111111111111111111111111111111111';
const ORG = '0x' + '22'.repeat(32);
const task = (id: number) => ({ id: `${TM}-${id}`, taskId: String(id), title: `Task ${id}`, status: 'Assigned', metadataHash: null, metadata: null, payout: '1' });
const project = (id: number, tasks = [task(id)]) => ({ id: `${TM}-${ethers.utils.hexZeroPad(ethers.utils.hexlify(id), 32)}`, title: `Project ${id}`, tasks });
const envelope = (projects: any[], tierIndex = 0) => ({ data: { organization: { id: ORG, taskManager: { id: TM, projects } } }, tierIndex });
const eventId = (i: number) => ethers.utils.hexZeroPad(ethers.utils.hexlify(i), 36);
const submission = (i: number) => ({ id: eventId(i), submissionHash: '0x' + 'ab'.repeat(32), submittedAt: String(i), submittedAtBlock: String(i), transactionHash: '0x' + 'cc'.repeat(32), metadata: { submission: `Version ${i}` } });

describe('complete task/project reads', () => {
  it('paginates projects and independently paginates a project with more than 1000 tasks', async () => {
    const calls: any[] = [];
    const queryWithFieldFallback = vi.fn(async (tiers: any[]) => {
      const { query, variables } = tiers[0]; calls.push({ query, variables });
      if (query.includes('FetchProjectTaskPage')) return { data: { project: { tasks: [task(0)] } }, tierIndex: 0 };
      if (variables.projectCursor) return envelope([project(50)]);
      const projects = Array.from({ length: 50 }, (_, i) => project(i));
      projects[0].tasks = Array.from({ length: 1000 }, (_, i) => task(1000 - i));
      return envelope(projects);
    });
    const result = await fetchProjectsData({ queryWithFieldFallback } as any, ORG, 100);
    const projects = result.data.organization!.taskManager!.projects;
    expect(projects).toHaveLength(51);
    expect(projects[0].tasks).toHaveLength(1001);
    expect(projects[0].tasks![1000].taskId).toBe('0');
    expect(calls.find(call => call.variables.projectCursor).variables.projectCursor).toBe(project(49).id);
    expect(calls.find(call => call.variables.taskCursor).variables).toEqual({ projectId: project(0).id, taskCursor: '1' });
    expect(result.hasReleaseData).toBe(true);
  });
  it('refuses a non-advancing project cursor instead of returning a misleading partial list', async () => {
    const projects = Array.from({ length: 50 }, (_, i) => project(i));
    const queryWithFieldFallback = vi.fn(async () => envelope(projects));
    await expect(fetchProjectsData({ queryWithFieldFallback } as any, ORG)).rejects.toThrow('pagination did not advance');
  });
  it('looks up a canonical task directly, with exact uint256 IDs and old-index field tiers', async () => {
    const queryWithFieldFallback = vi.fn(async () => ({ data: { task: task(7) }, tierIndex: 2 }));
    const result = await fetchTaskData({ queryWithFieldFallback } as any, TM, `${TM}-0007`, 100);
    expect(result.task?.taskId).toBe('7');
    expect(result.tierIndex).toBe(2);
    expect(queryWithFieldFallback.mock.calls[0][0][0].variables).toEqual({ taskId: `${TM}-7` });
    expect(taskEntityId(TM, '9007199254740993')).toBe(`${TM}-9007199254740993`);
    expect(() => taskEntityId(TM, Number.MAX_SAFE_INTEGER + 1)).toThrow('exact integer');
    expect(() => taskEntityId(TM, '0x2222222222222222222222222222222222222222-7')).toThrow('different TaskManager');
  });
});

describe('immutable task submission/review history', () => {
  it('keeps a rejected submission and the exact review link despite cleared current submissionHash', async () => {
    const submitted = submission(1);
    const review = { id: eventId(2), rejector: TM, rejectionHash: '0x' + 'ef'.repeat(32), rejectedAt: '2', rejectedAtBlock: '2', transactionHash: '0x' + 'dd'.repeat(32), metadata: { rejection: 'Needs tests' }, submission: submitted };
    const queryWithFieldFallback = vi.fn(async () => ({ tierIndex: 0, data: { task: { submissionHash: null, latestSubmission: submitted, latestRejection: { id: review.id }, submissions: [submitted], rejections: [review] } } }));
    const history = await fetchTaskSubmissionHistory({ queryWithFieldFallback } as any, TM, '7');
    expect(history.indexed).toBe(true);
    expect(history.latestSubmission?.metadata?.submission).toBe('Version 1');
    expect(history.rejections[0].submission?.id).toBe(history.submissions[0].id);
  });
  it('paginates all immutable records with ID cursors, including same-timestamp events', async () => {
    const queryWithFieldFallback = vi.fn(async (tiers: any[]) => ({ tierIndex: 0, data: { task: {
      latestSubmission: submission(1001), latestRejection: null, rejections: [],
      submissions: tiers[0].variables.submissionCursor === '0x' ? Array.from({ length: 1000 }, (_, i) => submission(i + 1)) : [submission(1001)],
    } } }));
    const history = await fetchTaskSubmissionHistory({ queryWithFieldFallback } as any, TM, 7);
    expect(history.submissions).toHaveLength(1001);
    expect(queryWithFieldFallback.mock.calls[1][0][0].variables.submissionCursor).toBe(eventId(1000));
    expect(history.submissions[0].id).toBe(eventId(1001));
  });
  it('reports unindexed history separately from an indexed empty history', async () => {
    const queryWithFieldFallback = vi.fn(async () => ({ tierIndex: 1, data: { task: { id: `${TM}-7` } } }));
    expect((await fetchTaskSubmissionHistory({ queryWithFieldFallback } as any, TM, 7)).indexed).toBe(false);
  });
});
