/**
 * fork-apply: re-applies this fork's declarative per-group container config
 * (fork/config.json) after a migration or reset. Must be idempotent and must
 * never clobber operator-added state it doesn't own.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { createAgentGroup } from '../src/db/agent-groups.js';
import { ensureContainerConfig, getContainerConfig, updateContainerConfigJson } from '../src/db/container-configs.js';
import { applyForkConfig, type ForkConfig } from './fork-apply.js';

const GCAL = { type: 'http', url: 'http://host.docker.internal:3020/mcp' } as const;

async function group(id: string, folder: string): Promise<void> {
  await createAgentGroup({ id, name: folder, folder, agent_provider: null, created_at: new Date().toISOString() });
}

describe('applyForkConfig', () => {
  beforeEach(async () => {
    await runMigrations(await initTestDb());
  });
  afterEach(async () => {
    await closeDb();
  });

  it('adds declared MCP servers to the group matched by folder', async () => {
    await group('ag-1', 'whatsapp_main');
    const spec: ForkConfig = { groups: { whatsapp_main: { mcpServers: { 'google-calendar': GCAL } } } };

    const report = await applyForkConfig(spec);

    const row = await getContainerConfig('ag-1');
    expect(JSON.parse(row!.mcp_servers)).toEqual({ 'google-calendar': GCAL });
    expect(report).toContainEqual({ folder: 'whatsapp_main', action: 'mcp-set', name: 'google-calendar' });
  });

  it('is idempotent and keeps operator-added servers', async () => {
    await group('ag-1', 'whatsapp_main');
    await ensureContainerConfig('ag-1');
    await updateContainerConfigJson('ag-1', 'mcp_servers', { mine: { type: 'http', url: 'https://example.com/mcp' } });
    const spec: ForkConfig = { groups: { whatsapp_main: { mcpServers: { 'google-calendar': GCAL } } } };

    await applyForkConfig(spec);
    await applyForkConfig(spec);

    const servers = JSON.parse((await getContainerConfig('ag-1'))!.mcp_servers);
    expect(Object.keys(servers).sort()).toEqual(['google-calendar', 'mine']);
  });

  it('unions declared packages without duplicates', async () => {
    await group('ag-1', 'whatsapp_main');
    await ensureContainerConfig('ag-1');
    await updateContainerConfigJson('ag-1', 'packages_apt', ['jq']);
    const spec: ForkConfig = { groups: { whatsapp_main: { packages: { apt: ['jq', 'pandoc'], npm: ['x'] } } } };

    await applyForkConfig(spec);
    await applyForkConfig(spec);

    const row = (await getContainerConfig('ag-1'))!;
    expect(JSON.parse(row.packages_apt)).toEqual(['jq', 'pandoc']);
    expect(JSON.parse(row.packages_npm)).toEqual(['x']);
  });

  it('reports a missing group instead of failing the whole run', async () => {
    await group('ag-1', 'whatsapp_main');
    const spec: ForkConfig = {
      groups: { nope: { mcpServers: { a: GCAL } }, whatsapp_main: { mcpServers: { 'google-calendar': GCAL } } },
    };

    const report = await applyForkConfig(spec);

    expect(report).toContainEqual({ folder: 'nope', action: 'missing-group' });
    expect(JSON.parse((await getContainerConfig('ag-1'))!.mcp_servers)).toHaveProperty('google-calendar');
  });

  it('rejects an invalid MCP server through the same validator ncl uses', async () => {
    await group('ag-1', 'whatsapp_main');
    const spec = { groups: { whatsapp_main: { mcpServers: { bad: { type: 'http', url: 'http://evil.example/mcp' } } } } };

    await expect(applyForkConfig(spec as ForkConfig)).rejects.toThrow(/HTTPS/);
  });

  it('ships a fork/config.json that declares google-calendar for the self-chat group', () => {
    const spec = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'fork', 'config.json'), 'utf8')) as ForkConfig;
    expect(spec.groups.whatsapp_main.mcpServers?.['google-calendar']).toMatchObject(GCAL);
  });
});
