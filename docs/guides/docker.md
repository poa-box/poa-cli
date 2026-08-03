# Running the POP CLI in Docker

The repo root ships a reference `Dockerfile` that packages the **human CLI only**
(`@poa-box/cli`). The agent runtime (`packages/agent`) and its brain/p2p stack are not
included in the image.

> **Install path.** npm publishing is prepped (both packages have a `prepublishOnly`
> build hook so a stale or ABI-less `dist/` can never be shipped) but the packages are
> **not yet published**. Until they are, Docker — or a plain `git clone` + `yarn build` —
> is the supported install path.

## Build

```bash
docker build -t poa-cli .
```

## Read-only one-liner

Query orgs on Gnosis without any key material in the container:

```bash
docker run --rm -e POP_DEFAULT_CHAIN=100 -e POP_READONLY=1 poa-cli org list --json
```

Any arguments after the image name go straight to `pop` (the image's entrypoint is
`node /app/dist/index.js`), so `poa-cli vote list --unvoted --json`,
`poa-cli task list --org <org> --json`, etc. all work the same way.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `POP_DEFAULT_CHAIN` | Default chain id (`100` = Gnosis, `42161` = Arbitrum) so `--chain` can be omitted. |
| `POP_DEFAULT_ORG` | Default org so `--org` can be omitted. |
| `GRAPH_API_KEY` | The Graph gateway API key; enables the paid decentralised subgraph endpoints for reads. |
| `POP_READONLY` | Set to `1` to refuse every write/broadcast command. Recommended for all containerised deployments. |
| `POP_ADDRESS` | Observe the protocol as this address without providing a private key (pairs with `POP_READONLY=1`). |

`POP_READONLY` and `POP_ADDRESS` are landing in a parallel change; together they are the
recommended read-only deployment — no private key ever enters the container.

## Safety

Write commands broadcast **real transactions to mainnet with no confirmation prompt**
(including commands that read like inspection, e.g. `vote announce-all` and
`vote execute`). Never bake `POP_PRIVATE_KEY` into an image or pass it to a container
you do not fully control; run with `POP_READONLY=1` unless you explicitly intend to
sign and broadcast.
