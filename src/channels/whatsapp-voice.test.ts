/** Fork: how a transcribed voice note is presented to the agent (v1 format). */
import { describe, expect, it } from 'vitest';

import { voiceNoteContent } from './whatsapp.js';

describe('voiceNoteContent', () => {
  it('presents a transcript as [Voice] text', () => {
    expect(voiceNoteContent('', 'add milk to the list')).toBe('[Voice] add milk to the list');
  });

  it('says so when transcription is unavailable', () => {
    expect(voiceNoteContent('', '')).toBe('[Voice message — transcription unavailable]');
  });

  it('keeps any existing text (e.g. a media failure note) ahead of the transcript', () => {
    expect(voiceNoteContent('[document failed]', 'hello')).toBe('[document failed]\n[Voice] hello');
  });
});
