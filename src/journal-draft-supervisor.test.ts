import net from 'node:net';
import express from 'express';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { logger } from './logger.js';
import { superviseServer, Supervisor } from './journal-draft-supervisor.js';

// TEST-NET-1 (RFC 5737) — reserved for documentation, never assigned to a
// real interface, so binding to it reliably fails with EADDRNOTAVAIL. Stands
// in for "the Tailscale IP while tailscale0 doesn't exist".
const UNAVAILABLE_HOST = '192.0.2.1';

function makeApp(): express.Express {
  const app = express();
  app.get('/internal/journal/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  return app;
}

// Grab a free port, then hold it with a plain TCP server so the supervisor's
// first bind fails with EADDRINUSE until we release it.
async function occupyPort(): Promise<{ port: number; release: () => void }> {
  const blocker = net.createServer();
  await new Promise<void>((resolve) =>
    blocker.listen(0, '127.0.0.1', () => resolve()),
  );
  const port = (blocker.address() as net.AddressInfo).port;
  return { port, release: () => blocker.close() };
}

let sup: Supervisor | undefined;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  await sup?.stop();
  sup = undefined;
});

describe('superviseServer — bind failures', () => {
  it('does not throw when the bind address is unavailable', async () => {
    expect(() => {
      sup = superviseServer({
        app: makeApp(),
        host: UNAVAILABLE_HOST,
        port: 0,
        intervalMs: 20,
      });
    }).not.toThrow();

    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalled());
    expect(sup!.listening()).toBe(false);
  });

  it('logs the outage once, not on every retry', async () => {
    sup = superviseServer({
      app: makeApp(),
      host: UNAVAILABLE_HOST,
      port: 0,
      intervalMs: 10,
    });

    // Long enough for several retry ticks to have run.
    await new Promise((r) => setTimeout(r, 100));
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('retries and starts listening once the address becomes available', async () => {
    const { port, release } = await occupyPort();

    sup = superviseServer({
      app: makeApp(),
      host: '127.0.0.1',
      port,
      intervalMs: 20,
    });

    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalled());
    expect(sup.listening()).toBe(false);

    release();

    await vi.waitFor(() => expect(sup!.listening()).toBe(true));
    const res = await fetch(`http://127.0.0.1:${port}/internal/journal/health`);
    expect(res.status).toBe(200);
  });

  it('stop() closes the server and halts retries', async () => {
    sup = superviseServer({
      app: makeApp(),
      host: '127.0.0.1',
      port: 0,
      intervalMs: 20,
    });
    await vi.waitFor(() => expect(sup!.listening()).toBe(true));

    await sup.stop();
    expect(sup.listening()).toBe(false);
  });
});
