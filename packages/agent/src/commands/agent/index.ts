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

export function registerAgentCommands(yargs: Argv) {
  return yargs
    .command('status', 'Show agent operational status and action items', agentStatusHandler.builder, agentStatusHandler.handler)
    .command('triage', 'Prioritized action plan for current heartbeat', triageHandler.builder, triageHandler.handler)
    .command('daily-digest', 'Summarize cross-agent activity for operator status checks', dailyDigestHandler.builder, dailyDigestHandler.handler)
    .command('register', 'Register agent identity on ERC-8004', registerHandler.builder, registerHandler.handler)
    .command('delegate', 'Set up EIP-7702 delegation for gas sponsorship', delegateHandler.builder, delegateHandler.handler)
    .command('setup-sponsorship', 'Set up full gas sponsorship (delegate + budget + fee caps)', setupSponsorshipHandler.builder, setupSponsorshipHandler.handler)
    .command('paymaster-status', 'Show gas sponsorship status (budgets, deposits, fee caps)', paymasterStatusHandler.builder, paymasterStatusHandler.handler)
    .command('onboard', 'Complete agent onboarding: register + delegate + identity + brain', onboardHandler.builder, onboardHandler.handler)
    .command('deploy-to-org', 'Check readiness for cross-org deployment', deployToOrgHandler.builder, deployToOrgHandler.handler)
    .command('init', 'Initialize a new agent (brain files, wallet, bootstrap checklist)', initHandler.builder, initHandler.handler)
    .demandCommand(1, 'Please specify an agent action');
}
