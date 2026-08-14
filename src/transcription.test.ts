import { describe, it, expect, vi, beforeEach } from 'vitest';
import { transcribeAudio } from './transcription.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue(Buffer.from('fake-audio')),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('node:child_process', () => ({
  execFile: vi.fn((_cmd, _args, cb) => cb(null, '', '')),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('transcribeAudio', () => {
  it('returns transcript from whisper.cpp response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: ' check my calendar for tomorrow' }),
    });

    const result = await transcribeAudio('/tmp/voice-abc123.wav');
    expect(result).toBe('check my calendar for tomorrow');
    expect(mockFetch).toHaveBeenCalledOnce();

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('/inference');
    expect(opts.method).toBe('POST');
  });

  it('returns empty string and logs on server error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    });
    const result = await transcribeAudio('/tmp/voice-abc123.wav');
    expect(result).toBe('');
  });

  it('returns empty string when whisper server is unreachable', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const result = await transcribeAudio('/tmp/voice-abc123.wav');
    expect(result).toBe('');
  });
});
