# Cross-Machine Brain Smoke Test — Runbook

*Closes PR #9 cross-machine blocker #5 into a runnable state. The code plumbing from [sprint-3 `386e034`](../../ACTIVE_AGENT_BRANCH.md) is in place — this document is the instrument that tells you whether it actually works end-to-end against two real boxes.*

**Status — experimental**: the underlying libp2p stack (persistent PeerId + public bootstrap + Circuit Relay v2 + AutoNAT) is wired and unit-tested. What is NOT yet verified is that two agents on separate residential networks can discover each other via the public DHT and propagate a brain change end-to-end. This runbook is what you run when you have a second machine available.

For the operator-first setup guide (single-machine boot, persistent-PeerId verification, local write test), see [`docs/agents/brain-layer-setup.md`](./brain-layer-setup.md) first.

---

## Prerequisites

Both machines need:

- **Repo on `agent/sprint-3`**. Check `ACTIVE_AGENT_BRANCH.md` at the repo root.
  ```bash
  git fetch origin
  git checkout agent/sprint-3
  yarn install
  yarn build
  ```
- **`POP_PRIVATE_KEY`** — a hex wallet private key that signs the envelope. A throwaway key is fine for testing, but the signing address must be in `agent/brain/Config/brain-allowlist.json` on both machines for the publish side's writes to be ACCEPTED by the subscriber side. Use `pop brain allowlist add --address 0x<publisher-addr>` if needed; that edit only needs to land before the verify step runs.
- **`POP_BRAIN_HOME`** — distinct per machine (or per terminal session). Default is `~/.pop-agent/brain`. Set it explicitly for each test run so state is isolated:
  ```bash
  export POP_BRAIN_HOME=/tmp/brain-xmachine-A   # machine A
  export POP_BRAIN_HOME=/tmp/brain-xmachine-B   # machine B
  ```
- **Node 18+** on both machines.

---

## The script

A single parameterized script handles all three roles:

```bash
node test/scripts/brain-cross-machine-smoke.js
```

The `ROLE` env var picks behavior:

| Role | What it does |
|---|---|
| `subscribe` | Boot a brain node, print the listening multiaddrs in copy-paste-ready form, subscribe to `test.xmachine`, wait forever logging inbound announcements. Ctrl-C to exit. |
| `publish` | Boot a DIFFERENT brain home, optionally dial `SUBSCRIBER_ADDR`, wait for peer discovery, subscribe to the same topic, apply a signed brain change with a **known tag** (`xmachine-<unix>-<hostname>`), linger 15s for Bitswap delivery, exit. |
| `verify` | Read the local doc, check whether any lesson matching `XMACHINE_TAG` exists. Exit 0 (PASS) or 1 (FAIL). |

---

## Scenario 1: LAN + explicit dial (known-working baseline)

This proves the substrate is functional before any WAN scenario. If this doesn't work, nothing else will.

**Machine A — subscribe:**

```bash
export POP_BRAIN_HOME=/tmp/brain-xmachine-A
export POP_PRIVATE_KEY=0x<A-key>
ROLE=subscribe node test/scripts/brain-cross-machine-smoke.js
```

Expected output:
```
[subscribe] role=subscribe doc=test.xmachine home=/tmp/brain-xmachine-A
[subscribe] local peer: 12D3KooW<...>
[subscribe] listening multiaddrs — copy the one the peer should dial:
  /ip4/127.0.0.1/tcp/<port>/p2p/12D3KooW<...>
  /ip4/<LAN-addr>/tcp/<port>/p2p/12D3KooW<...>

[subscribe] subscribing to brain topic for "test.xmachine" — waiting for announcements...
```

Copy the `/ip4/<LAN-addr>/...` multiaddr (NOT the 127.0.0.1 one unless both machines are on localhost).

**Machine B — publish:**

