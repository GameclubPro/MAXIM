import { BadRequestException } from '@nestjs/common';
import {
  decodeBroadcastImageBase64,
  hasManagedBroadcastVideoAttachment,
  hasRetriableManagedBroadcastAttachment,
  isAttachmentNotReadyError,
  isManagedBroadcastSlotConflictError,
  resolveBroadcastImageFileName,
  resolveManagedBroadcastAttachmentRetryCount,
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

  it('waits longer for video processing while preserving the image retry budget', () => {
    const error = {
      response: {
        status: 400,
        data: { code: 'attachment.not.ready' },
      },
    };
    const videoOptions = { attachments: [{ type: 'video' as const, payload: {} }] };

    expect(hasManagedBroadcastVideoAttachment(videoOptions)).toBe(true);
    expect(resolveManagedBroadcastAttachmentRetryCount(videoOptions)).toBe(5);
    expect(resolveManagedBroadcastSendRetryDelayMs(error, 4, videoOptions)).toBe(12_000);
    expect(resolveManagedBroadcastSendRetryDelayMs(error, 5, videoOptions)).toBe(24_000);
    expect(resolveManagedBroadcastSendRetryDelayMs(error, 6, videoOptions)).toBeNull();
    expect(resolveManagedBroadcastSendRetryDelayMs(error, 4, { imagePayload: {} })).toBeNull();
  });

  it('does not retry ambiguous attachment sends', () => {
    const timeout = Object.assign(new Error('timeout of 30000ms exceeded'), {
      code: 'ECONNABORTED',
    });

    expect(
      resolveManagedBroadcastSendRetryDelayMs(timeout, 1, {
        attachments: [{ type: 'video', payload: { token: 'video-1' } }],
      }),
    ).toBeNull();
  });

  it('recognizes managed broadcast slot conflicts', () => {
    expect(
      isManagedBroadcastSlotConflictError({
        code: 'P2002',
        meta: { target: ['managed_broadcast_occurrences_slot_key'] },
      }),
    ).toBe(true);
    expect(
      isManagedBroadcastSlotConflictError({
        code: 'P2002',
        meta: { target: 'managed_broadcast_calendar_reservations_target_slot_key' },
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
