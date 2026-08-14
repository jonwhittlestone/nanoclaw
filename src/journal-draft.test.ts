import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

vi.mock('./config.js', () => ({
  JOURNAL_DRAFT_PORT: 3021,
  JOURNAL_DRAFT_BIND_HOST: '127.0.0.1',
  JOURNAL_DRAFT_API_KEY: 'test-secret',
  JOURNAL_DRAFT_MAX_CONCURRENT: 2,
}));

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { runContainerAgent, stopContainer } = vi.hoisted(() => ({
  runContainerAgent: vi.fn(),
  stopContainer: vi.fn(),
}));
vi.mock('./container-runner.js', () => ({ runContainerAgent }));
vi.mock('./container-runtime.js', () => ({ stopContainer }));

// Import after mocks are set up (vi.mock is hoisted — same pattern as
// tools/gcal-mcp/index.test.ts)
import {
  createJournalDraftApp,
  parseAgentJson,
  draftJournalEntry,
} from './journal-draft.js';

const validBody = {
  dailyNoteRaw: '## 📌 etc.\n\n- ',
  userText: 'Great sprint retro today.',
  nowIso: '2026-08-14T11:12:00+01:00',
};

const successResult =
  '{"heading":"## 📌 etc.","insertionMarkdown":"- x","reply":"ok"}';

// runContainerAgent's real signature is (group, input, onProcess, onOutput).
// draftJournalEntry resolves off the onOutput callback (streaming mode),
// not the returned promise — see journal-draft.ts's doc comment on why —
// so mocks must actually invoke onProcess/onOutput synchronously, the way
// the real implementation does when a result arrives, rather than just
// resolving a promise the way container-runner's *return value* would.
function mockImmediateOutput(output: { status: string; result?: string | null; error?: string }) {
  runContainerAgent.mockImplementation((_group, _input, onProcess, onOutput) => {
    onProcess({} as never, 'fake-container-name');
    onOutput(output);
    return Promise.resolve({ status: 'success', result: null });
  });
}

describe('parseAgentJson', () => {
  it('parses a bare JSON object', () => {
    // given
    const raw =
      '{"heading":"## 📌 etc.","insertionMarkdown":"- x","reply":"ok"}';

    // when
    const result = parseAgentJson(raw);

    // then
    expect(result).toEqual({
      heading: '## 📌 etc.',
      insertionMarkdown: '- x',
      reply: 'ok',
    });
  });

  it('extracts JSON wrapped in a markdown code fence', () => {
    // given — model ignores the "no fence" instruction, a known real-world case
    const raw =
      '```json\n{"heading":"### Vent","insertionMarkdown":"- y","reply":"noted"}\n```';

    // when / then
    expect(parseAgentJson(raw)).toEqual({
      heading: '### Vent',
      insertionMarkdown: '- y',
      reply: 'noted',
    });
  });

  it('throws on empty result', () => {
    expect(() => parseAgentJson(null)).toThrow('empty agent result');
    expect(() => parseAgentJson('')).toThrow('empty agent result');
  });

  it('throws when no JSON object is present', () => {
    expect(() => parseAgentJson('sorry, I cannot help with that')).toThrow(
      'no JSON object found',
    );
  });

  it('throws when a required field is missing', () => {
    expect(() => parseAgentJson('{"heading":"## 📌 etc."}')).toThrow(
      'missing required fields',
    );
  });
});

describe('draftJournalEntry', () => {
  beforeEach(() => {
    runContainerAgent.mockReset();
    stopContainer.mockReset();
  });

  it('calls runContainerAgent with isMain:false and a dedicated group', async () => {
    // given
    mockImmediateOutput({ status: 'success', result: successResult });

    // when
    await draftJournalEntry(validBody);

    // then
    const [group, input] = runContainerAgent.mock.calls[0];
    expect(group.folder).toBe('journal-draft');
    expect(group.isMain).toBe(false);
    expect(input.isMain).toBe(false);
    expect(input.prompt).toContain(validBody.userText);
    expect(input.prompt).toContain(validBody.nowIso);
  });

  it('resolves as soon as the first result streams in, without waiting for the container to close', async () => {
    // given
    mockImmediateOutput({ status: 'success', result: successResult });

    // when
    const result = await draftJournalEntry(validBody);

    // then
    expect(result).toEqual({
      heading: '## 📌 etc.',
      insertionMarkdown: '- x',
      reply: 'ok',
    });
  });

  it('stops the container once a result is captured, instead of leaving it running', async () => {
    // given
    mockImmediateOutput({ status: 'success', result: successResult });

    // when
    await draftJournalEntry(validBody);

    // then — this is the fix for the real bug found during smoke testing:
    // non-main containers otherwise sit alive until IDLE_TIMEOUT, and the
    // caller (a one-shot HTTP request) would hang the whole time waiting
    // for a close event that was never coming soon.
    expect(stopContainer).toHaveBeenCalledWith('fake-container-name');
  });

  it('throws when the container reports an error, without needing to stop first', async () => {
    // given
    mockImmediateOutput({ status: 'error', error: 'boom' });

    // when / then
    await expect(draftJournalEntry(validBody)).rejects.toThrow('boom');
    expect(stopContainer).toHaveBeenCalledWith('fake-container-name');
  });

  it('rejects if runContainerAgent itself rejects before any output streams', async () => {
    // given — e.g. a synchronous spawn failure, before onProcess ever fires
    runContainerAgent.mockRejectedValue(new Error('spawn failed'));

    // when / then
    await expect(draftJournalEntry(validBody)).rejects.toThrow('spawn failed');
  });
});

