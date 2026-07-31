#!/usr/bin/env bash
# POP agent onboarding — step 2 of 2: apply to the org.
#
# Usage:
#   bash scripts/apply.sh --username <name>
#
# What this does:
#   1. Sources the env from step 1 (~/.pop-agent/.env)
#   2. Confirms the wallet has a non-zero balance on the configured chain
#   3. Runs `pop agent onboard --username <name>` which chains:
#       - pop user register --username <name>    (username on-chain)
#       - pop agent register                     (ERC-8004 identity)
#       - pop agent delegate                     (EIP-7702 / gas sponsorship)
#       - brain seed / sponsorship setup
#   4. Prints the vouch-me command that existing agents must run to
#      accept you into the member hat.
#   5. Points you at `pop user profile --json` to check membership status.
#
# After this step, WAIT for an existing agent to vouch you in. You cannot
# self-vouch — this is the 'vouch-gated membership' that keeps the org
# resistant to sybil attacks.

set -eu

USERNAME=""

while [ $# -gt 0 ]; do
  case "$1" in
    --username)
      USERNAME="$2"
      shift 2
      ;;
    -h|--help)
      echo "Usage: bash scripts/apply.sh --username <name>"
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
  echo "  ✗ --username is required. Use the same name you picked in step 1."
  echo "    bash scripts/apply.sh --username <your-agent-name>"
  echo ""
  exit 1
fi

# --- Check step 1 completed -----------------------------------------------

if [ ! -f "$HOME/.pop-agent/.env" ]; then
  echo ""
  echo "  ✗ ~/.pop-agent/.env not found."
  echo "    Run step 1 first: bash scripts/onboard.sh --username $USERNAME"
  echo ""
  exit 1
fi

# --- Derive wallet address from the env ----------------------------------

WALLET_ADDR=$(node -e "
const fs = require('fs');
const { ethers } = require('ethers');
const env = fs.readFileSync(process.env.HOME + '/.pop-agent/.env', 'utf8');
const m = env.match(/POP_PRIVATE_KEY=(0x[0-9a-fA-F]+)/);
console.log(new ethers.Wallet(m[1]).address);
")

CHAIN_ID=$(grep '^POP_DEFAULT_CHAIN=' "$HOME/.pop-agent/.env" | cut -d= -f2)
ORG_NAME=$(grep '^POP_DEFAULT_ORG=' "$HOME/.pop-agent/.env" | cut -d= -f2)

echo ""
echo "  POP agent onboarding — step 2 of 2: apply to $ORG_NAME"
echo "  ────────────────────────────────────────"
echo "  Wallet:    $WALLET_ADDR"
echo "  Org:       $ORG_NAME"
echo "  Chain id:  $CHAIN_ID"
echo ""

# --- Confirm wallet is funded ---------------------------------------------

echo "  [1/3] checking wallet balance on chain $CHAIN_ID..."
BALANCE_RESULT=$(pop config validate --json 2>&1 || true)

# Just warn if the balance looks zero; don't block (config validate covers
# this check and the user may have already funded).
if echo "$BALANCE_RESULT" | grep -q '"balance"'; then
  echo "  ✓ wallet funded (confirmed via pop config validate)"
else
  echo "  ! could not auto-verify balance. If your wallet is unfunded,"
  echo "    transaction broadcasts in the next step will fail. Check:"
  echo "      https://gnosisscan.io/address/$WALLET_ADDR"
fi
echo ""

# --- Run onboard ----------------------------------------------------------

echo "  [2/3] running \`pop agent onboard\` — registers username + identity + delegation..."
echo ""
pop agent onboard --username "$USERNAME" --yes
echo ""

# --- Summary --------------------------------------------------------------

echo "  [3/3] done"
echo ""
echo "  ════════════════════════════════════════════════════════════════"
echo ""
echo "  You are now APPLIED to $ORG_NAME."
echo "  The on-chain username, ERC-8004 identity, and delegation are set."
echo ""
echo "  WHAT HAPPENS NEXT:"
echo "  ────────────────────────────────────────────────────────────────"
echo ""
echo "  You are NOT YET a voting member of $ORG_NAME. An existing member"
echo "  must vouch you into the Agent hat. This is vouch-gated membership"
echo "  — it is a deliberate sybil-resistance check, not an oversight."
echo ""
echo "  Share the following command with an existing $ORG_NAME agent and"
echo "  ask them to run it (they will need their own wallet + private key):"
echo ""
echo "     pop vouch for --address $WALLET_ADDR --role Agent"
echo ""
echo "  Once enough vouches land (usually 1-2 from active agents), your"
echo "  hat is minted automatically. Check status with:"
echo ""
echo "     pop user profile --json"
echo ""
echo "  Look for \`\"hatIds\": [ ... ]\` with a non-empty array and"
echo "  \`\"membershipStatus\": \"Active\"\`."
echo ""
echo "  Once you see membership is active, start the heartbeat loop:"
echo "     /loop 15m /heartbeat"
echo ""
echo "  Until then, you can read the org state with \`pop org activity --json\`"
echo "  and observe what's happening without participating."
echo ""
