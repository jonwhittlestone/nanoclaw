# OneCLI gateway for v2

v2 pins OneCLI **1.42.0** (`.claude/skills/add-onecli/versions.json`); the v1 install runs
OneCLI 1.15.1 at `~/.onecli`. To keep v1 untouched during the side-by-side migration, v2
gets its own gateway, deployed from this compose file to `~/.onecli-v2`:

| | v1 (`~/.onecli`) | v2 (`~/.onecli-v2`) |
|---|---|---|
| Version | 1.15.1 (`latest` as of 2026-04) | 1.42.0 (pinned via `.env` `ONECLI_VERSION`) |
| API | `172.17.0.1:10254` | `172.17.0.1:10264` |
| Proxy | `:10255` | `:10265` (also inside the container — see below) |
| Postgres | `127.0.0.1:5432` | `127.0.0.1:5433` |

Non-obvious settings, each found while smoke-testing:

- `GATEWAY_PORT` / `GATEWAY_API_URL` / `GATEWAY_BASE_URL`: the gateway advertises its proxy
  to agent containers as `host.docker.internal:<port>`, so the port must differ from v1's
  *inside* the container too, or agents tunnel into v1's gateway (`ERR_PROXY_TUNNEL`).
- `extra_hosts: host.docker.internal:host-gateway`: MCP calls to host services (gcal-mcp on
  `:3020`) go through the proxy, so the gateway itself must resolve the host.

Seeding (done once, 2026-11-08): restore v1's `pg_dump` into the new Postgres and copy v1's
`app-data` volume (holds `secret-encryption-key`) before first start; OneCLI's own Prisma
migrations upgrade the schema on boot. v2's `.env`: `ONECLI_URL=http://172.17.0.1:10264`,
`ONECLI_GATEWAY_CONTAINER=onecli-v2`.

```bash
mkdir -p ~/.onecli-v2 && cp fork/onecli-v2/docker-compose.yml ~/.onecli-v2/
(umask 077; echo ONECLI_VERSION=1.42.0 > ~/.onecli-v2/.env)
cd ~/.onecli-v2 && docker compose up -d
```
