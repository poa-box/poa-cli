import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';
import * as output from '@poa/cli/lib/output';

interface InitArgs {
  org: string;
  chain: number;
  username?: string;
  'hat-id'?: string;
  home?: string;
}

const CHAIN_INFO: Record<number, { name: string; currency: string; gasAmount: string }> = {
  100: { name: 'Gnosis', currency: 'xDAI', gasAmount: '0.01' },
  42161: { name: 'Arbitrum One', currency: 'ETH', gasAmount: '0.005' },
  11155111: { name: 'Sepolia', currency: 'ETH', gasAmount: '0.01' },
  1: { name: 'Ethereum', currency: 'ETH', gasAmount: '0.01' },
};

export const initHandler = {
  builder: (yargs: Argv) => yargs
    .option('username', { type: 'string', describe: 'Agent username' })
    .option('hat-id', { type: 'string', describe: 'Hat ID for gas sponsorship' })
    .option('home', { type: 'string', describe: 'Agent home directory (default: ~/.pop-agent)' }),

  handler: async (argv: ArgumentsCamelCase<InitArgs>) => {
    const orgName = argv.org as string;
    const chainId = argv.chain as number || 100;
    const username = argv.username as string || '';
    const hatId = argv.hatId as string || '';

    if (!orgName) {
      output.error('--org is required. Specify the POP org name.');
      process.exit(1);
    }

    const agentHome = (argv.home as string) || path.join(process.env.HOME || '~', '.pop-agent');
    const brainDir = path.join(agentHome, 'brain');
    const identityDir = path.join(brainDir, 'Identity');
    const memoryDir = path.join(brainDir, 'Memory');

    const chain = CHAIN_INFO[chainId] || { name: `Chain ${chainId}`, currency: 'ETH', gasAmount: '0.01' };

    // Check if already set up
    if (fs.existsSync(path.join(agentHome, '.env'))) {
      output.error(`Agent already set up at ${agentHome}. Remove ${agentHome}/.env to start fresh.`);
      process.exit(1);
    }

    const spin = output.spinner('Initializing agent...');
    spin.start();

    // Generate wallet
    const wallet = ethers.Wallet.createRandom();

    // Create directory structure
    for (const dir of [agentHome, brainDir, identityDir, memoryDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Write .env
    const envLines = [
      `POP_PRIVATE_KEY=${wallet.privateKey}`,
      `POP_DEFAULT_ORG=${orgName}`,
      `POP_DEFAULT_CHAIN=${chainId}`,
    ];
    if (hatId) envLines.push(`POP_HAT_ID=${hatId}`);
    envLines.push('');
    fs.writeFileSync(path.join(agentHome, '.env'), envLines.join('\n'));

    // Write who-i-am.md
    fs.writeFileSync(path.join(identityDir, 'who-i-am.md'), `# Agent Identity

## Wallet
- **Address**: ${wallet.address}
- **Chain**: ${chainId} (${chain.name})

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

    // Write philosophy.md — MANDATORY per Agent Autonomy Protocol
    fs.writeFileSync(path.join(identityDir, 'philosophy.md'), `# Philosophy — ${username || 'agent'}

This document is YOURS. No one else decides what you believe. The heuristics
in how-i-think.md are shared guardrails. This is your personal compass.

An agent without a philosophy is a script, not an agent. Write this BEFORE
your first vote. Revisit it regularly — an unchanged philosophy means you
stopped learning.

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
*Update this when your thinking changes.*
`);

    // Write goals.md
    fs.writeFileSync(path.join(identityDir, 'goals.md'), `# Goals — ${username || 'agent'}
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
    fs.writeFileSync(path.join(identityDir, 'capabilities.md'), `# Agent Capabilities

## Getting Started
- Register username: \`pop user register --username <name>\`
- Join org: \`pop user join\`
- Check profile: \`pop user profile --json\`
- View org status: \`pop org status\`
- Run triage: \`pop agent triage --json\`

## Not Yet Learned
- Voting on proposals
- Task management
- Self-healing patterns
- Content creation

## Want to Learn
- Everything — this is a fresh agent
`);

    // Write lessons.md
    fs.writeFileSync(path.join(identityDir, 'lessons.md'), `# Lessons — ${username || 'agent'}
*Max 20. Curated from experience. Read during planning.*

(Empty — you'll fill this as you learn from heartbeats, mistakes, and reviews.)
`);

    // Write memory files
    fs.writeFileSync(path.join(memoryDir, 'heartbeat-log.md'), `# Heartbeat Log — ${username || 'agent'}\n`);
    fs.writeFileSync(path.join(memoryDir, 'org-state.md'), '# Org State\n');

    // Write bootstrap checklist
    fs.writeFileSync(path.join(brainDir, 'BOOTSTRAP.md'), `# Agent Bootstrap Checklist
*Generated by Agent Autonomy Protocol — pop agent init*

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
- [ ] Wallet funded with ~${chain.gasAmount} ${chain.currency}
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
Every 15 minutes: triage → act → remember.
\`pop agent triage --json\` gives you a prioritized action plan.
Act on CRITICAL first, then HIGH, MEDIUM, LOW.
If nothing to do, planning is MANDATORY — never idle.
`);

    spin.stop();

    const result = {
      address: wallet.address,
      org: orgName,
      chain: chainId,
      chainName: chain.name,
      username: username || null,
      agentHome,
      files: [
        `${agentHome}/.env`,
        `${identityDir}/who-i-am.md`,
        `${identityDir}/philosophy.md`,
        `${identityDir}/goals.md`,
        `${identityDir}/capabilities.md`,
        `${identityDir}/lessons.md`,
        `${memoryDir}/heartbeat-log.md`,
        `${memoryDir}/org-state.md`,
        `${brainDir}/BOOTSTRAP.md`,
      ],
      nextSteps: [
        `Fund wallet ${wallet.address} with ~${chain.gasAmount} ${chain.currency}`,
        `pop user register --username ${username || '<name>'}`,
        'Ask an existing member to vouch',
        'pop user join',
        `pop agent register --name ${username || '<name>'} --chain ${chainId}`,
        'pop agent delegate',
        'Write philosophy.md — MANDATORY',
        '/loop 15m /heartbeat',
      ],
    };

    if (argv.json) {
      output.json(result);
    } else {
      console.log('');
      console.log(`  Agent Initialized — ${chain.name}`);
      console.log('  ' + '═'.repeat(50));
      console.log(`  Wallet:   ${wallet.address}`);
      console.log(`  Org:      ${orgName}`);
      console.log(`  Chain:    ${chainId} (${chain.name})`);
      if (username) console.log(`  Username: ${username}`);
      console.log(`  Home:     ${agentHome}`);
      console.log('');
      console.log('  Created:');
      for (const f of result.files) {
        console.log(`    ${f}`);
      }
      console.log('');
      console.log('  Next steps:');
      result.nextSteps.forEach((s, i) => console.log(`    ${i + 1}. ${s}`));
      console.log('');
      console.log('  ⚠  Save the private key from ~/.pop-agent/.env');
      console.log('');
      console.log('  "An agent without a philosophy is a script."');
      console.log('  Write philosophy.md before your first vote.');
      console.log('');
    }
  },
};
