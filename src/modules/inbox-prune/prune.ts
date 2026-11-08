/**
 * Fork: delete session inbox attachments older than the retention window.
 *
 * Layout: <sessionsRoot>/<agentGroupId>/<sessionId>/inbox/<messageId>/<file>.
 * Only regular files under inbox/ are removed; symlinks are never followed
 * (lstat throughout), and emptied message folders are removed.
 */
import fs from 'node:fs';
import path from 'node:path';

export const INBOX_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;

function realDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.isSymbolicLink())
      .map((e) => path.join(dir, e.name));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

export function pruneInboxes(sessionsRoot: string, opts: { now?: number; maxAgeMs?: number } = {}): number {
  const cutoff = (opts.now ?? Date.now()) - (opts.maxAgeMs ?? INBOX_MAX_AGE_MS);
  let removed = 0;
  for (const group of realDirs(sessionsRoot)) {
    for (const session of realDirs(group)) {
      const inbox = path.join(session, 'inbox');
      for (const msgDir of realDirs(inbox)) {
        for (const entry of fs.readdirSync(msgDir, { withFileTypes: true })) {
          if (!entry.isFile()) continue;
          const p = path.join(msgDir, entry.name);
          if (fs.lstatSync(p).mtimeMs < cutoff) {
            fs.unlinkSync(p);
            removed++;
          }
        }
        if (fs.readdirSync(msgDir).length === 0) fs.rmdirSync(msgDir);
      }
    }
  }
  return removed;
}
