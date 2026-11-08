/**
 * Fork: inbound WhatsApp media must reach the agent container.
 *
 * Upstream's adapter wrote media to DATA_DIR/attachments/ and passed
 * localPath "attachments/<file>", which the container resolves to
 * /workspace/attachments/<file>, but /workspace is the session dir, so the
 * file never existed there. Passing the bytes inline (`data`, base64) lets
 * the host's session-manager stage them into inbox/<message id>/, the
 * path every other channel uses.
 */
import { describe, expect, it } from 'vitest';

import { toInboundAttachment } from './whatsapp.js';

describe('toInboundAttachment', () => {
  it('carries the bytes inline as base64 with name, type, mime and size', () => {
    const buf = Buffer.from('\x89PNG fake');
    const att = toInboundAttachment('image', 'photo.jpg', 'image/jpeg', buf);
    expect(att).toEqual({
      type: 'image',
      name: 'photo.jpg',
      mimeType: 'image/jpeg',
      size: buf.length,
      data: buf.toString('base64'),
    });
  });

  it('never sets localPath, so the host stages it into the session inbox', () => {
    const att = toInboundAttachment('audio', 'voice.ogg', 'audio/ogg; codecs=opus', Buffer.from('x'));
    expect(att).not.toHaveProperty('localPath');
  });

  it('replaces an unsafe (attacker-controlled) document filename', () => {
    const att = toInboundAttachment('document', '../../etc/passwd', undefined, Buffer.from('x'), 'document-1.bin');
    expect(att.name).toBe('document-1.bin');
  });

  it('drops a missing mime type rather than inventing one', () => {
    const att = toInboundAttachment('document', 'notes.txt', undefined, Buffer.from('x'));
    expect(att).not.toHaveProperty('mimeType');
  });
});
