/**
 * Fork: rotation and warm-hours policy for the shared journal-draft session
 * (design doc 06.12). Pure functions; times are evaluated in the configured
 * IANA timezone so "midnight" and "06:00" mean Jon's local time.
 */

/** Rotate after this many drafts in one session, to keep history small. */
export const MAX_DRAFTS = 40;

export interface SessionStats {
  /** sessions.created_at (ISO, or SQLite "YYYY-MM-DD HH:MM:SS" in UTC). */
  createdAt: string;
  /** Drafts this session has received. */
  drafts: number;
  /** A draft is pending or processing right now. */
  busy: boolean;
}

function parts(date: Date, timeZone: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)) {
    out[p.type] = p.value;
  }
  return out;
}

export function localDay(date: Date, timeZone: string): string {
  const p = parts(date, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

function parseCreatedAt(createdAt: string): Date {
  // SQLite datetime('now') has no zone and is UTC.
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(createdAt) ? createdAt : `${createdAt.replace(' ', 'T')}Z`);
}

export function shouldRotate(stats: SessionStats, now: Date, timeZone: string): boolean {
  if (stats.busy) return false;
  if (stats.drafts >= MAX_DRAFTS) return true;
  return localDay(parseCreatedAt(stats.createdAt), timeZone) !== localDay(now, timeZone);
}

export interface WarmHours {
  /** "HH:MM", inclusive. */
  start: string;
  /** "HH:MM", exclusive. */
  end: string;
}

export const DEFAULT_WARM_HOURS: WarmHours = { start: '06:00', end: '23:30' };

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

export function withinWarmHours(now: Date, timeZone: string, hours: WarmHours = DEFAULT_WARM_HOURS): boolean {
  const p = parts(now, timeZone);
  const t = Number(p.hour) * 60 + Number(p.minute);
  return t >= minutes(hours.start) && t < minutes(hours.end);
}
