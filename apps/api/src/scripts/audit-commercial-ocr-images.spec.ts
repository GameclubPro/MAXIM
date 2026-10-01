import { chatSettingsSchema } from '@maxim/contracts';
import type { ChatSettings } from '../prisma/prisma-client';
import {
  auditCommercialOcrAlbums,
  readCommercialOcrImageAuditOptions,
  selectCommercialOcrAuditAlbums,
} from './audit-commercial-ocr-images';

function receipt(photoIds = ['photo-1'], extra: Record<string, unknown> = {}) {
  return {
    normalizedPayload: {
      type: 'message_created',
      raw: {
        message: {
          timestamp: '2026-10-01T08:00:00.000Z',
          recipient: { chat_id: 'chat-private' },
          sender: { user_id: 'private-author', is_bot: false },
          body: {
            mid: 'private-message',
            text: 'Private visible caption',
            attachments: photoIds.map((photoId) => ({
              type: 'image',
              payload: { photo_id: photoId, url: `https://i.oneme.ru/private/${photoId}` },
            })),
          },
          ...extra,
        },
      },
    },
  };
}

const settings = chatSettingsSchema.parse({
  commercialAdsFilterEnabled: true,
}) as unknown as ChatSettings;

describe('commercial OCR read-only image audit', () => {
  it('accepts only a bounded lookback and never an apply/mutation option', () => {
    expect(readCommercialOcrImageAuditOptions([])).toEqual({ lookbackHours: 1 });
    expect(readCommercialOcrImageAuditOptions(['--lookback-hours', '24'])).toEqual({
      lookbackHours: 24,
    });
    for (const argv of [
      ['--apply'],
      ['--lookback-hours', '25'],
      ['--lookback-hours', '0'],
      ['--lookback-hours', '1.5'],
    ]) {
      expect(() => readCommercialOcrImageAuditOptions(argv)).toThrow();
    }
  });

  it('bounds total unique photos while preserving complete albums and source creation identity', () => {
    const selected = selectCommercialOcrAuditAlbums([
      receipt(['photo-1', 'photo-2']),
      receipt(['photo-2']),
      receipt(['photo-3']),
      receipt(['photo-4']),
    ]);
    expect(selected.selectedImages).toBe(3);
    expect(selected.albums.map((album) => album.images.length)).toEqual([2, 1]);
    expect(selected.albums[0]!.createdAtMs).toBe(Date.parse('2026-10-01T08:00:00.000Z'));
    expect(selected.counters.duplicate_photo).toBe(1);
    expect(selectCommercialOcrAuditAlbums([receipt(['1', '2', '3', '4'])]).selectedImages).toBe(0);
  });

  it('rejects bot authors, missing immutable source time and disabled chat opt-in', () => {
    expect(
      selectCommercialOcrAuditAlbums([
        receipt(['photo'], { sender: { user_id: 'bot', is_bot: true } }),
      ]).selectedImages,
    ).toBe(0);
    expect(
      selectCommercialOcrAuditAlbums([receipt(['photo'], { timestamp: undefined })]).selectedImages,
    ).toBe(0);
    expect(
      selectCommercialOcrAuditAlbums([
        { ...receipt(), commercialSettings: { commercialAdsFilterEnabled: false } },
      ]).selectedImages,
    ).toBe(0);
  });

  it('does not inspect receipts beyond its hard 500-row limit', () => {
    const rows = Array.from({ length: 500 }, () => ({
      normalizedPayload: { type: 'message_removed' },
    }));
    const selected = selectCommercialOcrAuditAlbums([...rows, receipt()]);
    expect(selected.selectedImages).toBe(0);
    expect(selected.counters.receipts_scanned).toBe(500);
  });

  it('recognizes both native passes but returns only aggregate counts and latency', async () => {
    const albums = selectCommercialOcrAuditAlbums([receipt()]).albums;
    const privateText = 'OPAQUE PRIVATE RECOGNIZED WORD';
    const sourceBytes = Buffer.from('private raster bytes');
    const preparedBuffers: Buffer[] = [];
    const downloader = {
      download: jest.fn().mockResolvedValue({ bytes: sourceBytes, format: 'jpeg' }),
    };
    const preprocessor = {
      prepare: jest.fn().mockImplementation(async () => {
        const bytes = Buffer.from('prepared private raster');
        preparedBuffers.push(bytes);
        return { bytes };
      }),
    };
    const native = {
      isSandboxBoundaryVerified: jest.fn().mockReturnValue(true),
      recognize: jest.fn().mockResolvedValue({
        ok: true,
        status: 'recognized',
        text: privateText,
        aggregateConfidence: 95,
        words: [
          {
            text: privateText,
            start: 0,
            end: privateText.length,
            confidence: 95,
            lineIndex: 0,
            boundingBox: { left: 0, top: 0, width: 1, height: 1 },
          },
        ],
        truncated: false,
        durationMs: 1,
        lines: [],
      }),
    };
    const result = await auditCommercialOcrAlbums({
      albums,
      settings,
      downloader: downloader as never,
      preprocessor: preprocessor as never,
      native: native as never,
      deadlineAtMs: Date.now() + 30_000,
    });
    expect(result.counters).toMatchObject({
      images_downloaded: 1,
      images_recognized: 1,
      primary_recognized: 1,
      confirmation_recognized: 1,
      strict_keep_decisions: 1,
    });
    expect(native.recognize.mock.calls.map((call) => call[1].psm)).toEqual([11, 6]);
    const output = JSON.stringify(result);
    for (const privateValue of [
      privateText,
      'Private visible caption',
      'chat-private',
      'private-author',
      'photo-1',
      'https://',
    ]) {
      expect(output).not.toContain(privateValue);
    }
    expect(sourceBytes.every((byte) => byte === 0)).toBe(true);
    expect(preparedBuffers.every((buffer) => buffer.every((byte) => byte === 0))).toBe(true);
  });

  it('never downloads or recognizes when sandbox verification is unavailable', async () => {
    const downloader = { download: jest.fn() };
    const native = {
      recognize: jest.fn(),
      isSandboxBoundaryVerified: jest.fn().mockReturnValue(false),
    };
    const result = await auditCommercialOcrAlbums({
      albums: selectCommercialOcrAuditAlbums([receipt()]).albums,
      settings,
      downloader,
      preprocessor: { prepare: jest.fn() },
      native,
      deadlineAtMs: Date.now() + 30_000,
    });
    expect(result.counters.sandbox_or_deadline_unavailable).toBe(1);
    expect(downloader.download).not.toHaveBeenCalled();
    expect(native.recognize).not.toHaveBeenCalled();
  });

  it('reports transport failure without echoing a private URL or error details', async () => {
    const result = await auditCommercialOcrAlbums({
      albums: selectCommercialOcrAuditAlbums([receipt()]).albums,
      settings,
      downloader: {
        download: jest.fn().mockRejectedValue(new Error('https://private.example/credential')),
      },
      preprocessor: { prepare: jest.fn() },
      native: { recognize: jest.fn(), isSandboxBoundaryVerified: jest.fn().mockReturnValue(true) },
      deadlineAtMs: Date.now() + 30_000,
    });
    expect(result.counters.download_failed).toBe(1);
    expect(JSON.stringify(result)).not.toContain('private.example');
    expect(JSON.stringify(result)).not.toContain('credential');
  });
});
