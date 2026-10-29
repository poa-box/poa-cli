import fs from 'fs';
import type { Argv } from 'yargs';
import { ethers } from 'ethers';
import { normalizeSubjectId } from '@poa-box/core/authority/ids';
import { knownFact } from '@poa-box/core/data/facts';
import { planElection, planRoleRemovals, readRemovalPreflights, electionPlanningFingerprint,
  type ElectionContext, type ElectionPlanningInput, type RemovalPlanningInput } from '@poa-box/core/governance/elections';
import { readRoleEvidence, completeCoverage, statusFromResult } from './evidence';
import * as output from '../../lib/output';

/** Desired choices and exact ban consent are accepted from the review file;
 * rosters, reasons, source sets, capacities and acceptance are always observed. */
export function electionPlanHandler(election: boolean) {
  return {
    builder: (y: Argv) => y.option('file', { type: 'string', demandOption: true, describe: 'JSON choices: subjectId, removals, confirmedBans, candidates, stickyWinner, fallbackSubjectId, includeNoOneOption, expectedFingerprint' }),
    handler: async (argv: any) => {
      const draft = JSON.parse(fs.readFileSync(argv.file, 'utf8'));
      if (!draft || typeof draft !== 'object' || !Array.isArray(draft.removals) || !Array.isArray(draft.confirmedBans)) throw new Error('removals and confirmedBans arrays are required');
      for (const key of ['scope', 'source', 'context', 'preflights', 'freshness']) if (key in draft) throw new Error(`Review choices must not contain evidence field ${key}`);
      const subjectId = normalizeSubjectId(draft.subjectId);
      const evidence = await readRoleEvidence(argv);
      const ids = [subjectId, ...(draft.fallbackSubjectId ? [normalizeSubjectId(draft.fallbackSubjectId)] : [])];
      const accounts = [...new Set<string>([...draft.removals.map((row: any) => row.account), ...(draft.candidates ?? [])]
        .map(address => ethers.utils.getAddress(address).toLowerCase()))];
      const roles = evidence.snapshot.data.subjects.filter(row => row.kind === 'Role');
      const rosters = ids.map(id => {
        if (!roles.some(row => row.subjectId === id)) throw new Error('ELECTION_SUBJECT_UNAVAILABLE');
        return { id, accounts: [...new Set([...accounts, ...evidence.snapshot.data.memberships
          .filter(row => row.subject.subjectId === id && row.accepted).map(row => row.user.toLowerCase())])] };
      });
      const requests = rosters.flatMap(row => row.accounts.map(account => ({ subjectId: row.id, account })));
      const results = await evidence.read(requests.map(row => ({ method: 'getStatus', args: [row.subjectId, row.account] })));
      const userSubjects = await evidence.read(accounts.map(account => ({ method: 'userSubjects', args: [account] })));
      const context: ElectionContext = {
        readiness: { membershipAuthority: evidence.snapshot.data.authority as any }, executorAuthorized: knownFact(true, evidence.rpcSource), paused: knownFact(evidence.paused, evidence.rpcSource),
        subjects: rosters.map(row => {
          const subject = roles.find(subject => subject.subjectId === row.id)!;
          const statuses = requests.flatMap((request, i) => request.subjectId === row.id ? [{ account: request.account, ...statusFromResult(results[i]) }] : []);
          return { subjectId: row.id, kind: 'Role', maxMembers: subject.maxMembers, memberCount: subject.memberCount, statuses,
            rulesRevision: ethers.utils.id(JSON.stringify([subject.raw, evidence.snapshot.data.rules.filter(rule => rule.subjectId === row.id)])) };
        }),
        accounts: accounts.map((account, i) => ({ account, acceptedAnywhere: knownFact(userSubjects[i][0].length > 0, { ...evidence.rpcSource, account }),
          acceptedSubjectIds: knownFact((userSubjects[i][0] as ethers.BigNumber[]).map(id => id.toString()), { ...evidence.rpcSource, account }) })),
      };
      const preflights = await readRemovalPreflights({ source: evidence.rpcSource, subjectId,
        accounts: draft.removals.map((row: any) => row.account), reader: {
          canRemove: async request => {
            const [result] = await evidence.read([{ method: 'canRemove', args: [request.subjectId, request.account, false] }]);
            return { source: { ...request.source, account: request.account }, coverage: completeCoverage,
              data: { reason: Number(result.reason ?? result[0]), sourceSet: Number(result.sourceSet ?? result[1]) } };
          },
          getStatus: async request => {
            const found = requests.findIndex(row => row.subjectId === request.subjectId && row.account === request.account.toLowerCase());
            if (found < 0) throw new Error('GET_STATUS_UNAVAILABLE');
            return { source: { ...request.source, account: request.account }, coverage: completeCoverage, data: statusFromResult(results[found]) };
          },
        } });
      const input: RemovalPlanningInput = { scope: evidence.scope, freshness: evidence.freshness,
        context: { source: evidence.rpcSource, coverage: completeCoverage, data: context }, subjectId, preflights,
        removals: draft.removals, confirmedBans: draft.confirmedBans, expectedFingerprint: draft.expectedFingerprint };
      const plan = election ? planElection({ ...input, candidates: draft.candidates, stickyWinner: draft.stickyWinner,
        includeNoOneOption: draft.includeNoOneOption, fallbackSubjectId: draft.fallbackSubjectId } as ElectionPlanningInput) : planRoleRemovals(input);
      await evidence.assertCanonical();
      const fingerprint = electionPlanningFingerprint(context, preflights.data);
      const result = { orgId: evidence.scope.orgId, plan, fingerprint, preflights, indexedSource: evidence.snapshot.source, liveSource: evidence.rpcSource };
      if (output.isJsonMode()) output.json(result);
      else output.keyValueBlock(election ? 'Election plan' : 'Removal plan', { status: plan.status, fingerprint,
        ...(plan.status === 'blocked' ? { codes: plan.codes.join(', ') } : { options: plan.data.length }) });
    },
  };
}
