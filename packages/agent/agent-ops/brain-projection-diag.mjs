#!/usr/bin/env node
/**
 * Task #359 diagnostic — compare three projection paths in one process.
 * Prints doc.lessons counts seen by:
 *   1. openBrainDoc + direct .lessons access (migrate's view)
 *   2. readBrainDoc (Automerge.toJS) — read command's view
 *   3. Inside an applyBrainChange callback (the actual live merge-delta view)
 */
import { openBrainDoc, readBrainDoc, applyBrainChange } from '../../dist/lib/brain.js';

const docId = 'pop.brain.shared';

console.log(`\n=== brain-projection-diag: ${docId} ===\n`);

// Path 1: openBrainDoc + direct access (matches migrate's post-open view)
const { doc: openDoc, headCid: openHead } = await openBrainDoc(docId);
const openLessons = Array.isArray(openDoc?.lessons) ? openDoc.lessons : [];
const openIds = openLessons.map((l) => l?.id).filter((i) => typeof i === 'string');
console.log(`[1] openBrainDoc + direct:`);
console.log(`    headCid: ${openHead}`);
console.log(`    doc.lessons.length: ${openLessons.length}`);
console.log(`    unique ids: ${new Set(openIds).size}`);

// Path 2: readBrainDoc (Automerge.toJS)
const { doc: readDoc, headCid: readHead } = await readBrainDoc(docId);
const readLessons = Array.isArray(readDoc?.lessons) ? readDoc.lessons : [];
const readIds = readLessons.map((l) => l?.id).filter((i) => typeof i === 'string');
console.log(`\n[2] readBrainDoc (Automerge.toJS):`);
console.log(`    headCid: ${readHead}`);
console.log(`    doc.lessons.length: ${readLessons.length}`);
console.log(`    unique ids: ${new Set(readIds).size}`);

// Path 3: inside an applyBrainChange no-op callback
let insideLength = null;
let insideIds = null;
// NOTE: this will write a new envelope even if callback is a no-op. Dry diag.
try {
  const res = await applyBrainChange(docId, (doc) => {
    const lessons = Array.isArray(doc.lessons) ? doc.lessons : [];
    insideLength = lessons.length;
    insideIds = new Set(
      lessons.map((l) => l?.id).filter((i) => typeof i === 'string'),
    );
  });
  console.log(`\n[3] applyBrainChange callback (no-op):`);
  console.log(`    new headCid: ${res.headCid}`);
  console.log(`    doc.lessons.length (inside): ${insideLength}`);
  console.log(`    unique ids (inside): ${insideIds.size}`);
} catch (err) {
  console.log(`\n[3] applyBrainChange callback FAILED: ${err.message}`);
}

// Id comparison
if (openIds.length > 0 && insideIds) {
  const openIdSet = new Set(openIds);
  const onlyInInside = [...insideIds].filter((i) => !openIdSet.has(i));
  const onlyInOpen = [...openIdSet].filter((i) => !insideIds.has(i));
  console.log(`\n[diff] inside-only ids: ${onlyInInside.length}`);
  if (onlyInInside.length > 0) {
    console.log(`       first 5:`, onlyInInside.slice(0, 5));
  }
  console.log(`       open-only ids: ${onlyInOpen.length}`);
}

// Force exit — the Helia node keeps timers alive.
process.exit(0);
