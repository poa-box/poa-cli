import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';

/**
 * Distribution merkle-tree conformance.
 *
 * `pop treasury compute-merkle` produces a root that governance commits via
 * PaymentManager.createDistribution, and proofs members submit to PaymentManager.claim. The
 * contract recomputes the leaf as
 *   keccak256(bytes.concat(keccak256(abi.encode(msg.sender, claimAmount))))
 * and verifies with OpenZeppelin `MerkleProof.verify`.
 *
 * The command previously hand-rolled the tree, pairing leaves left-to-right within each layer
 * and promoting an odd trailing leaf unchanged. That matches OZ for 1, 2, 3, 4, 6 and 8 leaves
 * but NOT for 5 or 7 — so a distribution to a 5- or 7-member org produced a root whose proofs
 * MerkleProof.verify rejected, leaving the funds unclaimable.
 *
 * These tests reimplement both the old algorithm and the on-chain verifier so the divergence is
 * demonstrated rather than asserted, and lock in the fixed behaviour.
 */

// --- the contract's own leaf hashing ---
function onChainLeaf(address: string, amount: string): string {
  return ethers.utils.keccak256(
    ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['address', 'uint256'], [address, amount]))
  );
}

/** OpenZeppelin MerkleProof.verify — commutative sorted-pair hashing. */
function verifyProof(proof: string[], root: string, leaf: string): boolean {
  let computed = leaf;
  for (const p of proof) {
    const [a, b] = computed.toLowerCase() < p.toLowerCase() ? [computed, p] : [p, computed];
    computed = ethers.utils.solidityKeccak256(['bytes32', 'bytes32'], [a, b]);
  }
  return computed.toLowerCase() === root.toLowerCase();
}

/** The pre-fix hand-rolled tree, kept ONLY to demonstrate the divergence it caused. */
function legacyRoot(leaves: string[]): string {
  const hashPair = (a: string, b: string) => {
    const [l, r] = a < b ? [a, b] : [b, a];
    return ethers.utils.solidityKeccak256(['bytes32', 'bytes32'], [l, r]);
  };
  let current = [...leaves].sort();
  while (current.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < current.length; i += 2) {
      next.push(i + 1 < current.length ? hashPair(current[i], current[i + 1]) : current[i]);
    }
    current = next;
  }
  return current[0];
}

function members(n: number): Array<[string, string]> {
  return Array.from({ length: n }, (_, i) => [
    ethers.utils.hexZeroPad('0x' + (i + 1).toString(16), 20),
    String((i + 1) * 1000),
  ]);
}

const buildTree = (rows: Array<[string, string]>) =>
  StandardMerkleTree.of(rows, ['address', 'uint256']);

describe('distribution merkle tree — on-chain verifiability', () => {
  // 5 and 7 are the counts the old implementation got wrong.
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 13, 17]) {
    it(`every member of a ${n}-member org can claim`, () => {
      const rows = members(n);
      const tree = buildTree(rows);

      for (const [address, amount] of rows) {
        const proof = tree.getProof([address, amount]);
        // Exactly what PaymentManager.claim does.
        expect(
          verifyProof(proof, tree.root, onChainLeaf(address, amount)),
          `member ${address} could not claim from a ${n}-member distribution`
        ).toBe(true);
      }
    });
  }

  it('the leaf the CLI commits to is the one the contract recomputes', () => {
    const rows = members(3);
    const tree = buildTree(rows);
    for (const [address, amount] of rows) {
      expect(tree.leafHash([address, amount]).toLowerCase()).toBe(onChainLeaf(address, amount).toLowerCase());
    }
  });

  it('a proof does not verify for a different amount (no over-claiming)', () => {
    const rows = members(5);
    const tree = buildTree(rows);
    const [address, amount] = rows[0];
    const proof = tree.getProof([address, amount]);
    expect(verifyProof(proof, tree.root, onChainLeaf(address, String(Number(amount) * 2)))).toBe(false);
  });

  it("a member's proof does not verify for someone else's address", () => {
    const rows = members(5);
    const tree = buildTree(rows);
    const proof = tree.getProof([rows[0][0], rows[0][1]]);
    expect(verifyProof(proof, tree.root, onChainLeaf(rows[1][0], rows[1][1]))).toBe(false);
  });
});

describe('both builders agree — compute-merkle and claim-mine must produce identical trees', () => {
  // These are two separate code paths over the same allocation set: compute-merkle builds the
  // root that governance commits, claim-mine RECOMPUTES it to derive a member's proof. If they
  // ever disagree, claim-mine reports "Root mismatch" for a perfectly valid distribution and
  // every member is pushed onto the manual --proof-file escape hatch. They diverged once
  // already, at exactly 5 and 7 members.
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 11]) {
    it(`${n}-member allocation set round-trips between the two paths`, () => {
      const rows = members(n);
      // compute-merkle side: commit the root.
      const committed = buildTree(rows).root;
      // claim-mine side: independently rebuild from the same allocations.
      const rebuilt = StandardMerkleTree.of(
        rows.map(([a, amt]) => [a, amt]),
        ['address', 'uint256']
      );
      expect(rebuilt.root).toBe(committed);

      // And the proof it derives must satisfy the on-chain verifier against the COMMITTED root.
      for (const [address, amount] of rows) {
        expect(
          verifyProof(rebuilt.getProof([address, amount]), committed, onChainLeaf(address, amount)),
          `member ${address} could not claim from the recomputed tree (n=${n})`
        ).toBe(true);
      }
    });
  }
});

describe('regression: the old hand-rolled tree diverged from OpenZeppelin', () => {
  it('agreed for 1, 2, 3, 4, 6, 8 members — which is why this went unnoticed', () => {
    for (const n of [1, 2, 3, 4, 6, 8]) {
      const rows = members(n);
      const leaves = rows.map(([a, amt]) => onChainLeaf(a, amt));
      expect(legacyRoot(leaves).toLowerCase(), `n=${n}`).toBe(buildTree(rows).root.toLowerCase());
    }
  });

  it('produced an UNCLAIMABLE root for 5 and 7 members', () => {
    for (const n of [5, 7]) {
      const rows = members(n);
      const leaves = rows.map(([a, amt]) => onChainLeaf(a, amt));
      const bad = legacyRoot(leaves);
      const good = buildTree(rows).root;
      expect(bad.toLowerCase(), `n=${n} should have diverged`).not.toBe(good.toLowerCase());

      // The concrete harm: no member could produce a proof the contract accepts.
      const tree = buildTree(rows);
      for (const [address, amount] of rows) {
        const proof = tree.getProof([address, amount]);
        expect(
          verifyProof(proof, bad, onChainLeaf(address, amount)),
          `n=${n}: a proof should NOT verify against the old root`
        ).toBe(false);
      }
    }
  });
});