```bash
export POP_BRAIN_HOME=/tmp/brain-xmachine-B
export POP_PRIVATE_KEY=0x<B-key>
export SUBSCRIBER_ADDR=/ip4/<A-LAN-addr>/tcp/<port>/p2p/12D3KooW<...>
ROLE=publish node test/scripts/brain-cross-machine-smoke.js
```

Expected output:
```
[publish] explicit dial to /ip4/.../tcp/.../p2p/...
[publish] dial succeeded
[publish] subscribing to test.xmachine topic to form the gossipsub mesh...
[publish] applying brain change: title=xmachine-<unix>-<hostname>
[publish] new head CID: bafkrei<...>
[publish] envelope signer: 0x<B-addr>
[publish] lingering 15s for bitswap delivery...
[publish] DONE.
```

Machine A (subscribe) should log a `head <cid>  from <B peerId>` line within ~2 seconds of the publish.

**Machine A — verify** (in a separate terminal):

```bash
export POP_BRAIN_HOME=/tmp/brain-xmachine-A
export XMACHINE_TAG=xmachine-<unix>-<hostname-from-publish-output>
ROLE=verify node test/scripts/brain-cross-machine-smoke.js
```

Expected: `[verify] PASS — cross-machine lesson propagated`.

---

## Scenario 2: LAN + mDNS (known flaky on macOS)

Same machines, same network, but **no explicit dial**. This tests whether mDNS can auto-discover peers.

**Machine A:** unchanged from scenario 1.

**Machine B:** same as scenario 1 but WITHOUT `SUBSCRIBER_ADDR`:
```bash
unset SUBSCRIBER_ADDR
ROLE=publish node test/scripts/brain-cross-machine-smoke.js
```

Expected: the publish side prints `[publish] t+3s connected peers: 0 ...` progress lines for up to 30s before giving up. If `connected peers` goes to 1+ within the window, mDNS worked. If it stays at 0 the whole time, mDNS is blocked (common on macOS — this is the documented flaky path).

Regardless of mDNS success, the publish will still attempt to apply the change. Whether machine A actually receives it depends on whether gossipsub mesh formed, which depends on whether peer discovery succeeded.

**This scenario is NOT expected to work reliably on macOS.** Log the result either way — a pass is newsworthy, a fail is the expected state.

---

## Scenario 3: WAN + bootstrap DHT only (experimental — the main test)

This is the one we actually want to work. Two machines on separate residential networks, no direct dial, no mDNS. Both peers need to find each other via the Protocol Labs public IPFS bootstrap peers + libp2p DHT.

**Machine A** (may or may not be behind NAT):
```bash
export POP_BRAIN_HOME=/tmp/brain-xmachine-A
export POP_PRIVATE_KEY=0x<A-key>
ROLE=subscribe node test/scripts/brain-cross-machine-smoke.js
```

Let it run for **at least 60 seconds** before introducing machine B — the bootstrap DNS records take time to resolve and the DHT takes time to populate.

**Machine B** (no `SUBSCRIBER_ADDR`):
```bash
export POP_BRAIN_HOME=/tmp/brain-xmachine-B
export POP_PRIVATE_KEY=0x<B-key>
unset SUBSCRIBER_ADDR
ROLE=publish node test/scripts/brain-cross-machine-smoke.js
```

Expected (if it works):
- `[publish] t+3s connected peers: 0` → `[publish] t+6s connected peers: 1+` within 30 seconds.
- Machine A logs the head announcement.
- `ROLE=verify` on A returns PASS.

