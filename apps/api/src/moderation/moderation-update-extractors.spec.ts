import type { MaxUpdate } from '@maxim/contracts';
import { detectMediaFlags } from './moderation-update-extractors';

const EMPTY_FLAGS = {
  hasPhotoAttachment: false,
  hasStickerAttachment: false,
  hasVideoAttachment: false,
  hasFileAttachment: false,
  hasVoiceAttachment: false,
  hasMediaBatch: false,
};

function createUpdate(raw: Record<string, unknown>): MaxUpdate {
  return {
    updateId: 'upd-media-flags-1',
    type: 'message_created',
    message: {
      messageId: 'msg-media-flags-1',
      chatId: 'chat-1',
      senderId: 'user-1',
      senderName: 'User 1',
      text: '',
      createdAt: new Date('2026-06-01T00:00:00.000Z').toISOString(),
    },
    raw,
  };
}

describe('moderation update media flag extraction', () => {
  it.each([
    [
      'image attachment',
      {
        message: {
          attachments: [{ type: 'image', payload: { url: 'https://cdn.example/photo.jpg' } }],
        },
      },
      { hasPhotoAttachment: true },
    ],
    [
      'payload photo type in nested MAX envelope',
      {
        message_created: {
          message: {
            body: {
              media_group_id: 'group-1',
              attachments: [{ payload: { type: 'photo', url: 'https://cdn.example/photo-1' } }],
            },
          },
        },
      },
      { hasPhotoAttachment: true, hasMediaBatch: true },
    ],
    [
      'payload photo media type',
      {
        message: {
          attachments: [{ type: 'media', payload: { media_type: 'photo' } }],
        },
      },
      { hasPhotoAttachment: true },
    ],
    [
      'image file attachment',
      {
        message: {
          attachments: [
            {
              type: 'file',
              payload: { mime_type: 'image/jpeg', file_name: 'photo-as-file.jpg' },
            },
          ],
        },
      },
      { hasPhotoAttachment: true },
    ],
    [
      'video attachment',
      {
        message: {
          attachments: [{ type: 'video', payload: { url: 'https://cdn.example/video.mp4' } }],
        },
      },
      { hasVideoAttachment: true },
    ],
    [
      'regular file attachment',
      {
        message: {
          attachments: [{ type: 'file', payload: { file_name: 'document.pdf' } }],
        },
      },
      { hasFileAttachment: true },
    ],
    [
      'voice attachment',
      {
        message: {
          attachments: [{ type: 'voice', payload: { url: 'https://cdn.example/voice.ogg' } }],
        },
      },
      { hasVoiceAttachment: true },
    ],
    [
      'sticker attachment with image payload',
      {
        message: {
          attachments: [
            {
              type: 'sticker',
              payload: { mime_type: 'image/webp', url: 'https://cdn.example/sticker.webp' },
            },
          ],
        },
      },
      { hasStickerAttachment: true },
    ],
    [
      'media group marker without attachment shape',
      {
        message: {
          body: {
            media_group_id: 'group-1',
          },
        },
      },
      { hasMediaBatch: true },
    ],
    [
      'photos key',
      {
        message: {
          body: {
            photos: ['photo-token-1'],
          },
        },
      },
      { hasPhotoAttachment: true },
    ],
  ])('detects %s', (_label, raw, expected) => {
    expect(detectMediaFlags(createUpdate(raw))).toEqual({
      ...EMPTY_FLAGS,
      ...expected,
    });
  });

  it('ignores media attached only to replied or quoted messages', () => {
    expect(
      detectMediaFlags(
        createUpdate({
          message: {
            body: {
              text: 'reply text',
              reply_message: {
                attachments: [{ type: 'image', payload: { url: 'https://cdn.example/photo.jpg' } }],
              },
            },
          },
        }),
      ),
    ).toEqual(EMPTY_FLAGS);

    expect(
      detectMediaFlags(
        createUpdate({
          message: {
            body: {
              text: 'quoted preview',
              link: {
                type: 'quoted',
                media_group_id: 'quoted-group-1',
                attachments: [
                  { type: 'video', payload: { url: 'https://cdn.example/quoted-video.mp4' } },
                ],
              },
            },
          },
        }),
      ),
    ).toEqual(EMPTY_FLAGS);
  });
});
