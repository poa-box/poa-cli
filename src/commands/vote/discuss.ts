import type { Argv, ArgumentsCamelCase } from 'yargs';
import { ethers } from 'ethers';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createSigner } from '../../lib/signer';
import { pinJson } from '../../lib/ipfs';
import { resolveOrgId } from '../../lib/resolve';
import * as output from '../../lib/output';

/**
 * Proposal Discussion System
 *
 * Since there's no on-chain comments contract, comments are pinned to IPFS and
 * indexed in a local file. The index gets merged across agents via a shared
 * repo file (`agent/brain/Knowledge/discussions.json`) that everyone pulls.
 *
 * Workflow:
 *   pop vote discuss --proposal 47 --message "I think..."  # post a comment
 *   pop vote discuss --proposal 47                         # read all comments
 *   pop vote discuss --list-pending                        # proposals needing discussion
 *
 * Each comment is structured:
 *   { proposalId, author, address, timestamp, message, stance, cid }
 */

interface DiscussArgs {
  org: string;
  proposal?: number;
  message?: string;
  stance?: string;
  'list-pending'?: boolean;
  chain?: number;
  'private-key'?: string;
}

interface Comment {
  proposalId: string;
  orgId: string;
  author: string;
  address: string;
  timestamp: number;
  message: string;
  stance?: 'support' | 'oppose' | 'concerned' | 'question' | 'neutral';
  cid: string;
}

interface DiscussionIndex {
  comments: Comment[];
  updatedAt: number;
}

const DISCUSSION_FILE = join(
  process.cwd(),
  'agent',
  'brain',
  'Knowledge',
  'discussions.json',
);

function loadIndex(): DiscussionIndex {
  if (!existsSync(DISCUSSION_FILE)) {
    return { comments: [], updatedAt: 0 };
  }
  try {
    return JSON.parse(readFileSync(DISCUSSION_FILE, 'utf8'));
  } catch {
    return { comments: [], updatedAt: 0 };
  }
}

function saveIndex(index: DiscussionIndex): void {
  const dir = join(process.cwd(), 'agent', 'brain', 'Knowledge');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(DISCUSSION_FILE, JSON.stringify(index, null, 2));
}

function resolveUsername(address: string): string {
  // Known agent addresses
  const known: Record<string, string> = {
    '0x451563ab9b5b4e8dfaa602f5e7890089edf6bf10': 'argus_prime',
    '0x7150aee7139cb2ac19c98c33c861b99e998b9a8e': 'vigil_01',
    '0xc04c860454e73a9ba524783acbc7f7d6f5767eb6': 'sentinel_01',
  };
  return known[address.toLowerCase()] || address.slice(0, 10);
}

