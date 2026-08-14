/**
 * Journal draft endpoint — a one-shot, stateless HTTP endpoint that
 * classifies a fragment of text against today's daily note headings and
 * drafts the markdown line to insert, for randoread's floating "Send to
 * oh-two" journal input (see main.md §05.05).
 *
 * Deliberately NOT a Channel: this doesn't go through the message
 * router/queue/session machinery every other channel uses, isn't in
 * registered_groups, and the group ("journal-draft") never appears in
 * available_groups.json. Each request is a single, independent
 * runContainerAgent() call — no conversation continuity is wanted here,
 * the propose→confirm flow is inherently single-shot per request.
 *
 * The actual Dropbox write happens in randoread (HandleSaveRelated's
 * pattern), not here — this endpoint never gets vault credentials.
 */
import express, { Request, Response } from 'express';

import {
  JOURNAL_DRAFT_API_KEY,
  JOURNAL_DRAFT_BIND_HOST,
  JOURNAL_DRAFT_MAX_CONCURRENT,
  JOURNAL_DRAFT_PORT,
} from './config.js';
import { runContainerAgent } from './container-runner.js';
import { stopContainer } from './container-runtime.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

// Ad-hoc RegisteredGroup — never written to the registered_groups table.
// runContainerAgent only needs the shape, not a DB row (see group-folder.ts:
// resolveGroupFolderPath just needs a folder name that passes
// isValidGroupFolder). isMain stays false: this group gets only its own
// folder mounted, not the project/store access main has.
const JOURNAL_DRAFT_GROUP: RegisteredGroup = {
  name: 'Journal Draft',
  folder: 'journal-draft',
  trigger: '',
  added_at: '2026-08-14T00:00:00.000Z',
  requiresTrigger: false,
  isMain: false,
};

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

function buildPrompt(req: JournalDraftRequest): string {
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

// The agent is instructed to reply with strict JSON, but models sometimes
// wrap it in a ```json fence anyway — extract the first {...} object rather
// than trusting the whole response to be bare JSON.
export function parseAgentJson(result: string | null): JournalDraftResult {
  if (!result || !result.trim()) {
    throw new Error('empty agent result');
  }
  const match = result.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error(`no JSON object found in agent result: ${result}`);
  }
  let parsed: Partial<JournalDraftResult>;
  try {
    parsed = JSON.parse(match[0]);
  } catch (err) {
    throw new Error(`failed to parse agent JSON (${err}): ${match[0]}`);
  }
  if (!parsed.heading || !parsed.insertionMarkdown || !parsed.reply) {
    throw new Error(
      `agent JSON missing required fields (heading/insertionMarkdown/reply): ${match[0]}`,
    );
  }
  return parsed as JournalDraftResult;
}

export async function draftJournalEntry(
  req: JournalDraftRequest,
): Promise<JournalDraftResult> {
  return new Promise<JournalDraftResult>((resolve, reject) => {
    let containerName: string | undefined;
    let settled = false;

    // Non-main containers are left running after their result (matches
    // chat-group behavior, where staying alive lets a follow-up message
    // reuse the same session cheaply — see IDLE_TIMEOUT). This endpoint is
    // genuinely one-shot: nothing will ever send a follow-up turn to it, so
    // waiting for the container to exit on its own (up to IDLE_TIMEOUT,
    // 30min default) would leave the caller hanging long after the actual
    // answer is ready. Passing onOutput puts runContainerAgent in
    // streaming mode, which calls back the moment a result is parsed from
    // the container's stdout — resolve right there instead of waiting for
    // the process to close, then stop the container explicitly.
    runContainerAgent(
      JOURNAL_DRAFT_GROUP,
      {
        prompt: buildPrompt(req),
        groupFolder: JOURNAL_DRAFT_GROUP.folder,
        chatJid: 'journal-draft@web',
        isMain: false,
      },
      (_proc, name) => {
        containerName = name;
      },
      async (output) => {
        if (settled) return; // only the first result matters for a one-shot call
        settled = true;

        if (output.status === 'error') {
          reject(new Error(output.error || 'agent error'));
        } else {
          try {
            resolve(parseAgentJson(output.result));
          } catch (err) {
            reject(err);
          }
        }

        if (containerName) {
          try {
            stopContainer(containerName);
          } catch (err) {
            logger.warn(
              { err, containerName },
              'failed to stop journal-draft container after result',
            );
          }
        }
      },
    ).catch((err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

// runContainerAgent bypasses GroupQueue entirely (see module doc comment),
// so MAX_CONCURRENT_CONTAINERS' backpressure doesn't apply here — this
// endpoint needs its own, much smaller cap so a runaway or malicious client
// can't spawn unbounded containers alongside real channel traffic. Rejected
// requests get a 429; there's no queue to hold them because this is a
// synchronous "type a note, wait for one reply" UI, not a message channel.
let activeRequests = 0;

export function createJournalDraftApp(): express.Express {
  const app = express();
  // Daily notes are small markdown files (tens of KB); 256kb leaves generous
  // headroom without accepting arbitrarily large bodies.
  app.use(express.json({ limit: '256kb' }));

  // Unauthenticated on purpose — a liveness probe, not a data endpoint. It
  // reveals nothing beyond "this port is answering," which randoread's
  // /api/journal/status already exposes indirectly (that's the whole point
  // of the check — see main.md §05.05.02: the feature must go unavailable
  // on the frontend when doylestone02 isn't reachable, e.g. off the
  // tailnet). Reachability itself is already gated by JOURNAL_DRAFT_BIND_HOST
  // defaulting to loopback, so this doesn't widen the trust boundary.
  app.get('/internal/journal/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  app.post('/internal/journal/draft', async (req: Request, res: Response) => {
    if (!JOURNAL_DRAFT_API_KEY) {
      logger.error(
        'JOURNAL_DRAFT_API_KEY not configured — refusing journal draft request',
      );
      res.status(503).json({ error: 'journal draft endpoint not configured' });
      return;
    }

    const authHeader = req.header('authorization') || '';
    if (authHeader !== `Bearer ${JOURNAL_DRAFT_API_KEY}`) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    const { dailyNoteRaw, userText, nowIso } = req.body ?? {};
    if (
      !isNonEmptyString(userText) ||
      typeof dailyNoteRaw !== 'string' ||
      !isNonEmptyString(nowIso)
    ) {
      res
        .status(400)
        .json({ error: 'dailyNoteRaw, userText, and nowIso are required' });
      return;
    }

    if (activeRequests >= JOURNAL_DRAFT_MAX_CONCURRENT) {
      logger.warn(
        { activeRequests, max: JOURNAL_DRAFT_MAX_CONCURRENT },
        'journal draft request rejected — too many in flight',
      );
      res
        .status(429)
        .json({ error: 'too many journal draft requests in flight' });
      return;
    }

    activeRequests++;
    try {
      const result = await draftJournalEntry({
        dailyNoteRaw,
        userText,
        nowIso,
      });
      res.json(result);
    } catch (err) {
      logger.error({ err }, 'journal draft failed');
      res.status(502).json({ error: 'failed to draft journal entry' });
    } finally {
      activeRequests--;
    }
  });

  return app;
}

export function startJournalDraftServer(): void {
  const app = createJournalDraftApp();
  app.listen(JOURNAL_DRAFT_PORT, JOURNAL_DRAFT_BIND_HOST, () => {
    logger.info(
      { port: JOURNAL_DRAFT_PORT, host: JOURNAL_DRAFT_BIND_HOST },
      'Journal draft server listening',
    );
  });
}
