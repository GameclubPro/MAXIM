import { RedisCounterService } from './redis-counter.service';
import {
  buildCommercialCampaignSlidingSenderVelocityChatsKey,
  fingerprintCommercialCampaignSlidingMember,
} from './commercial/commercial-campaign-sliding';

function serviceWithResult(result: unknown) {
  const redis = { eval: jest.fn().mockResolvedValue(result) };
  const service = Object.create(RedisCounterService.prototype) as RedisCounterService;
  Object.defineProperty(service, 'redis', { value: redis });
  return { redis, service };
}

describe('commercial sliding Redis boundary', () => {
  const params = {
    key: buildCommercialCampaignSlidingSenderVelocityChatsKey('user-1', 300),
    chatId: 'chat-1',
    eventTimestampMs: 1_800_000_000_000,
    windowSeconds: 300,
  };

  it('sends digests, bounded sizes and trusted event time to one atomic script', async () => {
    const { redis, service } = serviceWithResult([256, 1]);
    await expect(service.trackCommercialCampaignSlidingWindow(params)).resolves.toEqual({
      size: 256,
      saturated: true,
    });
    const [script, ...arguments_] = redis.eval.mock.calls[0]!;
    expect(arguments_).toEqual([
      1,
      params.key,
      fingerprintCommercialCampaignSlidingMember(params.chatId),
      String(params.eventTimestampMs),
      '300',
      '256',
      '30000',
    ]);
    const lua = String(script);
    expect(lua.indexOf('if event_ms <= now_ms - window_ms')).toBeLessThan(
      lua.indexOf("redis.call('ZREMRANGEBYSCORE'"),
    );
    expect(lua).toContain('if not previous or event_ms > previous then');
    expect(lua).toContain(
      "redis.call('ZCOUNT', KEYS[1], '(' .. tostring(event_ms - window_ms), event_ms)",
    );
    expect(lua).toContain("redis.call('PEXPIRE', KEYS[1], window_ms)");
    expect(lua).not.toContain('chat-1');
    expect(lua).not.toContain("redis.call('SADD'");
  });

  it.each([
    { ...params, eventTimestampMs: Number.NaN },
    { ...params, eventTimestampMs: 0 },
    { ...params, windowSeconds: 60 },
    { ...params, key: 'commercial-campaign:v1:sender:user-1:chats' },
    { ...params, key: buildCommercialCampaignSlidingSenderVelocityChatsKey('user-1', 1800) },
    { ...params, chatId: ' ' },
  ])('rejects invalid observations before executing Redis: %p', async (invalid) => {
    const { redis, service } = serviceWithResult([1, 0]);
    await expect(service.trackCommercialCampaignSlidingWindow(invalid)).rejects.toThrow(
      'Invalid commercial sliding window observation',
    );
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it.each([[257, 0], [-1, 0], [1, 2], ['bad', 0], undefined])(
    'rejects malformed or unbounded counts: %p',
    async (invalid) => {
      const { service } = serviceWithResult(invalid);
      await expect(service.trackCommercialCampaignSlidingWindow(params)).rejects.toThrow(
        'Invalid commercial sliding window result',
      );
    },
  );
});