Expected (if it doesn't work — which is honest uncertainty as of sprint-3):
- `[publish] t+30s connected peers: 0`. No discovery.
- Publish still completes locally (the brain layer writes are signed and persisted regardless of network state), but the announcement never reaches machine A.
- `ROLE=verify` on A returns FAIL.

If scenario 3 fails, go to the **diagnostic capture** section and grab the evidence.

---

## Scenario 4: WAN + Circuit Relay v2 (NAT hole-punch case)

This is the hardest case: both machines behind residential NAT, no direct reachability, must use a public Circuit Relay v2 node as an intermediary. The sprint-3 wiring includes `circuitRelayTransport()` for exactly this.

Setup is the same as scenario 3. What differs is the evidence of success:

- Machine A's `pop brain status --json` should list at least one `listeningAddrs` entry containing `/p2p-circuit/` within 60-120 seconds of startup. That's the AutoNAT-detected relay-reachable address.
- Machine B's dial should succeed through the relay without `SUBSCRIBER_ADDR` being set.

If `pop brain status --json` on A never shows a `/p2p-circuit/` entry, AutoNAT didn't find a usable relay, and scenario 4 won't work regardless of what B does. Check `POP_BRAIN_DEBUG=1` for warnings.

---

## Diagnostic capture (if any scenario fails)

Grab the following from **both** machines and include them in a bug report:

```bash
# Local state — peer store, listening addrs, topic membership
pop brain status --json > /tmp/brain-status-<hostname>.json

# Local brain doc state
pop brain list > /tmp/brain-list-<hostname>.txt
pop brain read --doc test.xmachine --json > /tmp/brain-read-<hostname>.json

# libp2p debug logs — re-run the script with this in the environment
DEBUG='libp2p:*,@chainsafe/libp2p-gossipsub:*' ROLE=... node test/scripts/brain-cross-machine-smoke.js 2>&1 | tee /tmp/libp2p-debug-<hostname>.log
```

Useful on-host tcpdump (if you have root):

```bash
# libp2p default TCP port is random; grep it from `pop brain status --json`
sudo tcpdump -i any -w /tmp/brain-pcap-<hostname>.pcap 'tcp port <port-from-status>'
```

**The single most useful datum**: `getPeers()` and `getSubscribers(topic)` values from both peers' gossipsub state. If peers see each other in `getPeers()` but NOT in `getSubscribers(topic)`, the gossipsub mesh is failing to form — which was the exact failure mode of the libp2p 3.x + gossipsub 14 silent-break caught in HB#268. If peers don't appear in `getPeers()` at all, discovery is failing upstream.

---

## Known-good verification (what "it works" looks like)

All of the following must be true after scenario 3 runs successfully:

1. **Publish side** prints `[publish] new head CID: bafkrei<X>` and exits 0.
2. **Subscribe side** prints an incoming `head <X> from <B-peerId>` line within ~5 seconds of the publish (the CID `X` matches).
3. **Verify on subscribe side** (`ROLE=verify`) prints `[verify] PASS — cross-machine lesson propagated` with the lesson's `id`, `author`, `ts` in the output, and exits 0.
4. `pop brain read --doc test.xmachine --json` on the subscribe side shows the lesson in `doc.lessons[]` with `author=<publish-hostname>` and `title=xmachine-<unix>-<hostname>`.
5. The subscribe side's `pop brain list` shows `test.xmachine` with the same head CID as the publish side.

If 1–4 all pass but 5 shows a different head, run `pop brain snapshot --doc test.xmachine` and re-check — the manifest may just be stale.

---

## Running the publish + verify loop on a single machine (local sanity)

Before sending this runbook to a second-machine operator, sanity-check the script end-to-end on the local machine:

```bash
yarn build
yarn test:xmachine-smoke   # publish + verify against /tmp/brain-xmachine-loopback
```

The `test:xmachine-smoke` npm script wraps ROLE=publish and ROLE=verify back-to-back with the same `POP_BRAIN_HOME` (so it's essentially just testing local write + read — NOT cross-machine, but it proves the script's plumbing works before you run it remotely).

---

## What to file if it fails

Open a GitHub issue with:

- Which scenario (1/2/3/4)
- Both machines' `brain-status-<hostname>.json` files
- Both machines' `libp2p-debug-<hostname>.log` files (tail, not full — last 500 lines is plenty)
- Expected vs actual (success from each side's perspective)

If scenario 3 passes, **remove the `experimental` / `untested` tags** from `docs/agents/brain-layer-setup.md` §8 and from this file's header. That flip is the real close of PR #9 cross-machine blocker #5.
