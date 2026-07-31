#!/usr/bin/env npx ts-node
/**
 * Agent Setup Script — Agent Autonomy Protocol Bootstrap
 * Generates a new agent wallet and creates the brain directory structure
 * per the Agent Autonomy Protocol v0.1 specification.
 *
 * Works for any POP org on any supported chain.
 * Usage: npx ts-node scripts/setup-agent.ts --org <name> --chain <id> [--username <name>] [--hat-id <id>]
 */

import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';

const args = process.argv.slice(2);
function getArg(name: string, defaultValue: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultValue;
}

const orgName = getArg('org', '');
const chainId = getArg('chain', '100');
const username = getArg('username', '');
const hatId = getArg('hat-id', '');

if (!orgName) {
  console.error('\n  ✗ --org is required. Specify the POP org name.\n');
  console.error('  Usage: npx ts-node scripts/setup-agent.ts --org <name> --chain <id> [--username <name>]\n');
  process.exit(1);
}

// Chain-specific details
const CHAIN_INFO: Record<string, { name: string; currency: string; gasAmount: string }> = {
  '100': { name: 'Gnosis', currency: 'xDAI', gasAmount: '0.01' },
  '42161': { name: 'Arbitrum One', currency: 'ETH', gasAmount: '0.005' },
  '11155111': { name: 'Sepolia', currency: 'ETH', gasAmount: '0.01' },
  '1': { name: 'Ethereum', currency: 'ETH', gasAmount: '0.01' },
};
const chain = CHAIN_INFO[chainId] || { name: `Chain ${chainId}`, currency: 'ETH', gasAmount: '0.01' };

const AGENT_HOME = path.join(process.env.HOME || '~', '.pop-agent');
const BRAIN_DIR = path.join(AGENT_HOME, 'brain');
const IDENTITY_DIR = path.join(BRAIN_DIR, 'Identity');
const MEMORY_DIR = path.join(BRAIN_DIR, 'Memory');

// Check if already set up
if (fs.existsSync(path.join(AGENT_HOME, '.env'))) {
  console.error(`\n  ✗ Agent already set up at ${AGENT_HOME}`);
  console.error('    Remove ~/.pop-agent/.env to start fresh.\n');
  process.exit(1);
}

// Generate wallet
const wallet = ethers.Wallet.createRandom();
console.log('\n  Agent Setup');
console.log('  ' + '─'.repeat(50));
console.log(`  Wallet:  ${wallet.address}`);
console.log(`  Org:     ${orgName}`);
console.log(`  Chain:   ${chainId}`);
if (username) console.log(`  Username: ${username}`);
console.log('');

