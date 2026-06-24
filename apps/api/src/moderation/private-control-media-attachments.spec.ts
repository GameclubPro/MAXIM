import { BadRequestException } from '@nestjs/common';
import type { MaxUpdate } from '@maxim/contracts';
import {
  buildPrivateDownloadedFileName,
  buildPrivateSuggestionImageDraftsFromImages,
  buildPrivateSuggestionMediaDraftFromVideo,
  downloadPrivateImageSourceAttachment,
  extractPrivateFirstFileAttachment,
  extractPrivateFirstImageSourceAttachment,
  extractPrivateFirstVideoSourceAttachment,
  extractPrivateImageSourceAttachments,
  hasPrivateVideoAttachment,
  resolvePrivateImageMimeType,
  resolvePrivateVideoMimeType,
} from './private-control-media-attachments';

function createAttachmentUpdate(attachments: unknown[]): MaxUpdate {
  return {
    updateId: 'upd-private-media-1',
    type: 'message_created',
    message: {
      messageId: 'msg-private-media-1',
      chatId: '152517912',
      senderId: 'user-1',
      senderName: 'Тестовый пользователь',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'message_created',
      message: {
        body: {
          attachments,
        },
      },
    },
  };
}

function mockFetch(buffer: Buffer, mimeType: string, ok = true, status = 200) {
  const fetchMock = jest.fn().mockResolvedValue({
    ok,
    status,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-type' ? mimeType : null),
    },
    arrayBuffer: async () =>
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  });
  const originalFetch = global.fetch;
  Object.defineProperty(global, 'fetch', {
    configurable: true,
    writable: true,
    value: fetchMock,
  });

  return {
    fetchMock,
    restore() {
      Object.defineProperty(global, 'fetch', {
        configurable: true,
        writable: true,
        value: originalFetch,
      });
    },
  };
}