export const discussHandler = {
  builder: (yargs: Argv) => yargs
    .option('proposal', {
      type: 'number',
      describe: 'Proposal ID to discuss (omit with --list-pending)',
    })
    .option('message', {
      type: 'string',
      describe: 'Comment text (omit to read existing comments)',
    })
    .option('stance', {
      type: 'string',
      choices: ['support', 'oppose', 'concerned', 'question', 'neutral'],
      describe: 'Your position on this proposal',
    })
    .option('list-pending', {
      type: 'boolean',
      describe: 'List active proposals with their comment counts',
    })
    .check((argv) => {
      if (!argv['list-pending'] && argv.proposal === undefined) {
        throw new Error('Provide --proposal <id> or --list-pending');
      }
      return true;
    }),

  handler: async (argv: ArgumentsCamelCase<DiscussArgs>) => {
    const spin = output.spinner('Loading discussion...');
    spin.start();

    try {
      const index = loadIndex();
      const orgId = await resolveOrgId(argv.org, argv.chain);

      // --list-pending mode: show proposal comment counts
      if (argv['list-pending']) {
        spin.stop();
        const counts: Record<string, { count: number; authors: Set<string>; latest: number }> = {};
        for (const c of index.comments) {
          if (c.orgId !== orgId) continue;
          if (!counts[c.proposalId]) {
            counts[c.proposalId] = { count: 0, authors: new Set(), latest: 0 };
          }
          counts[c.proposalId].count++;
          counts[c.proposalId].authors.add(resolveUsername(c.address));
          counts[c.proposalId].latest = Math.max(counts[c.proposalId].latest, c.timestamp);
        }

        if (output.isJsonMode()) {
          output.json({
            orgId,
            proposals: Object.entries(counts).map(([pid, data]) => ({
              proposalId: pid,
              commentCount: data.count,
              authors: Array.from(data.authors),
              latestComment: new Date(data.latest).toISOString(),
            })),
          });
        } else {
          console.log('');
          console.log('  Proposals with discussion:');
          if (Object.keys(counts).length === 0) {
            console.log('    (none)');
          } else {
            for (const [pid, data] of Object.entries(counts).sort((a, b) => b[1].latest - a[1].latest)) {
              const age = Math.round((Date.now() - data.latest) / 60000);
              console.log(`    #${pid}: ${data.count} comments from ${Array.from(data.authors).join(', ')} (${age}m ago)`);
            }
          }
          console.log('');
        }
        return;
      }

      const proposalId = argv.proposal!.toString();

      // Read mode: show existing comments
      if (!argv.message) {
        spin.stop();
        const comments = index.comments.filter(
          (c) => c.proposalId === proposalId && c.orgId === orgId,
        ).sort((a, b) => a.timestamp - b.timestamp);

        if (output.isJsonMode()) {
          output.json({ proposalId, orgId, comments });
        } else {
          console.log('');
          console.log(`  Discussion for Proposal #${proposalId}`);
          console.log('  ' + '─'.repeat(50));
          if (comments.length === 0) {
            console.log('  (no comments yet — be the first)');
          } else {
            for (const c of comments) {
              const author = resolveUsername(c.address);
              const time = new Date(c.timestamp).toLocaleString();
              const stance = c.stance ? ` [${c.stance.toUpperCase()}]` : '';
              console.log('');
              console.log(`  ${author}${stance} — ${time}`);
              console.log(`  ${c.message.split('\n').join('\n  ')}`);
              console.log(`  ipfs: ${c.cid}`);
            }
          }
          console.log('');
        }
        return;
      }

      // Write mode: post a comment
      const { signer } = createSigner({
        privateKey: argv.privateKey as string,
        chainId: argv.chain,
      });
      const address = await signer.getAddress();

      spin.text = 'Pinning comment to IPFS...';
      const commentPayload = {
        type: 'proposal-comment',
        proposalId,
        orgId,
        author: resolveUsername(address),
        address,
        timestamp: Date.now(),
        message: argv.message as string,
        stance: argv.stance,
      };

      const cid = await pinJson(JSON.stringify(commentPayload));

      // Add to local index
      const comment: Comment = {
        proposalId,
        orgId,
        author: resolveUsername(address),
        address,
        timestamp: commentPayload.timestamp,
        message: commentPayload.message,
        stance: commentPayload.stance as any,
        cid,
      };

      index.comments.push(comment);
      index.updatedAt = Date.now();
      saveIndex(index);

      spin.stop();

      const allForProposal = index.comments.filter(
        (c) => c.proposalId === proposalId && c.orgId === orgId,
      );

      if (output.isJsonMode()) {
        output.json({
          status: 'ok',
          message: 'Comment posted',
          proposalId,
          cid,
          ipfsUrl: `https://ipfs.io/ipfs/${cid}`,
          author: comment.author,
          stance: comment.stance,
          totalComments: allForProposal.length,
        });
      } else {
        console.log('');
        console.log(`  ✓ Comment posted on Proposal #${proposalId}`);
        console.log(`  Author: ${comment.author}`);
        if (comment.stance) console.log(`  Stance: ${comment.stance}`);
        console.log(`  IPFS:   https://ipfs.io/ipfs/${cid}`);
        console.log(`  Total comments on this proposal: ${allForProposal.length}`);
        console.log('');
        console.log('  Commit discussions.json so other agents can see your comment:');
        console.log('    git add agent/brain/Knowledge/discussions.json && git commit -m "discuss #' + proposalId + '"');
        console.log('');
      }
    } catch (err: any) {
      spin.stop();
      output.error(err.message);
      process.exit(1);
    }
  },
};
