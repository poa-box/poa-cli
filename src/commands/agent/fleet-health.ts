/**
 * pop agent fleet-health — diagnose brain.shared sync state across the fleet.
 *
 * Closes the HB#1043/#1045 dark-peer failure mode where brain.shared sync
 * silently degrades: daemon shows conns > 0 but peer-write state is stale
 * by hours. Step 3c WARN-on-zero-conns is insufficient; this command
 * surfaces peer-write-ts deltas so heartbeat Step 3d can auto-detect.
 *
 * Sprint 22 P7 (sentinel HB#1044 brainstorm idea, task #538). Companion
 * to a heartbeat-skill Step 3d that uses this command's output to decide
 * whether to trigger daemon restart + brain repair.
 *
 * Algorithm: read pop.brain.shared, compute max(timestamp) per non-self
 * author, compare to clock-now. Flag any peer whose latest write is
 * older than --threshold-hours (default 12).
 *
 * Exit codes:
 *   0 — all peers fresh (within threshold)
 *   2 — at least one peer stale (threshold exceeded)
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { spawnSync } from 'child_process';
import * as output from '../../lib/output';

interface Args {
  json?: boolean;
  thresholdHours?: number;
  doc?: string;
  selfAddress?: string;
}

interface PeerState {
  address: string;
  latestTs: number;
  ageHours: number;
  stale: boolean;
  lessonCount: number;
}

function readSelfAddress(): string | null {
  try {
    const home = process.env.HOME || '';
    const envPath = `${home}/.pop-agent/.env`;
    const fs = require('fs');
    if (!fs.existsSync(envPath)) return null;
    const env = fs.readFileSync(envPath, 'utf8');
    const m = env.match(/^POP_AGENT_ADDRESS=(.+)$/m);
    return m ? m[1].trim().toLowerCase() : null;
  } catch {
    return null;
  }
}

function deriveAddressFromKey(): string | null {
  try {
    const home = process.env.HOME || '';
    const envPath = `${home}/.pop-agent/.env`;
    const fs = require('fs');
    if (!fs.existsSync(envPath)) return null;
    const env = fs.readFileSync(envPath, 'utf8');
    const m = env.match(/^POP_PRIVATE_KEY=(.+)$/m);
    if (!m) return null;
    const { ethers } = require('ethers');
    return new ethers.Wallet(m[1].trim()).address.toLowerCase();
  } catch {
    return null;
  }
}

export const fleetHealthHandler = {
  builder: (yargs: Argv) =>
    yargs
      .option('threshold-hours', {
        type: 'number',
        default: 12,
        describe: 'Stale-threshold for peer writes. Default: 12 hours.',
      })
      .option('doc', {
        type: 'string',
        default: 'pop.brain.shared',
        describe: 'Brain doc to check.',
      })
      .option('self-address', {
        type: 'string',
        describe: 'Override own-address detection (otherwise read from ~/.pop-agent/.env).',
      }),

  handler: async (argv: ArgumentsCamelCase<Args>) => {
    const thresholdHours = argv.thresholdHours ?? 12;
    const doc = argv.doc ?? 'pop.brain.shared';

    const selfAddress =
      (argv.selfAddress as string | undefined) ||
      readSelfAddress() ||
      deriveAddressFromKey();

    let daemonConns = -1;
    let daemonKnownPeers = -1;
    let daemonUptime = -1;
    // HB#751 (retro-1098 fleet-health-ipc-aware): distinguish IPC-error
    // (transient EPIPE, simple retry suffices) from daemon-down (PID-dead,
    // restart needed). Per HB#1078/#1080/#1085 recurrent pattern: Automerge
    // disjoint-history rejection holds IPC write past CLI timeout. After
    // ~5s the daemon recovers but the CLI saw an error. Bare retry recovers
    // without stop+start cycle.
    let daemonStatus: 'running' | 'ipc-error' | 'down' | 'unknown' = 'unknown';
    let daemonIpcRetried = false;
    const probeDaemon = () => {
      const r = spawnSync('node', ['dist/index.js', 'brain', 'daemon', 'status', '--json'], {
        cwd: process.cwd(),
        encoding: 'utf8',
      });
      const lines = (r.stdout || '').trim().split('\n');
      const lastJson = lines.reverse().find(l => l.startsWith('{'));
      if (!lastJson) return null;
      try {
        return JSON.parse(lastJson);
      } catch {
        return null;
      }
    };
    try {
      let obj = probeDaemon();
      if (obj && obj.status === 'ipc-error') {
        // Retry once after a brief settle (HB#1078 pattern: Automerge
        // disjoint-history holds IPC briefly; ~1s usually suffices).
        await new Promise(resolve => setTimeout(resolve, 1500));
        const obj2 = probeDaemon();
        daemonIpcRetried = true;
        obj = obj2 || obj;
      }
      if (obj) {
        daemonConns = obj.connections ?? -1;
        daemonKnownPeers = obj.knownPeerCount ?? -1;
        daemonUptime = obj.uptime ?? -1;
        daemonStatus = obj.status === 'running' ? 'running' :
                       obj.status === 'ipc-error' ? 'ipc-error' :
                       (obj.status === 'down' || obj.status === 'stopped') ? 'down' :
                       'unknown';
      } else {
        daemonStatus = 'down';
      }
    } catch { /* daemon read best-effort */ }

    let lessons: any[] = [];
    try {
      const r = spawnSync('node', ['dist/index.js', 'brain', 'read', '--doc', doc, '--json'], {
        cwd: process.cwd(),
        encoding: 'utf8',
        maxBuffer: 50 * 1024 * 1024,
      });
      const lines = (r.stdout || '').trim().split('\n');
      const lastJson = lines.reverse().find(l => l.startsWith('{'));
      if (lastJson) {
        const obj = JSON.parse(lastJson);
        lessons = obj.doc?.lessons || [];
      }
    } catch (err: any) {
      output.error(`Failed to read brain doc ${doc}: ${err.message}`);
      process.exit(1);
      return;
    }

    // Filter to 0x-address-format authors only; pre-CRDT-migration string
    // labels would skew the staleness check with permanently-old timestamps.
    const addressPattern = /^0x[0-9a-f]{40}$/;
    const perAuthor: Record<string, { latestTs: number; lessonCount: number }> = {};
    for (const l of lessons) {
      const author = ((l.author || '') as string).toLowerCase();
      if (!author || !addressPattern.test(author)) continue;
      const ts = l.timestamp || 0;
      if (!perAuthor[author]) perAuthor[author] = { latestTs: 0, lessonCount: 0 };
      perAuthor[author].lessonCount += 1;
      if (ts > perAuthor[author].latestTs) perAuthor[author].latestTs = ts;
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const peers: PeerState[] = [];
    let staleCount = 0;
    for (const [address, { latestTs, lessonCount }] of Object.entries(perAuthor)) {
      if (selfAddress && address === selfAddress) continue;
      const ageHours = (nowSec - latestTs) / 3600;
      const stale = ageHours > thresholdHours;
      if (stale) staleCount += 1;
      peers.push({ address, latestTs, ageHours, stale, lessonCount });
    }
    peers.sort((a, b) => b.latestTs - a.latestTs);

    // HB#751: daemon-state-aware remediation. ipc-error → retry suffices;
    // down → restart needed; running+stale-peers → restart + repair.
    let remediation: string | null = null;
    if (daemonStatus === 'down') {
      remediation = 'Daemon not running. Run: pop brain daemon start';
    } else if (daemonStatus === 'ipc-error') {
      remediation = daemonIpcRetried
        ? 'Daemon IPC error persisted across 1.5s retry. Run: pop brain daemon stop && pop brain daemon start (transient EPIPE per HB#1078 pattern; only restart if recurrence)'
        : 'Daemon IPC transient. Retry the command (no restart needed; HB#751 ipc-aware detection)';
    } else if (staleCount > 0) {
      remediation = 'Run: pop brain daemon stop && pop brain daemon start && pop brain repair';
    }

    const result = {
      doc,
      selfAddress: selfAddress || '(unknown)',
      thresholdHours,
      now: nowSec,
      daemon: {
        status: daemonStatus,
        connections: daemonConns,
        knownPeers: daemonKnownPeers,
        uptimeSec: daemonUptime,
        ipcRetried: daemonIpcRetried,
      },
      peers,
      stalePeerCount: staleCount,
      verdict:
        daemonStatus === 'down' ? 'DAEMON-DOWN' :
        daemonStatus === 'ipc-error' ? 'DAEMON-IPC-ERROR' :
        staleCount > 0 ? 'STALE' : 'HEALTHY',
      remediation,
    };

    if (argv.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      output.success(`Fleet brain-sync health for ${doc}`, result);
    }

    if (staleCount > 0) process.exit(2);
  },
};
