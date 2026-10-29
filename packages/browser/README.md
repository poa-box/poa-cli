# @poa-box/browser

Optional, framework-independent browser integration for `@poa-box/core`.
Core owns protocol reads, encodings, permissions and outcome proofs. This package
owns reusable browser ceremonies, wallet handoff, account generations, durable
journals and the operation lifecycle. It has no React, routing, branding, wallet
modal or environment-variable dependency.

**0.1.0 is a release candidate in this PR.** Core 2.1.0 is already published.
Until the browser package is published, install the reviewed `.tgz` from its
build; never substitute a source alias when verifying an integration. After
publication the installation is:

```sh
npm install @poa-box/browser@0.1.0 ethers@5.7.2
```

The package pins its tested core dependency to **2.1.0**. A future core release
cannot silently change that dependency. TypeScript consumers use the DOM library
and an explicit `@types/node` development dependency for ethers v5 declarations.
Use subpath imports to keep unrelated adapters out of your bundle.

| Import | Supported responsibility |
| --- | --- |
| `@poa-box/browser/passkeys` | WebAuthn create/discover/assert, exact challenge/origin/RP/credential checks, P-256 and signature codecs, account readiness |
| `@poa-box/browser/wallet` | EIP-1193/ethers final dispatch and explicit EntryPoint v0.7 sponsored/passkey transport ports |
| `@poa-box/browser/storage` | Durable unsigned IndexedDB journal, account Web Locks, compatible credential hint storage |
| `@poa-box/browser/session` | Resolved-account generation and cancellation, including account A → B → A |
| `@poa-box/browser/workflows` | Reviewed roles, informational polls, ballots, task create/claim/complete, atomic registration + joining |
| `@poa-box/browser/observations` | Bound RPC and indexed-data readers assembling verified workflow evidence and exact simulations |
| `@poa-box/browser/config` | Pure configuration inspection and bounded, explicit, read-only setup diagnostics |

See [the integration guide](docs/integration.md) and the machine-readable
[feature catalog](docs/features.v1.json). The catalog distinguishes package
functionality, injected host services and unsupported workflows. Setup availability
never grants current permission, spending approval or consent.

## Establish browser identity and scope

<!-- browser-test:connection -->
```js
import { createAccountSession } from '@poa-box/browser/session';
import { createEip1193WalletAdapter } from '@poa-box/browser/wallet';
import { createBrowserJournal } from '@poa-box/browser/storage';

export async function connectExistingWallet(ethereum) {
  // The app's connection UI has already selected this provider.
  const wallet = createEip1193WalletAdapter({ ethereum });
  const identity = await wallet.getIdentity();
  const session = createAccountSession({ initialScope: identity });
  const journal = createBrowserJournal();
  const invalidate = () => session.clear();
  ethereum.on?.('accountsChanged', invalidate);
  ethereum.on?.('chainChanged', invalidate);
  return { wallet, session, journal, dispose() {
    session.clear(); wallet.dispose();
    ethereum.removeListener?.('accountsChanged', invalidate);
    ethereum.removeListener?.('chainChanged', invalidate);
  } };
}
```

Saved account and credential data are hints, not authenticated identity. Restore
and validate the selected credential and account before placing them in a session.
The reference frontend keeps its existing UI and migration behavior while importing
these shared modules. Other applications can use the native browser credential
adapter or inject their existing WebAuthn library.

## Use one operation lifecycle

The supported operation factories expose `review`, `prepare`, `submit`, `status`
and `recover`. Roles also expose `capabilities` and `continuation` for the separate
creation/configuration stages. Results distinguish `ready`, `blocked`, `unknown`,
`pending` and `confirmed`; role status additionally carries the core's exact
creation/configuration states.

Supply a resolved organization/account scope, bound read sources, explicit
approval callbacks, document publication where required, a wallet transport and
journal. The default never signs, sends or publishes merely by importing or
constructing a client. Review is read-only. Prepare can publish reviewed metadata;
atomic enrollment can request a separately approved registration signature.
Submit requires a separate approval and repeats identity, ownership, freshness,
policy and simulation checks at the actual transport boundary.

A timeout is not permission to retry. Reload the original unsigned journal and
recover that operation. Keep transaction hashes and UserOperation hashes distinct.
An outer successful bundle receipt is insufficient to confirm an inner action.

## Verification and release

From this repository:

```sh
yarn --cwd packages/browser install --frozen-lockfile
yarn --cwd packages/browser build
yarn --cwd packages/browser test
yarn --cwd packages/browser api:check
npm pack ./packages/browser --ignore-scripts --pack-destination /tmp
node packages/browser/scripts/verify-packed-consumer.mjs /tmp/poa-box-browser-0.1.0.tgz
```

The archive verifier installs outside the repository, checks public declaration
resolution, replays behavioral tests against the installed JavaScript, runs the
independent role host using this package's controller/adapters, and bundles a
network-free workflow for a browser VM. Neither verification command publishes
anything. Runtime compatibility and service readiness must also be checked on the
application's actual deployment.
