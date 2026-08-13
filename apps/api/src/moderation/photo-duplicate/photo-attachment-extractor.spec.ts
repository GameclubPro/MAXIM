import type { MaxUpdate } from '@maxim/contracts';
import {
  extractLogicalPhotoAlbum,
  extractLogicalPhotoAlbumResult,
  extractVisiblePhotoMessageContent,
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
        caption: '',
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

  it('extracts one canonical caption and photo order across legacy and nested forwards', () => {
    const aliasAttachments = [{ type: 'image', payload: { photo_id: 'legacy-photo' } }];
    const result = extractLogicalPhotoAlbumResult(
      buildUpdate({
        body: {
          text: 'Current\n caption',
          attachments: [{ type: 'image', payload: { photo_id: 'direct-photo' } }],
          forwarded_message: {
            body: {
              text: 'Legacy caption',
              attachments: aliasAttachments,
              forwardedMessage: {
                content: {
                  caption: 'Nested caption',
                  attachments: [{ type: 'image', payload: { photo_id: 'nested-photo' } }],
                },
              },
            },
            attachments: aliasAttachments,
          },
        },
        link: {
          type: 'forward',
          message: {
            text: 'Modern caption',
            attachments: [{ type: 'image', payload: { photo_id: 'modern-photo' } }],
          },
        },
      }),
    );

    expect(result).toMatchObject({
      kind: 'complete',
      album: {
        caption: 'Current caption Modern caption Legacy caption Nested caption',
        images: [
          { source: 'direct', photoId: 'direct-photo' },
          { source: 'forward', photoId: 'modern-photo' },
          { source: 'forward', photoId: 'legacy-photo' },
          { source: 'forward', photoId: 'nested-photo' },
        ],
      },
    });
  });

  it('excludes reply and quoted preview captions and photos at every supported holder', () => {
    const result = extractLogicalPhotoAlbumResult(
      buildUpdate({
        body: {
          text: 'Visible',
          attachments: [{ type: 'image', payload: { photo_id: 'current-photo' } }],
          forwarded_message: {
            type: 'reply',
            body: {
              text: 'Hidden legacy reply',
              attachments: [{ type: 'image', payload: { photo_id: 'legacy-reply-photo' } }],
            },
          },
        },
        link: {
          type: 'reply',
          message: {
            text: 'Hidden modern reply',
            attachments: [{ type: 'image', payload: { photo_id: 'modern-reply-photo' } }],
          },
        },
        content: {
          forwardedMessages: [
            {
              kind: 'quoted',
              text: 'Hidden quoted preview',
              attachments: [{ type: 'image', payload: { photo_id: 'quoted-photo' } }],
            },
          ],
        },
      }),
    );

    expect(result).toMatchObject({
      kind: 'complete',
      album: {
        caption: 'Visible',
        images: [{ source: 'direct', photoId: 'current-photo' }],
      },
    });
  });

  it('fails open when forward traversal, attachment scanning, or caption size is truncated', () => {
    const deepRoot: Record<string, unknown> = {
      attachments: [{ type: 'image', payload: { photo_id: 'photo-1' } }],
    };
    let cursor = deepRoot;
    for (let index = 0; index < 9; index += 1) {
      const next: Record<string, unknown> = { text: `forward-${index}` };
      cursor.forwarded_message = next;
      cursor = next;
    }
    expect(extractVisiblePhotoMessageContent(deepRoot)).toEqual({
      kind: 'incomplete',
      reason: 'forward_traversal_limit',
    });

    expect(
      extractVisiblePhotoMessageContent({
        attachments: [
          { type: 'image', payload: { photo_id: 'photo-1' } },
          ...Array.from({ length: 256 }, () => ({ type: 'file' })),
        ],
      }),
    ).toEqual({ kind: 'incomplete', reason: 'attachment_scan_limit' });

    expect(
      extractVisiblePhotoMessageContent({
        text: 'x'.repeat(8_001),
        attachments: [{ type: 'image', payload: { photo_id: 'photo-1' } }],
      }),
    ).toEqual({ kind: 'incomplete', reason: 'caption_too_long' });
  });

  it('bounds forward arrays even when most entries are malformed or repeated aliases', () => {
    expect(
      extractVisiblePhotoMessageContent({
        attachments: [{ type: 'image', payload: { photo_id: 'photo-1' } }],
        forwarded_messages: Array.from({ length: 65 }, () => null),
      }),
    ).toEqual({ kind: 'incomplete', reason: 'forward_traversal_limit' });

    const shared = { text: 'one shared forward' };
    expect(
      extractVisiblePhotoMessageContent({
        attachments: [{ type: 'image', payload: { photo_id: 'photo-1' } }],
        forwarded_messages: Array.from({ length: 65 }, () => shared),
      }),
    ).toEqual({ kind: 'incomplete', reason: 'forward_traversal_limit' });
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
