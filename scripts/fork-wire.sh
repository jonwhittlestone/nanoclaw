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
# --is-group must be 0, not "false": "false" is stored as NULL, and the router
# forces per-thread sessions whenever is_group != 0 (design doc 06.12.07).
ncl messaging-groups create --channel-type journal-draft --platform-id randoread --name randoread \
  --is-group 0 --unknown-sender-policy public >/dev/null
MG=$(pnpm -s exec tsx scripts/q.ts data/v2.db "select id from messaging_groups where channel_type='journal-draft' and platform_id='randoread'")
ncl messaging-groups update "$MG" --is-group 0 >/dev/null   # create returns an existing row unchanged

# One shared, warm session (kept started by src/modules/journal-warm); every
# draft is still its own thread, and replies route by the turn's thread.
ncl wirings create --channel-type journal-draft --platform-id randoread --agent-group journal-draft \
  --engage-mode pattern --engage-pattern . --session-mode shared --threads true >/dev/null
W=$(pnpm -s exec tsx scripts/q.ts data/v2.db "select mga.id from messaging_group_agents mga where mga.messaging_group_id='$MG'")
ncl wirings update "$W" --session-mode shared --threads true >/dev/null

# Instructions only reach a session when it starts: close the warm session so
# the warmer starts a fresh one with the current text within a minute.
pnpm -s exec tsx scripts/q.ts data/v2.db "update sessions set status='closed' where messaging_group_id='$MG' and status='active'" >/dev/null
echo "journal-draft: group, messaging group (is_group=0), shared wiring and instructions in place"
