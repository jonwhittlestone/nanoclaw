/**
 * Fork: one tick of the journal-draft warmer (design doc 06.12).
 *
 * The journal-draft wiring is session_mode "shared": every draft is a turn in
 * one session, and v2 routes each turn's reply to that turn's thread. This
 * tick keeps that session's container started during warm hours (so a draft
 * skips container boot and Claude Code init), re-warms it after the host's
 * 30-min idle ceiling kills it, and rotates the session at the local day
 * change or after MAX_DRAFTS so drafts don't share a growing history.
 */
import { shouldRotate, withinWarmHours, type WarmHours } from './policy.js';

export interface WarmSession {
  id: string;
  created_at: string;
}

export interface WarmDeps {
  timeZone: string;
  warmHours?: WarmHours;
  targets(): Promise<{ agentGroupId: string; messagingGroupId: string } | null>;
  findSession(agentGroupId: string, messagingGroupId: string): Promise<WarmSession | undefined>;
  resolveSession(agentGroupId: string, messagingGroupId: string): Promise<WarmSession>;
  closeSession(sessionId: string): Promise<void>;
  stats(session: WarmSession): Promise<{ drafts: number; busy: boolean }>;
  isRunning(sessionId: string): boolean;
  wake(session: WarmSession): Promise<boolean>;
}

export type WarmOutcome = 'no-targets' | 'cold-hours' | 'warm' | 'woke' | 'rotated' | 'rotated+woke' | 'wake-failed';

export async function warmTick(deps: WarmDeps, now = new Date()): Promise<WarmOutcome> {
  const targets = await deps.targets();
  if (!targets) return 'no-targets';
  const { agentGroupId, messagingGroupId } = targets;

  let session = await deps.findSession(agentGroupId, messagingGroupId);
  let rotated = false;
  if (session) {
    const { drafts, busy } = await deps.stats(session);
    if (shouldRotate({ createdAt: session.created_at, drafts, busy }, now, deps.timeZone)) {
      await deps.closeSession(session.id);
      session = undefined;
      rotated = true;
    }
  }

  if (!withinWarmHours(now, deps.timeZone, deps.warmHours)) return rotated ? 'rotated' : 'cold-hours';

  session ??= await deps.resolveSession(agentGroupId, messagingGroupId);
  if (deps.isRunning(session.id)) return rotated ? 'rotated' : 'warm';
  const ok = await deps.wake(session);
  if (!ok) return 'wake-failed';
  return rotated ? 'rotated+woke' : 'woke';
}
