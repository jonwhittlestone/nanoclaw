/**
 * fork-apply — re-apply this fork's per-group container config.
 *
 * v2 keeps MCP servers and packages in the central DB (`container_configs`),
 * not in code, so a fresh `migrate-v2.sh` (or `migrate-v2-reset.sh`) loses
 * them. `fork/config.json` is the declarative source; this script merges it
 * into the DB, keyed by agent-group folder.
 *
 * Merge rules (safe to run any number of times):
 *   - MCP servers: declared names are set; servers not named in the spec are
 *     left alone (operator-added via `ncl groups config add-mcp-server`).
 *   - Packages: set union, original order kept.
 *   - Unknown folder: reported, others still applied.
 *
 * Usage: pnpm exec tsx scripts/fork-apply.ts [fork/config.json]
 * Then `ncl groups restart --id <group>` (add `--rebuild` if packages changed).
 */
import fs from 'node:fs';
import path from 'node:path';

import { CENTRAL_DB_PATH } from '../src/config.js';
import { backfillContainerConfigs } from '../src/backfill-container-configs.js';
import {
  parseMcpServerConfig,
  validateMcpServerName,
  type AdditionalMountConfig,
  type McpServerConfig,
} from '../src/container-config.js';
import { getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { closeDb, initDb } from '../src/db/connection.js';
import { ensureContainerConfig, getContainerConfig, updateContainerConfigJson } from '../src/db/container-configs.js';
import { runMigrations } from '../src/db/migrations/index.js';

export interface ForkGroupConfig {
  mcpServers?: Record<string, Record<string, unknown>>;
  packages?: { apt?: string[]; npm?: string[] };
  additionalMounts?: AdditionalMountConfig[];
}

export interface ForkConfig {
  groups: Record<string, ForkGroupConfig>;
}

export type ForkApplyReport =
  | { folder: string; action: 'missing-group' }
  | { folder: string; action: 'mcp-set'; name: string }
  | { folder: string; action: 'packages'; apt: string[]; npm: string[] }
  | { folder: string; action: 'mounts'; containerPaths: string[] };

export interface ForkApplyDeps {
  /** Seeds rows from legacy groups/<folder>/container.json; must run before any row is created. */
  backfill?: () => Promise<void>;
}

function union(existing: string[], add: string[] = []): string[] {
  return [...existing, ...add.filter((p) => !existing.includes(p))];
}

export async function applyForkConfig(spec: ForkConfig, deps: ForkApplyDeps = {}): Promise<ForkApplyReport[]> {
  // Validate everything before writing anything, so a bad entry can't leave
  // half the spec applied.
  const parsed = Object.entries(spec.groups).map(([folder, cfg]) => {
    const servers: Record<string, McpServerConfig> = {};
    for (const [name, raw] of Object.entries(cfg.mcpServers ?? {})) {
      validateMcpServerName(name);
      servers[name] = parseMcpServerConfig(raw);
    }
    return { folder, servers, packages: cfg.packages, mounts: cfg.additionalMounts };
  });

  // A freshly migrated install only has groups/<folder>/container.json (with the
  // vault mount). Upstream's backfill imports it only for groups with no row, so
  // it must run before ensureContainerConfig creates an empty one.
  await (deps.backfill ?? backfillContainerConfigs)();

  const report: ForkApplyReport[] = [];
  for (const { folder, servers, packages, mounts } of parsed) {
    const group = await getAgentGroupByFolder(folder);
    if (!group) {
      report.push({ folder, action: 'missing-group' });
      continue;
    }
    await ensureContainerConfig(group.id);
    const row = (await getContainerConfig(group.id))!;

    if (Object.keys(servers).length > 0) {
      const current = JSON.parse(row.mcp_servers) as Record<string, McpServerConfig>;
      await updateContainerConfigJson(group.id, 'mcp_servers', { ...current, ...servers });
      for (const name of Object.keys(servers)) report.push({ folder, action: 'mcp-set', name });
    }

    if (packages) {
      const apt = union(JSON.parse(row.packages_apt) as string[], packages.apt);
      const npm = union(JSON.parse(row.packages_npm) as string[], packages.npm);
      await updateContainerConfigJson(group.id, 'packages_apt', apt);
      await updateContainerConfigJson(group.id, 'packages_npm', npm);
      report.push({ folder, action: 'packages', apt, npm });
    }

    if (mounts && mounts.length > 0) {
      const declared = new Set(mounts.map((m) => m.containerPath));
      const current = JSON.parse(row.additional_mounts) as AdditionalMountConfig[];
      const kept = current.filter((m) => !declared.has(m.containerPath));
      await updateContainerConfigJson(group.id, 'additional_mounts', [...kept, ...mounts]);
      report.push({ folder, action: 'mounts', containerPaths: [...declared] });
    }
  }
  return report;
}

async function main(): Promise<void> {
  const file = path.resolve(process.argv[2] ?? 'fork/config.json');
  const spec = JSON.parse(fs.readFileSync(file, 'utf8')) as ForkConfig;
  const db = await initDb(CENTRAL_DB_PATH);
  try {
    await runMigrations(db);
    for (const line of await applyForkConfig(spec)) console.log(JSON.stringify(line));
  } finally {
    await closeDb();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
