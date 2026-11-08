/**
 * Keeps the journal-draft HTTP server bound to JOURNAL_DRAFT_BIND_HOST
 * (doylestone02's Tailscale IP) across Tailscale restarts.
 *
 * Why this exists (main.md §05.06): the bind host is an address on the
 * tailscale0 device, which can be absent at boot (tailscaled not up yet) or
 * destroyed and recreated at runtime (e.g. `tailscale update` restarting
 * tailscaled). A one-shot `app.listen()` either crashed the whole NanoClaw
 * process on EADDRNOTAVAIL (unhandled 'error' → uncaughtException →
 * process.exit) or silently lost its listening socket, leaving the endpoint
 * dead until a manual restart.
 *
 * The supervisor runs one idempotent tick at start and every `intervalMs`:
 * if the server isn't listening, (re)bind it. Bind errors are logged, never
 * thrown, so the WhatsApp message loop is never taken down by this.
 */
import http from 'node:http';
import type express from 'express';

import { logger } from './logger.js';

const DEFAULT_INTERVAL_MS = 30_000;

export interface SuperviseOptions {
  app: express.Express;
  host: string;
  port: number;
  intervalMs?: number;
  probe?: (url: string) => Promise<boolean>;
}

export interface Supervisor {
  listening(): boolean;
  server(): http.Server | undefined;
  stop(): Promise<void>;
}

function closeQuietly(server: http.Server | undefined): Promise<void> {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

export function superviseServer(opts: SuperviseOptions): Supervisor {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  let server: http.Server | undefined;
  let state: 'up' | 'down' | undefined;
  let running = false;
  let stopped = false;

  function markUp(): void {
    if (state === 'up') return;
    state = 'up';
    logger.info(
      { host: opts.host, port: opts.port },
      'Journal draft server listening',
    );
  }

  function markDown(err: unknown): void {
    if (state === 'down') return;
    state = 'down';
    logger.warn(
      { err, host: opts.host, port: opts.port, retryMs: intervalMs },
      'Journal draft server not listening — will retry',
    );
  }

  function bind(): Promise<void> {
    const s = http.createServer(opts.app);
    server = s;
    return new Promise((resolve) => {
      // Permanent listener: without one, any server error is rethrown as an
      // uncaughtException, which exits the whole process (src/logger.ts).
      s.on('error', (err) => {
        markDown(err);
        resolve();
      });
      s.listen(opts.port, opts.host, () => {
        markUp();
        resolve();
      });
    });
  }

  async function tick(): Promise<void> {
    if (running || stopped) return;
    running = true;
    try {
      if (server?.listening) return;
      await closeQuietly(server);
      if (!stopped) await bind();
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => void tick(), intervalMs);
  // Don't let the retry loop alone keep the process (or a test run) alive.
  timer.unref();
  void tick();

  return {
    listening: () => server?.listening ?? false,
    server: () => server,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await closeQuietly(server);
    },
  };
}
