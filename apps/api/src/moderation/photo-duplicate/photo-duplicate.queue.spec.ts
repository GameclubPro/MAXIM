import {
  buildPhotoDuplicateJobId,
  PHOTO_DUPLICATE_ALGORITHM_VERSION,
  PhotoDuplicateSourceNotReadyError,
} from './photo-duplicate.queue';

describe('photo duplicate queue identity', () => {
  it('is stable per logical MAX message and algorithm version', () => {
    const first = buildPhotoDuplicateJobId({ chatId: 'chat-1', messageId: 'message-1' });
    expect(first).toBe(buildPhotoDuplicateJobId({ chatId: 'chat-1', messageId: 'message-1' }));
    expect(first).not.toBe(
      buildPhotoDuplicateJobId({
        chatId: 'chat-1',
        messageId: 'message-1',
        algorithmVersion: PHOTO_DUPLICATE_ALGORITHM_VERSION + 1,
      }),
    );
    expect(first).not.toContain('chat-1');
    expect(first).not.toContain('message-1');
  });

  it('exposes a typed retry signal while the source webhook is unfinished', () => {
    const error = new PhotoDuplicateSourceNotReadyError('webhook-1');

    expect(error).toMatchObject({
      name: 'PhotoDuplicateSourceNotReadyError',
      code: 'PHOTO_DUPLICATE_SOURCE_NOT_READY',
      message: 'Photo duplicate source webhook webhook-1 is not processed yet',
    });
  });
});
