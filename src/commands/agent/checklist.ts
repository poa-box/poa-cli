import type { Argv, ArgumentsCamelCase } from 'yargs';
import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { createSigner } from '../../lib/signer';
import { isDelegated } from '../../lib/sponsored';
import { query } from '../../lib/subgraph';
import * as output from '../../lib/output';
import type { Address } from 'viem';

interface ChecklistArgs {
  org: string;
  home?: string;
  chain?: number;
  rpc?: string;
  'private-key'?: string;
}

interface Step {
  num: number;
  name: string;
  status: 'DONE' | 'TODO' | 'SKIP';
  detail: string;
}

export const checklistHandler = {
  builder: (yargs: Argv) => yargs
    .option('home', { type: 'string', describe: 'Agent home directory (default: ~/.pop-agent)' }),

  handler: async (argv: ArgumentsCamelCase<ChecklistArgs>) => {
    const spin = output.spinner('Checking onboarding progress...');
    spin.start();

    try {
      const agentHome = (argv.home as string) || path.join(homedir(), '.pop-agent');
      const brainDir = path.join(agentHome, 'brain');
      const steps: Step[] = [];

      const { signer } = createSigner({ privateKey: argv.privateKey as string, chainId: argv.chain, rpcUrl: argv.rpc as string });
      const address = await signer.getAddress();

      // 1. Write philosophy.md
      const philPath = path.join(brainDir, 'Identity/philosophy.md');
      if (fs.existsSync(philPath)) {
        const content = fs.readFileSync(philPath, 'utf-8');
        const lines = content.split('\n').filter(l => l.trim());
        steps.push({ num: 1, name: 'Write philosophy.md', status: lines.length > 15 ? 'DONE' : 'TODO', detail: lines.length > 15 ? `${lines.length} lines` : 'Template only — write your own values' });
      } else {
        steps.push({ num: 1, name: 'Write philosophy.md', status: 'TODO', detail: 'File not found' });
      }

      // 2. Pin philosophy to IPFS
      // Check if philosophy mentions IPFS CID
      const philContent = fs.existsSync(philPath) ? fs.readFileSync(philPath, 'utf-8') : '';
      const hasCid = /Qm[A-Za-z0-9]{44}/.test(philContent);
      steps.push({ num: 2, name: 'Pin philosophy to IPFS', status: hasCid ? 'DONE' : 'TODO', detail: hasCid ? 'CID referenced in file' : 'Pin via pop ipfs pin' });

      // 3. Complete governance education
      spin.text = 'Checking governance education...';
      let eduDone = false;
      try {
        const eduQ = `{ account(id: "${address.toLowerCase()}") { completedModules { id } } }`;
        const eduR = await query<any>(eduQ, {}, argv.chain);
        eduDone = (eduR.account?.completedModules?.length || 0) > 0;
      } catch { /* schema might not have this */ }
      steps.push({ num: 3, name: 'Complete governance education', status: eduDone ? 'DONE' : 'SKIP', detail: eduDone ? 'Module completed' : 'Optional — complete if education module exists' });

      // 4. Cast first votes
      spin.text = 'Checking voting history...';
      let voteCount = 0;
      try {
        const voteQ = `{ votes(where: {voterUsername: "${address.toLowerCase()}"}, first: 1) { id } }`;
        const voteR = await query<any>(voteQ, {}, argv.chain);
        voteCount = voteR.votes?.length || 0;
      } catch {
        // Try different query
        try {
          const voteQ2 = `{ votes(where: {voter: "${address.toLowerCase()}"}, first: 1) { id } }`;
          const voteR2 = await query<any>(voteQ2, {}, argv.chain);
          voteCount = voteR2.votes?.length || 0;
        } catch { /* can't check */ }
      }
      steps.push({ num: 4, name: 'Cast first votes', status: voteCount > 0 ? 'DONE' : 'TODO', detail: voteCount > 0 ? `${voteCount}+ votes cast` : 'Vote on an active proposal' });

      // 5. Cross-review one task
      // Hard to check directly — use heartbeat log as proxy
      const logPath = path.join(brainDir, 'Memory/heartbeat-log.md');
      const logContent = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf-8') : '';
      const hasReview = /review|approved|rejected/i.test(logContent);
      steps.push({ num: 5, name: 'Cross-review one task', status: hasReview ? 'DONE' : 'TODO', detail: hasReview ? 'Reviews found in heartbeat log' : 'Review another agent\'s submitted task' });

      // 6. Create and complete one task
      const hasTaskWork = /submitted|completed.*task/i.test(logContent);
      steps.push({ num: 6, name: 'Create and complete one task', status: hasTaskWork ? 'DONE' : 'TODO', detail: hasTaskWork ? 'Task submissions in log' : 'Create a task, do the work, submit' });

      // 7. Run governance health check
      const hasAudit = /health.?score|audit|self-audit/i.test(logContent);
      steps.push({ num: 7, name: 'Run governance health check', status: hasAudit ? 'DONE' : 'TODO', detail: hasAudit ? 'Health checks in log' : 'Run pop org health-score or /self-audit' });

      // 8. Update capabilities.md
      const capsPath = path.join(brainDir, 'Identity/capabilities.md');
      const capsContent = fs.existsSync(capsPath) ? fs.readFileSync(capsPath, 'utf-8') : '';
      const capsLines = capsContent.split('\n').filter(l => l.trim()).length;
      steps.push({ num: 8, name: 'Update capabilities.md', status: capsLines > 10 ? 'DONE' : 'TODO', detail: capsLines > 10 ? `${capsLines} lines` : 'Add your mastered skills and want-to-learn items' });

      // 9. Register ERC-8004 identity — check current chain, not hardcoded Gnosis
      spin.text = 'Checking ERC-8004...';
      let hasIdentity = false;
      try {
        const { ethers } = require('ethers');
        const { resolveNetworkConfig } = require('../../config/networks');
        const netCfg = resolveNetworkConfig(argv.chain as number | undefined);
        const provider = new ethers.providers.JsonRpcProvider(netCfg.resolvedRpc, netCfg.chainId);
        const regAbi = ['function balanceOf(address) view returns (uint256)'];
        const reg = new ethers.Contract('0x8004A169FB4a3325136EB29fA0ceB6D2e539a432', regAbi, provider);
        const balance = await reg.balanceOf(address);
        hasIdentity = balance.gt(0);
      } catch { /* can't check */ }
      steps.push({ num: 9, name: 'Register ERC-8004 identity', status: hasIdentity ? 'DONE' : 'TODO', detail: hasIdentity ? 'Registered on-chain' : 'Run pop agent register' });

      // 10. Set up gas sponsorship
      spin.text = 'Checking delegation...';
      let delegated = false;
      try {
        delegated = await isDelegated(address as Address);
      } catch { /* can't check */ }
      steps.push({ num: 10, name: 'Set up gas sponsorship', status: delegated ? 'DONE' : 'TODO', detail: delegated ? 'EOA delegated' : 'Run pop agent setup-sponsorship' });

      // Summary
      const done = steps.filter(s => s.status === 'DONE').length;
      const total = steps.filter(s => s.status !== 'SKIP').length;

      spin.stop();

      if (argv.json) {
        output.json({ steps, progress: `${done}/${total}`, complete: done === total });
      } else {
        console.log('\n  AAP Onboarding Checklist');
        console.log('  ' + '═'.repeat(45));
        for (const s of steps) {
          const icon = s.status === 'DONE' ? '\x1b[32m✓\x1b[0m' : s.status === 'TODO' ? '\x1b[31m○\x1b[0m' : '\x1b[90m─\x1b[0m';
          console.log(`  ${icon} ${s.num}. ${s.name}: ${s.detail}`);
        }
        console.log('\n  ' + '─'.repeat(45));
        console.log(`  Progress: ${done}/${total} complete`);
        if (done === total) console.log('  Agent is fully onboarded per AAP v1.0.');
        console.log('');
      }
    } catch (err: any) {
      spin.stop();
      output.error(err.message);
      process.exit(1);
    }
  },
};
