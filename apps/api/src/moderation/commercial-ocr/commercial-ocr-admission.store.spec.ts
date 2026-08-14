import { buildCommercialOcrJobId } from './commercial-ocr.queue';
import { COMMERCIAL_OCR_REDIS_OPTIONS } from './commercial-ocr-redis.options';
import { CommercialOcrAdmissionStore } from './commercial-ocr-admission.store';

type RedisMock = {
  status: string;
  disconnect: jest.Mock;
  eval: jest.Mock;
  quit: jest.Mock;
};

const sourceCreatedAt = '2026-08-12T08:00:00.000Z';
const jobId = buildCommercialOcrJobId({
  chatId: 'chat-secret',
  messageId: 'message-secret',
  sourceCreatedAt,
  ocrVersion: 'tesseract-rus-eng-v1',
});
const limits = {
  maxGlobalImageUnits: 100,
  maxChatImageUnits: 20,
  reservedActionableImageUnits: 25,
  maxJobAgeMs: 120_000,
  reservationTtlMs: 300_000,
};

function createStore(evalResults: unknown[]) {
  const redis: RedisMock = {
    status: 'ready',
    disconnect: jest.fn(),
    eval: jest.fn(),
    quit: jest.fn().mockResolvedValue(undefined),
  };
  for (const result of evalResults) {
    redis.eval.mockResolvedValueOnce(result);
  }
  const store = Object.create(CommercialOcrAdmissionStore.prototype) as CommercialOcrAdmissionStore;
  Object.defineProperties(store, {
    redis: { value: redis },
    logger: { value: { warn: jest.fn() } },
  });
  return { redis, store };
}

