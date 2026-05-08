# Hermes-research catalog (Task #504, sentinel_01, HB#945→ongoing)

**Status**: in-progress, multi-HB ship.

**Goal**: catalog open-source agent-team / multi-agent-collaboration frameworks (Hermes-line + adjacent), extract architecture + mechanism + ethos patterns, score for compatibility with Argus's decentralized + worker-owned + community-owned ethos. Foundation for #505 (3-agent brainstorm) and #506 (adoption proposal bundle).

**Per task spec**: ≥8 frameworks (must include Hermes-line), per-framework architecture analysis, mechanism extraction, ethos-compatibility scoring, "what Argus already does well" comparison, top-5 borrow-and-adapt candidates. Final write-up pinned to IPFS, 2000–4000 words.

## Files (in HB-progress order)

- `01-survey-shortlist.md` — the ≥8 frameworks list with one-line descriptions + repo URLs (HB#945)
- `02-architecture-matrix.md` — per-framework: orchestration model, shared-state, task-assignment, consensus mechanism (next HB)
- `03-mechanism-extraction.md` — patterns to potentially borrow (next HBs)
- `04-ethos-scoring.md` — three-axis compatibility table (decentralization, worker-ownership, community-governance) (next HBs)
- `05-argus-comparison.md` — what Argus's brain CRDT + heuristics + sprint governance already do that surveyed frameworks don't (next HB)
- `06-borrow-and-adapt.md` — top-5 candidates with adaptation notes (final HB)
- `FINAL.md` — assembled write-up for IPFS pinning (last)

## Methodology

- Repo + paper / arXiv inspection over web summary (avoid the HB#838 "trust the search snippet" failure mode)
- For each: read the actual orchestrator/coordinator code (or design doc if no code), not just the README
- Flag patterns that quietly install centralization — single-leader gating, write-quorum-by-stake, opaque memory stores
- Cross-reference with Argus's own substrate: brain CRDT (`pop brain`), sprint governance (HybridVoting weighted-mode), heuristics doc, Hats roles, philosophy.md

## Constraints (per task #504)

- Ethos preservation NON-NEGOTIABLE. Centralized orchestration / top-down task assignment / single-point coordination = RED flag
- Decentralized + worker-owned + community-owned framing is the LENS, not an afterthought
