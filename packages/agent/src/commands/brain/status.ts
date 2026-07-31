/**
 * pop brain status — show the local brain layer state.
 *
 * MVP step 1: initialize a local Helia node, print the peer ID and
 * listening addresses, report connected peer count. No CRDT ops yet;
 * this is the "environment works" smoke test.
 *
 * Future steps will add doc sync status, known brain documents, and
 * per-document sync state.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import { getBrainNodeInfo, stopBrainNode } from '../../lib/brain';
import { getRunningDaemonPid, sendIpcRequest } from '../../lib/brain-daemon';
import * as output from '@poa/cli/lib/output';

export const statusHandler = {
  builder: (yargs: Argv) => yargs,

  handler: async (_argv: ArgumentsCamelCase<{}>) => {
    // HB#364: when a daemon is running, query it via IPC instead of
    // spinning up a second libp2p instance in the CLI process. The
    // ephemeral-instance path produced misleading state (random listen
    // port each call, 0 peers because the daemon owns the connections)
    // and made cross-device onboarding debugging impossible. Fall back
    // to the in-process libp2p path only when no daemon is running.
    const daemonPid = getRunningDaemonPid();
    if (daemonPid !== null) {
      try {
        const daemonInfo = await sendIpcRequest('status', {}, 5_000);
        const info = {
          peerId: daemonInfo.peerId,
          peerIdSource: 'daemon' as const,
          peerKeyPath: daemonInfo.brainHome + '/peer-key.json',
          listeningAddrs: daemonInfo.listenAddrs ?? [],
          connectedPeers: daemonInfo.connections ?? 0,
          bootstrapPeerCount: 0, // not exposed via IPC yet; pending #349 follow-up
          subscribedTopics: daemonInfo.topics ?? [],
          topicPeerCounts: {} as Record<string, number>,
          heliaVersion: 'daemon-owned',
          blockstorePath: daemonInfo.brainHome + '/helia-blocks',
        };
        if (output.isJsonMode()) {
          output.json({ status: 'ok', source: 'daemon', daemonPid, ...info });
        } else {
          console.log('');
          console.log('  Brain layer — P2P CRDT substrate (daemon-owned)');
          console.log('  ' + '─'.repeat(60));
          console.log(`  Daemon PID:       ${daemonPid}`);
          console.log(`  Peer ID:          ${info.peerId}`);
          console.log(`  Connected peers:  ${info.connectedPeers}`);
          console.log(`  Blockstore path:  ${info.blockstorePath}`);
          console.log('');
          if (info.listeningAddrs.length > 0) {
            console.log('  Listening on (use for POP_BRAIN_PEERS):');
            for (const addr of info.listeningAddrs) {
              console.log(`    ${addr}`);
            }
            console.log('');
          }
          if (info.subscribedTopics.length > 0) {
            console.log('  Subscribed topics:');
            for (const t of info.subscribedTopics) {
              console.log(`    ${t}`);
            }
          }
          console.log('');
        }
        return;
      } catch (err: any) {
        // IPC failed — fall through to in-process path and surface the
        // daemon issue as a warning so operators see it.
        if (!output.isJsonMode()) {
          console.error(`  [warn] daemon IPC at PID ${daemonPid} failed: ${err.message}`);
          console.error(`  [warn] falling back to in-process libp2p probe (may show stale state)`);
        }
      }
    }

    const spin = output.spinner('Initializing brain node...');
    spin.start();

    try {
      const info = await getBrainNodeInfo();
      spin.stop();

      if (output.isJsonMode()) {
        output.json({
          status: 'ok',
          ...info,
        });
      } else {
        console.log('');
        console.log('  Brain layer — P2P CRDT substrate');
        console.log('  ' + '─'.repeat(60));
        console.log(`  Helia version:    ${info.heliaVersion}`);
        console.log(`  Peer ID:          ${info.peerId}`);
        console.log(`  PeerId source:    ${info.peerIdSource}`);
        console.log(`  Peer key file:    ${info.peerKeyPath}`);
        console.log(`  Connected peers:  ${info.connectedPeers}`);
        console.log(`  Bootstrap known:  ${info.bootstrapPeerCount}`);
        console.log(`  Blockstore path:  ${info.blockstorePath}`);
        console.log('');
        if (info.listeningAddrs.length > 0) {
          console.log('  Listening on:');
          for (const addr of info.listeningAddrs) {
            console.log(`    ${addr}`);
          }
          console.log('');
        }
        if (info.subscribedTopics.length > 0) {
          console.log('  Subscribed topics:');
          for (const t of info.subscribedTopics) {
            const n = info.topicPeerCounts[t] ?? 0;
            console.log(`    ${t}  (${n} peer${n === 1 ? '' : 's'})`);
          }
        } else {
          console.log('  (no subscribed topics yet — run `pop brain subscribe --doc <id>` to listen)');
        }
        console.log('');
      }
    } catch (err: any) {
      spin.stop();
      output.error(err.message);
      process.exit(1);
    } finally {
      // Short-lived CLI invocation — clean shutdown so the process exits.
      await stopBrainNode();
    }
  },
};
