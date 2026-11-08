/**
 * Fork: one tick of the journal-draft warmer (design doc 06.12). All host
 * effects are injected so the decision logic is tested in isolation.
 */
import { describe, expect, it, vi } from 'vitest';

import { warmTick, type WarmDeps } from './warm.js';

const DAY = new Date('2026-11-08T12:00:00Z'); // 12:00 London, warm hours
const NIGHT = new Date('2026-11-08T03:00:00Z');
const session = { id: 'sess-1', created_at: '2026-11-08T08:00:00Z' };

function deps(over: Partial<WarmDeps> = {}): WarmDeps {
  return {
    timeZone: 'Europe/London',
    targets: vi.fn(async () => ({ agentGroupId: 'ag-j', messagingGroupId: 'mg-r' })),
    findSession: vi.fn(async () => session),
    resolveSession: vi.fn(async () => session),
    closeSession: vi.fn(async () => {}),
    stats: vi.fn(async () => ({ drafts: 2, busy: false })),
    isRunning: vi.fn(() => false),
    wake: vi.fn(async () => true),
    ...over,
  } as WarmDeps;
}

describe('warmTick', () => {
  it('does nothing when the journal group or its messaging group is missing', async () => {
    const d = deps({ targets: vi.fn(async () => null) });
    expect(await warmTick(d, DAY)).toBe('no-targets');
    expect(d.wake).not.toHaveBeenCalled();
  });

  it('pre-warms a stopped session during warm hours', async () => {
    const d = deps();
    expect(await warmTick(d, DAY)).toBe('woke');
    expect(d.wake).toHaveBeenCalledWith(session);
  });

  it('creates the shared session if none exists yet, then wakes it', async () => {
    const d = deps({ findSession: vi.fn(async () => undefined) });
    expect(await warmTick(d, DAY)).toBe('woke');
    expect(d.resolveSession).toHaveBeenCalledWith('ag-j', 'mg-r');
  });

  it('leaves an already-running container alone', async () => {
    const d = deps({ isRunning: vi.fn(() => true) });
    expect(await warmTick(d, DAY)).toBe('warm');
    expect(d.wake).not.toHaveBeenCalled();
  });

  it('re-warms after the idle ceiling killed the container', async () => {
    const running = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    const d = deps({ isRunning: running });
    expect(await warmTick(d, DAY)).toBe('warm');
    expect(await warmTick(d, DAY)).toBe('woke');
  });

  it('does not wake anything outside warm hours', async () => {
    const d = deps();
    expect(await warmTick(d, NIGHT)).toBe('cold-hours');
    expect(d.wake).not.toHaveBeenCalled();
    expect(d.resolveSession).not.toHaveBeenCalled();
  });

  it('rotates a stale session (closes it, creates a fresh one, wakes that)', async () => {
    const fresh = { id: 'sess-2', created_at: '2026-11-09T06:00:00Z' };
    const d = deps({ resolveSession: vi.fn(async () => fresh) });
    const nextDay = new Date('2026-11-09T09:00:00Z');
    expect(await warmTick(d, nextDay)).toBe('rotated+woke');
    expect(d.closeSession).toHaveBeenCalledWith('sess-1');
    expect(d.wake).toHaveBeenCalledWith(fresh);
  });

  it('rotates at night too, but does not wake the fresh session', async () => {
    const d = deps({ stats: vi.fn(async () => ({ drafts: 40, busy: false })) });
    expect(await warmTick(d, NIGHT)).toBe('rotated');
    expect(d.closeSession).toHaveBeenCalledWith('sess-1');
    expect(d.wake).not.toHaveBeenCalled();
  });

  it('never rotates mid-draft', async () => {
    const d = deps({ stats: vi.fn(async () => ({ drafts: 40, busy: true })), isRunning: vi.fn(() => true) });
    expect(await warmTick(d, DAY)).toBe('warm');
    expect(d.closeSession).not.toHaveBeenCalled();
  });
});
