/**
 * Fork: local speech-to-text for inbound voice notes via the host's
 * whisper.cpp server (whisper.service), ported from v1. Takes the bytes the
 * WhatsApp adapter already holds in memory.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

vi.mock('node:child_process', () => ({
  execFile: vi.fn((_cmd: string, args: string[], cb: (e: Error | null, o: string, s: string) => void) => {
    // simulate ffmpeg writing the .wav output (last-but-one arg before -y)
    void args;
    cb(null, '', '');
  }),
}));

const env: Record<string, string> = {};
vi.mock('./env.js', () => ({ readEnvFile: vi.fn(() => env) }));
vi.mock('./log.js', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { transcribeAudio, whisperUrl } from './transcription.js';

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(env)) delete env[k];
});

describe('whisperUrl', () => {
  it('defaults to the local whisper.service port', () => {
    expect(whisperUrl()).toBe('http://127.0.0.1:8080');
  });
  it('honours WHISPER_SERVER_URL from .env', () => {
    env.WHISPER_SERVER_URL = 'http://10.0.0.5:9000/';
    expect(whisperUrl()).toBe('http://10.0.0.5:9000');
  });
});

describe('transcribeAudio', () => {
  it('posts the audio to /inference and returns the trimmed transcript', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ text: ' check my calendar for tomorrow ' }) });

    const text = await transcribeAudio(Buffer.from('fake-ogg'), 'voice.ogg');

    expect(text).toBe('check my calendar for tomorrow');
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8080/inference');
    expect(opts.method).toBe('POST');
    expect(opts.body).toBeInstanceOf(FormData);
  });

  it('returns an empty string on a server error', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' });
    expect(await transcribeAudio(Buffer.from('x'), 'voice.ogg')).toBe('');
  });

  it('returns an empty string when the server is unreachable', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await transcribeAudio(Buffer.from('x'), 'voice.ogg')).toBe('');
  });
});
