/**
 * Fork (jonwhittlestone/nanoclaw): the HTTP surface of the journal-draft
 * endpoint used by randoread's floating "Send to oh-two" input. Same
 * contract as v1 (main.md §05.05), on node:http:
 *
 *   GET  /internal/journal/health  → 200 {status:"ok"}        (no auth)
 *   POST /internal/journal/draft   {dailyNoteRaw, userText, nowIso}
 *                                  → 200 {heading, insertionMarkdown, reply}
 *        401 bad/missing bearer · 400 bad body · 413 too large
 *        429 too many in flight · 502 agent failed · 503 no key configured
 *
 * The agent round trip is injected as `ask(prompt) → reply text`; the
 * channel adapter (./index.ts) implements it with a v2 session.
 */
import type http from 'node:http';

import { log } from '../../log.js';

export interface JournalDraftRequest {
  dailyNoteRaw: string;
  userText: string;
  nowIso: string;
}

export interface JournalDraftResult {
  heading: string;
  insertionMarkdown: string;
  reply: string;
}

export interface JournalDraftHandlerOptions {
  apiKey: string;
  maxConcurrent: number;
  ask: (prompt: string) => Promise<string>;
}

const MAX_BODY_BYTES = 256 * 1024;

export function buildPrompt(req: JournalDraftRequest): string {
  return [
    `Current local time: ${req.nowIso}`,
    '',
    "---TODAY'S DAILY NOTE---",
    req.dailyNoteRaw,
    '---END NOTE---',
    '',
    '---FRAGMENT TO FILE---',
    req.userText,
    '---END FRAGMENT---',
  ].join('\n');
}

// The agent is told to reply with strict JSON, but models sometimes wrap it
// in a ```json fence anyway, so take the first {...} object.
export function parseAgentJson(result: string | null | undefined): JournalDraftResult {
  if (!result || !result.trim()) throw new Error('empty agent result');
  const match = result.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`no JSON object found in agent result: ${result}`);
  let parsed: Partial<JournalDraftResult>;
  try {
    parsed = JSON.parse(match[0]) as Partial<JournalDraftResult>;
  } catch (err) {
    throw new Error(`failed to parse agent JSON (${String(err)}): ${match[0]}`, { cause: err });
  }
  if (!parsed.heading || !parsed.insertionMarkdown || !parsed.reply) {
    throw new Error(`agent JSON missing required fields (heading/insertionMarkdown/reply): ${match[0]}`);
  }
  return parsed as JournalDraftResult;
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

class BodyTooLarge extends Error {}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BodyTooLarge());
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createJournalDraftHandler(
  opts: JournalDraftHandlerOptions,
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  // Each request costs an agent container, so cap them; there's no queue
  // because the UI is a synchronous "type a note, wait for one reply".
  let active = 0;

  async function draft(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!opts.apiKey) {
      log.error('JOURNAL_DRAFT_API_KEY not configured — refusing journal draft request');
      return send(res, 503, { error: 'journal draft endpoint not configured' });
    }
    if ((req.headers.authorization ?? '') !== `Bearer ${opts.apiKey}`) {
      return send(res, 401, { error: 'unauthorized' });
    }

    let body: Partial<JournalDraftRequest>;
    try {
      body = JSON.parse(await readBody(req)) as Partial<JournalDraftRequest>;
    } catch (err) {
      if (err instanceof BodyTooLarge) return send(res, 413, { error: 'request body too large' });
      return send(res, 400, { error: 'invalid JSON body' });
    }
    const { dailyNoteRaw, userText, nowIso } = body ?? {};
    if (!isNonEmptyString(userText) || typeof dailyNoteRaw !== 'string' || !isNonEmptyString(nowIso)) {
      return send(res, 400, { error: 'dailyNoteRaw, userText, and nowIso are required' });
    }

    if (active >= opts.maxConcurrent) {
      log.warn('journal draft request rejected — too many in flight', { active, max: opts.maxConcurrent });
      return send(res, 429, { error: 'too many journal draft requests in flight' });
    }

    active++;
    try {
      const reply = await opts.ask(buildPrompt({ dailyNoteRaw, userText, nowIso }));
      send(res, 200, parseAgentJson(reply));
    } catch (err) {
      log.error('journal draft failed', { err });
      send(res, 502, { error: 'failed to draft journal entry' });
    } finally {
      active--;
    }
  }

  return (req, res) => {
    const url = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && url === '/internal/journal/health') return send(res, 200, { status: 'ok' });
    if (req.method === 'POST' && url === '/internal/journal/draft') {
      draft(req, res).catch((err) => {
        log.error('journal draft handler crashed', { err });
        if (!res.headersSent) send(res, 500, { error: 'internal error' });
      });
      return;
    }
    send(res, 404, { error: 'not found' });
  };
}
