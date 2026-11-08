/**
 * Fork: the journal-draft channel adapter turns one HTTP request into one
 * inbound message on its own thread (so per-thread wiring gives it a fresh
 * session, matching v1's no-continuity design) and resolves with the first
 * reply delivered back to that thread.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../log.js', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import type { ChannelSetup } from '../adapter.js';
import { createJournalDraftChannel, JOURNAL_PLATFORM_ID, readJournalDraftEnv } from './adapter.js';

function fakeSetup() {
  const onInbound = vi.fn();
  return { onInbound, setup: { onInbound } as unknown as ChannelSetup };
}

function channel(timeoutMs = 1000) {
  return createJournalDraftChannel({
    apiKey: 'k',
    host: '127.0.0.1',
    port: 0,
    maxConcurrent: 2,
    timeoutMs,
    listen: false,
  });
}

describe('journal-draft channel', () => {
  it('declares threads and an always-engage, trusted default', () => {
    const { adapter } = channel();
    expect(adapter.channelType).toBe('journal-draft');
    expect(adapter.supportsThreads).toBe(true);
    expect(adapter.defaults?.dm).toMatchObject({ engageMode: 'pattern', engagePattern: '.', threads: true });
  });

  it('sends the prompt as an inbound message on a fresh thread and resolves with the reply', async () => {
    const { adapter, ask } = channel();
    const { onInbound, setup } = fakeSetup();
    await adapter.setup(setup);

    const pending = ask('PROMPT');
    await vi.waitFor(() => expect(onInbound).toHaveBeenCalledOnce());
    const [platformId, threadId, message] = onInbound.mock.calls[0];
    expect(platformId).toBe(JOURNAL_PLATFORM_ID);
    expect(typeof threadId).toBe('string');
    expect(message).toMatchObject({ kind: 'chat', content: { text: 'PROMPT', sender: 'randoread' } });

    await adapter.deliver(JOURNAL_PLATFORM_ID, threadId, { kind: 'chat', content: { text: '{"a":1}' } });
    await expect(pending).resolves.toBe('{"a":1}');
  });

  it('keeps concurrent requests apart by thread', async () => {
    const { adapter, ask } = channel();
    const { onInbound, setup } = fakeSetup();
    await adapter.setup(setup);

    const a = ask('A');
    const b = ask('B');
    await vi.waitFor(() => expect(onInbound).toHaveBeenCalledTimes(2));
    const threadA = onInbound.mock.calls[0][1];
    const threadB = onInbound.mock.calls[1][1];
    expect(threadA).not.toBe(threadB);

    await adapter.deliver(JOURNAL_PLATFORM_ID, threadB, { kind: 'chat', content: { text: 'for B' } });
    await adapter.deliver(JOURNAL_PLATFORM_ID, threadA, { kind: 'chat', content: 'for A' });
    await expect(a).resolves.toBe('for A');
    await expect(b).resolves.toBe('for B');
  });

  it('ignores deliveries for other platforms or unknown threads', async () => {
    const { adapter } = channel();
    await adapter.setup(fakeSetup().setup);
    await expect(adapter.deliver('other', 't', { kind: 'chat', content: 'x' })).resolves.toBeUndefined();
    await expect(
      adapter.deliver(JOURNAL_PLATFORM_ID, 'stale', { kind: 'chat', content: 'x' }),
    ).resolves.toBeUndefined();
  });

  it('rejects when the agent does not reply in time', async () => {
    const { adapter, ask } = channel(50);
    await adapter.setup(fakeSetup().setup);
    await expect(ask('slow')).rejects.toThrow(/timed out/);
  });
});

describe('readJournalDraftEnv', () => {
  it('returns null without an API key, so the channel stays offline', () => {
    expect(readJournalDraftEnv({})).toBeNull();
  });

  it('applies v1 defaults', () => {
    expect(readJournalDraftEnv({ JOURNAL_DRAFT_API_KEY: 'k' })).toMatchObject({
      apiKey: 'k',
      host: '127.0.0.1',
      port: 3021,
      maxConcurrent: 2,
    });
  });

  it('reads host, port and concurrency overrides', () => {
    const cfg = readJournalDraftEnv({
      JOURNAL_DRAFT_API_KEY: 'k',
      JOURNAL_DRAFT_BIND_HOST: '100.111.143.116',
      JOURNAL_DRAFT_PORT: '3022',
      JOURNAL_DRAFT_MAX_CONCURRENT: '1',
    });
    expect(cfg).toMatchObject({ host: '100.111.143.116', port: 3022, maxConcurrent: 1 });
  });
});
