import { ServiceUnavailableException } from '@nestjs/common';
import * as values from './admin-channel-dialog-values';
import { AdminChannelSuggestionImageRuntime } from './admin-channel-suggestion-image-runtime';
import { createAdminChannelSuggestionImageRuntimeContext } from './admin-channel-suggestion-image-runtime-context';

function fixture() {
  const findMany = jest.fn().mockResolvedValue([]);
  const logger = { error: jest.fn() };
  const context = createAdminChannelSuggestionImageRuntimeContext({
    ...values,
    logger: logger as never,
    prisma: { channelSuggestionImageAsset: { findMany } } as never,
  });
  return { findMany, logger, runtime: new AdminChannelSuggestionImageRuntime(context) };
}

describe('suggestion image storage without AdminService', () => {
  it('reads the exact suggestion and retains legacy inline media when relation storage is absent', async () => {
    const f = fixture();
    await expect(
      f.runtime.loadStoredImages('suggestion-1', {
        imageBase64: ' image ',
        imageMimeType: ' image/png ',
        imageFileName: ' image.png ',
      }),
    ).resolves.toEqual([{ base64: 'image', mimeType: 'image/png', fileName: 'image.png' }]);
    expect(f.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { auditLogId: 'suggestion-1' },
        orderBy: { position: 'asc' },
        take: 11,
      }),
    );
  });

  it('does not silently fall back when required durable media is missing', async () => {
    const f = fixture();
    await expect(
      f.runtime.loadStoredImages('suggestion-1', {
        imageStorageVersion: 1,
        imageCount: 1,
        imageBase64: 'stale-inline-image',
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(f.logger.error).toHaveBeenCalledTimes(1);
  });
});
