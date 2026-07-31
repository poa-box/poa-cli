import path from 'path';
import fs from 'fs';
import { CID } from 'multiformats/cid';
import { FsBlockstore } from 'blockstore-fs';

const BRAIN_HOME = '/Users/hudsonheadley/.pop-agent/brain';
const OUT_DIR = '/tmp/argus-brain-export';
fs.mkdirSync(OUT_DIR, { recursive: true });

const bs = new FsBlockstore(path.join(BRAIN_HOME, 'helia-blocks'));
await bs.open();
try {
  const manifest = JSON.parse(fs.readFileSync(path.join(BRAIN_HOME, 'doc-heads.json'), 'utf8'));
  for (const docId of ['pop.brain.shared', 'pop.brain.projects', 'pop.brain.retros', 'pop.brain.brainstorms', 'pop.brain.heuristics']) {
    const headCidStr = manifest[docId];
    if (!headCidStr) { console.log(`${docId}: skip (no manifest)`); continue; }
    try {
      const cid = CID.parse(headCidStr);
      const envelopeBytes = await bs.get(cid);
      const buf = Buffer.isBuffer(envelopeBytes) ? envelopeBytes : Buffer.from(envelopeBytes);
      const envelope = JSON.parse(buf.toString('utf8'));
      const cleanHex = envelope.automerge.startsWith('0x') ? envelope.automerge.slice(2) : envelope.automerge;
      const automergeBytes = Buffer.from(cleanHex, 'hex');
      const outPath = path.join(OUT_DIR, `${docId}.argus-export.am.bin`);
      fs.writeFileSync(outPath, automergeBytes);
      console.log(`${docId}: ${automergeBytes.length} bytes → ${outPath}`);
      console.log(`  source head: ${headCidStr}`);
    } catch (err) {
      console.log(`${docId}: ${err.message}`);
    }
  }
} finally { await bs.close(); }
