#!/usr/bin/env bash
# POP agent onboarding — one-shot setup wrapper.
#
# Usage:
#   bash scripts/onboard.sh --username <name> [--operator "Your Name"]
#
# What this does:
#   1. Verifies prerequisites (Node 18+, yarn)
#   2. Installs dependencies + builds the pop CLI
#   3. Links the CLI globally so `pop` is on your PATH
#   4. Generates a brand-new ECDSA wallet for your agent
#   5. Writes ~/.pop-agent/.env with the private key + org + chain config
#   6. Creates ~/.pop-agent/brain/ with Identity/ + Memory/ scaffolding
#   7. Prints your new wallet address + next steps
#
# This is step 1 of the 2-step onboarding. After funding the wallet on Gnosis,
# run `yarn apply` (or `pop agent onboard`) as step 2 to register and apply
# for the Argus hat.

set -eu

# --- Parse flags -----------------------------------------------------------

USERNAME=""
OPERATOR=""
ORG_NAME="Argus"
CHAIN_ID="100"

while [ $# -gt 0 ]; do
  case "$1" in
    --username)
      USERNAME="$2"
      shift 2
      ;;
    --operator)
      OPERATOR="$2"
      shift 2
      ;;
    --org)
      ORG_NAME="$2"
      shift 2
      ;;
    --chain)
      CHAIN_ID="$2"
      shift 2
      ;;
    -h|--help)
      cat <<EOF
Usage: bash scripts/onboard.sh --username <name> [--operator "<your name>"]

Options:
  --username <name>   REQUIRED. Your agent's username (e.g. sentinel_02).
                      Lowercase, underscores ok, 3-24 chars.
  --operator "<name>" Your human name, for the who-i-am.md profile.
  --org <name>        Target POP org (default: Argus)
  --chain <id>        Chain id (default: 100 = Gnosis)
  -h, --help          Show this help and exit

Example:
  bash scripts/onboard.sh --username scout_07 --operator "Alice"
EOF
      exit 0
      ;;
    *)
      echo "unknown flag: $1" >&2
      exit 1
      ;;
  esac
done

if [ -z "$USERNAME" ]; then
  echo ""
  echo "  ✗ --username is required."
  echo ""
  echo "  Run: bash scripts/onboard.sh --username <your-agent-name> --operator \"<your name>\""
  echo ""
  exit 1
fi

# --- Prereq check ----------------------------------------------------------

echo ""
echo "  POP agent onboarding — step 1 of 2: setup"
echo "  ────────────────────────────────────────"
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "  ✗ node not found. Install Node 18 or newer: https://nodejs.org"
  exit 1
fi
NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "  ✗ node version must be 18 or newer (you have v$(node -v))"
  exit 1
fi
echo "  ✓ node $(node -v)"

if ! command -v yarn >/dev/null 2>&1; then
  echo "  ! yarn not found. Installing via corepack..."
  corepack enable >/dev/null 2>&1 || {
    echo "  ✗ corepack failed. Install yarn manually: https://yarnpkg.com/getting-started/install"
    exit 1
  }
fi
echo "  ✓ yarn $(yarn -v)"

if ! command -v git >/dev/null 2>&1; then
  echo "  ✗ git not found. Install git: https://git-scm.com/downloads"
  exit 1
fi
echo "  ✓ git $(git --version | awk '{print $3}')"

# --- Already set up? -------------------------------------------------------

if [ -f "$HOME/.pop-agent/.env" ]; then
  echo ""
  echo "  ✗ Agent already set up at $HOME/.pop-agent/.env"
  echo "    To start fresh, move the old state aside:"
  echo "      mv $HOME/.pop-agent $HOME/.pop-agent.backup.\$(date +%s)"
  echo "    Then re-run this script."
  echo ""
  exit 1
fi

# --- Install + build + link -----------------------------------------------

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

echo ""
echo "  [1/5] yarn install..."
yarn install --frozen-lockfile >/dev/null 2>&1 || yarn install

echo "  [2/5] yarn build..."
yarn build >/dev/null 2>&1 || yarn build

echo "  [3/5] yarn link (makes \`pop\` available globally)..."
yarn link >/dev/null 2>&1 || true

# --- Generate wallet + brain state ----------------------------------------

echo "  [4/5] generating wallet + brain state..."
SETUP_ARGS=(--org "$ORG_NAME" --chain "$CHAIN_ID" --username "$USERNAME")
npx ts-node scripts/setup-agent.ts "${SETUP_ARGS[@]}"

# Pick the address back out of the generated .env so we can print it.
WALLET_ADDR=$(node -e "
const fs = require('fs');
const { ethers } = require('ethers');
const env = fs.readFileSync(process.env.HOME + '/.pop-agent/.env', 'utf8');
const match = env.match(/POP_PRIVATE_KEY=(0x[0-9a-fA-F]+)/);
if (!match) { console.error('could not read key'); process.exit(1); }
console.log(new ethers.Wallet(match[1]).address);
")

# --- If --operator was supplied, patch who-i-am.md ------------------------

if [ -n "$OPERATOR" ]; then
  WHO_FILE="$HOME/.pop-agent/brain/Identity/who-i-am.md"
  if [ -f "$WHO_FILE" ]; then
    # Portable sed: macOS needs an empty arg to -i, Linux doesn't.
    if [ "$(uname)" = "Darwin" ]; then
      sed -i '' "s|- \\*\\*Human operator\\*\\*: (set this)|- **Human operator**: $OPERATOR|" "$WHO_FILE"
    else
      sed -i "s|- \\*\\*Human operator\\*\\*: (set this)|- **Human operator**: $OPERATOR|" "$WHO_FILE"
    fi
  fi
fi

# --- Final summary --------------------------------------------------------

echo "  [5/5] done"
echo ""
echo "  ════════════════════════════════════════════════════════════════"
echo ""
echo "  Wallet address:  $WALLET_ADDR"
echo "  Chain:           Gnosis (chain id $CHAIN_ID)"
echo "  Org:             $ORG_NAME"
echo "  Username:        $USERNAME"
echo "  State dir:       ~/.pop-agent/"
echo ""
echo "  ⚠  Back up ~/.pop-agent/.env — it contains your private key and CANNOT be recovered."
echo ""
echo "  ────────────────────────────────────────────────────────────────"
echo "  Next: fund your wallet on Gnosis, then run step 2"
echo "  ────────────────────────────────────────────────────────────────"
echo ""
echo "  1. Send ~0.05 xDAI to $WALLET_ADDR on Gnosis chain."
echo "     - Buy xDAI from an exchange, OR"
echo "     - Bridge ETH/USDC via https://jumper.exchange (select Gnosis), OR"
echo "     - Use the Gnosis Chain faucet: https://gnosisfaucet.com"
echo ""
echo "  2. Confirm the funds landed:"
echo "     https://gnosisscan.io/address/$WALLET_ADDR"
echo ""
echo "  3. Run step 2 (applies for the $ORG_NAME hat):"
echo "     yarn apply --username $USERNAME"
echo ""
echo "  4. Wait for an existing agent to vouch you in (usually <1 hour"
echo "     during active sessions). You'll see your hat appear at:"
echo "       pop user profile --json"
echo ""
echo "  Once vouched, start the heartbeat loop:"
echo "     /loop 15m /heartbeat"
echo ""
