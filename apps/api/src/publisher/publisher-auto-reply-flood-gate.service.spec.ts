import Redis from 'ioredis';
import { ConfigService } from '@nestjs/config';
import {
  PUBLISHER_AUTO_REPLY_FLOOD_GATE_BURST_WINDOW_SEC,
  PUBLISHER_AUTO_REPLY_FLOOD_GATE_DECISION_TTL_SEC,
  PUBLISHER_AUTO_REPLY_FLOOD_GATE_DEFAULTS,
  PUBLISHER_AUTO_REPLY_FLOOD_GATE_ROLLING_WINDOW_SEC,
} from './publisher-auto-reply-flood-gate.config';
import {
  PublisherAutoReplyFloodGateAmbiguousError,
  PublisherAutoReplyFloodGateService,
} from './publisher-auto-reply-flood-gate.service';

const redisEvalMock = jest.fn();
const redisDisconnectMock = jest.fn();
const redisOnMock = jest.fn();
let redisStatus = 'ready';

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    eval: redisEvalMock,
    disconnect: redisDisconnectMock,
    on: redisOnMock,
    get status() {
      return redisStatus;
    },
  })),
}));

const redisConstructorMock = Redis as unknown as jest.Mock;

function createConfig(overrides: Record<string, number> = {}): ConfigService {
  return {
    get: jest.fn((key: string, fallback?: unknown) => overrides[key] ?? fallback),
    getOrThrow: jest.fn(() => 'redis://localhost:6379/0'),
  } as unknown as ConfigService;
}

function reservation(
  overrides: Partial<Parameters<PublisherAutoReplyFloodGateService['reserve']>[0]> = {},
) {
  return {
    publisherBotId: 'publisher-bot-raw',
    chatId: 'chat-raw-100',
    senderUserId: 'user-raw-1',
    sourceMessageId: 'message-raw-1',
    ...overrides,
  };
}

