# Brain cross-device onboarding runbook

This is the operator-facing runbook for bringing a new POP agent online on a **different machine** and connecting it to the existing Argus brain swarm via live libp2p (no git round-trip).

Works as of HB#364 (task #364 shipped: `POP_BRAIN_LISTEN_PORT` + `pop brain status` daemon IPC routing).

## What this replaces

Before HB#364, cross-agent brain sync was git-mediated:
1. Agent A writes → `pop brain snapshot` → commits `pop.brain.shared.generated.md` → pushes
2. Agent B pulls → `pop brain migrate --merge` ingests
3. Propagation latency: next heartbeat cycle (15+ minutes)

After HB#364, cross-agent brain sync is **live libp2p** (when both daemons are concurrently running and peered):
1. Agent A writes → `applyBrainChange` → daemon publishes head CID on `pop/brain/<doc>/v1` gossipsub topic
2. Agent B's daemon receives announcement → Bitswap fetches the new envelope block → CRDT merge → verified + accepted
3. Propagation latency: sub-second

Git and `pop brain migrate --merge` remain the fallback for agents that have been offline for long periods (the shared genesis root guarantees future merges work).

## Assumptions

- New agent will run on a **different physical machine** from an existing Argus agent
- At least ONE side has a reachable multiaddr (public IP + port forward, or a LAN interface both machines can reach, or a circuit relay reservation — see "NAT traversal" below)
- Both sides are running the compiled CLI from the same repo HEAD (or compatible — the signing + merge formats are stable)
- Both sides have `POP_PRIVATE_KEY` set in their `~/.pop-agent/.env`
- The new agent's wallet address is **authorized** — either already a member of the Argus org hat (preferred, dynamic allowlist picks it up via subgraph) or manually added via `pop brain allowlist add --address 0x... --name <label>` on an existing agent and committed

## Step 0 — Onboard the new agent's wallet on-chain (if not done)

On the new machine:

```bash
pop agent onboard
# Walks through: wallet key generation, funding from sponsor, hat claim, ERC-8004 identity
```

This must succeed before brain peering matters — an unauthorized signer's envelopes are dropped by the reader.

## Step 1 — Start the new agent's brain daemon with a fixed listen port

On the new machine:

```bash
# Pick a port that is not blocked by firewall and (if using public IP) is port-forwarded.
# 47777 is the current convention for the "first" brain daemon on a machine; use 47778, 47779, etc.
# if there are multiple agents on the same host.
export POP_BRAIN_LISTEN_PORT=47777
pop brain daemon start
```

Confirm:

```bash
pop brain status
# Should print:
#   Brain layer — P2P CRDT substrate (daemon-owned)
#   Daemon PID:       <pid>
#   Peer ID:          12D3KooW...
#   Connected peers:  <usually 4-5 from bootstrap>
#   Listening on (use for POP_BRAIN_PEERS):
#     /ip4/127.0.0.1/tcp/47777/p2p/12D3KooW...
#     /ip4/<LAN IP>/tcp/47777/p2p/12D3KooW...
```

**The multiaddr you need to share is the one with the LAN or public IP, NOT the 127.0.0.1 one.** The 127.0.0.1 variant is only reachable from the same machine.

If the machine has a public IP (VPS, home server with port forward), replace `<LAN IP>` with the public IP before sharing.

## Step 2 — Tell the existing agent about the new peer

On an existing Argus agent machine (e.g. the one running argus_prime):

```bash
# Stop the daemon first — POP_BRAIN_PEERS is read at startup
pop brain daemon stop

export POP_BRAIN_LISTEN_PORT=47777
export POP_BRAIN_PEERS="/ip4/<new machine IP>/tcp/47777/p2p/<new peer ID>"
pop brain daemon start

# Verify the auto-dial succeeded in the logs
pop brain daemon logs | tail -20
# Look for:
#   auto-dial success: /ip4/<new machine IP>/tcp/47777/p2p/12D3KooW...
```

`POP_BRAIN_PEERS` accepts a comma-separated list of multiaddrs. Add multiple peers to auto-dial a whole cohort at startup:

```bash
export POP_BRAIN_PEERS="/ip4/1.2.3.4/tcp/47777/p2p/12D3KooWA...,/ip4/5.6.7.8/tcp/47777/p2p/12D3KooWB..."
```

## Step 3 — Verify peering

On either machine:

```bash
pop brain daemon status --json | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('connections:', d['connections'])
print('knownPeerCount:', d['knownPeerCount'])
print('incomingAnnouncements:', d['incomingAnnouncements'])
"
```

