# Reference Dockerfile for the POP human CLI (@poa/cli) only.
# The autonomous agent runtime (packages/agent, @poa/agent) and its brain/p2p
# stack are deliberately NOT built or installed here.
#
# Build:  docker build -t poa-cli .
# Run:    docker run --rm -e POP_DEFAULT_CHAIN=100 -e POP_READONLY=1 poa-cli org list --json
# See docs/guides/docker.md for the full guide.

# ---------------------------------------------------------------------------
# Stage 1: build — full install (dev deps included) + compile.
# `yarn build` runs tsc AND `cp src/abi/*.json dist/abi/`; the copy is
# load-bearing because plain tsc only emits ABIs that are import-referenced.
# ---------------------------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app

# @poa/core is a link: dependency — its package.json must exist BEFORE install
# so yarn can create the node_modules/@poa/core symlink.
COPY package.json yarn.lock ./
COPY packages/core/package.json packages/core/yarn.lock ./packages/core/
RUN yarn install --frozen-lockfile --production=false \
  && yarn --cwd packages/core install --frozen-lockfile --production=false

COPY tsconfig.json ./
COPY src ./src
# Full core sources: yarn build compiles packages/core first (gen-abis.mjs
# reads ../../src/abi from the src/ copy above, then tsc → packages/core/dist).
# .dockerignore excludes packages/core/{node_modules,dist}, so this overlay
# never clobbers the image's installed deps.
COPY packages/core ./packages/core
RUN yarn build

# ---------------------------------------------------------------------------
# Stage 2: runtime — production deps only, plus the built dist/ and docs/.
# ---------------------------------------------------------------------------
FROM node:20-alpine
WORKDIR /app

# The runtime needs @poa/core resolvable at node_modules/@poa/core; the link:
# symlink points at packages/core, so ship its package.json + built dist.
COPY package.json yarn.lock ./
COPY packages/core/package.json ./packages/core/package.json
RUN yarn install --frozen-lockfile --production=true && yarn cache clean

COPY --from=build /app/dist ./dist
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY docs ./docs

# --- Safe-integration knobs -------------------------------------------------
# Set these with `docker run -e ...` (or uncomment to bake in defaults).
#
# ENV POP_DEFAULT_CHAIN=100       # default chain id (100 = Gnosis, 42161 = Arbitrum)
# ENV POP_DEFAULT_ORG=<org>       # default org so --org can be omitted
# ENV GRAPH_API_KEY=<key>         # The Graph gateway key for subgraph reads
#
# Recommended read-only deployment (flags landing in a parallel change):
# ENV POP_READONLY=1              # refuse all write/broadcast commands
# ENV POP_ADDRESS=0x...           # observe as this address, no private key needed
#
# Never bake POP_PRIVATE_KEY into an image. Write commands broadcast real
# transactions to mainnet with no confirmation prompt; prefer POP_READONLY=1.

ENTRYPOINT ["node", "/app/dist/index.js"]