describe('private control media attachments', () => {
  it('extracts image attachments and image-file attachments in message order', () => {
    const update = createAttachmentUpdate([
      {
        type: 'image',
        payload: {
          url: 'https://example.test/photo.jpg',
          token: 'image-token',
          photo_id: 'photo-1',
          width: '640',
          height: 480,
        },
      },
      {
        type: 'file',
        filename: 'rules image.PNG',
        payload: {
          url: 'https://example.test/rules.png',
          file_id: 'file-1',
          token: 'file-token',
        },
      },
    ]);

    expect(extractPrivateImageSourceAttachments(update)).toEqual([
      {
        kind: 'image',
        attachment: expect.objectContaining({
          url: 'https://example.test/photo.jpg',
          token: 'image-token',
          photoId: 'photo-1',
          width: 640,
          height: 480,
        }),
      },
      {
        kind: 'file',
        attachment: expect.objectContaining({
          url: 'https://example.test/rules.png',
          token: 'file-token',
          fileId: 'file-1',
          fileName: 'rules image.PNG',
          mimeType: 'image/png',
        }),
      },
    ]);
    expect(extractPrivateFirstImageSourceAttachment(update)?.kind).toBe('image');
    expect(extractPrivateFirstFileAttachment(update)).toEqual(
      expect.objectContaining({
        fileName: 'rules image.PNG',
        url: 'https://example.test/rules.png',
      }),
    );
  });

  it('extracts video attachments and detects video-like files', () => {
    const videoUpdate = createAttachmentUpdate([
      {
        type: 'video',
        payload: {
          url: 'https://example.test/source.mov',
          video_id: 'video-1',
          file_name: 'source.mov',
        },
      },
    ]);
    const fileUpdate = createAttachmentUpdate([
      {
        type: 'file',
        filename: 'clip.mp4',
        payload: {
          url: 'https://example.test/clip.bin',
        },
      },
    ]);

    expect(extractPrivateFirstVideoSourceAttachment(videoUpdate)).toEqual(
      expect.objectContaining({
        url: 'https://example.test/source.mov',
        fileId: 'video-1',
        fileName: 'source.mov',
        mimeType: 'video/quicktime',
      }),
    );
    expect(extractPrivateFirstVideoSourceAttachment(fileUpdate)).toEqual(
      expect.objectContaining({
        url: 'https://example.test/clip.bin',
        fileName: 'clip.mp4',
        mimeType: 'video/mp4',
      }),
    );
    expect(hasPrivateVideoAttachment(videoUpdate)).toBe(true);
    expect(hasPrivateVideoAttachment(fileUpdate)).toBe(false);
  });

  it('normalizes mime types and downloaded file names', () => {
    expect(resolvePrivateImageMimeType(null, null, 'https://example.test/a/photo.webp')).toBe(
      'image/webp',
    );
    expect(resolvePrivateVideoMimeType(null, 'clip.m4v', null)).toBe('video/x-m4v');
    expect(buildPrivateDownloadedFileName('private-rules', 'bad/name?.png', null, 'image/png')).toBe(
      'bad-name-.png',
    );
    expect(buildPrivateDownloadedFileName('private-rules', null, 'file-1', 'image/webp')).toBe(
      'private-rules-file-1.webp',
    );
  });

  it('downloads images and preserves server image mime type', async () => {
    const source = extractPrivateFirstImageSourceAttachment(
      createAttachmentUpdate([
        {
          type: 'image',
          payload: {
            url: 'https://example.test/photo.jpg',
            photo_id: 'photo-1',
            mime_type: 'image/jpeg',
          },
        },
      ]),
    );
    const fetchMock = mockFetch(Buffer.from('image'), 'image/png; charset=utf-8');

    try {
      await expect(downloadPrivateImageSourceAttachment(source!, 'private-rules')).resolves.toEqual({
        base64: Buffer.from('image').toString('base64'),
        mimeType: 'image/png',
        fileName: 'private-rules-photo-1.png',
      });
      expect(fetchMock.fetchMock).toHaveBeenCalledWith('https://example.test/photo.jpg', {
        method: 'GET',
        signal: expect.any(AbortSignal),
      });
    } finally {
      fetchMock.restore();
    }
  });

  it('rejects failed and empty image downloads with user-facing errors', async () => {
    const source = extractPrivateFirstImageSourceAttachment(
      createAttachmentUpdate([
        {
          type: 'file',
          filename: 'photo.png',
          payload: {
            url: 'https://example.test/photo.png',
          },
        },
      ]),
    );
    const failedFetch = mockFetch(Buffer.from('image'), 'image/png', false, 503);
    try {
      await expect(downloadPrivateImageSourceAttachment(source!)).rejects.toThrow(
        'Не удалось загрузить файл (503).',
      );
    } finally {
      failedFetch.restore();
    }

    const emptyFetch = mockFetch(Buffer.alloc(0), 'image/png');
    try {
      await expect(downloadPrivateImageSourceAttachment(source!)).rejects.toThrow(
        'Файл оказался пустым.',
      );
    } finally {
      emptyFetch.restore();
    }
  });

  it('uploads downloaded images and videos into suggestion media drafts', async () => {
    const imageSources = extractPrivateImageSourceAttachments(
      createAttachmentUpdate([
        {
          type: 'image',
          payload: {
            url: 'https://example.test/photo.jpg',
            photo_id: 'photo-1',
          },
        },
      ]),
    );
    const videoSource = extractPrivateFirstVideoSourceAttachment(
      createAttachmentUpdate([
        {
          type: 'video',
          payload: {
            url: 'https://example.test/video.mp4',
            video_id: 'video-1',
            file_name: 'video.mp4',
            mime_type: 'video/mp4',
          },
        },
      ]),
    );
    const uploader = {
      uploadImage: jest.fn().mockResolvedValue({ token: 'image-token' }),
      uploadVideo: jest.fn().mockResolvedValue({ token: 'video-token' }),
    };

    const imageFetch = mockFetch(Buffer.from('image'), 'image/jpeg');
    try {
      await expect(
        buildPrivateSuggestionImageDraftsFromImages(imageSources, uploader, 'channel-suggestion'),
      ).resolves.toEqual([
        {
          kind: 'image',
          mimeType: 'image/jpeg',
          fileName: 'channel-suggestion-photo-1.jpg',
          payload: { token: 'image-token' },
        },
      ]);
      expect(uploader.uploadImage).toHaveBeenCalledWith(
        Buffer.from('image'),
        'channel-suggestion-photo-1.jpg',
        'image/jpeg',
      );
    } finally {
      imageFetch.restore();
    }

    const videoFetch = mockFetch(Buffer.from('video'), 'video/mp4');
    try {
      await expect(
        buildPrivateSuggestionMediaDraftFromVideo(videoSource!, uploader, 'channel-suggestion'),
      ).resolves.toEqual({
        kind: 'video',
        mimeType: 'video/mp4',
        fileName: 'video.mp4',
        payload: { token: 'video-token' },
      });
      expect(uploader.uploadVideo).toHaveBeenCalledWith(
        Buffer.from('video'),
        'video.mp4',
        'video/mp4',
      );
    } finally {
      videoFetch.restore();
    }
  });

  it('rejects downloads when a video source cannot be resolved', async () => {
    const videoSource = {
      ...extractPrivateFirstVideoSourceAttachment(
        createAttachmentUpdate([
          {
            type: 'video',
            payload: {
              url: 'https://example.test/video',
              mime_type: 'video/mp4',
            },
          },
        ]),
      )!,
      fileName: null,
      mimeType: '',
    };
    const unresolvedSource = extractPrivateFirstVideoSourceAttachment(
      createAttachmentUpdate([
        {
          type: 'file',
          filename: 'asset.bin',
          payload: {
            url: 'https://example.test/asset.bin',
          },
        },
      ]),
    );
    const fetchMock = mockFetch(Buffer.from('not-video'), 'text/plain');
    const uploader = {
      uploadImage: jest.fn(),
      uploadVideo: jest.fn(),
    };

    try {
      expect(unresolvedSource).toBeNull();
      await expect(buildPrivateSuggestionMediaDraftFromVideo(videoSource, uploader)).rejects.toThrow(
        BadRequestException,
      );
    } finally {
      fetchMock.restore();
    }
  });
});
