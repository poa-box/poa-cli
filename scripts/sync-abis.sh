#!/usr/bin/env bash
set -euo pipefail

# Sync src/abi/*.json from the POP contracts repo.
#
# Builds origin/main in a temporary detached git worktree so the contracts
# repo's working tree (which may be dirty on a feature branch) is never
# touched, then extracts bare ABI arrays into src/abi/ via extract-abis.mjs.
#
# Env overrides:
#   POP_CONTRACTS_REPO      path to the contracts repo   (required)
#   POP_CONTRACTS_REF       git ref to build             (default: origin/main)
#   POP_CONTRACTS_WORKTREE  unused temp worktree path    (default: unique temp dir)
#   POP_SKIP_FETCH=1        skip `git fetch origin`

CONTRACTS_REPO="${POP_CONTRACTS_REPO:?Set POP_CONTRACTS_REPO to the authorized contracts checkout}"
WORKTREE_DIR="${POP_CONTRACTS_WORKTREE:-}"
REF="${POP_CONTRACTS_REF:-origin/main}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CREATED_WORKTREE=0
TEMP_PARENT=""

if [ ! -e "$CONTRACTS_REPO/.git" ]; then
  echo "error: contracts repo not found at $CONTRACTS_REPO (set POP_CONTRACTS_REPO)" >&2
  exit 1
fi

cleanup() {
  if [ "$CREATED_WORKTREE" = "1" ]; then
    git -C "$CONTRACTS_REPO" worktree remove --force "$WORKTREE_DIR" 2>/dev/null || true
  fi
  if [ -n "$TEMP_PARENT" ]; then
    rmdir "$TEMP_PARENT" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if [ -z "$WORKTREE_DIR" ]; then
  TEMP_PARENT="$(mktemp -d "${TMPDIR:-/tmp}/pop-abi-sync.XXXXXX")"
  WORKTREE_DIR="$TEMP_PARENT/contracts"
elif [ -e "$WORKTREE_DIR" ]; then
  echo "error: worktree path already exists: $WORKTREE_DIR (choose an unused path)" >&2
  exit 1
fi

if [ "${POP_SKIP_FETCH:-0}" != "1" ]; then
  echo "==> git fetch origin ($CONTRACTS_REPO)"
  git -C "$CONTRACTS_REPO" fetch origin
fi

echo "==> creating worktree $WORKTREE_DIR @ $REF"
git -C "$CONTRACTS_REPO" worktree add --detach "$WORKTREE_DIR" "$REF"
CREATED_WORKTREE=1
# Init lib/ dependencies only — main carries a stray `_frontend` gitlink with
# no .gitmodules entry, so a blanket `--init --recursive` fatals.
git -C "$WORKTREE_DIR" config submodule.active 'lib/*'
git -C "$WORKTREE_DIR" submodule update --init --recursive -- lib/

echo "==> forge build (production, $(git -C "$WORKTREE_DIR" rev-parse HEAD))"
(cd "$WORKTREE_DIR" && FOUNDRY_PROFILE=production forge build --skip test --skip script --out out-production)

echo "==> extracting ABIs"
node "$SCRIPT_DIR/extract-abis.mjs" "$WORKTREE_DIR/out-production"

echo "==> done (worktree removed on exit)"
