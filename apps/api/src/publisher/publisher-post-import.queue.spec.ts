import {
  buildPublisherPostImportNotificationJobId,
  buildPublisherPostImportProcessJobId,
  PUBLISHER_POST_IMPORT_PROCESS_JOB_BUCKET_MS,
} from './publisher-post-import.queue';

describe('publisher post import queue identity', () => {
  it('deduplicates one lease bucket and permits bounded post-lease recovery', () => {
    const start = new Date('2026-08-28T12:00:00.000Z');
    const sameBucket = new Date(start.getTime() + PUBLISHER_POST_IMPORT_PROCESS_JOB_BUCKET_MS - 1);
    const nextBucket = new Date(start.getTime() + PUBLISHER_POST_IMPORT_PROCESS_JOB_BUCKET_MS);

    expect(buildPublisherPostImportProcessJobId('session-1', sameBucket)).toBe(
      buildPublisherPostImportProcessJobId('session-1', start),
    );
    expect(buildPublisherPostImportProcessJobId('session-1', nextBucket)).not.toBe(
      buildPublisherPostImportProcessJobId('session-1', start),
    );
  });

  it('hashes arbitrary MAX identifiers into a BullMQ-safe notification id', () => {
    const first = buildPublisherPostImportNotificationJobId(
      'session-1',
      'ready',
      'callback:with:redis:separators',
    );
    expect(first).not.toContain(':');
    expect(first).toBe(
      buildPublisherPostImportNotificationJobId(
        'session-1',
        'ready',
        'callback:with:redis:separators',
      ),
    );
    expect(first).not.toBe(
      buildPublisherPostImportNotificationJobId('session-1', 'ready', 'another-callback'),
    );
  });
});