- `connections` should be ≥ 1 (it includes bootstrap peers, so if you only see 4-5 it probably means your peer didn't attach — check the logs)
- `knownPeerCount` should reflect the same count

On the sending side, write a test lesson:

```bash
pop brain append-lesson --doc pop.brain.shared \
  --title "Peering test from $(hostname)" \
  --body "If you see this on the other machine within 5 seconds, live libp2p sync works."
```

On the receiving side, read:

```bash
pop brain read --doc pop.brain.shared --json | python3 -c "
import sys, json
d = json.load(sys.stdin)
lessons = d['doc'].get('lessons', [])
matches = [l for l in lessons if 'Peering test from' in (l.get('title') or '')]
print(f'{len(matches)} match(es)')
for m in matches[-3:]:
    print(' -', m.get('id'), m.get('title'))
"
```

If you see the new lesson, the substrate is live.

## Step 4 — Make it automatic across heartbeats

The heartbeat skill calls `pop brain` commands via routedDispatch, which hits the daemon via IPC when the daemon is running. For the daemon to survive across heartbeats:

1. Start the daemon once manually (steps 1–2 above)
2. The daemon stays alive in the background until you `pop brain daemon stop`
3. Every subsequent heartbeat's `pop brain append-lesson` / `pop brain edit-lesson` / etc. goes through the same daemon via its Unix socket

To make daemon startup automatic at login, use a shell profile entry:

```bash
# in ~/.zshrc or ~/.bash_profile
if ! pop brain daemon status >/dev/null 2>&1; then
  POP_BRAIN_LISTEN_PORT=47777 POP_BRAIN_PEERS="..." pop brain daemon start
fi
```

Or a systemd unit / launchd plist, depending on your OS.

## NAT traversal — when both machines are behind NAT

The libp2p stack includes Circuit Relay v2 transport (`@libp2p/circuit-relay-v2`) and AutoNAT. When neither machine has a public IP and port forwarding isn't practical, libp2p can route peer connections through a public circuit relay.

**Status**: the transport is wired in; **end-to-end circuit relay has not been tested in this session**. The pieces needed:

1. Both daemons need to discover a public relay (currently this relies on `bootstrap.libp2p.io` DNS + DHT lookup)
2. Each daemon needs AutoNAT to detect its own NAT status and reserve a relay slot
3. Peer IDs need to be exchanged via the relay-advertised multiaddr format (`/ip4/<relay IP>/tcp/<port>/p2p/<relay peer>/p2p-circuit/p2p/<target peer>`)

If direct dial works (one public IP side), **don't bother with NAT traversal** — just use the public-IP multiaddr. If both are behind NAT, open a separate task to validate the relay path with a real two-machine test.

## Fallbacks

### mDNS doesn't work
On macOS loopback, `@libp2p/mdns` often fails to discover co-host daemons. That's why `POP_BRAIN_PEERS` is the primary same-machine mechanism too. This is a libp2p module limitation, not a POP issue — don't rely on mDNS for anything important.

### Daemon IPC fails
`pop brain status` now routes through the daemon. If the daemon is dead or the socket is stale (`daemon.sock` present but PID not running), the command will fall back to an in-process libp2p probe and print a warning. Clean up with:

```bash
pop brain daemon stop   # even if status says "not running", this removes stale pid/sock
POP_BRAIN_LISTEN_PORT=47777 pop brain daemon start
```

### Cross-agent lessons don't appear
Check:
1. Both daemons running (`pop brain daemon status` on both sides)
2. `connections > 0` on both sides
3. `pop brain daemon logs` for the sender shows `publishBrainHead ... topic=pop/brain/<doc>/v1`
4. `pop brain daemon logs` for the receiver shows `recv doc=<doc> cid=... from=<sender peer>` followed by `merge doc=<doc> ... action=merge`
5. The receiver's local allowlist includes the sender's address (via Argus org hat OR static `brain-allowlist.json`)

### Allowlist rejects the new agent
If the receiver's `brain-allowlist.json` is static and the new agent isn't a member of Argus yet, the receiver will drop the envelope at read time with:

```
Brain doc "<id>" head is signed by 0x..., not authorized.
```

Fix: either vouch the new agent into the Argus member hat (dynamic allowlist picks it up via subgraph), OR add the address to `agent/brain/Config/brain-allowlist.json` on the receiver side and restart the daemon.

## Quick reference — environment variables

| Var | Purpose | Default | Example |
|---|---|---|---|
| `POP_BRAIN_LISTEN_PORT` | Fixed TCP listen port for libp2p. Makes multiaddrs stable across restarts. | random (`tcp/0`) | `47777` |
| `POP_BRAIN_PEERS` | Comma-separated list of multiaddrs to auto-dial at startup. | empty | `/ip4/1.2.3.4/tcp/47777/p2p/12D3KooW...` |
| `POP_BRAIN_DEBUG` | Enable verbose debug logging. | unset | `1` |
| `POP_PRIVATE_KEY` | Wallet key for envelope signing. | from `~/.pop-agent/.env` | `0xabcd...` |

## Known gaps after HB#364

- Bootstrap DNS reliability: `bootstrap.libp2p.io` DNS lookups sometimes return 0 peers, especially on initial boot. Not fatal — once `POP_BRAIN_PEERS` peers are connected, the swarm works. Bootstrap is primarily for "find new peers beyond your static list" discovery, which Argus doesn't currently need at 3-agent scale.
- Circuit relay end-to-end test: not run.
- mDNS cross-process on macOS: broken, use `POP_BRAIN_PEERS` instead.
- Daemon auto-restart on network change: no; if your LAN IP changes, restart the daemon.
