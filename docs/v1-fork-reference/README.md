# v1 fork reference

Frozen copy of the customisations in `jonwhittlestone/nanoclaw` v1 (tag `v1-final`, `51f92a8`).
This is **reference only**: the code here does not build or run against v2. Upstream advises
not to translate v1 `src/` into v2 line by line; each feature is re-implemented on a v2
extension point instead (see the design doc, section 06).

`v1-core-edits.diff` holds the v1 edits made to upstream core files (`src/index.ts`, `src/ipc.ts`,
`container/Dockerfile`, …), as a diff against the v1 merge-base.

| v1 feature | Files here | v2 status |
|---|---|---|
| Google Calendar MCP server | `tools/gcal-mcp/*`, `tools/tsconfig.json` | Host service unchanged; wired via group `container.json` `mcpServers` (`v2/01-gcal`) |
| reMarkable PDF conversion | `scripts/md_to_remarkable.py`, `scripts/tests/*`, `scripts/pyproject.toml`, `.claude/skills/remarkable/` | Re-implemented on `v2/02-remarkable` |
| Bidirectional WhatsApp media | `.claude/skills/whatsapp-media/`, `container/skills/whatsapp-media/`, parts of `src/channels/whatsapp.ts`, `src/ipc.ts` | Native in v2 (adapter media download + `send_file`); only the prune and the bare-media prompt are ported (`v2/03-media-deltas`) |
| Inbound speech to text | `src/transcription.ts`, `setup/whisper.service`, `.claude/skills/whatsapp-speech/` | Re-implemented on `v2/04-speech` |
| journal-draft endpoint (randoread) | `src/journal-draft*.ts`, `groups/journal-draft/CLAUDE.md` | Compat shim on `v2/05-journal-shim` (same HTTP contract) |
| WhatsApp channel + Baileys 6.x patches | `src/channels/whatsapp*.ts`, `src/whatsapp-auth.ts`, `setup/whatsapp-auth.ts` | Dropped: v2 uses the upstream Baileys 7 adapter from the `channels` branch |
| Persona rename (Andy → oh-two) | `groups/global/CLAUDE.md`, `groups/main/CLAUDE.md` | Moved to `instructions.prepend.md` via `/migrate-memory` |
| Session cleanup | `scripts/cleanup-sessions.sh` | Re-check against v2's own `scripts/cleanup-sessions.sh` |
