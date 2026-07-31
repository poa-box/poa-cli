# Silent OutboundStream failure on libp2p 3.x + gossipsub 14.x (type mismatches in onPeerConnected)

*Target repo: `@chainsafe/libp2p-gossipsub` — the root cause is a libp2p-3.x interface skew that gossipsub's topology handler hits at connect time. Filing here because the failure surfaces as a gossipsub bug even though the root cause is upstream.*

## Summary

`@chainsafe/libp2p-gossipsub@14.1.2` is incompatible with `libp2p@3.x`. The failure mode is **silent**: `publish` returns `{ recipients: [] }`, peers see each other in `getPeers()` but NOT in `getSubscribers(topic)`, no `/meshsub` substream is ever opened, no exception propagates to application code. Two specific inner exceptions get eaten by the registrar topology callback in `_onPeerIdentify`, so the only visible symptom is that pubsub delivery silently does nothing.

## Versions that reproduce

```
libp2p                     3.2.0
@chainsafe/libp2p-gossipsub 14.1.2
@libp2p/tcp                11.0.15
@libp2p/mdns               12.0.16
@multiformats/multiaddr    13.0.1  (top-level, via libp2p 3.x)
```

## Reproduction

Two local-process libp2p nodes, both with gossipsub, both subscribing to the same topic, connected via explicit `dial`:

```js
const a = await createLibp2p({
  addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
  transports: [tcp()],
  streamMuxers: [yamux()],
  connectionEncrypters: [noise()],
  services: {
    identify: identify(),
    pubsub: gossipsub({ allowPublishToZeroTopicPeers: true, emitSelf: false }),
  },
});
const b = /* same */;

a.services.pubsub.subscribe('test/topic/v1');
b.services.pubsub.subscribe('test/topic/v1');
await a.dial(b.getMultiaddrs()[0]);
// Wait several seconds for gossipsub heartbeat.
await a.services.pubsub.publish('test/topic/v1', new TextEncoder().encode('hello'));
```

Expected: `b` receives the message via its `pubsub` event listener.

Actual: publish returns `{ recipients: [] }`. `b` receives nothing. No exception is thrown anywhere in the application.

## Inspection (after ~5 seconds of quiescence)

```
a.services.pubsub.getPeers()               → [<b peerId>]     // known
a.services.pubsub.getSubscribers(topic)    → []               // not known in topic
a.services.pubsub.getMeshPeers(topic)      → []               // no mesh
a.getConnections()[0].streams              → []               // no substreams at all
a.peerStore.get(<b peerId>).protocols      → ['/ipfs/id/1.0.0',
                                              '/meshsub/1.0.0',
                                              '/meshsub/1.1.0',
                                              '/meshsub/1.2.0']
```

Peers know each other's gossipsub protocols via identify, but no `/meshsub/*` substream is ever opened. That's the critical asymmetry: discovery works, stream attachment doesn't.

## Root cause

Gossipsub's `_onPeerIdentify` topology callback runs `addPeer` → `createOutboundStream`. Two separate exceptions throw and are caught-and-eaten inside the registrar's `onConnect` wrapper (`@libp2p/registrar._onPeerIdentify`):

1. **`TypeError: multiaddr.tuples is not a function`** at `@chainsafe/libp2p-gossipsub/dist/src/utils/multiaddr.js` (line ~12). Gossipsub's nested `@multiformats/multiaddr` is v12, which has `.tuples()`. libp2p 3.x ships v13 top-level, which replaced `.tuples()` with `.getComponents()`. `Connection.remoteAddr` is the v13 Multiaddr, and v12's `.tuples()` call fails.

2. **`TypeError: fns.shift(...) is not a function`** at `@chainsafe/libp2p-gossipsub/dist/src/stream.js` inside `new OutboundStream`, via `pipe(this.pushable, this.rawStream)`. libp2p 3.x's `Stream extends MessageStream` is an event-based API and no longer exposes `sink` / `source` duplexes, so `it-pipe` can't use it as a sink and throws.

Both are silently logged once by the registrar and the outbound stream creation short-circuits. Application code sees no error, gossipsub sees no peer in `getSubscribers`, publish flood-publishes to an empty set.

## Workaround: pin libp2p to 2.x

Gossipsub 14 declares `@libp2p/interface ^2.0.0` as its peer dep. The only supported combination is **libp2p 2.x** with a matched transport/muxer/crypto set:

```
helia                          5.5.1    (required because helia 6.x pulls libp2p 3.x)
libp2p                         2.10.x
@chainsafe/libp2p-gossipsub    14.x
@chainsafe/libp2p-noise        16.x
@chainsafe/libp2p-yamux        7.x
@libp2p/tcp                    10.x
@libp2p/mdns                   11.x
@libp2p/identify               3.x
@libp2p/bootstrap              11.x
@libp2p/circuit-relay-v2       3.x
@libp2p/autonat                2.x
```

With this pin, gossipsub's `OutboundStream` instantiates cleanly, `getSubscribers` populates, publish delivers, and peers see each other in the mesh. Verified in-process and in two-process-on-localhost tests; live Protocol Labs bootstrap peers connect within ~3 seconds of process start when a TCP + mDNS + bootstrap peerDiscovery stack is wired.

Yarn `resolutions` may also be needed if noise@16 pulls `@noble/ciphers` / `@noble/hashes` at a transitive v2 that v1-exports-based `libp2p-noise` can't resolve:

```json
"resolutions": {
  "@noble/ciphers": "^1.3.0",
  "@noble/hashes": "^1.8.0"
}
```

Do NOT pin `@noble/curves` — pinning it conflicts with `ox`'s TypeScript types in viem-adjacent packages.

## Suggested fix

Gossipsub 14 needs a libp2p-3.x-compatible release. Specifically:

- Replace `multiaddr.tuples()` with the 13.x API (`.getComponents()`) in `utils/multiaddr.js`.
- Update the `OutboundStream` pipe in `stream.js` to use libp2p 3.x's `Stream` event-based API instead of `it-pipe`.
- Bump the peer dep to `@libp2p/interface ^2.0.0 || ^3.0.0` once the above work.

Until that ships, the silent-failure path is a trap for anyone combining the `latest` tag of gossipsub with the `latest` tag of libp2p — which is the most common thing a new project will do.

## Defensive logging suggestion

Independent of the version work: the registrar's `_onPeerIdentify → topology.onConnect` catch-and-log pattern swallows the root cause unless `DEBUG=libp2p:*` is set at process start. Raising the default log level on that specific exception path (or re-throwing it after logging) would have cut the debug time on this bug from an hour to a minute.

## Related reading

- Argus brain substrate writeup (full debug narrative + design context): `ipfs://QmXkSW9xqndev77ht4SUzvSEwVmUkAbGjsjViXF8SPFdR4`
- `github.com/PerpetualOrganizationArchitect/poa-cli` — the JS codebase where this was caught, using the pinned 2.x stack above.
