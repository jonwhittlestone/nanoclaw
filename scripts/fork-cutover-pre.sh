#!/usr/bin/env bash
# Fork cut-over, part 1 of 3 (design doc §06.06 P5). Run from the v2 checkout.
#   1. this script     — checks, stops v1, fresh v1 backup, resets v2 state
#   2. YOU, in a real terminal: bash migrate-v2.sh   (select WhatsApp; choose
#      "skip" at the service switchover; /exit when it opens Claude)
#   3. scripts/fork-cutover-post.sh
# Rollback at any point: scripts/fork-rollback.sh
set -euo pipefail
cd "$(dirname "$0")/.."
V1=${NANOCLAW_V1_PATH:-$HOME/code/playground/nanoclaw}
STAMP=$(date +%Y%m%d-%H%M%S)
BK="$HOME/backups/nanoclaw-v1-cutover-$STAMP"
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

say "Preflight"
[ "$(git rev-parse --abbrev-ref HEAD)" = "v2/main" ] || { echo "check out v2/main first"; exit 1; }
git fetch -q origin && [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/v2/main)" ] || { echo "v2/main not in sync with origin"; exit 1; }
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "tracked changes in the v2 checkout"; exit 1; }
[ -z "$(git -C "$V1" status --porcelain --untracked-files=no)" ] || { echo "v1 checkout has local changes"; exit 1; }
curl -fsS -o /dev/null http://172.17.0.1:10264/v1/gateway-url || { echo "v2 OneCLI (~/.onecli-v2) not answering"; exit 1; }
curl -fsS -o /dev/null http://127.0.0.1:8080/health || echo "WARN: whisper.service not answering"
systemctl --user is-active --quiet gcal-mcp || echo "WARN: gcal-mcp.service not active"

say "Stop the staging host (if running) and v1"
pkill -f '[n]anoclaw-v2/node_modules/.pnpm/tsx' || true
for i in $(seq 1 30); do pgrep -f '[n]anoclaw-v2/(node_modules|dist)/' >/dev/null || break; sleep 1; done
systemctl --user stop nanoclaw
sleep 2
! pgrep -f '[n]anoclaw/dist/index.js' >/dev/null || { echo "v1 still running"; exit 1; }

say "Fresh v1 backup (WhatsApp keystore is current now) → $BK"
mkdir -p "$BK"
tar -czf "$BK/nanoclaw-v1-state.tgz" -C "$V1" store groups data .env
for f in $(cd "$V1" && find store data -name '*.db'); do
  mkdir -p "$BK/sqlite/$(dirname "$f")"; sqlite3 "$V1/$f" ".backup '$BK/sqlite/$f'"
done
tar -tzf "$BK/nanoclaw-v1-state.tgz" store/auth/creds.json >/dev/null && echo "keystore captured"
echo "$BK" > logs-cutover-backup-path.txt

say "Reset v2 migration state (data/ logs/ .env groups/ — tracked code is kept)"
bash migrate-v2-reset.sh

cat <<'MSG'

Next, in a real terminal (not inside Claude):

  cd ~/code/playground/nanoclaw-v2 && bash migrate-v2.sh

  • channels: select WhatsApp
  • service switchover: v1 is already stopped, so it should report nothing to switch
  • when it opens Claude for /migrate-from-v1: /exit

Then run: scripts/fork-cutover-post.sh
The clock is running: roll back (scripts/fork-rollback.sh) if not green within 1 hour.
MSG
