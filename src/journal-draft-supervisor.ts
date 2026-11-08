import http from 'node:http';
import type express from 'express';

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

export function superviseServer(_opts: SuperviseOptions): Supervisor {
  throw new Error('not implemented');
}
