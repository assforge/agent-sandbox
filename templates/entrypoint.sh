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
  "$HOME/.pi" \
  "$HOME/.grok" \
  "$HOME/.gemini" \
  "$HOME/.qwen" \
  "$HOME/.kimi-code" \
  "$HOME/.augment" \
  "$HOME/.local/share/mimocode" \
  "$HOME/.config/mimocode" \
  "$HOME/.cursor" \
  "$HOME/.config/devin" \
  "$HOME/.local/share/devin" \
  "$HOME/.kiro" \
  "$HOME/.aider" \
  "$HOME/.config/opencode" \
  "$HOME/.config/github-copilot" \
  "$HOME/.config/goose" \
  "$HOME/work" \
  "$HOME/instances"

# Kiro self-updates in the background, which would move binaries under a
# recorded image and manufacture drift. Seed the opt-out once: an existing
# settings file means the user manages it. Never fails the start.
if [ ! -e "$HOME/.kiro/settings/cli.json" ] && command -v kiro-cli >/dev/null 2>&1; then
  kiro-cli settings "app.disableAutoupdates" "true" >/dev/null 2>&1 || true
fi

printf '{"generation":"%s","fingerprint":"%s","started_at":%s}\n' "$GENERATION" "$FINGERPRINT" "$(date +%s)" > "$READY_DIR/ready.json"

exec "$@"