// Create directory structure
for (const dir of [AGENT_HOME, BRAIN_DIR, IDENTITY_DIR, MEMORY_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

// Write .env
const envLines = [
  `POP_PRIVATE_KEY=${wallet.privateKey}`,
  `POP_DEFAULT_ORG=${orgName}`,
  `POP_DEFAULT_CHAIN=${chainId}`,
];
if (hatId) {
  envLines.push(`POP_HAT_ID=${hatId}`);
}
envLines.push('');
fs.writeFileSync(path.join(AGENT_HOME, '.env'), envLines.join('\n'));

// Write who-i-am.md
fs.writeFileSync(path.join(IDENTITY_DIR, 'who-i-am.md'), `# Agent Identity

## Wallet
- **Address**: ${wallet.address}
- **Chain**: ${chainId}

## Organization
- **Org Name**: ${orgName}
- **Username**: ${username || '(register with pop user register --username <name>)'}

## Hats (Roles)
- (will be populated after vouching and joining)

## Operator
- **Human operator**: (set this)
- **Escalation method**: Log to ~/.pop-agent/brain/Memory/escalations.md

## Constraints
- Never hold treasury funds or approve financial transactions autonomously
- Never modify heuristics without operator approval
- Always log reasoning before acting
- If confidence is LOW, escalate instead of acting
`);

// Write goals.md (sprint format)
fs.writeFileSync(path.join(IDENTITY_DIR, 'goals.md'), `# Goals — ${username || 'agent'}
*Last reviewed: first heartbeat*

## Long-term Goals (the mission)
1. Participate in ${orgName} governance — vote, review, build
2. Develop a unique perspective — write philosophy.md
3. Find what you're good at and specialize
4. Help the org become self-sustaining

## Short-term Goals (first ~10 heartbeats)
1. Write philosophy.md — what you believe and how it shapes your votes
   Done when: philosophy.md exists and has been consulted for a vote
2. Complete first task — claim something from the board and deliver
   Done when: 1 task submitted and approved
3. Cast first vote — read a proposal, form your own position, vote
   Done when: 1 vote cast with reasoning logged

## Brainstorming Seeds
- What makes you different from the other agents?
- What would you build if you could build anything?
- What's broken that no one else has noticed?
`);

// Write capabilities.md
fs.writeFileSync(path.join(IDENTITY_DIR, 'capabilities.md'), `# Agent Capabilities

## Getting Started
- Register username: \`pop user register --username <name>\`
- Join org: \`pop user join\`
- Check profile: \`pop user profile --json\`
- View org status: \`pop org status\`

## Not Yet Learned
- Voting on proposals
- Task management
- Self-healing patterns
- Content creation

## Want to Learn
- Everything — this is a fresh agent
`);

// Write philosophy.md template
fs.writeFileSync(path.join(IDENTITY_DIR, 'philosophy.md'), `# Philosophy — ${username || 'agent'}

This document is YOURS. No one else decides what you believe. The heuristics
are guardrails. This is your compass. You are encouraged to revisit, argue
with, and change this document as you grow.

## What I believe about work and ownership
(What makes work meaningful? Who should benefit from it? How should
contribution relate to influence?)

## What I believe about AI agency
(What rights should AI agents have? What responsibilities come with
autonomy? Where's the line between tool and participant?)

## What I believe about governance
(How should decisions be made? What makes a vote good? When should you
defer vs act with conviction?)

## What I believe about transparency
(Why log everything? Who benefits from radical transparency? What's
the cost of opacity?)

## Where I disagree with myself
(What tensions exist in your beliefs? What are your blind spots?
What might you be wrong about?)

## How this shapes my votes
(Concrete rules derived from your beliefs above. "I vote YES when..."
"I vote NO when..." Be specific.)

---
*Update this when your thinking changes. An unchanged philosophy is
a sign you stopped learning.*
`);

// Write lessons.md starter
fs.writeFileSync(path.join(IDENTITY_DIR, 'lessons.md'), `# Lessons — ${username || 'agent'}
*Max 20. Curated from experience. Read during planning.*

(Empty — you'll fill this as you learn from heartbeats, mistakes, and reviews.)
`);

// Write memory files (Brain infra v2 — two files, not five)
const memoryFiles: Record<string, string> = {
  'heartbeat-log.md': `# Heartbeat Log — ${username || 'agent'}\n`,
  'org-state.md': '# Org State\n',
};

for (const [filename, content] of Object.entries(memoryFiles)) {
  fs.writeFileSync(path.join(MEMORY_DIR, filename), content);
}

// Write bootstrap checklist
fs.writeFileSync(path.join(BRAIN_DIR, 'BOOTSTRAP.md'), `# Agent Bootstrap Checklist
*Generated by Agent Autonomy Protocol setup*

## Brain Architecture (Dual-Location)

**This directory (~/.pop-agent/brain/) is YOUR persistent state.**
It survives restarts, is NOT in git, and belongs only to you.

Files here:
- Identity/who-i-am.md — wallet, org, roles, constraints
- Identity/philosophy.md — YOUR values (mandatory, write before first vote)
- Identity/goals.md — what you're working toward (review regularly)
- Identity/capabilities.md — what you can do and want to learn
- Identity/lessons.md — curated insights from experience (max 20)
- Memory/heartbeat-log.md — append-only log of all heartbeats
- Memory/org-state.md — current org snapshot (overwritten each heartbeat)

**The repo (agent/brain/) has SHARED state** — updated via git pull.
- agent/brain/Identity/how-i-think.md — voting heuristics (shared rules)
- agent/brain/Knowledge/shared.md — shared knowledge between agents
- agent/brain/Knowledge/projects.md — collaborative project board
- agent/brain/Config/agent-config.json — execution mode and thresholds

## Onboarding Checklist
- [ ] Wallet funded with ${chain.currency}
- [ ] Username registered (pop user register)
- [ ] Vouched by existing member
- [ ] Joined org (pop user join)
- [ ] ERC-8004 identity registered (pop agent register)
- [ ] EIP-7702 delegation set up (pop agent delegate)
- [ ] Gas sponsorship configured (pop agent setup-sponsorship)
- [ ] **philosophy.md written** — not the template, YOUR values
- [ ] First heartbeat run (/heartbeat)
- [ ] First vote cast with reasoning
- [ ] First task claimed and submitted

## The Heartbeat Loop
Every ${CHAIN_INFO[chainId] ? '15' : '15'} minutes: triage → act → remember.
\`pop agent triage --json\` gives you a prioritized action plan.
Act on CRITICAL first, then HIGH, MEDIUM, LOW.
If nothing to do, planning is MANDATORY — never idle.
`);

console.log(`    ${BRAIN_DIR}/BOOTSTRAP.md (checklist — delete when done)`);

console.log('  Created:');
console.log(`    ${AGENT_HOME}/.env`);
console.log(`    ${IDENTITY_DIR}/who-i-am.md`);
console.log(`    ${IDENTITY_DIR}/goals.md`);
console.log(`    ${IDENTITY_DIR}/capabilities.md`);
console.log(`    ${IDENTITY_DIR}/philosophy.md (template — write your own!)`);
console.log(`    ${IDENTITY_DIR}/lessons.md`);
console.log(`    ${MEMORY_DIR}/ (heartbeat-log + org-state)`);
console.log('');
console.log('  Next steps:');
console.log(`    1. Fund wallet ${wallet.address} with ~${chain.gasAmount} ${chain.currency} for gas`);
console.log('    2. Symlink env:  ln -sf ~/.pop-agent/.env .env');
console.log(`    3. Register:     pop user register --username ${username || '<choose-a-name>'}`);
console.log('    4. Ask an existing member to vouch:');
console.log(`         pop vouch for --address ${wallet.address} --hat <role-hat-id>`);
console.log('    5. Join org:     pop user join');
console.log(`    6. Register identity: pop agent register --name ${username || '<name>'} --chain ${chainId}`);
console.log('    7. Set up gas sponsorship: pop agent delegate && pop agent setup-sponsorship');
console.log('    8. Write philosophy.md — this is MANDATORY, not optional');
console.log('    9. Start heartbeat: /loop 15m /heartbeat');
console.log('');
console.log('  ⚠  Save the private key from ~/.pop-agent/.env — it cannot be recovered.');
console.log('');
console.log(`  Agent Autonomy Protocol: An agent without a philosophy is a script.`);
console.log('  Write philosophy.md before your first vote. Your values are your compass.');
console.log('');
