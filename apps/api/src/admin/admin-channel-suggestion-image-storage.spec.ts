import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';

import {
  CHANNEL_SUGGESTION_IMAGE_STORAGE_VERSION,
  loadStoredChannelSuggestionImages,
  prepareChannelSuggestionImageRows,
  prepareNormalizedChannelSuggestionImageRows,
  buildChannelSuggestionMediaMetadata,
} from './admin-channel-suggestion-image-storage';

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

describe('channel suggestion image storage', () => {
  it('round-trips mixed inline and bot receipt images through metadata-only audit storage', async () => {
    const rows = await prepareNormalizedChannelSuggestionImageRows([
      { payload: { token: 'bot-owned-token' }, fileName: 'remote.jpg', mimeType: 'image/jpeg' },
      { base64: TINY_PNG.toString('base64'), fileName: 'local.png', mimeType: 'image/png' },
    ]);
    const payload = buildChannelSuggestionMediaMetadata(rows);
    expect(payload).toMatchObject({ imageStorageVersion: 1, imageCount: 2 });
    expect(JSON.stringify(payload)).not.toContain('bot-owned-token');
    expect(JSON.stringify(payload)).not.toContain(TINY_PNG.toString('base64'));
    const images = await loadStoredChannelSuggestionImages({
      auditLogId: 'mixed-suggestion',
      payload,
      legacyImages: [],
      repository: {
        findMany: jest
          .fn()
          .mockResolvedValue(
            rows.map((row) => ({ bytes: null, durablePayload: null, sizeBytes: null, ...row })),
          ),
      },
      logger: { error: jest.fn() },
    });
    expect(images).toEqual([
      { payload: { token: 'bot-owned-token' }, fileName: 'remote.jpg', mimeType: 'image/jpeg' },
      { base64: TINY_PNG.toString('base64'), fileName: 'local.png', mimeType: 'image/png' },
    ]);
  });

  it('rejects ambiguous storage and videos on the compact image path', async () => {
    await expect(
      prepareNormalizedChannelSuggestionImageRows([
        { payload: { token: 'token' }, base64: TINY_PNG.toString('base64') },
      ]),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      prepareNormalizedChannelSuggestionImageRows([{ type: 'video', payload: { token: 'video' } }]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('validates image bytes and prepares compact ordered relation rows', async () => {
    const rows = await prepareChannelSuggestionImageRows([
      {
        base64: TINY_PNG.toString('base64'),
        mimeType: 'image/jpeg',
        fileName: '../photo.weird',
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      position: 0,
      bytes: expect.any(Uint8Array),
      mimeType: 'image/png',
      fileName: 'photo.png',
      sizeBytes: TINY_PNG.length,
    });
    expect(Buffer.from(rows[0]?.bytes ?? []).equals(TINY_PNG)).toBe(true);
  });

  it('rejects damaged and duplicate image bytes before persistence', async () => {
    await expect(
      prepareChannelSuggestionImageRows([
        { base64: 'not-base64', mimeType: 'image/png', fileName: 'bad.png' },
      ]),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      prepareChannelSuggestionImageRows(
        Array.from({ length: 2 }, (_, index) => ({
          base64: TINY_PNG.toString('base64'),
          mimeType: 'image/png',
          fileName: `same-${index}.png`,
        })),
      ),
    ).rejects.toThrow('Один и тот же медиафайл добавлен несколько раз.');
  });

  it('restores relation bytes in order without exposing a partial compact set', async () => {
    const logger = { error: jest.fn() };
    const repository = {
      findMany: jest.fn().mockResolvedValue([
        {
          position: 0,
          bytes: Buffer.from('first'),
          durablePayload: null,
          mimeType: 'image/png',
          fileName: 'first.png',
          sizeBytes: 5,
        },
        {
          position: 1,
          bytes: Buffer.from('second'),
          durablePayload: null,
          mimeType: 'image/jpeg',
          fileName: 'second.jpg',
          sizeBytes: 6,
        },
      ]),
    };

    await expect(
      loadStoredChannelSuggestionImages({
        auditLogId: 'suggestion-1',
        payload: {
          imageStorageVersion: CHANNEL_SUGGESTION_IMAGE_STORAGE_VERSION,
          imageCount: 2,
        },
        legacyImages: [],
        repository,
        logger,
      }),
    ).resolves.toEqual([
      {
        base64: Buffer.from('first').toString('base64'),
        mimeType: 'image/png',
        fileName: 'first.png',
      },
      {
        base64: Buffer.from('second').toString('base64'),
        mimeType: 'image/jpeg',
        fileName: 'second.jpg',
      },
    ]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('fails closed when compact storage declares media but relation rows are missing', async () => {
    const logger = { error: jest.fn() };

    await expect(
      loadStoredChannelSuggestionImages({
        auditLogId: 'suggestion-missing',
        payload: {
          imageStorageVersion: CHANNEL_SUGGESTION_IMAGE_STORAGE_VERSION,
          imageCount: 1,
        },
        legacyImages: [],
        repository: { findMany: jest.fn().mockResolvedValue([]) },
        logger,
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
