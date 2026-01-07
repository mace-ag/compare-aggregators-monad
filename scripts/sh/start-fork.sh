#!/bin/bash

# Start Anvil fork for transaction simulation
# This script starts a local Anvil node that forks from Monad (mainnet or testnet)
#
# Usage:
#   ./start-fork.sh <FORK_URL> [CHAIN_ID]
#   or:  FORK_URL="<url>" CHAIN_ID="<id>" ./start-fork.sh

# Accept FORK_URL as first parameter, or use environment variable
FORK_URL="${1:-${FORK_URL:-}}"
# CHAIN_ID can be provided as 2nd arg, env var, or derived from MONAD_NETWORK.
CHAIN_ID="${2:-${CHAIN_ID:-}}"

if [ -z "$CHAIN_ID" ]; then
  if [ "${MONAD_NETWORK}" = "testnet" ]; then
    CHAIN_ID=10143
  else
    CHAIN_ID=143
  fi
fi

# Check if FORK_URL is provided
if [ -z "$FORK_URL" ]; then
  echo "Error: FORK_URL is required"
  echo ""
  echo "Usage:"
  echo "  ./start-fork.sh <FORK_URL> [CHAIN_ID]"
  echo "  or"
  echo "  FORK_URL=\"<url>\" CHAIN_ID=\"<id>\" ./start-fork.sh"
  echo ""
  echo "Example:"
  echo "  MONAD_NETWORK=mainnet ./start-fork.sh <your_mainnet_rpc_url>"
  echo "  MONAD_NETWORK=testnet ./start-fork.sh <your_testnet_rpc_url>"
  exit 1
fi

echo "Starting Anvil fork from $FORK_URL..."
echo "Chain ID: $CHAIN_ID"
echo "Local RPC will be available at http://127.0.0.1:8545"
echo ""
echo "Press Ctrl+C to stop the fork"
echo ""

anvil \
  --fork-url "$FORK_URL" \
  --chain-id "$CHAIN_ID" \
  --port 8545 \
  --host 0.0.0.0 \
  --timeout 600000 \
  --gas-limit 30000000 \
  --code-size-limit 100000 \
  --block-time 1 \
  --no-rate-limit
