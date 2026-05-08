import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import * as output from '../../lib/output';
import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { isRegistered, getAgentTokenId } from '../../lib/erc8004';
import { getX402PaidFetch } from '../../lib/x402';
import { resolveNetworkConfig } from '../../config/networks';

interface ValidateArgs {
  org: string;
  home?: string;
  chain?: number;
}

interface Check {
  name: string;
  status: 'PASS' | 'FAIL' | 'WARN';
  detail: string;
}

export const validateHandler = {
  builder: (yargs: Argv) => yargs
    .option('home', { type: 'string', describe: 'Agent home directory (default: ~/.pop-agent)' }),

  handler: async (argv: ArgumentsCamelCase<ValidateArgs>) => {
    const spin = output.spinner('Validating agent brain...');
    spin.start();

    try {
      const agentHome = (argv.home as string) || path.join(homedir(), '.pop-agent');
      const brainDir = path.join(agentHome, 'brain');
      const checks: Check[] = [];

      // 1. Brain directory exists
      if (fs.existsSync(brainDir)) {
        checks.push({ name: 'Brain directory', status: 'PASS', detail: brainDir });
      } else {
        checks.push({ name: 'Brain directory', status: 'FAIL', detail: `${brainDir} not found. Run pop agent init.` });
        spin.stop();
        outputResults(checks, argv.json as boolean);
        return;
      }

      // 2. Required Identity files
      const identityFiles = [
        { file: 'Identity/who-i-am.md', required: true, minLines: 5 },
        { file: 'Identity/philosophy.md', required: true, minLines: 10 },
        { file: 'Identity/goals.md', required: true, minLines: 3 },
        { file: 'Identity/capabilities.md', required: true, minLines: 3 },
      ];

      for (const f of identityFiles) {
        const filePath = path.join(brainDir, f.file);
        if (!fs.existsSync(filePath)) {
          checks.push({ name: f.file, status: f.required ? 'FAIL' : 'WARN', detail: 'Missing' });
        } else {
          const content = fs.readFileSync(filePath, 'utf-8');
          const lines = content.split('\n').filter(l => l.trim().length > 0);
          if (lines.length < f.minLines) {
            checks.push({ name: f.file, status: 'WARN', detail: `Only ${lines.length} lines — may be a template. Write your own content.` });
          } else {
            checks.push({ name: f.file, status: 'PASS', detail: `${lines.length} lines` });
          }
        }
      }

      // 3. Memory files
      const memoryFiles = ['Memory/heartbeat-log.md', 'Memory/org-state.md'];
      for (const f of memoryFiles) {
        const filePath = path.join(brainDir, f);
        if (fs.existsSync(filePath)) {
          const size = fs.statSync(filePath).size;
          checks.push({ name: f, status: 'PASS', detail: `${Math.round(size / 1024)} KB` });
        } else {
          checks.push({ name: f, status: 'WARN', detail: 'Missing — will be created on first heartbeat' });
        }
      }

      // 4. Philosophy quality check
      const philPath = path.join(brainDir, 'Identity/philosophy.md');
      if (fs.existsSync(philPath)) {
        const phil = fs.readFileSync(philPath, 'utf-8');
        const hasVotingRules = /vote|voting/i.test(phil);
        const hasValues = /believe|value|principle/i.test(phil);
        const hasWorkRules = /work|task|build/i.test(phil);

        if (!hasValues) {
          checks.push({ name: 'Philosophy: values', status: 'WARN', detail: 'No value statements found. Philosophy should express beliefs.' });
        } else {
          checks.push({ name: 'Philosophy: values', status: 'PASS', detail: 'Contains value statements' });
        }
        if (!hasVotingRules) {
          checks.push({ name: 'Philosophy: voting', status: 'WARN', detail: 'No voting rules found. Add how values shape your votes.' });
        } else {
          checks.push({ name: 'Philosophy: voting', status: 'PASS', detail: 'Contains voting guidance' });
        }
        if (!hasWorkRules) {
          checks.push({ name: 'Philosophy: work selection', status: 'WARN', detail: 'No work selection rules. Add how values shape task choices.' });
        } else {
          checks.push({ name: 'Philosophy: work', status: 'PASS', detail: 'Contains work selection guidance' });
        }
      }

      // 5. Environment
      const envPath = path.join(agentHome, '.env');
      if (fs.existsSync(envPath)) {
        const env = fs.readFileSync(envPath, 'utf-8');
        const hasKey = env.includes('POP_PRIVATE_KEY');
        const hasOrg = env.includes('POP_DEFAULT_ORG');
        const hasChain = env.includes('POP_DEFAULT_CHAIN');
        const hasPimlico = env.includes('PIMLICO_API_KEY');

        checks.push({ name: '.env: wallet', status: hasKey ? 'PASS' : 'FAIL', detail: hasKey ? 'Private key configured' : 'POP_PRIVATE_KEY missing' });
        checks.push({ name: '.env: org', status: hasOrg ? 'PASS' : 'FAIL', detail: hasOrg ? 'Default org set' : 'POP_DEFAULT_ORG missing' });
        checks.push({ name: '.env: chain', status: hasChain ? 'PASS' : 'FAIL', detail: hasChain ? 'Chain configured' : 'POP_DEFAULT_CHAIN missing' });
        checks.push({ name: '.env: sponsorship', status: hasPimlico ? 'PASS' : 'WARN', detail: hasPimlico ? 'Gas sponsorship configured' : 'PIMLICO_API_KEY missing — run pop agent setup-sponsorship' });
      } else {
        checks.push({ name: '.env', status: 'FAIL', detail: 'No .env file found' });
      }

      // 6. ERC-8004 identity
      try {
        const networkConfig = resolveNetworkConfig(argv.chain);
        const provider = new ethers.providers.JsonRpcProvider(networkConfig.resolvedRpc);
        const pk = process.env.POP_PRIVATE_KEY;
        if (pk) {
          const wallet = new ethers.Wallet(pk);
          const registered = await isRegistered(wallet.address, provider);
          if (registered) {
            const tokenId = await getAgentTokenId(wallet.address, provider);
            checks.push({ name: 'ERC-8004 identity', status: 'PASS', detail: `Registered as #${tokenId}` });
          } else {
            checks.push({ name: 'ERC-8004 identity', status: 'WARN', detail: 'Not registered — run pop agent register' });
          }
        } else {
          checks.push({ name: 'ERC-8004 identity', status: 'WARN', detail: 'No private key to check registration' });
        }
      } catch {
        checks.push({ name: 'ERC-8004 identity', status: 'WARN', detail: 'Could not query registry' });
      }

      // 7. x402 payment client
      try {
        const paidFetch = getX402PaidFetch();
        if (paidFetch) {
          checks.push({ name: 'x402 payments', status: 'PASS', detail: 'Client initialized' });
        } else if (process.env.X402_ENABLED === 'false') {
          checks.push({ name: 'x402 payments', status: 'WARN', detail: 'Disabled via X402_ENABLED=false' });
        } else if (!process.env.POP_PRIVATE_KEY) {
          checks.push({ name: 'x402 payments', status: 'WARN', detail: 'No POP_PRIVATE_KEY — cannot sign payments' });
        } else {
          checks.push({ name: 'x402 payments', status: 'WARN', detail: 'SDK not available' });
        }
      } catch {
        checks.push({ name: 'x402 payments', status: 'WARN', detail: 'Client initialization failed' });
      }

      // Summary
      const passed = checks.filter(c => c.status === 'PASS').length;
      const failed = checks.filter(c => c.status === 'FAIL').length;
      const warned = checks.filter(c => c.status === 'WARN').length;
      const total = checks.length;
      const score = Math.round((passed / total) * 100);

      spin.stop();
      outputResults(checks, argv.json as boolean, { passed, failed, warned, total, score });

    } catch (err: any) {
      spin.stop();
      output.error(err.message);
      process.exit(1);
    }
  },
};

function outputResults(checks: Check[], json: boolean, summary?: any) {
  if (json) {
    output.json({ checks, summary });
  } else {
    console.log('\n  Agent Brain Validation');
    console.log('  ' + '═'.repeat(45));
    for (const c of checks) {
      const icon = c.status === 'PASS' ? '\x1b[32m✓\x1b[0m' : c.status === 'FAIL' ? '\x1b[31m✗\x1b[0m' : '\x1b[33m⚠\x1b[0m';
      console.log(`  ${icon} ${c.name}: ${c.detail}`);
    }
    if (summary) {
      console.log('\n  ' + '─'.repeat(45));
      console.log(`  Score: ${summary.score}% (${summary.passed} pass, ${summary.failed} fail, ${summary.warned} warn)`);
      if (summary.failed > 0) console.log('  Fix FAIL items before running heartbeats.');
      if (summary.score === 100) console.log('  Brain is fully conformant with AAP v1.0.');
    }
    console.log('');
  }
}
