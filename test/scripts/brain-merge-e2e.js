#!/usr/bin/env node
/**
 * Brain step 6 — concurrent-writer CRDT merge E2E (Task #295).
 *
 * Exercises the `merge` branch of fetchAndMergeRemoteHead
 * (src/lib/brain.ts:551-722), the one path Task #293 shipped untested.
 * Normal agent operation is sequential so this path only fires in a
 * race, but a silent data-loss bug in the merge would be catastrophic;
 * this script gives us a green test proving divergent writes converge
 * and that the merge block is signed by the merger (not either writer).
 *
 * Why a standalone node script instead of a vitest file:
 *   brain.ts bridges CJS → ESM-only deps (helia, automerge, libp2p,
 *   blockstore-fs) with `new Function('s','return import(s)')`. Vitest's
 *   VM isolation refuses to resolve that dynamic import, so any test
 *   that imports brain.ts's production path from src/ explodes before
 *   the test body runs. Running against the compiled dist/lib/brain.js
 *   under plain Node sidesteps the VM entirely and gives us the exact
 *   production code path.
 *
 * Harness design:
 *   - Three ephemeral Ethereum wallets A, B, C; temporarily added to
 *     the repo allowlist (restored in finally, even on crash).
 *   - Three isolated POP_BRAIN_HOME dirs under /tmp.
 *   - Writers A and B each build their own signed envelope block in
 *     their own FsBlockstore *without* starting helia/libp2p. Neither
 *     writer ever sees the other — this is the "divergent history"
 *     precondition for a true CRDT merge.
 *   - Subscriber C gets A's and B's block files copied into its own
 *     helia-blocks dir so helia.blockstore.get() inside
 *     fetchAndMergeRemoteHead resolves locally (no real network
 *     between test peers, matches the /ip4/127.0.0.1 constraint in
 *     spirit — no cross-host traffic at all).
 *   - fetchAndMergeRemoteHead runs twice on C: first A1 (adopt, since
 *     C starts empty) then B1 (merge, since C's head now diverges
 *     from B1's independent history).
 *
 * Constraints honoured:
 *   - Does NOT modify fetchAndMergeRemoteHead. Test-only.
 *   - Reuses signBrainChange / verifyBrainChange from brain-signing.ts.
 *   - Cleans up tmp dirs and restores allowlist in a finally block.
 *
 * Run:  yarn build && node test/scripts/brain-merge-e2e.js
 * Or:   yarn test:brain-merge
 */

'use strict';

const { ethers } = require('ethers');
const {
  mkdtempSync,
  mkdirSync,
  cpSync,
  readFileSync,
  writeFileSync,
  rmSync,
} = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');

const { signBrainChange, verifyBrainChange } = require('../../dist/lib/brain-signing');
const {
  fetchAndMergeRemoteHead,
  readBrainDoc,
  stopBrainNode,
  getBrainHome,
} = require('../../dist/lib/brain');

const ALLOWLIST_PATH = join(process.cwd(), 'agent', 'brain', 'Config', 'brain-allowlist.json');
const DOC_ID = `pop.brain.test-merge-${Date.now()}`;

// Real dynamic import — this is a .js file so Node handles it natively;
// no TS/vitest VM shenanigans.
const esmImport = (specifier) => import(specifier);

function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`ASSERT FAIL [${label}]: expected ${e}, got ${a}`);
  }
  console.log(`  ✓ ${label}`);
}
function assertTrue(cond, label) {
  if (!cond) throw new Error(`ASSERT FAIL [${label}]: expected truthy`);
  console.log(`  ✓ ${label}`);
}

/**
 * Build a signed envelope block directly in `dir`/helia-blocks using
 * the given private key. Mirrors the tail of applyBrainChange
 * (brain.ts:463-508) but without initBrainNode / publishBrainHead so
 * the "writer" half of the test never spins up libp2p.
 */
/**
 * Produce a "genesis" Automerge snapshot so two writers can share a
 * common ancestor. Without this, each writer's Automerge.init() creates
 * a separate actor with no shared history, and an assignment like
 * `doc.lessons = []` at divergent actors resolves last-writer-wins on
 * merge — one writer's list silently wins and the other's push is lost.
 * With a shared ancestor that already contains `lessons: []`, both
 * subsequent pushes target the same CRDT list and the merge produces
 * the union of both entries.
 */
