/**
 * Fork (jonwhittlestone/nanoclaw): journal-draft as a v2 channel adapter.
 *
 * v1 called runContainerAgent() directly. In v2 the supported way to reach
 * an agent is a channel: each HTTP request becomes one inbound message on
 * its own thread. With the wiring's session_mode "per-thread", every request
 * gets a fresh session (v1's deliberate no-continuity design), and the
 * first reply the agent delivers to that thread answers the HTTP call.
 *
 * Offline (factory returns null) unless JOURNAL_DRAFT_API_KEY is set.
 */
import { randomUUID } from 'node:crypto';

import { log } from '../../log.js';
import type { ChannelAdapter, ChannelDefaults, ChannelSetup, OutboundMessage } from '../adapter.js';
import { createJournalDraftHandler } from './http.js';
import { superviseServer, type Supervisor } from './supervisor.js';

export const JOURNAL_CHANNEL_TYPE = 'journal-draft';
export const JOURNAL_PLATFORM_ID = 'randoread';

/** Every request is for the agent; the bearer key already authenticated it. */
export const JOURNAL_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: true, unknownSenderPolicy: 'public' },
  group: { engageMode: 'pattern', engagePattern: '.', threads: true, unknownSenderPolicy: 'public' },
  mentions: 'never',
};

export interface JournalDraftConfig {
  apiKey: string;
  host: string;
  port: number;
  maxConcurrent: number;
  timeoutMs: number;
  /** false in unit tests: skip the HTTP listener. */
  listen?: boolean;
}

export function readJournalDraftEnv(env: Record<string, string | undefined>): JournalDraftConfig | null {
  const apiKey = env.JOURNAL_DRAFT_API_KEY;
  if (!apiKey) return null;
  const int = (v: string | undefined, d: number) => (v && /^\d+$/.test(v) ? Number(v) : d);
  return {
    apiKey,
    host: env.JOURNAL_DRAFT_BIND_HOST || '127.0.0.1',
    port: int(env.JOURNAL_DRAFT_PORT, 3021),
    maxConcurrent: int(env.JOURNAL_DRAFT_MAX_CONCURRENT, 2),
    timeoutMs: int(env.JOURNAL_DRAFT_TIMEOUT_MS, 180_000),
  };
}

function replyText(message: OutboundMessage): string | null {
  const content = message.content as Record<string, unknown> | string | undefined;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
  return null;
}

interface Pending {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export function createJournalDraftChannel(cfg: JournalDraftConfig): {
  adapter: ChannelAdapter;
  ask: (prompt: string) => Promise<string>;
} {
  let setupConfig: ChannelSetup | null = null;
  let supervisor: Supervisor | null = null;
  const pending = new Map<string, Pending>();

  function ask(prompt: string): Promise<string> {
    if (!setupConfig) return Promise.reject(new Error('journal-draft channel not set up'));
    const threadId = randomUUID();
    const config = setupConfig;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(threadId);
        reject(new Error(`journal draft timed out after ${cfg.timeoutMs}ms`));
      }, cfg.timeoutMs);
      timer.unref();
      pending.set(threadId, { resolve, reject, timer });
      Promise.resolve(
        config.onInbound(JOURNAL_PLATFORM_ID, threadId, {
          id: `journal-${threadId}`,
          kind: 'chat',
          timestamp: new Date().toISOString(),
          content: { text: prompt, sender: 'randoread', senderId: `${JOURNAL_CHANNEL_TYPE}:${JOURNAL_PLATFORM_ID}` },
        }),
      ).catch((err: unknown) => {
        clearTimeout(timer);
        pending.delete(threadId);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  const adapter: ChannelAdapter = {
    name: JOURNAL_CHANNEL_TYPE,
    channelType: JOURNAL_CHANNEL_TYPE,
    supportsThreads: true,
    defaults: JOURNAL_DEFAULTS,

    async setup(config: ChannelSetup): Promise<void> {
      setupConfig = config;
      if (cfg.listen === false) return;
      supervisor = superviseServer({
        handler: createJournalDraftHandler({ apiKey: cfg.apiKey, maxConcurrent: cfg.maxConcurrent, ask }),
        host: cfg.host,
        port: cfg.port,
      });
    },

    async teardown(): Promise<void> {
      await supervisor?.stop();
      supervisor = null;
      for (const [id, p] of pending) {
        clearTimeout(p.timer);
        p.reject(new Error('journal-draft channel shutting down'));
        pending.delete(id);
      }
    },

    isConnected(): boolean {
      return setupConfig !== null && (cfg.listen === false || (supervisor?.listening() ?? false));
    },

    async deliver(platformId, threadId, message): Promise<string | undefined> {
      if (platformId !== JOURNAL_PLATFORM_ID || !threadId) return undefined;
      const p = pending.get(threadId);
      if (!p) {
        log.debug('journal-draft: reply for a finished or unknown request', { threadId });
        return undefined;
      }
      const text = replyText(message);
      if (text === null) return undefined; // not a text reply (e.g. a card); keep waiting
      clearTimeout(p.timer);
      pending.delete(threadId);
      p.resolve(text);
      return undefined;
    },
  };

  return { adapter, ask };
}
