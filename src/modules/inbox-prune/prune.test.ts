/**
 * Fork: inbound attachments are a staging area (the agent copies anything
 * worth keeping into the vault), so session inbox files older than the
 * retention window are deleted, as v1's media/ prune did.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pruneInboxes, INBOX_MAX_AGE_MS } from './prune.js';

const DAY = 24 * 60 * 60 * 1000;
let root: string;

function file(rel: string, ageMs: number, now: number): string {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, 'x');
  const t = new Date(now - ageMs);
  fs.utimesSync(p, t, t);
  return p;
}

describe('pruneInboxes', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-prune-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('defaults to a two-day retention window', () => {
    expect(INBOX_MAX_AGE_MS).toBe(2 * DAY);
  });

  it('deletes inbox files older than the window and keeps newer ones', () => {
    const now = Date.now();
    const old = file('ag-1/sess-1/inbox/msg-a/photo.jpg', 3 * DAY, now);
    const fresh = file('ag-1/sess-1/inbox/msg-b/voice.ogg', 1 * DAY, now);

    const removed = pruneInboxes(root, { now });

    expect(removed).toBe(1);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('removes a message folder once it is empty', () => {
    const now = Date.now();
    file('ag-1/sess-1/inbox/msg-a/photo.jpg', 3 * DAY, now);
    pruneInboxes(root, { now });
    expect(fs.existsSync(path.join(root, 'ag-1/sess-1/inbox/msg-a'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'ag-1/sess-1/inbox'))).toBe(true);
  });

  it('only touches inbox/, never other session state', () => {
    const now = Date.now();
    const db = file('ag-1/sess-1/inbound.db', 30 * DAY, now);
    const outbox = file('ag-1/sess-1/outbox/m/f.pdf', 30 * DAY, now);
    const shared = file('ag-1/.claude-shared/settings.json', 30 * DAY, now);

    expect(pruneInboxes(root, { now })).toBe(0);
    for (const p of [db, outbox, shared]) expect(fs.existsSync(p)).toBe(true);
  });

  it('does not follow symlinks out of the inbox', () => {
    const now = Date.now();
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    const victim = file('outside/keep.txt', 30 * DAY, now);
    fs.mkdirSync(path.join(root, 'ag-1/sess-1/inbox'), { recursive: true });
    fs.symlinkSync(outside, path.join(root, 'ag-1/sess-1/inbox/msg-evil'));

    pruneInboxes(root, { now });

    expect(fs.existsSync(victim)).toBe(true);
  });

  it('copes with a missing sessions root', () => {
    expect(pruneInboxes(path.join(root, 'nope'))).toBe(0);
  });
});