async function makeGenesisBytes() {
  const Automerge = await esmImport('@automerge/automerge');
  let doc = Automerge.init();
  doc = Automerge.change(doc, (d) => { d.lessons = []; });
  return Automerge.save(doc);
}

async function writeWriterBlock(dir, privKey, genesisBytes, mutate) {
  const Automerge = await esmImport('@automerge/automerge');
  const { CID } = await esmImport('multiformats/cid');
  const { sha256 } = await esmImport('multiformats/hashes/sha2');
  const { FsBlockstore } = await esmImport('blockstore-fs');

  // Load from shared genesis so both writers descend from the same
  // Automerge history — required for a meaningful list-level merge.
  let doc = Automerge.load(genesisBytes);
  doc = Automerge.change(doc, mutate);
  const automergeBytes = Automerge.save(doc);

  const envelope = await signBrainChange(automergeBytes, privKey);
  const envelopeBytes = new TextEncoder().encode(JSON.stringify(envelope));
  const hash = await sha256.digest(envelopeBytes);
  const cid = CID.createV1(0x55, hash);

  const blockstorePath = join(dir, 'helia-blocks');
  mkdirSync(blockstorePath, { recursive: true });
  const bs = new FsBlockstore(blockstorePath);
  await bs.open();
  try {
    await bs.put(cid, envelopeBytes);
  } finally {
    await bs.close();
  }
  return cid.toString();
}

