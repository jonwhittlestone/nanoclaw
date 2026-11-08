/**
 * Fork (jonwhittlestone/nanoclaw): local speech-to-text for inbound voice
 * notes, ported from v1. The audio is converted to 16 kHz mono WAV with the
 * host's ffmpeg and posted to the whisper.cpp server run by whisper.service.
 * Failures return '' so the caller can say transcription was unavailable;
 * nothing here ever throws into the channel adapter.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { readEnvFile } from './env.js';
import { log } from './log.js';

const execFileAsync = promisify(execFile);
const DEFAULT_WHISPER_URL = 'http://127.0.0.1:8080';

export function whisperUrl(): string {
  const url = process.env.WHISPER_SERVER_URL || readEnvFile(['WHISPER_SERVER_URL']).WHISPER_SERVER_URL;
  return (url || DEFAULT_WHISPER_URL).replace(/\/+$/, '');
}

async function toWav(dir: string, input: string): Promise<string> {
  if (path.extname(input).toLowerCase() === '.wav') return input;
  const wav = path.join(dir, 'audio.wav');
  try {
    await execFileAsync('ffmpeg', ['-i', input, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav, '-y']);
    await fs.access(wav);
    return wav;
  } catch (err) {
    log.warn('transcribeAudio: ffmpeg conversion failed, sending original', { err });
    return input;
  }
}

export async function transcribeAudio(audio: Buffer, filename: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nanoclaw-voice-'));
  try {
    const input = path.join(dir, `input${path.extname(filename) || '.ogg'}`);
    await fs.writeFile(input, audio);
    const file = await toWav(dir, input);

    const form = new FormData();
    form.append('file', new Blob([await fs.readFile(file)]), path.basename(file));
    form.append('response_format', 'json');

    let res: Response;
    try {
      res = await fetch(`${whisperUrl()}/inference`, { method: 'POST', body: form });
    } catch (err) {
      log.error('transcribeAudio: whisper server unreachable', { err });
      return '';
    }
    if (!res.ok) {
      log.error('transcribeAudio: whisper server error', { status: res.status, body: await res.text() });
      return '';
    }
    const { text } = (await res.json()) as { text?: string };
    return (text ?? '').trim();
  } catch (err) {
    log.error('transcribeAudio: failed', { err });
    return '';
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
