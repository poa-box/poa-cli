/**
 * pop brain subscribe — keep the process alive and log incoming head-CID
 * announcements on a doc's gossipsub topic. The manual test surface for
 * MVP step 5.
 *
 * Typical 2-terminal smoke test:
 *   Terminal A:  pop brain subscribe --doc pop.brain.shared
 *   Terminal B:  (any write that calls applyBrainChange — step 7 ships
 *                the write CLI; until then, a direct script or test)
 *
 * Terminal A logs each announcement it sees: docId, CID, claimed author
 * (not trusted — see brain.ts#BrainHeadAnnouncement), the peer it came
 * from. Block fetch + load is step 6.
 */

import type { Argv, ArgumentsCamelCase } from 'yargs';
import {
  initBrainNode,
  subscribeBrainTopic,
  stopBrainNode,
  topicForDoc,
  fetchAndMergeRemoteHead,
  type BrainHeadAnnouncement,
} from '../../lib/brain';
import * as output from '@poa-box/cli/lib/output';

interface SubscribeArgs {
  doc: string;
  logOnly?: boolean;
}

export const subscribeHandler = {
  builder: (yargs: Argv) =>
    yargs
      .option('doc', {
        describe: 'Brain document ID (e.g. pop.brain.shared)',
        type: 'string',
        demandOption: true,
      })
      .option('log-only', {
        describe: 'Only log announcements — do NOT fetch blocks or update manifest',
        type: 'boolean',
        default: false,
      }),

  handler: async (argv: ArgumentsCamelCase<SubscribeArgs>) => {
    const docId = argv.doc;
    const topic = topicForDoc(docId);

    console.log(`Subscribing to ${topic} ...`);
    const helia = await initBrainNode();
    const peerId = helia.libp2p.peerId.toString();
    console.log(`Local peer: ${peerId}`);
    console.log(`Listening on:`);
    for (const a of helia.libp2p.getMultiaddrs()) {
      console.log(`  ${a.toString()}`);
    }
    console.log('');
    console.log('Waiting for announcements. Press Ctrl-C to exit.');
    console.log('');

    const logOnly = argv.logOnly === true;
    if (logOnly) {
      console.log('(log-only mode — will NOT fetch blocks)');
      console.log('');
    }

    const unsubscribe = await subscribeBrainTopic(
      docId,
      (ann: BrainHeadAnnouncement, from: string) => {
        const when = new Date(ann.timestamp * 1000).toISOString();
        console.log(`[${when}] head ${ann.cid}`);
        console.log(`           doc=${ann.docId}  author=${ann.author}  from=${from}`);

        if (logOnly) return;

        // Step 6: fetch the block via Bitswap, verify, merge, update manifest.
        // Runs async inside the event callback — we fire and forget so
        // the listener doesn't block on slow network fetches.
        fetchAndMergeRemoteHead(ann.docId, ann.cid)
          .then((result) => {
            if (result.action === 'reject') {
              console.log(`           -> REJECTED: ${result.reason}`);
            } else {
              console.log(`           -> ${result.action}: ${result.reason}`);
              if ('headCid' in result && result.headCid !== ann.cid) {
                console.log(`              new local head = ${result.headCid}`);
              }
            }
          })
          .catch((err: any) => {
            console.log(`           -> ERROR during sync: ${err.message}`);
          });
      },
    );

    // Keep the process alive. SIGINT cleanly unsubscribes and stops Helia.
    const shutdown = async () => {
      console.log('\nShutting down...');
      try {
        unsubscribe();
      } catch {}
      await stopBrainNode();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Block forever — keepalive so libp2p keeps running.
    await new Promise(() => {});
  },
};
