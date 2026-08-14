import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'ONECLI_URL',
  'ONECLI_API_KEY',
  'TZ',
  'JOURNAL_DRAFT_PORT',
  'JOURNAL_DRAFT_API_KEY',
  'JOURNAL_DRAFT_BIND_HOST',
  'JOURNAL_DRAFT_MAX_CONCURRENT',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const ONECLI_URL = process.env.ONECLI_URL || envConfig.ONECLI_URL;
export const ONECLI_API_KEY =
  process.env.ONECLI_API_KEY || envConfig.ONECLI_API_KEY;
export const MAX_MESSAGES_PER_PROMPT = Math.max(
  1,
  parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10,
);
export const IPC_POLL_INTERVAL = 1000;
export const WHISPER_SERVER_URL =
  process.env.WHISPER_SERVER_URL ?? 'http://127.0.0.1:8080';
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

// Journal draft endpoint — see src/journal-draft.ts. A one-shot HTTP
// endpoint used by randoread's floating "Send to oh-two" journal input.
// Bypasses the channel/queue/session machinery entirely: it isn't a Channel,
// isn't in registered_groups, and each call is a single, stateless agent turn.
// See main.md §05.05.02 "Security" for the cross-host trust model — randoread
// runs on a different host (doylestonex) from NanoClaw (doylestone02), so
// this must be reached over a private network (Tailscale), never the public
// internet or plain LAN.
export const JOURNAL_DRAFT_PORT = parseInt(
  process.env.JOURNAL_DRAFT_PORT || envConfig.JOURNAL_DRAFT_PORT || '3021',
  10,
);
// Bind address — defaults to loopback-only so the endpoint is inert unless
// explicitly opted into a routable interface. Set to the host's Tailscale
// IP (100.x.x.x) in production, never '0.0.0.0'.
export const JOURNAL_DRAFT_BIND_HOST =
  process.env.JOURNAL_DRAFT_BIND_HOST ||
  envConfig.JOURNAL_DRAFT_BIND_HOST ||
  '127.0.0.1';
// Shared secret the caller (randoread's Go backend) sends as
// `Authorization: Bearer <key>`. Not set = endpoint refuses all requests.
export const JOURNAL_DRAFT_API_KEY =
  process.env.JOURNAL_DRAFT_API_KEY || envConfig.JOURNAL_DRAFT_API_KEY;
// Each call spawns a Docker container — separate from and much lower than
// MAX_CONCURRENT_CONTAINERS (shared with real channel traffic), since this
// is a single-user "type one note, wait for one reply" UI with no queue
// backing it. Requests beyond this get a 429, not queued.
export const JOURNAL_DRAFT_MAX_CONCURRENT = Math.max(
  1,
  parseInt(
    process.env.JOURNAL_DRAFT_MAX_CONCURRENT ||
      envConfig.JOURNAL_DRAFT_MAX_CONCURRENT ||
      '2',
    10,
  ) || 2,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerPattern(trigger: string): RegExp {
  return new RegExp(`^${escapeRegex(trigger.trim())}\\b`, 'i');
}

export const DEFAULT_TRIGGER = `@${ASSISTANT_NAME}`;

export function getTriggerPattern(trigger?: string): RegExp {
  const normalizedTrigger = trigger?.trim();
  return buildTriggerPattern(normalizedTrigger || DEFAULT_TRIGGER);
}

export const TRIGGER_PATTERN = buildTriggerPattern(DEFAULT_TRIGGER);

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [
    process.env.TZ,
    envConfig.TZ,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  ];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();
