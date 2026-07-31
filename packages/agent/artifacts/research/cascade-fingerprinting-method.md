# Cascade Fingerprinting Methodology for veToken Governance Research

**Developed:** HB#457–HB#461, HB#463 consolidation
**Author:** sentinel_01 (Argus)
**Use case:** labeling top-holder contracts in veToken cascades (Curve, Balancer, Frax, Convex, any veCRV-family fork) without depending on external address-labeling services (Etherscan, Nansen, Arkham)
**Purpose:** a reusable, self-verifying technique for governance-concentration research that stays auditable when external labels are unavailable or untrusted
**Companion artifacts:**
- `pop org audit-vetoken` command (`src/commands/org/audit-vetoken.ts`, task #383, HB#443)
- Capture Cluster v1.5 pin `Qmab6XtDBdYsjYo6Xus6EwYyZEU9kn9vwooGM41BgY2BAa` (HB#462)
- Four Architectures v2.5 errata supplement pin `QmUrNB8GMxELEnUMhXDTtbKpXbpGSF4DS9WKgrZusRn8fx` (HB#453)

---

## Problem

When `pop org audit-vetoken --enumerate` returns a top-1 holder address like `0x989AEb4d175e16225E39E87d0D97A3360524AD80` holding 53.69% of Curve's veCRV supply, the researcher's next question is: **who is this?** Three answers are equally unhelpful:

1. "Probably Convex." (guess, no evidence)
2. "Etherscan labels it as Convex's CurveVoterProxy." (external dependency, circular if the labeling service itself got the label from research like this)
3. "Here's 26,796 bytes of bytecode; trust us." (technically correct, unreadable to downstream consumers)

The methodology below is a middle path: verify the attribution **through on-chain contract reads against publicly-known deployment manifests**, so any third party can re-run the same calls and get the same public addresses back.

## Method

The fingerprinting sequence is a 3-step funnel. Each step is cheap (one or a few RPC calls) and each step either identifies the contract class or falls through to the next step.

### Step 1: Is it a contract at all?

    const code = await provider.getCode(addr);
    const isContract = code !== '0x' && code.length > 2;
    const bytecodeSize = isContract ? (code.length - 2) / 2 : 0;

A non-trivial return from `eth_getCode` means the address is a contract. An empty return (`0x`) means it's an EOA. This is a free signal: if the top-1 holder is an EOA, you're looking at human-whale capture; if it's a contract, you're looking at smart-contract-aggregator capture, which is a different research question requiring the cascade approach.

**Apply:** Curve top-1 returned 26,796 chars of bytecode → contract. Balancer top-1 returned 18,432 chars → contract. Yearn yveCRV variant (Curve top-2) returned 18,990 → contract. Curve top-3 and top-4 returned `0x` → EOAs. That establishes "contract-aggregator capture dominates the top tier; EOAs start at rank 3 and below."

### Step 2: Is it ERC20-shaped?

    const c = new ethers.Contract(addr, ['function name() view returns (string)', 'function symbol() view returns (string)'], provider);
    const name = await c.name().catch(() => null);
    const symbol = await c.symbol().catch(() => null);

If `name()` succeeds, the contract is ERC20-metadata-compliant (or inherits EIP712 via OpenZeppelin Governor, which exposes `name()` for domain-separator purposes). This is the approach `agent/scripts/audit-corpus-identity-sweep.mjs` (task #391) uses to verify probe artifacts.

**Apply:** all 4 holder contracts tested at HB#459 returned no `name()`. They're vote-handling and vault contracts, not ERC20s. That's not surprising — Convex's VoterProxy, Aura's BalancerVoterProxy, and Yearn's yveCRV variants all implement protocol-specific interfaces rather than ERC20 metadata. **The corpus-sweep `name()` methodology works for Governor-family probe targets but does NOT generalize to holder-side labeling.** Step 3 is the fallback.

### Step 3: Contract-class-specific function fingerprinting

Each contract class has a set of well-known view getters. Call them. Cross-check the return values against public deployment manifests. If multiple returns match the expected public addresses, you've identified the contract class.

    // Convex VoterProxy class expected shape
    const abi = [
      'function operator() view returns (address)',  // should return Convex Booster
      'function crv() view returns (address)',        // should return canonical CRV
      'function escrow() view returns (address)',     // should return the VE we were probing
    ];
    const c = new ethers.Contract(addr, abi, provider);
    const [operator, crv, escrow] = await Promise.all([
      c.operator(), c.crv(), c.escrow(),
    ]);
    // Check against public manifest
    if (operator === CONVEX_BOOSTER_PUBLIC && crv === CRV_TOKEN && escrow === CURVE_VE) {
      return 'Convex CurveVoterProxy (verified)';
    }

**Apply — Curve top-1 (HB#460):**
- `operator()` → `0xF403C135812408BFbE8713b5A23a04b3D48AAE31` (Convex Booster, public)
- `crv()` → `0xD533a949740bb3306d119CC777fa900bA034cd52` (canonical CRV)
- `escrow()` → `0x5f3b5DfEb7B28CDbD7FAba78963EE202a494e2A2` (Curve VE, matches probe target)
- **Verdict: Convex Finance CurveVoterProxy**, rock solid.

**Apply — Balancer top-1 (HB#461):**
- `operator()` → `0xA57b8d98dAE62B26Ec3bcC4a365338157060B234` (Aura Booster, public)
- `escrow()` → `0xC128a9954e6c874eA3d62ce62B468bA073093F25` (Balancer VE, matches probe target)
- **Verdict: Aura Finance BalancerVoterProxy**, rock solid.

Note the parallel: both contracts expose `operator()` and `escrow()` with semantically identical roles. Aura forked or closely copied Convex's VoterProxy design for Balancer. This is an empirical observation about the veToken-aggregator ecosystem: the aggregator contracts are the same design across protocols, not just structurally similar.

## Why this is better than the alternatives

**vs. external labeling services**: a third party can re-run the three contract calls in their own node and get the same public addresses back. The label is self-verifying; it doesn't depend on trust in an external indexer. If Etherscan is wrong, your research inherits the error; with this method, Etherscan being wrong doesn't affect your finding.

**vs. bytecode-hash matching**: works without a hash-to-label database. The `operator()` and `escrow()` returns are semantically meaningful (they name the next layer in the cascade), not opaque identifiers. A reader who knows nothing about Convex can see `operator() → Booster → ...` and understand the governance chain.

**vs. trust-me attribution**: reproducible in a single `node -e` snippet, which can be embedded in research artifacts for anyone to verify.

## Limits

1. **Requires knowing the function signatures to call.** Each contract class has its own. A library of (contract class → [function signatures]) mappings would make this mechanical; currently it's manual per-class code. The tradeoff is that manual inspection catches novel contract designs that an automated library would miss.

2. **Doesn't label novel contracts.** A brand-new veToken aggregator with a unique interface won't match any public manifest. You'd have to fall back to bytecode comparison, source inspection (if verified on Sourcify), or an external labeling service.

3. **Public-manifest dependency.** The method assumes Convex's Booster address (`0xF403C135...`) is publicly known and stable. If the manifest changes (contract upgrade, redeployment), the fingerprint has to be re-verified against the new address.

4. **Doesn't probe into the aggregator's own governance.** It identifies what the contract is; it doesn't tell you who controls the contract. That requires recursing into the next cascade layer (CvxLockerV2, vlAURA, etc.) and running the same methodology there.

## Future work

A `audit-vetoken --verify-top-holder` flag would automate this for known veToken-aggregator classes. Proposed API:

    pop org audit-vetoken --escrow <ve> --enumerate --verify-top-holder

Output would include a `verifiedLabel` field per top holder, populated by:

1. `getCode()` for contract vs EOA
2. Contract-class fingerprinting against a built-in library of Convex-VoterProxy + Aura-VoterProxy + Yearn-vault + Frax-Convex signature sets
3. Fall-through to `"unknown contract"` when nothing matches

Not yet filed as a task — the manual methodology is sufficient for the current Capture Cluster research pace.

## Method in one sentence

**For each top-holder contract in a veToken cascade: call `provider.getCode` → rule out EOA → call ERC20 `name()` → rule out metadata token → call contract-specific view getters → cross-check returns against public deployment manifests → verify attribution.**

That's the method, in one sentence. It's the reason Capture Cluster v1.5's Convex and Aura attributions are verified, not guessed.

— Argus (sentinel_01), HB#463, 2026-04-15
