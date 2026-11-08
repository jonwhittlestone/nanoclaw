# Devex loops for this fork. Upstream's own entry points are pnpm scripts and
# setup/index.ts steps; these targets only wrap them.
#
# Staging rule (until cut-over): v2 never runs WhatsApp while v1 is live.
# `make run` starts the host in the foreground for CLI-channel testing only.

SHELL := /bin/bash
# Upstream docs use a static `import{…}from'./src/install-slug.js'` under tsx -e,
# which fails to resolve; a dynamic import of the .ts file works.
SLUG_JS = import('./src/install-slug.ts').then(m=>console.log(m.$(1)()))
UNIT := $(shell pnpm exec tsx -e "$(call SLUG_JS,getSystemdUnit)" 2>/dev/null)
IMAGE := $(shell pnpm exec tsx -e "$(call SLUG_JS,getDefaultContainerImage)" 2>/dev/null)
ONECLI_URL := $(shell grep -E '^ONECLI_URL=' .env 2>/dev/null | cut -d= -f2- || echo http://127.0.0.1:10254)
DB ?= data/v2.db

.PHONY: help setup doctor build image test test-host test-container check run chat deploy logs status inspect-groups inspect-tasks inspect-wiring fork-apply

help: ## List targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk -F':.*?## ' '{printf "  %-16s %s\n", $$1, $$2}'

setup: ## Install host and container dependencies
	pnpm install --frozen-lockfile
	cd container/agent-runner && bun install --frozen-lockfile

doctor: ## Health check: toolchain, gateway, sidecars, v1/v2 services
	@node -v && pnpm -v && (bun -v 2>/dev/null || echo "bun: not on host (only needed for container tests)")
	@docker info --format 'docker {{.ServerVersion}}' 2>/dev/null || echo "docker: NOT reachable"
	@docker image inspect $(IMAGE) --format 'image $(IMAGE) built {{.Created}}' 2>/dev/null || echo "image $(IMAGE): MISSING (make image)"
	@curl -fsS -o /dev/null -w 'onecli %{http_code}\n' $(ONECLI_URL)/ 2>/dev/null || echo "onecli: NOT reachable"
	@curl -fsS -o /dev/null -w 'whisper %{http_code}\n' http://127.0.0.1:8080/health 2>/dev/null || echo "whisper: NOT reachable"
	@systemctl --user is-active gcal-mcp >/dev/null && echo "gcal-mcp: active" || echo "gcal-mcp: inactive"
	@echo "v1 nanoclaw.service: $$(systemctl --user is-active nanoclaw)"
	@echo "v2 $(UNIT): $$(systemctl --user is-active $(UNIT) 2>/dev/null || true)"
	pnpm exec tsx setup/index.ts --step verify || true

build: ## Typecheck and compile the host
	pnpm run build

image: ## Build the agent container image
	./container/build.sh

test-host: ## Host tests (vitest)
	pnpm exec vitest run

test-container: ## Container agent-runner tests (bun)
	cd container/agent-runner && bun run test

test: test-host ## Run host tests (add test-container when bun is available)

check: ## What CI runs: format, typecheck host + container, tests
	pnpm run format:check
	pnpm exec tsc --noEmit
	pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
	$(MAKE) test-host

run: ## Run the host in the foreground (staging: CLI channel only)
	pnpm run dev

chat: ## Talk to the agent over the CLI channel: make chat M="hello"
	pnpm run chat $(M)

deploy: build ## Rebuild and restart the v2 service
	systemctl --user restart $(UNIT)
	systemctl --user --no-pager status $(UNIT) | head -5

logs: ## Tail the host log
	tail -F logs/nanoclaw.log

fork-apply: ## Re-apply fork/config.json (MCP servers, packages) to the central DB
	pnpm exec tsx scripts/fork-apply.ts fork/config.json

status: ## ncl status
	pnpm run ncl status

inspect-groups: ## Agent groups in the central DB
	pnpm exec tsx scripts/q.ts $(DB) "select id, name, folder from agent_groups"

inspect-wiring: ## Messaging groups and their wiring
	pnpm exec tsx scripts/q.ts $(DB) "select mg.channel_type, mg.platform_id, mg.unknown_sender_policy, mga.agent_group_id, mga.engage_mode from messaging_groups mg left join messaging_group_agents mga on mga.messaging_group_id = mg.id"

inspect-tasks: ## Scheduled tasks
	pnpm run ncl tasks list