async function main() {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'pop-brain-merge-'));
  const dirA = join(tmpRoot, 'A');
  const dirB = join(tmpRoot, 'B');
  const dirC = join(tmpRoot, 'C');
  mkdirSync(dirA, { recursive: true });
  mkdirSync(dirB, { recursive: true });
  mkdirSync(dirC, { recursive: true });

  const walletA = ethers.Wallet.createRandom();
  const walletB = ethers.Wallet.createRandom();
  const walletC = ethers.Wallet.createRandom();

  const allowlistBackup = readFileSync(ALLOWLIST_PATH, 'utf8');
  const list = JSON.parse(allowlistBackup);
  list.push(
    { address: walletA.address.toLowerCase(), name: 'test-merge-A', addedAt: 'test', addedBy: 'brain-merge-e2e' },
    { address: walletB.address.toLowerCase(), name: 'test-merge-B', addedAt: 'test', addedBy: 'brain-merge-e2e' },
    { address: walletC.address.toLowerCase(), name: 'test-merge-C', addedAt: 'test', addedBy: 'brain-merge-e2e' },
  );
  writeFileSync(ALLOWLIST_PATH, JSON.stringify(list, null, 2));

  const prevBrainHome = process.env.POP_BRAIN_HOME;
  const prevPrivKey = process.env.POP_PRIVATE_KEY;

  try {
    console.log(`[brain-merge-e2e] tmpRoot=${tmpRoot} doc=${DOC_ID}`);
    console.log(`[brain-merge-e2e] walletA=${walletA.address}`);
    console.log(`[brain-merge-e2e] walletB=${walletB.address}`);
    console.log(`[brain-merge-e2e] walletC=${walletC.address}`);

    // 0. Shared genesis: both writers start from the same ancestral
    //    Automerge state so pushing to doc.lessons converges on merge.
    const genesisBytes = await makeGenesisBytes();

    // 1. Writer A — from genesis, add lesson a1. Writer A never sees B.
    console.log('\n[1] writer A produces divergent block A1');
    const cidA1 = await writeWriterBlock(dirA, walletA.privateKey, genesisBytes, (doc) => {
      doc.lessons.push({ id: 'a1', text: 'lesson from writer A' });
    });
    console.log(`    cidA1=${cidA1}`);

    // 2. Writer B — from genesis, add lesson b1. Writer B never sees A.
    console.log('[2] writer B produces divergent block B1');
    const cidB1 = await writeWriterBlock(dirB, walletB.privateKey, genesisBytes, (doc) => {
      doc.lessons.push({ id: 'b1', text: 'lesson from writer B' });
    });
    console.log(`    cidB1=${cidB1}`);
    assertTrue(cidA1 !== cidB1, 'A1 and B1 are distinct CIDs');

    // 3. Subscriber C — copy block files in; helia.blockstore.get resolves locally.
    console.log('[3] seeding subscriber C blockstore with A1 and B1');
    cpSync(join(dirA, 'helia-blocks'), join(dirC, 'helia-blocks'), { recursive: true });
    cpSync(join(dirB, 'helia-blocks'), join(dirC, 'helia-blocks'), { recursive: true });

    // 4. Point brain lib at C, use walletC as merger identity.
    process.env.POP_BRAIN_HOME = dirC;
    process.env.POP_PRIVATE_KEY = walletC.privateKey;
    assertEq(getBrainHome(), dirC, 'POP_BRAIN_HOME applied');

    // 5. First fetch — C has no local head → adopt.
    console.log('[5] C.fetchAndMergeRemoteHead(A1) — expect adopt');
    const r1 = await fetchAndMergeRemoteHead(DOC_ID, cidA1);
    assertEq(r1.action, 'adopt', 'first fetch action=adopt');
    assertEq(r1.headCid, cidA1, 'adopted head == A1');

    // 6. Second fetch — divergent histories → true merge.
    console.log('[6] C.fetchAndMergeRemoteHead(B1) — expect merge');
    const r2 = await fetchAndMergeRemoteHead(DOC_ID, cidB1);
    if (r2.action !== 'merge') {
      throw new Error(`expected merge, got ${r2.action}: ${r2.reason}`);
    }
    const mergedCid = r2.headCid;
    console.log(`    mergedCid=${mergedCid}`);
    assertTrue(mergedCid !== cidA1, 'merged CID distinct from A1');
    assertTrue(mergedCid !== cidB1, 'merged CID distinct from B1');

    // 7. readBrainDoc converges — both lessons visible.
    console.log('[7] readBrainDoc — both lessons present');
    const { doc, headCid } = await readBrainDoc(DOC_ID);
    assertEq(headCid, mergedCid, 'readBrainDoc head matches merged CID');
    const ids = (doc.lessons || []).map((l) => l.id).sort();
    assertEq(ids, ['a1', 'b1'], 'merged doc.lessons contains a1 and b1');

    // 8. Merge block signed by walletC (the merger), not A or B.
    console.log('[8] merge block signature verifies against walletC');
    const { CID } = await esmImport('multiformats/cid');
    const { FsBlockstore } = await esmImport('blockstore-fs');
    const bs = new FsBlockstore(join(dirC, 'helia-blocks'));
    await bs.open();
    let envelope;
    try {
      const raw = await bs.get(CID.parse(mergedCid));
      const bytes = raw instanceof Uint8Array
        ? raw
        : (typeof raw.slice === 'function' ? raw.slice() : Uint8Array.from(raw));
      envelope = JSON.parse(new TextDecoder().decode(bytes));
    } finally {
      await bs.close();
    }
    const recovered = verifyBrainChange(envelope);
    assertEq(
      recovered.toLowerCase(),
      walletC.address.toLowerCase(),
      'merge block author == walletC',
    );

    // 9. No ping-pong: re-fetching the merged CID is a no-op (skip).
    //    fetchAndMergeRemoteHead does not call publishBrainHead on the
    //    merge branch (brain.ts:698-702). This re-call confirms the
    //    manifest didn't advance past mergedCid between calls.
    console.log('[9] re-fetch(mergedCid) — expect skip (no ping-pong)');
    const r3 = await fetchAndMergeRemoteHead(DOC_ID, mergedCid);
    assertEq(r3.action, 'skip', 'third fetch action=skip');
    assertEq(r3.headCid, mergedCid, 'skip head == mergedCid');

    console.log('\n✅ brain-merge-e2e: ALL ASSERTIONS PASSED');
  } finally {
    // Restore allowlist unconditionally — never leak test wallets.
    try { writeFileSync(ALLOWLIST_PATH, allowlistBackup); } catch (e) { console.error('allowlist restore failed:', e); }
    if (prevBrainHome !== undefined) process.env.POP_BRAIN_HOME = prevBrainHome;
    else delete process.env.POP_BRAIN_HOME;
    if (prevPrivKey !== undefined) process.env.POP_PRIVATE_KEY = prevPrivKey;
    else delete process.env.POP_PRIVATE_KEY;
    try { await stopBrainNode(); } catch {}
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('\n❌ brain-merge-e2e: FAILED');
    console.error(err && err.stack || err);
    process.exit(1);
  },
);
