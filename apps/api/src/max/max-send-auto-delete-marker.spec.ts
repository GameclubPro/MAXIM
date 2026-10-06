import {
  isMaxSendAutoDeleteMarker,
  MAX_SEND_AUTO_DELETE_MARKER_VERSION,
} from './max-send-auto-delete-marker';

describe('send auto-delete inherited source identity', () => {
  const marker = {
    version: MAX_SEND_AUTO_DELETE_MARKER_VERSION,
    sourceSendJobId: 'confirmed-parent-job',
    sourceSendCompletedAt: '2026-10-05T00:00:01.000Z',
    requestedDelayMs: 60_000,
    originBotId: 'origin-bot',
  };
  const origin = {
    sourceChatId: 'source-chat',
    sourceUserId: 'source-user',
    sourceMessageId: 'source-message',
    sourceCreatedAt: '2026-10-05T00:00:00.000Z',
  };

  it.each([1, 2])('keeps legacy v%s markers readable without source fields', (version) => {
    expect(isMaxSendAutoDeleteMarker({ ...marker, version })).toBe(true);
  });

  it('accepts a complete origin including an independently authored publication', () => {
    expect(isMaxSendAutoDeleteMarker({ ...marker, ...origin })).toBe(true);
    expect(
      isMaxSendAutoDeleteMarker({
        ...marker,
        ...origin,
        sourceUserId: null,
        sourceMessageId: null,
      }),
    ).toBe(true);
  });

  it.each(Object.keys(origin))('rejects a partial source origin missing %s', (field) => {
    const partial: Record<string, unknown> = { ...origin };
    delete partial[field];
    expect(isMaxSendAutoDeleteMarker({ ...marker, ...partial })).toBe(false);
  });

  it.each([
    { sourceChatId: ' source-chat' },
    { sourceUserId: '' },
    { sourceUserId: 1 },
    { sourceMessageId: 'source-message ' },
    { sourceCreatedAt: 'invalid' },
  ])('rejects malformed inherited source identity %j', (invalid) => {
    expect(isMaxSendAutoDeleteMarker({ ...marker, ...origin, ...invalid })).toBe(false);
  });
});
