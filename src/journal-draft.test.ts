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

const { runContainerAgent } = vi.hoisted(() => ({ runContainerAgent: vi.fn() }));
vi.mock('./container-runner.js', () => ({ runContainerAgent }));

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

describe('parseAgentJson', () => {
  it('parses a bare JSON object', () => {
    // given
    const raw = '{"heading":"## 📌 etc.","insertionMarkdown":"- x","reply":"ok"}';

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
  });

  it('calls runContainerAgent with isMain:false and a dedicated group', async () => {
    // given
    runContainerAgent.mockResolvedValue({
      status: 'success',
      result: '{"heading":"## 📌 etc.","insertionMarkdown":"- x","reply":"ok"}',
    });

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

  it('throws when the container reports an error', async () => {
    // given
    runContainerAgent.mockResolvedValue({ status: 'error', error: 'boom' });

    // when / then
    await expect(draftJournalEntry(validBody)).rejects.toThrow('boom');
  });
});

describe('POST /internal/journal/draft', () => {
  beforeEach(() => {
    runContainerAgent.mockReset();
    runContainerAgent.mockResolvedValue({
      status: 'success',
      result: '{"heading":"## 📌 etc.","insertionMarkdown":"- x","reply":"ok"}',
    });
  });

  it('rejects requests without the bearer token', async () => {
    // given
    const app = createJournalDraftApp();

    // when
    const res = await request(app).post('/internal/journal/draft').send(validBody);

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
    runContainerAgent.mockResolvedValue({ status: 'error', error: 'boom' });
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
    // given — runContainerAgent never resolves on its own, so both slots stay
    // occupied until releaseAll() below fires every pending resolver
    const resolvers: Array<() => void> = [];
    runContainerAgent.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(() =>
            resolve({
              status: 'success',
              result: '{"heading":"## 📌 etc.","insertionMarkdown":"- x","reply":"ok"}',
            }),
          );
        }),
    );
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
