/**
 * Fork (jonwhittlestone/nanoclaw), ported from v1 src/journal-draft-supervisor.ts.
 *
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
 * if the server isn't listening — or claims to be but doesn't answer its own
 * health route on the bound address — close it and bind a fresh one. The
 * HTTP probe matters: on 2026-11-08 the socket vanished with no 'error'
 * event, so only an outside request (the same one randoread makes) notices.
 * Bind errors are logged, never thrown, so the host (and every channel) is
 * never taken down by this.
 */
import http from 'node:http';
import net from 'node:net';
import { log } from '../../log.js';

export type RequestHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

const DEFAULT_INTERVAL_MS = 30_000;
const PROBE_TIMEOUT_MS = 2_000;
export const HEALTH_PATH = '/internal/journal/health';

export interface SuperviseOptions {
  handler: RequestHandler;
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

async function httpProbe(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    // Deliberately catch-all: refused, reset, timeout, no route — every
    // failure means "not reachable", and a probe must never throw.
    return false;
  }
}

function healthUrl(host: string, server: http.Server): string {
  const { port } = server.address() as net.AddressInfo;
  const h = net.isIPv6(host) ? `[${host}]` : host;
  return `http://${h}:${port}${HEALTH_PATH}`;
}

function closeQuietly(server: http.Server | undefined): Promise<void> {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

export function superviseServer(opts: SuperviseOptions): Supervisor {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const probe = opts.probe ?? httpProbe;
  let server: http.Server | undefined;
  let state: 'up' | 'down' | undefined;
  let running = false;
  let stopped = false;

  function markUp(): void {
    if (state === 'up') return;
    const recovered = state === 'down';
    state = 'up';
    log.info(recovered ? 'Journal draft server re-bound' : 'Journal draft server listening', {
      host: opts.host,
      port: opts.port,
    });
  }

  function markDown(err: unknown): void {
    if (state === 'down') return;
    state = 'down';
    log.warn('Journal draft server not listening — will retry', {
      err,
      host: opts.host,
      port: opts.port,
      retryMs: intervalMs,
    });
  }

  function bind(): Promise<void> {
    const s = http.createServer(opts.handler);
    server = s;
    return new Promise((resolve) => {
      // Permanent listener: without one, any server error is rethrown as an
      // uncaughtException, which exits the whole host process.
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
      if (server?.listening) {
        if (await probe(healthUrl(opts.host, server))) return;
        markDown(new Error('health probe of bound address failed'));
      }
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