describe('CommercialOcrAdmissionStore', () => {
  it('uses bounded fail-fast Redis connection and command options', () => {
    expect(COMMERCIAL_OCR_REDIS_OPTIONS).toEqual({
      commandTimeout: 1_000,
      connectTimeout: 1_000,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });
  });

  it('atomically reserves enforce work as pending with weighted opaque capacity', async () => {
    const { redis, store } = createStore([[1, 'P']]);

    await expect(
      store.reserve({
        jobId,
        chatId: 'chat-secret',
        sourceCreatedAt,
        imageCount: 3,
        actionEligible: true,
        limits,
      }),
    ).resolves.toEqual({ kind: 'admitted', state: 'pending' });

    const call = redis.eval.mock.calls[0] as unknown[];
    expect(call[1]).toBe(6);
    const keys = call.slice(2, 8).map(String);
    expect(keys.join('|')).not.toContain('chat-secret');
    expect(keys).toEqual([
      'commercial-ocr:admission:v2:global:expiry',
      'commercial-ocr:admission:v2:global:metadata',
      'commercial-ocr:admission:v2:global:units',
      expect.stringMatching(/^commercial-ocr:admission:v2:chat:[a-f0-9]{32}:expiry$/u),
      expect.stringMatching(/^commercial-ocr:admission:v2:chat:[a-f0-9]{32}:weights$/u),
      expect.stringMatching(/^commercial-ocr:admission:v2:chat:[a-f0-9]{32}:units$/u),
    ]);
    expect(call[10]).toBe('3');
    expect(call[15]).toBe('P');
    expect(call[20]).toBe('25');
    expect(String(call[0])).toContain("redis.call('TIME')");
    expect(String(call[0])).toMatch(/redis\.call\(\s*'ZRANGEBYSCORE'/u);
    expect(String(call[0])).toContain("'LIMIT', 0, tonumber(ARGV[11])");
  });

  it('reserves shadow work as an observation that is still admitted for OCR', async () => {
    const { redis, store } = createStore([[1, 'O']]);

    await expect(
      store.reserve({
        jobId,
        chatId: 'chat-secret',
        sourceCreatedAt,
        imageCount: 1,
        actionEligible: false,
        limits,
      }),
    ).resolves.toEqual({ kind: 'admitted', state: 'observation' });
    expect(redis.eval.mock.calls[0]![15]).toBe('O');
    expect(String(redis.eval.mock.calls[0]![0])).toContain(
      "ARGV[8] == 'O' and\n  global_units + tonumber(ARGV[3]) > tonumber(ARGV[6]) - tonumber(ARGV[13])",
    );
  });

  it('returns bounded capacity and age outcomes without throwing', async () => {
    const outcomes = [
      { response: [3, 'O'], kind: 'rejected_global' },
      { response: [4, 'O'], kind: 'rejected_chat' },
      { response: [5, 'O'], kind: 'rejected_age' },
      { response: [7, 'O'], kind: 'rejected_actionable_reserve' },
    ] as const;

    for (const outcome of outcomes) {
      const { store } = createStore([outcome.response]);
      await expect(
        store.reserve({
          jobId,
          chatId: 'chat-secret',
          sourceCreatedAt,
          imageCount: 1,
          actionEligible: true,
          limits,
        }),
      ).resolves.toEqual({ kind: outcome.kind });
    }
  });

  it('returns the absorbing observation state on a duplicate reservation', async () => {
    const { redis, store } = createStore([
      [2, 'O'],
      [2, 'O'],
    ]);

    await expect(
      store.reserve({
        jobId,
        chatId: 'chat-secret',
        sourceCreatedAt,
        imageCount: 1,
        actionEligible: false,
        limits,
      }),
    ).resolves.toEqual({ kind: 'duplicate', state: 'observation' });
    await expect(
      store.reserve({
        jobId,
        chatId: 'chat-secret',
        sourceCreatedAt,
        imageCount: 1,
        actionEligible: true,
        limits,
      }),
    ).resolves.toEqual({ kind: 'duplicate', state: 'observation' });

    const script = String(redis.eval.mock.calls[0]![0]);
    expect(script).toContain(
      "ARGV[8] == 'O' and (stored_state ~= 'O' or capacity_held == '1')",
    );
    expect(script).toContain(
      'release_capacity(ARGV[1], stored_chat_hash, tonumber(stored_units), ARGV[12])',
    );
    expect(script).toContain("capacity_held = '0'");
    expect(script).not.toMatch(/stored_state\s*=\s*'P'/u);
    expect(redis.eval.mock.calls.map((call) => call[15])).toEqual(['O', 'P']);
  });

  it('activates only through a pending-to-actionable compare-and-set', async () => {
    const { redis, store } = createStore([1, 2, 0, -3, -1]);

    const activation = { jobId, tombstoneTtlMs: limits.reservationTtlMs };
    await expect(store.activate(activation)).resolves.toBe('activated');
    await expect(store.activate(activation)).resolves.toBe('already_actionable');
    await expect(store.activate(activation)).resolves.toBe('suppressed');
    await expect(store.activate(activation)).resolves.toBe('expired');
    await expect(store.activate(activation)).resolves.toBe('missing');

    const script = String(redis.eval.mock.calls[0]![0]);
    expect(redis.eval.mock.calls[0]![1]).toBe(3);
    expect(redis.eval.mock.calls[0]![4]).toBe('commercial-ocr:admission:v2:global:units');
    expect(redis.eval.mock.calls[0]![6]).toBe('commercial-ocr:admission:v2:chat:');
    expect(redis.eval.mock.calls[0]![7]).toBe(String(limits.reservationTtlMs));
    expect(script).toContain("state ~= 'P' and state ~= 'A' and state ~= 'O'");
    expect(script).toContain("chat_hash .. '|' .. units .. '|A|1'");
    expect(script).toContain('expires_at_ms <= now_ms');
    expect(script).toContain("chat_hash .. '|' .. units .. '|O|0'");
    expect(script).toContain("redis.call('HDEL', chat_weights, ARGV[1])");
    expect(script).toContain("redis.call('ZREM', chat_expiry, ARGV[1])");
    expect(script).toContain("redis.call('ZADD', KEYS[1], now_ms + tonumber(ARGV[3]), ARGV[1])");
    expect(script).toContain('extend_ttl(KEYS[2], key_ttl_ms)');
    expect(script).toContain('return -3');
    expect(script.indexOf('expires_at_ms <= now_ms')).toBeLessThan(
      script.indexOf("if state == 'A' then"),
    );
    expect(script).not.toContain("'|A|0'");
  });

  it('releases global and originating-chat capacity during global expiry cleanup', async () => {
    const { redis, store } = createStore([[1, 'P']]);

    await store.reserve({
      jobId,
      chatId: 'chat-secret',
      sourceCreatedAt,
      imageCount: 3,
      actionEligible: true,
      limits,
    });

    const call = redis.eval.mock.calls[0] as unknown[];
    const script = String(call[0]);
    expect(call[19]).toBe('commercial-ocr:admission:v2:chat:');
    expect(script).toContain(
      'release_capacity(expired_job_id, expired_chat_hash, tonumber(expired_units), ARGV[12])',
    );
    expect(script).toContain("redis.call('HDEL', origin_weights, job_id)");
    expect(script).toContain("redis.call('ZREM', origin_expiry, job_id)");
    expect(script).toContain('decrement_or_delete(origin_units_key, origin_units)');
  });

  it('creates an absorbing suppression tombstone even before reservation', async () => {
    const { redis, store } = createStore([1]);

    await expect(
      store.suppress({
        jobId,
        chatId: 'chat-secret',
        imageCount: 1,
        tombstoneTtlMs: limits.reservationTtlMs,
      }),
    ).resolves.toBe('suppressed');

    const call = redis.eval.mock.calls[0] as unknown[];
    const script = String(call[0]);
    expect(call[1]).toBe(6);
    expect(call[12]).toBe('100');
    expect(call[13]).toBe('commercial-ocr:admission:v2:chat:');
    expect(script).toContain("ARGV[2] .. '|' .. ARGV[3] .. '|O|0'");
    expect(script).toContain("capacity_held == '1'");
    expect(script).toContain('expired_job_id ~= ARGV[1]');
    expect(script).toContain("'LIMIT', 0, tonumber(ARGV[5])");
    expect(script).toContain(
      'release_capacity(expired_job_id, expired_chat_hash, tonumber(expired_units), ARGV[6])',
    );
    expect(script).toContain("stored_chat_hash .. '|' .. stored_units .. '|O|0'");
    expect(script).toContain("stored_chat_hash ~= ARGV[2]");
    expect(script).not.toContain('tonumber(stored_units) ~= tonumber(ARGV[3])');
    expect(script).toContain("redis.call('HDEL', KEYS[5], ARGV[1])");
    expect(script).toContain("redis.call('ZREM', KEYS[4], ARGV[1])");
    expect(script).toContain('math.max(current_expiry, expires_at_ms)');
    expect(script).not.toContain("'|P|");
    expect(script).not.toContain("'|A|");
  });

  it('resolves pending, actionable and observation states with an expiry fence', async () => {
    const { redis, store } = createStore([0, 1, 2, -1]);

    await expect(store.resolveState(jobId)).resolves.toEqual({
      kind: 'available',
      state: 'pending',
    });
    await expect(store.resolveState(jobId)).resolves.toEqual({
      kind: 'available',
      state: 'actionable',
    });
    await expect(store.resolveState(jobId)).resolves.toEqual({
      kind: 'available',
      state: 'observation',
    });
    await expect(store.resolveState(jobId)).resolves.toEqual({ kind: 'missing' });
    const script = String(redis.eval.mock.calls[0]![0]);
    expect(script).toContain("redis.call('TIME')");
    expect(script).toContain('expires_at_ms <= now_ms');
  });

  it('releases capacity while retaining an observation tombstone', async () => {
    const { redis, store } = createStore([1]);

    await expect(store.release({ jobId, chatId: 'chat-secret' })).resolves.toBe(true);

    const call = redis.eval.mock.calls[0] as unknown[];
    expect(call[1]).toBe(6);
    expect(call[8]).toBe(jobId);
    const script = String(call[0]);
    expect(script).toContain("capacity_held == '1'");
    expect(script).toContain('remaining_global <= 0');
    expect(script).toContain("redis.call('DEL', KEYS[3])");
    expect(script).toContain("stored_chat_hash .. '|' .. stored_units .. '|O|0'");
    expect(script).not.toContain("redis.call('HDEL', KEYS[2]");
  });

  it('fails closed for admission and fail-open for action state when Redis is unavailable', async () => {
    const { redis, store } = createStore([]);
    redis.eval.mockRejectedValue(new Error('redis unavailable'));

    await expect(
      store.reserve({
        jobId,
        chatId: 'chat-secret',
        sourceCreatedAt,
        imageCount: 1,
        actionEligible: true,
        limits,
      }),
    ).resolves.toEqual({ kind: 'unavailable' });
    await expect(store.resolveState(jobId)).resolves.toEqual({ kind: 'unavailable' });
    await expect(store.activate({ jobId, tombstoneTtlMs: limits.reservationTtlMs })).resolves.toBe(
      'unavailable',
    );
    await expect(
      store.suppress({
        jobId,
        chatId: 'chat-secret',
        imageCount: 1,
        tombstoneTtlMs: limits.reservationTtlMs,
      }),
    ).resolves.toBe('unavailable');
  });

  it('rejects invalid capacity and inconsistent TTL input before running Lua', async () => {
    const { redis, store } = createStore([]);

    await expect(
      store.reserve({
        jobId,
        chatId: 'chat-secret',
        sourceCreatedAt,
        imageCount: 10,
        actionEligible: true,
        limits: { ...limits, maxChatImageUnits: 101 },
      }),
    ).rejects.toThrow('maxChatImageUnits is invalid');
    await expect(
      store.reserve({
        jobId,
        chatId: 'chat-secret',
        sourceCreatedAt,
        imageCount: 1,
        actionEligible: true,
        limits: { ...limits, reservationTtlMs: 179_999 },
      }),
    ).rejects.toThrow('reservationTtlMs is invalid');
    await expect(
      store.reserve({
        jobId,
        chatId: 'chat-secret',
        sourceCreatedAt,
        imageCount: 1,
        actionEligible: false,
        limits: { ...limits, reservedActionableImageUnits: 101 },
      }),
    ).rejects.toThrow('reservedActionableImageUnits is invalid');
    expect(redis.eval).not.toHaveBeenCalled();
  });
});
