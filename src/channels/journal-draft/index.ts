/**
 * Fork (jonwhittlestone/nanoclaw): registers the journal-draft channel used
 * by randoread. See ./adapter.ts. Offline unless JOURNAL_DRAFT_API_KEY is set
 * in .env; JOURNAL_DRAFT_BIND_HOST / _PORT / _MAX_CONCURRENT / _TIMEOUT_MS
 * tune it (v1 defaults: 127.0.0.1, 3021, 2, 180000).
 */
import { readEnvFile } from '../../env.js';
import { registerChannelAdapter } from '../channel-registry.js';
import { createJournalDraftChannel, JOURNAL_CHANNEL_TYPE, JOURNAL_DEFAULTS, readJournalDraftEnv } from './adapter.js';

const ENV_KEYS = [
  'JOURNAL_DRAFT_API_KEY',
  'JOURNAL_DRAFT_BIND_HOST',
  'JOURNAL_DRAFT_PORT',
  'JOURNAL_DRAFT_MAX_CONCURRENT',
  'JOURNAL_DRAFT_TIMEOUT_MS',
];

registerChannelAdapter(JOURNAL_CHANNEL_TYPE, {
  factory: () => {
    const fileEnv = readEnvFile(ENV_KEYS);
    const env = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k] || fileEnv[k]]));
    const cfg = readJournalDraftEnv(env);
    return cfg ? createJournalDraftChannel(cfg).adapter : null;
  },
  defaults: JOURNAL_DEFAULTS,
});
