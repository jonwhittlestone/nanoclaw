/**
 * Fork module: hourly prune of session inbox attachments (see prune.ts).
 * Self-registers on host start/shutdown; importing it does no work.
 */
import path from 'node:path';

import { DATA_DIR } from '../../config.js';
import { onHostShutdown, onHostStart } from '../../host-lifecycle.js';
import { log } from '../../log.js';
import { pruneInboxes } from './prune.js';

const INTERVAL_MS = 60 * 60 * 1000;
let timer: NodeJS.Timeout | undefined;

function runOnce(): void {
  try {
    const removed = pruneInboxes(path.join(DATA_DIR, 'v2-sessions'));
    if (removed > 0) log.info('Pruned old inbox attachments', { removed });
  } catch (err) {
    log.warn('Inbox prune failed', { err });
  }
}

onHostStart(() => {
  runOnce();
  timer = setInterval(runOnce, INTERVAL_MS);
  timer.unref();
});

onHostShutdown(() => {
  if (timer) clearInterval(timer);
  timer = undefined;
});
