#!/usr/bin/env bash
set -euo pipefail

# Sync src/abi/*.json from the POP contracts repo.
#
# Builds origin/main in a temporary detached git worktree so the contracts
# repo's working tree (which may be dirty on a feature branch) is never
# touched, then extracts bare ABI arrays into src/abi/ via extract-abis.mjs.
#
# Env overrides:
#   POP_CONTRACTS_REPO      path to the contracts repo   (default: /Users/hudsonheadley/Desktop/Code/POP)
#   POP_CONTRACTS_REF       git ref to build             (default: origin/main)
#   POP_CONTRACTS_WORKTREE  temp worktree location       (default: /tmp/pop-main)
#   POP_SKIP_FETCH=1        skip `git fetch origin`

CONTRACTS_REPO="${POP_CONTRACTS_REPO:-/Users/hudsonheadley/Desktop/Code/POP}"
WORKTREE_DIR="${POP_CONTRACTS_WORKTREE:-/tmp/pop-main}"
REF="${POP_CONTRACTS_REF:-origin/main}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -e "$CONTRACTS_REPO/.git" ]; then
  echo "error: contracts repo not found at $CONTRACTS_REPO (set POP_CONTRACTS_REPO)" >&2
  exit 1
fi

cleanup() {
  git -C "$CONTRACTS_REPO" worktree remove --force "$WORKTREE_DIR" 2>/dev/null || true
}
trap cleanup EXIT

if [ "${POP_SKIP_FETCH:-0}" != "1" ]; then
  echo "==> git fetch origin ($CONTRACTS_REPO)"
  git -C "$CONTRACTS_REPO" fetch origin
fi

# Remove any stale worktree from a previous failed run, then create fresh.
cleanup
git -C "$CONTRACTS_REPO" worktree prune
echo "==> creating worktree $WORKTREE_DIR @ $REF"
git -C "$CONTRACTS_REPO" worktree add --detach "$WORKTREE_DIR" "$REF"
# Init lib/ dependencies only — main carries a stray `_frontend` gitlink with
# no .gitmodules entry, so a blanket `--init --recursive` fatals.
git -C "$WORKTREE_DIR" config submodule.active 'lib/*'
git -C "$WORKTREE_DIR" submodule update --init --recursive -- lib/

echo "==> forge build ($(git -C "$WORKTREE_DIR" rev-parse --short HEAD))"
(cd "$WORKTREE_DIR" && forge build --skip test --skip script)

echo "==> extracting ABIs"
node "$SCRIPT_DIR/extract-abis.mjs" "$WORKTREE_DIR/out"

echo "==> done (worktree removed on exit)"
