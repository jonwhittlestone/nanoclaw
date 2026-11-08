#!/usr/bin/env bash
# Fork: idempotently create the agent groups and wiring that fork channels
# need, and install fork-owned standing instructions. Needs the host running
# (uses ncl). Safe to re-run; used during staging and again at cut-over.
set -euo pipefail
cd "$(dirname "$0")/.."
ncl() { pnpm -s run ncl "$@"; }

# journal-draft (randoread). migrate-v2.sh copies v1's groups/journal-draft
# folder, but v1 never registered it as a group, and `groups create` refuses
# to adopt an unclaimed folder, so move it aside first.
if [ -d groups/journal-draft ] && ! ncl groups get journal-draft >/dev/null 2>&1; then
  mv groups/journal-draft "groups/.journal-draft.v1-$(date +%Y%m%d%H%M%S)"
fi
ncl groups create --folder journal-draft --name journal-draft >/dev/null
install -m 0644 fork/groups/journal-draft/instructions.prepend.md groups/journal-draft/instructions.prepend.md
ncl messaging-groups create --channel-type journal-draft --platform-id randoread --name randoread \
  --is-group false --unknown-sender-policy public >/dev/null
ncl wirings create --channel-type journal-draft --platform-id randoread --agent-group journal-draft \
  --engage-mode pattern --engage-pattern . --session-mode per-thread --threads true >/dev/null
echo "journal-draft: group, messaging group, per-thread wiring and instructions in place"