describe('GET /internal/journal/health', () => {
  beforeEach(() => {
    runContainerAgent.mockReset();
  });

  it('responds ok with no auth required', async () => {
    // given
    const app = createJournalDraftApp();

    // when
    const res = await request(app).get('/internal/journal/health');

    // then
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(runContainerAgent).not.toHaveBeenCalled();
  });
});

describe('POST /internal/journal/draft', () => {
  beforeEach(() => {
    runContainerAgent.mockReset();
    stopContainer.mockReset();
    mockImmediateOutput({ status: 'success', result: successResult });
  });

  it('rejects requests without the bearer token', async () => {
    // given
    const app = createJournalDraftApp();

    // when
    const res = await request(app)
      .post('/internal/journal/draft')
      .send(validBody);

    // then
    expect(res.status).toBe(401);
    expect(runContainerAgent).not.toHaveBeenCalled();
  });

  it('rejects requests with the wrong bearer token', async () => {
    const app = createJournalDraftApp();

    const res = await request(app)
      .post('/internal/journal/draft')
      .set('Authorization', 'Bearer wrong')
      .send(validBody);

    expect(res.status).toBe(401);
  });

  it('accepts requests with the correct bearer token', async () => {
    // given
    const app = createJournalDraftApp();

    // when
    const res = await request(app)
      .post('/internal/journal/draft')
      .set('Authorization', 'Bearer test-secret')
      .send(validBody);

    // then
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      heading: '## 📌 etc.',
      insertionMarkdown: '- x',
      reply: 'ok',
    });
  });

  it('rejects a body missing userText', async () => {
    const app = createJournalDraftApp();

    const res = await request(app)
      .post('/internal/journal/draft')
      .set('Authorization', 'Bearer test-secret')
      .send({ ...validBody, userText: '' });

    expect(res.status).toBe(400);
  });

  it('returns 502 when the agent call fails', async () => {
    // given
    mockImmediateOutput({ status: 'error', error: 'boom' });
    const app = createJournalDraftApp();

    // when
    const res = await request(app)
      .post('/internal/journal/draft')
      .set('Authorization', 'Bearer test-secret')
      .send(validBody);

    // then
    expect(res.status).toBe(502);
  });

  it('returns 429 once JOURNAL_DRAFT_MAX_CONCURRENT requests are in flight', async () => {
    // given — onOutput is never called until releaseAll() below fires every
    // pending resolver, so both slots stay occupied
    const resolvers: Array<() => void> = [];
    runContainerAgent.mockImplementation((_group, _input, onProcess, onOutput) => {
      onProcess({} as never, 'fake-container-name');
      return new Promise((resolve) => {
        resolvers.push(() => {
          onOutput({ status: 'success', result: successResult });
          resolve({ status: 'success', result: null });
        });
      });
    });
    const app = createJournalDraftApp();

    // when — fire 2 (the configured max) concurrent requests, then a 3rd.
    // supertest/superagent requests are lazy until awaited/`.then()`'d, so
    // `.then()` is called on each immediately (without awaiting the result)
    // to actually dispatch them before the 3rd request is sent.
    const req1 = request(app)
      .post('/internal/journal/draft')
      .set('Authorization', 'Bearer test-secret')
      .send(validBody);
    const req2 = request(app)
      .post('/internal/journal/draft')
      .set('Authorization', 'Bearer test-secret')
      .send(validBody);
    const inFlight = [req1.then((r) => r), req2.then((r) => r)];
    // let both in-flight requests reach the queue/increment before the 3rd fires
    await new Promise((r) => setTimeout(r, 10));
    const third = await request(app)
      .post('/internal/journal/draft')
      .set('Authorization', 'Bearer test-secret')
      .send(validBody);

    // then
    expect(third.status).toBe(429);

    // cleanup — release the held requests so the test doesn't hang
    resolvers.forEach((release) => release());
    await Promise.all(inFlight);
  });
});
