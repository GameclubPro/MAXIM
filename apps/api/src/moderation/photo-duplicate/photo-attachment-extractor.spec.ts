import type { MaxUpdate } from '@maxim/contracts';
import {
  extractLogicalPhotoAlbum,
  extractLogicalPhotoAlbumResult,
} from './photo-attachment-extractor';

function buildUpdate(message: Record<string, unknown>, type = 'message_created'): MaxUpdate {
  return {
    updateId: 'update-1',
    type,
    message: {
      messageId: 'message-1',
      chatId: 'chat-1',
      senderId: 'user-1',
      text: '',
      createdAt: '2026-08-05T10:00:00.000Z',
    },
    raw: {
      update_type: type,
      message: {
        message_id: 'message-1',
        chat_id: 'chat-1',
        sender_id: 'user-1',
        ...message,
      },
    },
  };
}

describe('extractLogicalPhotoAlbum', () => {
  it('extracts direct and forwarded photos into one logical album', () => {
    const result = extractLogicalPhotoAlbumResult(
      buildUpdate({
        body: {
          attachments: [
            {
              type: 'image',
              payload: {
                photo_id: 'direct-photo',
                token: 'must-not-leave-the-extractor',
                url: 'https://i.oneme.ru/direct',
              },
            },
          ],
        },
        link: {
          type: 'forward',
          message: {
            body: {
              attachments: [
                {
                  type: 'image',
                  payload: {
                    photo_id: 'forward-photo',
                    token: 'another-secret-token',
                    url: 'https://i.oneme.ru/forward',
                  },
                },
              ],
            },
          },
        },
      }),
    );

    expect(result).toEqual({
      kind: 'complete',
      album: {
        chatId: 'chat-1',
        messageId: 'message-1',
        senderId: 'user-1',
        createdAtMs: Date.parse('2026-08-05T10:00:00.000Z'),
        images: [
          {
            source: 'direct',
            photoId: 'direct-photo',
            downloadUrl: 'https://i.oneme.ru/direct',
          },
          {
            source: 'forward',
            photoId: 'forward-photo',
            downloadUrl: 'https://i.oneme.ru/forward',
          },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain('secret-token');
  });

  it('excludes reply previews while retaining direct photos', () => {
    const album = extractLogicalPhotoAlbum(
      buildUpdate({
        body: {
          attachments: [{ type: 'image', payload: { photo_id: 'current-photo' } }],
        },
        link: {
          type: 'reply',
          message: {
            attachments: [{ type: 'image', payload: { photo_id: 'quoted-photo' } }],
          },
        },
      }),
    );

    expect(album?.images).toEqual([
      { source: 'direct', photoId: 'current-photo', downloadUrl: null },
    ]);
  });

  it('preserves repeated attachments as album multiset members', () => {
    const album = extractLogicalPhotoAlbum(
      buildUpdate({
        body: {
          attachments: [
            { type: 'image', payload: { photo_id: 'same-photo' } },
            { type: 'image', payload: { photo_id: 'same-photo' } },
          ],
        },
      }),
    );

    expect(album?.images).toHaveLength(2);
  });

  it('treats raster images sent as files as photos and excludes stickers', () => {
    const album = extractLogicalPhotoAlbum(
      buildUpdate({
        body: {
          attachments: [
            {
              type: 'file',
              payload: {
                mime_type: 'image/jpeg',
                filename: 'original.jpg',
                url: 'https://i.oneme.ru/file-image',
              },
            },
            {
              type: 'sticker',
              payload: {
                mime_type: 'image/webp',
                url: 'https://i.oneme.ru/sticker.webp',
              },
            },
          ],
        },
      }),
    );

    expect(album?.images).toEqual([
      {
        source: 'direct',
        photoId: null,
        downloadUrl: 'https://i.oneme.ru/file-image',
      },
    ]);
  });

  it('fails open for a partially identifiable album', () => {
    const result = extractLogicalPhotoAlbumResult(
      buildUpdate({
        body: {
          attachments: [
            { type: 'image', payload: { photo_id: 'known-photo' } },
            { type: 'image', payload: { token: 'not-an-identity' } },
          ],
        },
      }),
    );

    expect(result).toEqual({ kind: 'incomplete', reason: 'missing_identity' });
  });

  it('does not extract edited messages', () => {
    expect(
      extractLogicalPhotoAlbum(
        buildUpdate(
          {
            body: {
              attachments: [{ type: 'image', payload: { photo_id: 'photo-1' } }],
            },
          },
          'message_edited',
        ),
      ),
    ).toBeNull();
  });
});
