import { readFile, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { extname } from 'node:path';
import { WHISPER_SERVER_URL } from './config.js';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

export async function transcribeAudio(filePath: string): Promise<string> {
  const wavPath = await ensureWav(filePath);
  try {
    return await postToWhisper(wavPath);
  } finally {
    if (wavPath !== filePath) await unlink(wavPath).catch(() => {});
  }
}

async function ensureWav(filePath: string): Promise<string> {
  if (extname(filePath).toLowerCase() === '.wav') return filePath;
  const wavPath = filePath.replace(/\.[^.]+$/, '.wav');
  try {
    await execFileAsync('ffmpeg', [
      '-i', filePath,
      '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
      wavPath, '-y',
    ]);
    return wavPath;
  } catch (err) {
    logger.warn(`transcribeAudio: ffmpeg conversion failed, sending original — ${err}`);
    return filePath;
  }
}

async function postToWhisper(filePath: string): Promise<string> {
  const buffer = await readFile(filePath);
  const form = new FormData();
  form.append('file', new Blob([buffer]), filePath.split('/').pop()!);
  form.append('response_format', 'json');

  let response: Response;
  try {
    response = await fetch(`${WHISPER_SERVER_URL}/inference`, {
      method: 'POST',
      body: form,
    });
  } catch (err) {
    logger.error(`transcribeAudio: whisper server unreachable — ${err}`);
    return '';
  }

  if (!response.ok) {
    logger.error(`transcribeAudio: server error ${response.status}: ${await response.text()}`);
    return '';
  }

  const { text } = (await response.json()) as { text: string };
  return text.trim();
}
