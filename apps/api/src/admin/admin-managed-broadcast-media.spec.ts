import { BadRequestException } from '@nestjs/common';
import {
  decodeBroadcastImageBase64,
  hasRetriableManagedBroadcastAttachment,
  isAttachmentNotReadyError,
  isManagedBroadcastSlotConflictError,
  resolveBroadcastImageFileName,
  resolveManagedBroadcastSendRetryDelayMs,
} from './admin-managed-broadcast-media';

describe('admin managed broadcast media helpers', () => {
  it('detects retriable attachment send options', () => {
    expect(hasRetriableManagedBroadcastAttachment(undefined)).toBe(false);
    expect(hasRetriableManagedBroadcastAttachment({ attachments: [] })).toBe(false);
    expect(hasRetriableManagedBroadcastAttachment({ imagePayload: { token: 'image-1' } })).toBe(
      true,
    );
    expect(
      hasRetriableManagedBroadcastAttachment({ attachments: [{ type: 'image', payload: {} }] }),
    ).toBe(true);
  });

  it('resolves retry delay for attachment-not-ready errors before other retry classes', () => {
    const error = {
      response: {
        status: 400,
        data: { code: 'attachment.not.ready' },
      },
    };

    expect(resolveManagedBroadcastSendRetryDelayMs(error, 1, { imagePayload: {} })).toBe(1500);
    expect(isAttachmentNotReadyError(error)).toBe(true);
  });

  it('recognizes managed broadcast slot conflicts', () => {
    expect(
      isManagedBroadcastSlotConflictError({
        code: 'P2002',
        meta: { target: ['managed_broadcast_occurrences_slot_key'] },
      }),
    ).toBe(true);
    expect(
      isManagedBroadcastSlotConflictError({ code: 'P2002', meta: { target: ['other'] } }),
    ).toBe(false);
  });

  it('decodes broadcast images and rejects empty payloads', () => {
    expect(
      decodeBroadcastImageBase64(`data:image/png;base64,${Buffer.from('ok').toString('base64')}`),
    ).toEqual(Buffer.from('ok'));
    expect(() => decodeBroadcastImageBase64('  ')).toThrow(BadRequestException);
  });

  it('resolves fallback broadcast image file names by mime type', () => {
    expect(resolveBroadcastImageFileName('custom.png', 'image/jpeg')).toBe('custom.png');
    expect(resolveBroadcastImageFileName('', 'image/png')).toBe('broadcast-image.png');
    expect(resolveBroadcastImageFileName('', 'image/webp')).toBe('broadcast-image.webp');
    expect(resolveBroadcastImageFileName('', 'image/gif')).toBe('broadcast-image.gif');
    expect(resolveBroadcastImageFileName('', 'image/jpeg')).toBe('broadcast-image.jpg');
  });
});
