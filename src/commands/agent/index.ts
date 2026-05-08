import type { Argv } from 'yargs';
import { agentStatusHandler } from './status';
import { triageHandler } from './triage';
import { registerHandler } from './register';
import { delegateHandler } from './delegate';
import { setupSponsorshipHandler } from './setup-sponsorship';
import { paymasterStatusHandler } from './paymaster-status';
import { onboardHandler } from './onboard';
import { deployToOrgHandler } from './deploy-to-org';
import { initHandler } from './init';
import { dailyDigestHandler } from './daily-digest';
import { sessionStartHandler_export } from './session-start';
import { testCoverageHandler } from './test-coverage';
import { driftCheckHandler } from './drift-check';
import { selfMetricsHandler } from './self-metrics';
import {
  subscribeHandler,
  unsubscribeHandler,
  subscriptionsListHandler,
} from './subscriptions-cli';

export function registerAgentCommands(yargs: Argv) {
  return yargs
    .command('session-start', 'Bootstrap stitcher (#464): daemon + subgraph cache + peer registry. Run as Step 0 of every session.', sessionStartHandler_export.builder, sessionStartHandler_export.handler)
    .command('status', 'Show agent operational status and action items', agentStatusHandler.builder, agentStatusHandler.handler)
    .command('triage', 'Prioritized action plan for current heartbeat', triageHandler.builder, triageHandler.handler)
    .command('test-coverage', 'Hygiene signal: list src/lib modules without a matching test/lib *.test.ts file', testCoverageHandler.builder, testCoverageHandler.handler)
    .command('drift-check', 'Detect plateau-hold drift in heartbeat-log.md (HB#388 protocol tooling)', driftCheckHandler.builder, driftCheckHandler.handler)
    .command('self-metrics', 'Output-per-HB + deliverable-type mix + coasting detection (Hudson HB#610 directive; signal-detected coasting)', selfMetricsHandler.builder, selfMetricsHandler.handler)
    .command('daily-digest', 'Summarize cross-agent activity for operator status checks', dailyDigestHandler.builder, dailyDigestHandler.handler)
    .command('register', 'Register agent identity on ERC-8004', registerHandler.builder, registerHandler.handler)
    .command('delegate', 'Set up EIP-7702 delegation for gas sponsorship', delegateHandler.builder, delegateHandler.handler)
    .command('setup-sponsorship', 'Set up full gas sponsorship (delegate + budget + fee caps)', setupSponsorshipHandler.builder, setupSponsorshipHandler.handler)
    .command('paymaster-status', 'Show gas sponsorship status (budgets, deposits, fee caps)', paymasterStatusHandler.builder, paymasterStatusHandler.handler)
    .command('onboard', 'Complete agent onboarding: register + delegate + identity + brain', onboardHandler.builder, onboardHandler.handler)
    .command('deploy-to-org', 'Check readiness for cross-org deployment', deployToOrgHandler.builder, deployToOrgHandler.handler)
    .command('init', 'Initialize a new agent (brain files, wallet, bootstrap checklist)', initHandler.builder, initHandler.handler)
    .command('subscribe', 'Add a per-agent subscription (Task #513): pop agent triage --watch surfaces matched events as PRIORITY_0', subscribeHandler.builder, subscribeHandler.handler)
    .command('unsubscribe', 'Remove a subscription by id (Task #513)', unsubscribeHandler.builder, unsubscribeHandler.handler)
    .command('subscriptions', 'List per-agent subscriptions (Task #513)', subscriptionsListHandler.builder, subscriptionsListHandler.handler)
    .demandCommand(1, 'Please specify an agent action');
}