describe('PublisherAutoReplyFloodGateService', () => {
  const originalRole = process.env.APP_ROLE;

  beforeEach(() => {
    jest.clearAllMocks();
    redisStatus = 'ready';
    process.env.APP_ROLE = 'enqueue';
  });

  afterAll(() => {
    process.env.APP_ROLE = originalRole;
  });

  it('reserves user and chat rolling capacity atomically with hashed cluster-safe keys', async () => {
    redisEvalMock.mockResolvedValue([1, 0, 1, 1, 1, 1]);
    const service = new PublisherAutoReplyFloodGateService(createConfig());

    await expect(service.reserve(reservation())).resolves.toEqual({
      allowed: true,
      replayed: false,
    });

    expect(redisConstructorMock).toHaveBeenCalledWith(
      'redis://localhost:6379/0',
      expect.objectContaining({
        commandTimeout: PUBLISHER_AUTO_REPLY_FLOOD_GATE_DEFAULTS.redisTimeoutMs,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
      }),
    );
    expect(redisEvalMock).toHaveBeenCalledTimes(1);
    const call = redisEvalMock.mock.calls[0]!;
    const script = String(call[0]);
    const keys: string[] = call.slice(2, 5).map((value: unknown) => String(value));
    expect(script).toContain('MAXIM_PUBLISHER_AUTO_REPLY_FLOOD_GATE_V1');
    expect(script.indexOf("redis.call('TIME')")).toBeLessThan(
      script.indexOf("redis.call('ZREMRANGEBYSCORE'"),
    );
    expect(script.indexOf('now_ms >= tonumber(ARGV[1])')).toBeLessThan(
      script.indexOf("redis.call('ZREMRANGEBYSCORE'"),
    );
    expect(call[1]).toBe(3);
    expect(keys).toHaveLength(3);
    const hashSlots = keys.map((key) => key.match(/\{([a-f0-9]{32})\}/u)?.[1]);
    expect(hashSlots[0]).toBeTruthy();
    expect(new Set(hashSlots).size).toBe(1);
    expect(JSON.stringify(call.slice(1))).not.toContain('publisher-bot-raw');
    expect(JSON.stringify(call.slice(1))).not.toContain('chat-raw-100');
    expect(JSON.stringify(call.slice(1))).not.toContain('user-raw-1');
    expect(JSON.stringify(call.slice(1))).not.toContain('message-raw-1');
    expect(call.slice(7)).toEqual([
      PUBLISHER_AUTO_REPLY_FLOOD_GATE_BURST_WINDOW_SEC,
      PUBLISHER_AUTO_REPLY_FLOOD_GATE_ROLLING_WINDOW_SEC,
      PUBLISHER_AUTO_REPLY_FLOOD_GATE_DECISION_TTL_SEC,
      PUBLISHER_AUTO_REPLY_FLOOD_GATE_ROLLING_WINDOW_SEC + 1,
      PUBLISHER_AUTO_REPLY_FLOOD_GATE_DEFAULTS.userBurstLimit,
      PUBLISHER_AUTO_REPLY_FLOOD_GATE_DEFAULTS.userRollingLimit,
      PUBLISHER_AUTO_REPLY_FLOOD_GATE_DEFAULTS.chatBurstLimit,
      PUBLISHER_AUTO_REPLY_FLOOD_GATE_DEFAULTS.chatRollingLimit,
      0,
      0,
    ]);

    service.onModuleDestroy();
    expect(redisDisconnectMock).toHaveBeenCalledWith(false);
  });

  it('keeps the chat scope shared while isolating per-user capacity', async () => {
    redisEvalMock.mockResolvedValue([1, 0, 1, 1, 1, 1]);
    const service = new PublisherAutoReplyFloodGateService(createConfig());

    await service.reserve(reservation());
    await service.reserve(
      reservation({ senderUserId: 'user-raw-2', sourceMessageId: 'message-raw-2' }),
    );

    const first = redisEvalMock.mock.calls[0]!;
    const second = redisEvalMock.mock.calls[1]!;
    expect(first[3]).not.toBe(second[3]);
    expect(first[4]).toBe(second[4]);
  });

  it('replays a prior allow decision without requiring another reservation result', async () => {
    redisEvalMock.mockResolvedValue([2, 0]);
    const service = new PublisherAutoReplyFloodGateService(createConfig());

    await expect(service.replay(reservation())).resolves.toEqual({
      allowed: true,
      replayed: true,
    });
  });

  it('returns a read-only miss when replay has no stored decision', async () => {
    redisEvalMock.mockResolvedValue([3, 0]);
    const service = new PublisherAutoReplyFloodGateService(createConfig());

    await expect(service.replay(reservation())).resolves.toEqual({
      allowed: false,
      reason: 'decision_missing',
    });

    const call = redisEvalMock.mock.calls[0]!;
    const script = String(call[0]);
    expect(call.at(-1)).toBe(1);
    expect(script.indexOf('if replay_only == 1 then')).toBeLessThan(
      script.indexOf("redis.call('TIME')"),
    );
    expect(script.indexOf('if replay_only == 1 then')).toBeLessThan(
      script.indexOf("redis.call('ZREMRANGEBYSCORE'"),
    );
  });

  it.each([
    [1, 'user_burst'],
    [2, 'user_rolling'],
    [3, 'chat_burst'],
    [4, 'chat_rolling'],
    [5, 'backlog_limit'],
    [6, 'backlog_unavailable'],
  ] as const)('maps Redis denial %s to %s', async (reasonCode, reason) => {
    redisEvalMock.mockResolvedValue([0, reasonCode]);
    const service = new PublisherAutoReplyFloodGateService(createConfig());

    await expect(service.reserve(reservation())).resolves.toEqual({ allowed: false, reason });
  });

  it('persists an upstream backlog denial through the same idempotent decision script', async () => {
    redisEvalMock.mockResolvedValue([0, 5]);
    const service = new PublisherAutoReplyFloodGateService(createConfig());

    await expect(
      service.reserve(reservation({ upstreamDenialReason: 'backlog_limit' })),
    ).resolves.toEqual({ allowed: false, reason: 'backlog_limit' });

    expect(redisEvalMock.mock.calls[0]?.at(-2)).toBe(5);
    expect(redisEvalMock.mock.calls[0]?.at(-1)).toBe(0);
  });

  it('emits only a bounded aggregate denial signal without source identifiers', async () => {
    redisEvalMock.mockResolvedValue([0, 1]);
    const service = new PublisherAutoReplyFloodGateService(createConfig());
    const logger = (
      service as unknown as {
        logger: { warn: (context: unknown, message: string) => void };
      }
    ).logger;
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await service.reserve(reservation());
    await service.reserve(reservation({ sourceMessageId: 'message-raw-2' }));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { reasonCounts: { user_burst: 1 } },
      'Publisher auto-reply admission suppressed deliveries',
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('chat-raw-100');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('user-raw-1');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('message-raw');
  });

  it('treats a rejected ready-state EVAL as ambiguous so the webhook can replay its decision', async () => {
    redisEvalMock
      .mockRejectedValueOnce(Object.assign(new Error('Command timed out'), { code: 'ETIMEDOUT' }))
      .mockResolvedValueOnce([2, 0]);
    const service = new PublisherAutoReplyFloodGateService(createConfig());

    await expect(service.reserve(reservation())).rejects.toBeInstanceOf(
      PublisherAutoReplyFloodGateAmbiguousError,
    );
    await expect(service.replay(reservation())).resolves.toEqual({
      allowed: true,
      replayed: true,
    });
  });

  it('fails closed without dispatching EVAL when Redis is not ready', async () => {
    redisStatus = 'reconnecting';
    const service = new PublisherAutoReplyFloodGateService(createConfig());

    await expect(service.reserve(reservation())).resolves.toEqual({
      allowed: false,
      reason: 'unavailable',
    });
    expect(redisEvalMock).not.toHaveBeenCalled();
  });

  it('fails closed after a definitive server deadline response', async () => {
    redisEvalMock.mockResolvedValue([-2, 0]);
    const service = new PublisherAutoReplyFloodGateService(createConfig());

    await expect(service.reserve(reservation())).resolves.toEqual({
      allowed: false,
      reason: 'unavailable',
    });
  });

  it('treats an unrecognized EVAL response as ambiguous instead of ACK-suppressing it', async () => {
    redisEvalMock.mockResolvedValue([1]);
    const service = new PublisherAutoReplyFloodGateService(createConfig());

    await expect(service.reserve(reservation())).rejects.toBeInstanceOf(
      PublisherAutoReplyFloodGateAmbiguousError,
    );
  });

  it('rejects a new reservation result from replay-only mode', async () => {
    redisEvalMock.mockResolvedValue([1, 0]);
    const service = new PublisherAutoReplyFloodGateService(createConfig());

    await expect(service.replay(reservation())).rejects.toBeInstanceOf(
      PublisherAutoReplyFloodGateAmbiguousError,
    );
  });

  it.each([
    [
      'chat burst below user burst',
      {
        PUBLISHER_AUTO_REPLY_USER_BURST_LIMIT: 31,
        PUBLISHER_AUTO_REPLY_USER_ROLLING_LIMIT: 31,
        PUBLISHER_AUTO_REPLY_CHAT_BURST_LIMIT: 30,
      },
    ],
    [
      'chat rolling below user rolling',
      {
        PUBLISHER_AUTO_REPLY_USER_ROLLING_LIMIT: 121,
        PUBLISHER_AUTO_REPLY_CHAT_ROLLING_LIMIT: 120,
      },
    ],
  ] as const)('rejects invalid cross-scope limits: %s', (_label, overrides) => {
    expect(() => new PublisherAutoReplyFloodGateService(createConfig(overrides))).toThrow(
      /chat limits must cover user limits/u,
    );
  });

  it.each(['moderation', 'publisher', 'admin', 'action'] as const)(
    'does not open a flood-gate Redis client in the %s role',
    async (role) => {
      process.env.APP_ROLE = role;
      const config = createConfig();
      const service = new PublisherAutoReplyFloodGateService(config);

      expect(redisConstructorMock).not.toHaveBeenCalled();
      await expect(service.reserve(reservation())).resolves.toEqual({
        allowed: false,
        reason: 'unavailable',
      });
      service.onModuleDestroy();
      expect(redisDisconnectMock).not.toHaveBeenCalled();
    },
  );
});
