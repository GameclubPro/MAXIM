import { TrafficProtectionDetector } from './traffic-protection.detector';
import type { TrafficProtectionSettings } from './traffic-protection';

function setup(overrides: Partial<TrafficProtectionSettings> = {}) {
  const now = Date.now();
  const settings: TrafficProtectionSettings = {
    slowModeEnabled: true,
    slowModeIntervalSeconds: 30,
    mediaMessageCooldownEnabled: false,
    mediaMessageCooldownSeconds: 30,
    stickerMessagesEnabled: true,
    trafficPolicyRevision: 1,
    trafficPolicyEffectiveAt: new Date(now - 100_000),
    ...overrides,
  };
  const redis = { claimEventCooldown: jest.fn().mockResolvedValue('blocked') };
  const detector = new TrafficProtectionDetector(redis as never);
  const input = {
    chatId: 'chat',
    userId: 'user',
    messageId: 'message',
    eventTimestampMs: now,
    eventType: 'message_created' as const,
    text: 'message',
    media: {},
    settings,
  };
  return { detector, redis, input, settings, now };
}

describe('TrafficProtectionDetector', () => {
  it('produces a bounded delete-only decision', async () => {
    const h = setup();
    expect(await h.detector.detect(h.input)).toMatchObject({
      ruleCode: 'SLOW_MODE',
      metadata: {
        trafficPolicyVersion: 1,
        trafficPolicyRevision: 1,
        trafficIntervalSeconds: 30,
        trafficEventTimestampMs: h.now,
        trafficDeadlineAtMs: h.now + 30_000,
        messageDisposition: 'DELETE',
        userSanction: 'NONE',
      },
    });
  });
  it('uses the same policy from an in-memory or serialized cache', async () => {
    const h = setup();
    h.settings.trafficPolicyEffectiveAt = new Date(h.now - 1000).toISOString();
    expect(await h.detector.detect(h.input)).toMatchObject({ ruleCode: 'SLOW_MODE' });
  });
  it.each(['messageId', 'eventTimestampMs', 'trafficPolicyRevision', 'trafficPolicyEffectiveAt'])(
    'skips missing %s without touching counters',
    async (field) => {
      const h = setup();
      const input = {
        ...h.input,
        [field]: undefined,
        settings: { ...h.settings, [field]: undefined },
      };
      expect(await h.detector.detect(input)).toBeNull();
      expect(h.redis.claimEventCooldown).not.toHaveBeenCalled();
    },
  );
  it('does not count edits, disabled policies, or events before activation', async () => {
    const h = setup();
    expect(await h.detector.detect({ ...h.input, eventType: 'message_edited' })).toBeNull();
    expect(await h.detector.detect({ ...h.input, eventTimestampMs: h.now - 200_000 })).toBeNull();
    h.settings.slowModeEnabled = false;
    expect(await h.detector.detect(h.input)).toBeNull();
    expect(h.redis.claimEventCooldown).not.toHaveBeenCalled();
  });
  it('uses a bounded shared album identity, never timing-only grouping', async () => {
    const h = setup();
    expect(
      await h.detector.detect({
        ...h.input,
        media: { hasMediaBatch: true, hasPhotoAttachment: true },
      }),
    ).toBeNull();
    expect(h.redis.claimEventCooldown).not.toHaveBeenCalled();
    await h.detector.detect({
      ...h.input,
      mediaGroupId: 'album',
      media: { hasMediaBatch: true, hasPhotoAttachment: true },
    });
    const first = h.redis.claimEventCooldown.mock.calls[0][0];
    await h.detector.detect({
      ...h.input,
      messageId: 'next',
      mediaGroupId: 'album',
      media: { hasPhotoAttachment: true },
    });
    expect(h.redis.claimEventCooldown.mock.calls[1][0]).toMatchObject({
      key: first.key,
      memberKey: first.memberKey,
      memberTimestampToleranceMs: 2000,
    });
  });
  it('checks all supported media while ignoring a plain text message', async () => {
    const h = setup({ slowModeEnabled: false, mediaMessageCooldownEnabled: true });
    expect(await h.detector.detect(h.input)).toBeNull();
    for (const flag of [
      'hasPhotoAttachment',
      'hasStickerAttachment',
      'hasVideoAttachment',
      'hasFileAttachment',
      'hasVoiceAttachment',
    ])
      expect(await h.detector.detect({ ...h.input, media: { [flag]: true } })).toMatchObject({
        ruleCode: 'MEDIA_RATE_LIMIT',
      });
  });
  it('blocks a sticker on creation or edit without counting a send', async () => {
    const h = setup({ stickerMessagesEnabled: false });
    for (const eventType of ['message_created', 'message_edited'] as const)
      expect(
        await h.detector.detect({ ...h.input, eventType, media: { hasStickerAttachment: true } }),
      ).toMatchObject({ ruleCode: 'STICKER_BLOCKED' });
    expect(h.redis.claimEventCooldown).not.toHaveBeenCalled();
  });
  it.each(['allowed', 'stale'])('does not delete on a %s counter result', async (result) => {
    const h = setup();
    h.redis.claimEventCooldown.mockResolvedValue(result);
    expect(await h.detector.detect(h.input)).toBeNull();
  });
  it('bounds the action deadline even for a day-long interval', async () => {
    const h = setup({ slowModeIntervalSeconds: 86400 });
    expect((await h.detector.detect(h.input))?.metadata?.trafficDeadlineAtMs).toBe(h.now + 300_000);
  });
  it('surfaces an unavailable counter without fabricating a violation', async () => {
    const h = setup();
    h.redis.claimEventCooldown.mockResolvedValue('deadline_exceeded');
    await expect(h.detector.detect(h.input)).rejects.toThrow('unavailable');
  });
});
