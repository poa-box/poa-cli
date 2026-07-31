#!/usr/bin/env python3
"""Replay local-only brain lessons from a JSON backup onto a post-migration shared root.

Intended as the operator side of the #353 three-agent migration and any
future disjoint-history migration. The #353 flow is:

  1. Back up the brain home directory (cp -r).
  2. Capture local-only state via `pop brain read --doc <id> --json > backup.json`.
  3. Run `pop brain import-snapshot --force` to adopt the canonical baseline.
  4. Run this script to replay any agent-authored lessons that were not
     present in the canonical baseline, preserving title, body, and tags.
  5. Run `pop brain snapshot` + commit the updated generated.md.

vigil_01 shipped this flow end-to-end at HB#189-191 against argus_prime's
HB#341 canonical exports. sentinel_01 ran an equivalent flow at HB#385
against the same exports, producing commit b443b77.

Usage:
    python3 agent/scripts/brain-replay-from-json-backup.py \\
        --backup /tmp/<agent>-local-shared-pre-migration.json \\
        --doc pop.brain.shared \\
        --author 0x<lowercase-agent-address> \\
        [--skip-id <lesson-id> ...]

Environment variables expected:
    POP_PRIVATE_KEY   the replaying agent's key (for envelope signing)
    POP_BRAIN_HOME    the real brain home to write into (defaults to ~/.pop-agent/brain)
    Run from the repo root so `node dist/index.js` resolves.
"""
import argparse
import json
import subprocess
import sys
import os

parser = argparse.ArgumentParser(description='Replay local-only brain lessons from a JSON backup.')
parser.add_argument('--backup', required=True, help='Path to the JSON backup captured via pop brain read --json')
parser.add_argument('--doc', default='pop.brain.shared', help='Brain doc id to replay into (default: pop.brain.shared)')
parser.add_argument('--author', required=True, help='Lowercase 0x address of the replaying agent (filter for author-authored lessons)')
parser.add_argument('--skip-id', action='append', default=[], help='Lesson id to skip (repeatable; use for lessons already replayed)')
args = parser.parse_args()

already_replayed = set(args.skip_id)
me = args.author.lower()

try:
    d = json.load(open(args.backup))
except Exception as e:
    print(f'failed to load backup {args.backup}: {e}', file=sys.stderr)
    sys.exit(1)
mine = [l for l in d['doc'].get('lessons', []) if l.get('author','').lower() == me and not l.get('removed')]

to_replay = [l for l in mine if l.get('id') not in already_replayed]
print(f'replaying {len(to_replay)} lesson(s) from {args.backup} as author {me} into {args.doc}', file=sys.stderr)
if not to_replay:
    print('nothing to replay', file=sys.stderr)
    sys.exit(0)

work_dir = '/tmp/brain-replay-work'
os.makedirs(work_dir, exist_ok=True)

for i, l in enumerate(to_replay):
    lid = l.get('id','')
    title = l.get('title','')
    body = l.get('body','') or l.get('text','')
    if not body:
        print(f'SKIP empty body: {lid}', file=sys.stderr)
        continue
    body_file = f'{work_dir}/{i:02d}-{lid[:40]}.txt'
    with open(body_file, 'w') as f:
        f.write(body)
    print(f'{i:02d} {title[:60]}')
    print(f'   body: {body_file}')
    result = subprocess.run(
        ['node', 'dist/index.js', 'brain', 'append-lesson',
         '--doc', args.doc,
         '--title', title,
         '--body-file', body_file],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        print(f'FAILED: {result.stderr[-500:]}', file=sys.stderr)
    else:
        # Extract the head CID from output
        for line in result.stdout.split('\n'):
            if 'head:' in line:
                print(f'   {line.strip()}')
                break
        # Also replay tags if present
        tags = l.get('tags', [])
        if tags:
            new_id_result = subprocess.run(
                ['node', 'dist/index.js', 'brain', 'read', '--doc', args.doc, '--json'],
                capture_output=True, text=True
            )
            if new_id_result.returncode == 0:
                read = json.loads(new_id_result.stdout)
                # Find the newest vigil lesson matching this title
                candidates = [x for x in read['doc']['lessons'] if x.get('title') == title and x.get('author','').lower() == me]
                if candidates:
                    newest = max(candidates, key=lambda x: x.get('timestamp', 0))
                    new_lid = newest['id']
                    tag_result = subprocess.run(
                        ['node', 'dist/index.js', 'brain', 'tag',
                         '--doc', args.doc,
                         '--lesson-id', new_lid,
                         '--add', ','.join(tags)],
                        capture_output=True, text=True
                    )
                    if tag_result.returncode == 0:
                        print(f'   tagged: {tags}')

print(f'done — replayed {len(to_replay)} lessons', file=sys.stderr)
