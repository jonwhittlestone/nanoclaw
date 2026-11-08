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

  it('gives every request its own thread', async () => {
    const { adapter, ask } = channel();
    const { onInbound, setup } = fakeSetup();
    await adapter.setup(setup);

    const a = ask('A');
    await vi.waitFor(() => expect(onInbound).toHaveBeenCalledTimes(1));
    await adapter.deliver(JOURNAL_PLATFORM_ID, onInbound.mock.calls[0][1], { kind: 'chat', content: 'for A' });
    await a;
    const b = ask('B');
    await vi.waitFor(() => expect(onInbound).toHaveBeenCalledTimes(2));
    expect(onInbound.mock.calls[1][1]).not.toBe(onInbound.mock.calls[0][1]);
    await adapter.deliver(JOURNAL_PLATFORM_ID, onInbound.mock.calls[1][1], {
      kind: 'chat',
      content: { text: 'for B' },
    });
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

describe('journal-draft channel: one draft in flight (shared warm session)', () => {
  it('holds a second request until the first has been answered', async () => {
    const { adapter, ask } = channel();
    const { onInbound, setup } = fakeSetup();
    await adapter.setup(setup);

    const a = ask('A');
    const b = ask('B');
    await vi.waitFor(() => expect(onInbound).toHaveBeenCalledTimes(1));
    // B must not be routed while A is outstanding: in a shared session two
    // messages arriving together are batched into one turn whose replies all
    // go to the first thread (design doc 06.12.07).
    await new Promise((r) => setTimeout(r, 20));
    expect(onInbound).toHaveBeenCalledTimes(1);

    const threadA = onInbound.mock.calls[0][1];
    await adapter.deliver(JOURNAL_PLATFORM_ID, threadA, { kind: 'chat', content: 'for A' });
    await expect(a).resolves.toBe('for A');

    await vi.waitFor(() => expect(onInbound).toHaveBeenCalledTimes(2));
    const threadB = onInbound.mock.calls[1][1];
    await adapter.deliver(JOURNAL_PLATFORM_ID, threadB, { kind: 'chat', content: 'for B' });
    await expect(b).resolves.toBe('for B');
  });

  it('releases the slot when a request times out, so the next one runs', async () => {
    const { adapter, ask } = channel(40);
    const { onInbound, setup } = fakeSetup();
    await adapter.setup(setup);

    const a = ask('A');
    const b = ask('B');
    await expect(a).rejects.toThrow(/timed out/);
    await vi.waitFor(() => expect(onInbound).toHaveBeenCalledTimes(2));
    await expect(b).rejects.toThrow(/timed out/);
  });
});
