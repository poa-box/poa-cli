/**
 * pop brain daemon — process control for the persistent brain daemon
 * (HB#322 architecture: go-ds-crdt-shaped rebroadcast + keepalive loop,
 * see src/lib/brain-daemon.ts for the full design rationale).
 *
 * Subcommands:
 *   start    spawn a detached daemon child
 *   stop     signal a running daemon to shut down gracefully
 *   status   print daemon stats (peer count, topics, uptime, rebroadcast
 *            counts) via IPC
 *   logs     tail the daemon log file
 *   __run    internal — the actual daemon entrypoint. Never call directly
 *            from the shell; start uses this.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  runDaemon,
  getDaemonPidPath,
  getDaemonSockPath,
  getDaemonLogPath,
  getRunningDaemonPid,
  sendIpcRequest,
  REBROADCAST_INTERVAL_MS,
  KEEPALIVE_INTERVAL_MS,
} from '../../lib/brain-daemon';
import { getBrainHome } from '../../lib/brain';
import * as output from '@poa/cli/lib/output';

interface DaemonArgs {
  action: 'start' | 'stop' | 'status' | 'logs' | '__run';
  follow?: boolean;
  tail?: number;
}

async function handleStart(): Promise<void> {
  const existing = getRunningDaemonPid();
  if (existing !== null) {
    if (output.isJsonMode()) {
      output.json({
        status: 'already-running',
        pid: existing,
        pidPath: getDaemonPidPath(),
      });
    } else {
      console.log(`Brain daemon already running with PID ${existing}`);
      console.log(`  pid file: ${getDaemonPidPath()}`);
      console.log(`  socket:   ${getDaemonSockPath()}`);
      console.log(`  log:      ${getDaemonLogPath()}`);
    }
    return;
  }

  // Determine the path to our own CLI entrypoint so the detached child
  // can run the __run subcommand. We use process.argv[1] when it points
  // at dist/index.js, else fall back to the canonical path.
  const selfScript = process.argv[1];

  const child = spawn(
    process.execPath, // node itself
    [selfScript, 'brain', 'daemon', '__run'],
    {
      detached: true,
      stdio: 'ignore',
      // Forward critical env so the child has the same wallet / brain home.
      env: process.env,
    },
  );
  child.unref();

  // Poll the PID file for up to 5s to confirm the daemon actually came up.
  // Without this the user gets "started" for a process that crashed at init.
  const pidPath = getDaemonPidPath();
  const startedAt = Date.now();
  let pid: number | null = null;
  while (Date.now() - startedAt < 5000) {
    if (existsSync(pidPath)) {
      try {
        pid = parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
        if (Number.isFinite(pid) && pid > 0) break;
      } catch {}
    }
    await new Promise(r => setTimeout(r, 100));
  }

  if (!pid) {
    if (output.isJsonMode()) {
      output.json({
        status: 'error',
        reason: 'daemon did not write PID file within 5s — check log',
        logPath: getDaemonLogPath(),
      });
    } else {
      console.error(`Brain daemon failed to start within 5s.`);
      console.error(`Check the log: ${getDaemonLogPath()}`);
    }
    process.exitCode = 1;
    return;
  }

  if (output.isJsonMode()) {
    output.json({
      status: 'started',
      pid,
      pidPath,
      sockPath: getDaemonSockPath(),
      logPath: getDaemonLogPath(),
      rebroadcastIntervalMs: REBROADCAST_INTERVAL_MS,
      keepaliveIntervalMs: KEEPALIVE_INTERVAL_MS,
    });
  } else {
    console.log(`Brain daemon started`);
    console.log(`  PID:             ${pid}`);
    console.log(`  brain home:      ${getBrainHome()}`);
    console.log(`  pid file:        ${pidPath}`);
    console.log(`  socket:          ${getDaemonSockPath()}`);
    console.log(`  log:             ${getDaemonLogPath()}`);
    console.log(`  rebroadcast:     ${REBROADCAST_INTERVAL_MS / 1000}s`);
    console.log(`  keepalive:       ${KEEPALIVE_INTERVAL_MS / 1000}s`);
    console.log(``);
    console.log(`Verify with: pop brain daemon status`);
  }
}

async function handleStop(): Promise<void> {
  const pid = getRunningDaemonPid();
  if (pid === null) {
    if (output.isJsonMode()) {
      output.json({ status: 'not-running' });
    } else {
      console.log('Brain daemon is not running.');
    }
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (err: any) {
    if (output.isJsonMode()) {
      output.json({ status: 'error', reason: err.message, pid });
    } else {
      console.error(`Failed to signal PID ${pid}: ${err.message}`);
    }
    process.exitCode = 1;
    return;
  }

  // Wait up to 10s for the PID file to disappear (daemon's own cleanup).
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    if (getRunningDaemonPid() === null) break;
    await new Promise(r => setTimeout(r, 100));
  }

  const stillRunning = getRunningDaemonPid();
  if (stillRunning !== null) {
    if (output.isJsonMode()) {
      output.json({
        status: 'error',
        reason: `daemon still running after SIGTERM + 10s — may need SIGKILL`,
        pid: stillRunning,
      });
    } else {
      console.error(`Daemon still running after SIGTERM + 10s (PID ${stillRunning}).`);
      console.error(`Force-kill with: kill -9 ${stillRunning}`);
    }
    process.exitCode = 1;
    return;
  }

  if (output.isJsonMode()) {
    output.json({ status: 'stopped', pid });
  } else {
    console.log(`Brain daemon stopped (was PID ${pid}).`);
  }
}

async function handleStatus(): Promise<void> {
  const pid = getRunningDaemonPid();
  if (pid === null) {
    if (output.isJsonMode()) {
      output.json({ status: 'not-running' });
    } else {
      console.log('Brain daemon is not running.');
      console.log('Start it with: pop brain daemon start');
    }
    return;
  }

  let ipcResult: any;
  try {
    ipcResult = await sendIpcRequest('status', {}, 3000);
  } catch (err: any) {
    if (output.isJsonMode()) {
      output.json({
        status: 'ipc-error',
        pid,
        reason: err.message,
      });
    } else {
      console.error(`Daemon PID ${pid} is alive but IPC failed: ${err.message}`);
      console.error(`Check log: ${getDaemonLogPath()}`);
    }
    process.exitCode = 1;
    return;
  }

  if (output.isJsonMode()) {
    output.json({
      status: 'running',
      pid,
      ...ipcResult,
    });
    return;
  }

  const lastRebroadcast = ipcResult.lastRebroadcastAt
    ? new Date(ipcResult.lastRebroadcastAt).toISOString()
    : 'never';
  const lastKeepalive = ipcResult.lastKeepaliveAt
    ? new Date(ipcResult.lastKeepaliveAt).toISOString()
    : 'never';

  console.log(`Brain daemon running`);
  console.log(`  PID:                  ${pid}`);
  console.log(`  peer ID:              ${ipcResult.peerId}`);
  console.log(`  uptime:               ${ipcResult.uptime}s`);
  console.log(`  connections:          ${ipcResult.connections}`);
  console.log(`  known peers:          ${ipcResult.knownPeerCount}`);
  console.log(`  subscribed topics:    ${ipcResult.topics?.length ?? 0}`);
  if (ipcResult.topics?.length) {
    for (const t of ipcResult.topics) {
      console.log(`    - ${t}`);
    }
  }
  console.log(`  subscribed docs:      ${ipcResult.subscribedDocs?.length ?? 0}`);
  if (ipcResult.subscribedDocs?.length) {
    for (const d of ipcResult.subscribedDocs) {
      console.log(`    - ${d}`);
    }
  }
  console.log(`  rebroadcast count:    ${ipcResult.rebroadcastCount}`);
  console.log(`  last rebroadcast:     ${lastRebroadcast}`);
  console.log(`  keepalive count:      ${ipcResult.keepaliveCount}`);
  console.log(`  last keepalive:       ${lastKeepalive}`);
  console.log(`  incoming announces:   ${ipcResult.incomingAnnouncements}`);
  console.log(`  incoming merges:      ${ipcResult.incomingMerges}`);
  console.log(`  incoming rejects:     ${ipcResult.incomingRejects || 0}`);
  console.log(`  brain home:           ${ipcResult.brainHome}`);
  console.log(`  log:                  ${ipcResult.logPath}`);
}

async function handleLogs(tail: number, follow: boolean): Promise<void> {
  const logPath = getDaemonLogPath();
  if (!existsSync(logPath)) {
    console.error(`No daemon log at ${logPath}`);
    process.exitCode = 1;
    return;
  }
  // Minimal implementation: print last N lines. --follow uses tail -F.
  if (follow) {
    const { spawn: spawnFollow } = await import('child_process');
    const proc = spawnFollow('tail', ['-F', '-n', String(tail), logPath], {
      stdio: 'inherit',
    });
    await new Promise(r => proc.on('close', r));
    return;
  }
  const content = readFileSync(logPath, 'utf8');
  const lines = content.split('\n');
  const slice = lines.slice(Math.max(0, lines.length - tail - 1));
  console.log(slice.join('\n'));
}

async function handleRun(): Promise<void> {
  // This is the child process entrypoint. It blocks forever.
  try {
    await runDaemon();
  } catch (err: any) {
    // Write the error to the log file if we can; the parent process
    // watches the PID file to detect failures.
    const logPath = getDaemonLogPath();
    try {
      const { appendFileSync } = await import('fs');
      appendFileSync(
        logPath,
        `${new Date().toISOString()} FATAL ${err.stack ?? err.message}\n`,
      );
    } catch {}
    process.exit(1);
  }
}

export const daemonHandler = {
  builder: (yargs: Argv) =>
    yargs
      .positional('action', {
        describe: 'Daemon action',
        type: 'string',
        choices: ['start', 'stop', 'status', 'logs', '__run'] as const,
      })
      .option('follow', {
        alias: 'f',
        describe: 'Follow the log file (logs subcommand only)',
        type: 'boolean',
        default: false,
      })
      .option('tail', {
        alias: 'n',
        describe: 'Number of log lines to print (logs subcommand only)',
        type: 'number',
        default: 50,
      }),

  handler: async (argv: ArgumentsCamelCase<DaemonArgs>) => {
    const action = argv.action;
    switch (action) {
      case 'start':
        await handleStart();
        return;
      case 'stop':
        await handleStop();
        return;
      case 'status':
        await handleStatus();
        return;
      case 'logs':
        await handleLogs(argv.tail ?? 50, argv.follow ?? false);
        return;
      case '__run':
        await handleRun();
        return;
      default:
        output.error(`Unknown daemon action: ${action}`);
        process.exitCode = 1;
    }
  },
};
