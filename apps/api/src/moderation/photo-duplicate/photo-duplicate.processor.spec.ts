import type { Job } from 'bullmq';
import { PhotoDuplicateProcessor } from './photo-duplicate.processor';
import type { PhotoDuplicateJob } from './photo-duplicate.queue';

describe('retired photo-filter queue drain', () => {
  const job = {
    id: 'old-job',
    data: {
      idempotencyKey: 'old-job',
      chatId: '-123',
      sourceCreatedAt: new Date().toISOString(),
      actionEligible: true,
    },
  } as Job<PhotoDuplicateJob>;
  it('abandons old ordering without invoking moderation or downloading media', async () => {
    const ordering = { abandon: jest.fn(), runInOrder: jest.fn() };
    await new PhotoDuplicateProcessor(ordering as never).process(job);
    expect(ordering.abandon).toHaveBeenCalledWith({
      jobId: 'old-job',
      chatId: '-123',
      sourceCreatedAt: job.data.sourceCreatedAt,
    });
    expect(ordering.runInOrder).not.toHaveBeenCalled();
  });
  it('retries an unavailable ordering store instead of acknowledging unfinished retirement', async () => {
    const ordering = { abandon: jest.fn().mockRejectedValue(new Error('temporary Redis failure')) };
    await expect(new PhotoDuplicateProcessor(ordering as never).process(job)).rejects.toThrow(
      'temporary Redis failure',
    );
  });
});
