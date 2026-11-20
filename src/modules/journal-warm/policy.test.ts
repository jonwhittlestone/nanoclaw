/**
 * Fork: when the warm journal-draft session should be rotated (closed so the
 * next draft starts fresh) and when it should be kept warm. Design doc 06.12.
 */
import { describe, expect, it } from 'vitest';

import { localDay, MAX_DRAFTS, shouldRotate, withinWarmHours } from './policy.js';

const TZ = 'Europe/London';
const at = (iso: string) => new Date(iso);

describe('localDay', () => {
  it('uses the configured timezone, not UTC', () => {
    // 23:30 UTC on 1 Jul is 00:30 on 2 Jul in London (BST)
    expect(localDay(at('2026-07-01T23:30:00Z'), TZ)).toBe('2026-07-02');
  });
});

describe('shouldRotate', () => {
  const base = { createdAt: '2026-11-08T08:00:00Z', drafts: 3, busy: false };

  it('keeps a same-day session under the draft cap', () => {
    expect(shouldRotate(base, at('2026-11-08T20:00:00Z'), TZ)).toBe(false);
  });

  it('rotates once the local day has changed', () => {
    expect(shouldRotate(base, at('2026-11-09T00:05:00Z'), TZ)).toBe(true);
  });

  it('rotates at the draft cap', () => {
    expect(shouldRotate({ ...base, drafts: MAX_DRAFTS }, at('2026-11-08T09:00:00Z'), TZ)).toBe(true);
  });

  it('never rotates while a draft is pending or processing', () => {
    expect(shouldRotate({ ...base, drafts: MAX_DRAFTS, busy: true }, at('2026-11-09T09:00:00Z'), TZ)).toBe(false);
  });

  it('treats SQLite-style timestamps without a zone as UTC', () => {
    expect(shouldRotate({ ...base, createdAt: '2026-11-08 08:00:00' }, at('2026-11-08T20:00:00Z'), TZ)).toBe(false);
  });
});

describe('withinWarmHours', () => {
  const hours = { start: '06:00', end: '23:30' };
  it('is warm during the day', () => {
    expect(withinWarmHours(at('2026-11-08T12:00:00Z'), TZ, hours)).toBe(true);
  });
  it('is cold overnight', () => {
    expect(withinWarmHours(at('2026-11-08T03:00:00Z'), TZ, hours)).toBe(false);
    expect(withinWarmHours(at('2026-11-08T23:45:00Z'), TZ, hours)).toBe(false);
  });
  it('includes the start minute and excludes the end minute', () => {
    expect(withinWarmHours(at('2026-11-08T06:00:00Z'), TZ, hours)).toBe(true);
    expect(withinWarmHours(at('2026-11-08T23:30:00Z'), TZ, hours)).toBe(false);
  });
  it('respects local time in summer (BST)', () => {
    // 05:30 UTC = 06:30 BST → warm
    expect(withinWarmHours(at('2026-07-01T05:30:00Z'), TZ, hours)).toBe(true);
  });
});
