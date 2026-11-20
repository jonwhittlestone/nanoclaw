/**
 * Fork module: keeps the journal-draft (randoread) session warm. See warm.ts
 * and design doc 06.12. Self-registers on host start/shutdown; ticks every
 * minute. Off unless the journal-draft agent group and its randoread
 * messaging group exist (scripts/fork-wire.sh creates them).
 */
import fs from 'node:fs';

import Database from 'better-sqlite3';

import { TIMEZONE } from '../../config.js';
import { isContainerRunning, killContainer, wakeContainer } from '../../container-runner.js';
import { getAgentGroupByFolder } from '../../db/agent-groups.js';
import { getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { findSessionForAgent, getSession, updateSession } from '../../db/sessions.js';
import { onHostShutdown, onHostStart } from '../../host-lifecycle.js';
import { log } from '../../log.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { resolveSession } from '../../session-manager.js';
import { warmTick, type WarmDeps, type WarmOutcome } from './warm.js';

const TICK_MS = 60_000;
let timer: NodeJS.Timeout | undefined;
let last: WarmOutcome | undefined;

const deps: WarmDeps = {
  timeZone: TIMEZONE,
  async targets() {
    const group = await getAgentGroupByFolder('journal-draft');
    const mg = await getMessagingGroupByPlatform('journal-draft', 'randoread');
    return group && mg ? { agentGroupId: group.id, messagingGroupId: mg.id } : null;
  },
  findSession: (ag, mg) => findSessionForAgent(ag, mg, null),
  async resolveSession(ag, mg) {
    return (await resolveSession(ag, mg, null, 'shared')).session;
  },
  async closeSession(sessionId) {
    await updateSession(sessionId, { status: 'closed' });
    if (isContainerRunning(sessionId)) killContainer(sessionId, 'journal-warm rotation');
  },
  async stats(session) {
    const s = await getSession(session.id);
    if (!s) return { drafts: 0, busy: false };
    const file = inboundDbPath(s.agent_group_id, s.id);
    if (!fs.existsSync(file)) return { drafts: 0, busy: false };
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      const row = db
        .prepare(
          "SELECT COUNT(*) AS drafts, SUM(CASE WHEN status IN ('pending','processing') THEN 1 ELSE 0 END) AS busy FROM messages_in WHERE kind = 'chat'",
        )
        .get() as { drafts: number; busy: number | null };
      return { drafts: row.drafts, busy: (row.busy ?? 0) > 0 };
    } finally {
      db.close();
    }
  },
  isRunning: isContainerRunning,
  async wake(session) {
    const s = await getSession(session.id);
    return s ? wakeContainer(s) : false;
  },
};

async function tick(): Promise<void> {
  try {
    const outcome = await warmTick(deps);
    if (outcome !== last && outcome !== 'warm') log.info('journal-warm', { outcome });
    last = outcome;
  } catch (err) {
    log.warn('journal-warm tick failed', { err });
  }
}

onHostStart(() => {
  timer = setInterval(() => void tick(), TICK_MS);
  timer.unref();
  void tick();
});

onHostShutdown(() => {
  if (timer) clearInterval(timer);
  timer = undefined;
});
