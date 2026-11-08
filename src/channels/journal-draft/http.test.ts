/**
 * Fork: the journal-draft HTTP contract randoread depends on, ported from
 * v1's src/journal-draft.test.ts. The agent round trip is injected (`ask`)
 * so these tests cover only the HTTP surface; the channel adapter that
 * routes `ask` through a v2 session is tested separately.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../log.js', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { buildPrompt, createJournalDraftHandler, parseAgentJson } from './http.js';

const RESULT = { heading: '## 🙏Gratitudes', insertionMarkdown: '- sunshine', reply: 'Filed under Gratitudes.' };
const BODY = {
  dailyNoteRaw: '# note\n## 🙏Gratitudes\n',
  userText: 'grateful for sunshine',
  nowIso: '2026-11-08T10:00:00Z',
};

let server: http.Server | undefined;

async function serve(opts: Parameters<typeof createJournalDraftHandler>[0]): Promise<string> {
  server = http.createServer(createJournalDraftHandler(opts));
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function post(base: string, body: unknown, token?: string): Promise<Response> {
  return fetch(`${base}/internal/journal/draft`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

describe('parseAgentJson', () => {
  it('parses a bare JSON object', () => {
    expect(parseAgentJson(JSON.stringify(RESULT))).toEqual(RESULT);
  });
  it('extracts JSON wrapped in a markdown code fence', () => {
    expect(parseAgentJson('```json\n' + JSON.stringify(RESULT) + '\n```')).toEqual(RESULT);
  });
  it('throws on an empty result', () => {
    expect(() => parseAgentJson('  ')).toThrow(/empty/);
  });
  it('throws when no JSON object is present', () => {
    expect(() => parseAgentJson('sorry, no')).toThrow(/no JSON/);
  });
  it('throws when a required field is missing', () => {
    expect(() => parseAgentJson('{"heading":"## x","reply":"r"}')).toThrow(/missing required/);
  });
});

describe('buildPrompt', () => {
  it('frames the note and fragment exactly as v1 did', () => {
    const p = buildPrompt(BODY);
    expect(p).toContain('Current local time: 2026-11-08T10:00:00Z');
    expect(p).toContain("---TODAY'S DAILY NOTE---\n# note\n## 🙏Gratitudes\n\n---END NOTE---");
    expect(p).toContain('---FRAGMENT TO FILE---\ngrateful for sunshine\n---END FRAGMENT---');
  });
});

describe('GET /internal/journal/health', () => {
  it('responds ok with no auth required', async () => {
    const base = await serve({ apiKey: 'k', maxConcurrent: 2, ask: vi.fn() });
    const res = await fetch(`${base}/internal/journal/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});

describe('POST /internal/journal/draft', () => {
  it('returns 503 when no API key is configured', async () => {
    const base = await serve({ apiKey: '', maxConcurrent: 2, ask: vi.fn() });
    expect((await post(base, BODY, 'anything')).status).toBe(503);
  });

  it('rejects requests without, or with the wrong, bearer token', async () => {
    const ask = vi.fn();
    const base = await serve({ apiKey: 'secret', maxConcurrent: 2, ask });
    expect((await post(base, BODY)).status).toBe(401);
    expect((await post(base, BODY, 'nope')).status).toBe(401);
    expect(ask).not.toHaveBeenCalled();
  });

  it('rejects a body missing userText', async () => {
    const base = await serve({ apiKey: 'secret', maxConcurrent: 2, ask: vi.fn() });
    expect((await post(base, { ...BODY, userText: '' }, 'secret')).status).toBe(400);
  });

  it('returns the agent draft for a valid request', async () => {
    const ask = vi.fn(async () => '```json\n' + JSON.stringify(RESULT) + '\n```');
    const base = await serve({ apiKey: 'secret', maxConcurrent: 2, ask });
    const res = await post(base, BODY, 'secret');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(RESULT);
    expect(ask).toHaveBeenCalledWith(buildPrompt(BODY));
  });

  it('returns 502 when the agent call fails or replies without JSON', async () => {
    const base = await serve({ apiKey: 'secret', maxConcurrent: 2, ask: vi.fn(async () => 'no json here') });
    expect((await post(base, BODY, 'secret')).status).toBe(502);
  });

  it('returns 429 once maxConcurrent requests are in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const ask = vi.fn(async () => {
      await gate;
      return JSON.stringify(RESULT);
    });
    const base = await serve({ apiKey: 'secret', maxConcurrent: 1, ask });
    const first = post(base, BODY, 'secret');
    await vi.waitFor(() => expect(ask).toHaveBeenCalledOnce());
    expect((await post(base, BODY, 'secret')).status).toBe(429);
    release();
    expect((await first).status).toBe(200);
  });

  it('rejects bodies over 256 KB', async () => {
    const base = await serve({ apiKey: 'secret', maxConcurrent: 2, ask: vi.fn() });
    const res = await post(base, { ...BODY, dailyNoteRaw: 'x'.repeat(300 * 1024) }, 'secret');
    expect(res.status).toBe(413);
  });

  it('404s unknown paths', async () => {
    const base = await serve({ apiKey: 'secret', maxConcurrent: 2, ask: vi.fn() });
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});
