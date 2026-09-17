#!/bin/bash
# sandbox-entrypoint.sh: state setup, then readiness signal, then CMD.
# Readiness is a fresh generation token plus a configuration fingerprint.
# It is written only after setup finishes; a persistent file from a
# previous run can never satisfy a new generation.
set -euo pipefail

READY_DIR="${SANDBOX_READY_DIR:-/tmp/sandbox-ready}"
GENERATION="${SANDBOX_GENERATION:?SANDBOX_GENERATION is required}"
FINGERPRINT="${SANDBOX_CONFIG_FINGERPRINT:?SANDBOX_CONFIG_FINGERPRINT is required}"

mkdir -p "$READY_DIR"
rm -f "$READY_DIR/ready.json"

# State directories every supported agent needs, owned by the agent user.
mkdir -p \
  "$HOME/.claude" \
  "$HOME/.codex" \
  "$HOME/.copilot" \
  "$HOME/.config/opencode" \
  "$HOME/.config/github-copilot" \
  "$HOME/work"

printf '{"generation":"%s","fingerprint":"%s"}\n' "$GENERATION" "$FINGERPRINT" > "$READY_DIR/ready.json"

exec "$@"
