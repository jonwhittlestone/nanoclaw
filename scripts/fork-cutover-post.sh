#!/usr/bin/env bash
# Fork cut-over, part 3 of 3: re-apply fork state on top of the fresh
# migration, start v2 as the service, and run the automatable checks.
set -euo pipefail
cd "$(dirname "$0")/.."
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
setenv() { # setenv KEY VALUE — replace or append in .env
  if grep -q "^$1=" .env; then sed -i "s#^$1=.*#$1=$2#" .env; else echo "$1=$2" >> .env; fi
}

[ -f logs/setup-migration/handoff.json ] || { echo "run bash migrate-v2.sh first"; exit 1; }
say "Migration handoff"
python3 -c "import json;h=json.load(open('logs/setup-migration/handoff.json'));print(h['overall_status'],h['channels_installed']);[print(' ',k,v['status']) for k,v in h['steps'].items()]"
[ -f store/auth/creds.json ] || { echo "WhatsApp keystore not copied — roll back"; exit 1; }

say ".env overrides (v1's values were merged back in by the migration)"
setenv ONECLI_URL http://172.17.0.1:10264
setenv ONECLI_GATEWAY_CONTAINER onecli-v2
setenv JOURNAL_DRAFT_PORT 3021
grep -E '^(ONECLI_URL|ONECLI_GATEWAY_CONTAINER|JOURNAL_DRAFT_PORT|JOURNAL_DRAFT_BIND_HOST)=' .env

say "Remove stale v1 skill copies that would shadow the repo's container skills"
for d in data/v2-sessions/*/.claude-shared/skills/*/; do
  [ -d "$d" ] && [ ! -L "${d%/}" ] || continue
  name=$(basename "$d")
  if [ -d "container/skills/$name" ] || [ -f "container/skills/$name/SKILL.md" ]; then rm -rf "$d"; echo "  removed $d"; fi
done
for d in container/skills/*/; do
  git ls-files --error-unmatch "$d" >/dev/null 2>&1 || { rm -rf "$d"; echo "  removed untracked $d"; }
done

say "Fork container config (MCP, packages, vault mount)"
pnpm exec tsx scripts/fork-apply.ts fork/config.json

say "Install and start the v2 service (builds, stamps upgrade state)"
pnpm exec tsx setup/index.ts --step service
UNIT=$(pnpm -s exec tsx -e "import('./src/install-slug.ts').then(m=>console.log(m.getSystemdUnit()))")
for i in $(seq 1 60); do [ -S data/ncl.sock ] && break; sleep 2; done
systemctl --user --no-pager status "$UNIT" | head -3

say "Fork wiring (journal-draft) and per-group image with packages"
./scripts/fork-wire.sh
SELF=$(pnpm -s exec tsx scripts/q.ts data/v2.db "select id from agent_groups where folder='whatsapp_main'")
pnpm -s run ncl groups restart --id "$SELF" --rebuild

say "Automated checks"
sleep 5
grep -E 'WhatsApp|whatsapp' logs/nanoclaw.log | tail -3 || true
curl -s -o /dev/null -w 'journal health :3021 → %{http_code}\n' "http://$(grep '^JOURNAL_DRAFT_BIND_HOST=' .env | cut -d= -f2):3021/internal/journal/health"
pnpm -s run ncl tasks list | tail -6
pnpm -s exec tsx scripts/q.ts data/v2.db "select agent_group_id, json_extract(mcp_servers,'$') like '%google-calendar%', additional_mounts like '%obsidian%' from container_configs"

cat <<'MSG'

Manual checks (design doc §06.07), on your phone and in randoread:
  [ ] text in the self-chat → oh-two replies
  [ ] "what's on my calendar tomorrow?"           (F1)
  [ ] voice note → handled as [Voice] …            (F4)
  [ ] photo in → acknowledged; "send me X" → file  (F3)
  [ ] "send this note to my reMarkable" → PDF      (F2)
  [ ] randoread "Send to oh-two" round trip        (F5)
All green → tell Claude to swap main onto v2/main. Not green within 1 hour → scripts/fork-rollback.sh
MSG
