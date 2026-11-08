#!/usr/bin/env bash
# Fork rollback (design doc §06.08): stop v2, bring v1 back. v1's checkout
# and state were never modified; the WhatsApp keystore can be restored from
# the cut-over backup if v1 won't reconnect.
set -euo pipefail
cd "$(dirname "$0")/.."
V1=${NANOCLAW_V1_PATH:-$HOME/code/playground/nanoclaw}
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

say "Stop v2 (never run both against one WhatsApp number)"
UNIT=$(pnpm -s exec tsx -e "import('./src/install-slug.ts').then(m=>console.log(m.getSystemdUnit()))" 2>/dev/null || echo nanoclaw-v2-3aae753a)
systemctl --user disable --now "$UNIT" 2>/dev/null || true
pkill -f '[n]anoclaw-v2/node_modules/.pnpm/tsx' || true
docker ps --filter name=nanoclaw-v2 -q | xargs -r docker stop >/dev/null
for i in $(seq 1 30); do pgrep -f '[n]anoclaw-v2/(node_modules|dist)/' >/dev/null || break; sleep 1; done
if pgrep -f '[n]anoclaw-v2/(node_modules|dist)/' >/dev/null; then
  pkill -KILL -f '[n]anoclaw-v2/(node_modules|dist)/' || true; sleep 1
fi
! pgrep -f '[n]anoclaw-v2/(node_modules|dist)/' >/dev/null || { echo "v2 processes still running"; exit 1; }

say "v1 checkout must be clean"
git -C "$V1" status --short --untracked-files=no
if [ "${1:-}" = "--restore-keystore" ]; then
  BK=$(cat logs-cutover-backup-path.txt 2>/dev/null || true)
  [ -n "$BK" ] && [ -f "$BK/nanoclaw-v1-state.tgz" ] || { echo "no cut-over backup recorded"; exit 1; }
  say "Restore v1 WhatsApp keystore from $BK"
  rm -rf "$V1/store/auth" && tar -xzf "$BK/nanoclaw-v1-state.tgz" -C "$V1" store/auth
fi

say "Start v1"
systemctl --user enable --now nanoclaw
systemctl --user is-active gcal-mcp && systemctl is-active whisper || true
sleep 10
journalctl --user -u nanoclaw -n 15 --no-pager | grep -i -E 'connect|whatsapp|error' || true
curl -s -o /dev/null -w 'v1 journal health :3021 → %{http_code}\n' http://100.111.143.116:3021/internal/journal/health

cat <<'MSG'

Now send a WhatsApp message and check oh-two (v1) replies.
If WhatsApp won't connect: scripts/fork-rollback.sh --restore-keystore, then re-pair if still needed.
If main was already swapped: git push origin v1/main:main --force-with-lease
Log the rollback in the design doc §06.10.
MSG
