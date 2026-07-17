import { RedisCounterService } from './redis-counter.service';

function createService(evalResult: unknown) {
  const redis = {
    eval: jest.fn().mockResolvedValue(evalResult),
  };
  const service = Object.create(RedisCounterService.prototype) as RedisCounterService;
  Object.defineProperty(service, 'redis', { value: redis });
  return { redis, service };
}

describe('RedisCounterService replayable deadline counter', () => {
  it('keeps the server deadline check before every mutation', async () => {
    const { redis, service } = createService([0, 0]);

    await expect(
      service.incrementOncePerMemberWithTtlBeforeDeadline(
        'counter-key',
        'member-key',
        61,
        1_800_000_000_000,
      ),
    ).resolves.toEqual({ kind: 'deadline_exceeded' });

    const [script, keyCount, counterKey, memberKey, ttl, deadline] = redis.eval.mock.calls[0]!;
    const deadlineBranchAt = String(script).indexOf('if now_ms >= tonumber(ARGV[2]) then');
    expect(deadlineBranchAt).toBeGreaterThanOrEqual(0);
    expect(String(script).indexOf("redis.call('INCR'", deadlineBranchAt)).toBeGreaterThan(
      deadlineBranchAt,
    );
    expect(String(script).indexOf("redis.call('SET'", deadlineBranchAt)).toBeGreaterThan(
      deadlineBranchAt,
    );
    expect([keyCount, counterKey, memberKey, ttl, deadline]).toEqual([
      2,
      'counter-key',
      'member-key',
      '61',
      '1800000000000',
    ]);
  });

  it('does not extend an existing counter near expiry and retains the replay value', async () => {
    const { redis, service } = createService([1, 7]);

    await service.incrementOncePerMemberWithTtlBeforeDeadline(
      'counter-key',
      'member-key',
      61,
      1_800_000_000_000,
    );

    const script = String(redis.eval.mock.calls[0]?.[0] ?? '');
    expect(script).toContain("local counter_pttl = redis.call('PTTL', KEYS[1])");
    expect(script).toContain('if counter_pttl < 0 then');
    expect(script).not.toContain('if counter_pttl < 1 then');
    expect(script).toContain("redis.call('PEXPIRE', KEYS[1], full_ttl_ms)");
    expect(script).toContain("redis.call('SET', KEYS[2], tostring(count), 'PX', full_ttl_ms)");
  });

  it.each([
    { response: [1, 7] as [number, number], expected: { kind: 'inserted', count: 7 } },
    { response: [2, 7] as [number, number], expected: { kind: 'replayed', count: 7 } },
  ])('maps a replayable Redis result: $expected.kind', async ({ response, expected }) => {
    const { service } = createService(response);

    await expect(
      service.incrementOncePerMemberWithTtlBeforeDeadline(
        'counter-key',
        'member-key',
        61,
        1_800_000_000_000,
      ),
    ).resolves.toEqual(expected);
  });

  it('rejects malformed counter results instead of silently changing semantics', async () => {
    const { service } = createService([2, -1]);

    await expect(
      service.incrementOncePerMemberWithTtlBeforeDeadline(
        'counter-key',
        'member-key',
        61,
        1_800_000_000_000,
      ),
    ).rejects.toThrow('invalid replayable counter result');
  });
});

describe('RedisCounterService deadline lock', () => {
  it('checks Redis time before creating the lock and uses the caller token', async () => {
    const { redis, service } = createService(0);

    await expect(
      service.acquireLockBeforeDeadline('lock-key', 'caller-token', 45_000, 1_800_000_000_000),
    ).resolves.toEqual({ kind: 'deadline_exceeded' });

    const [script, keyCount, key, token, ttlMs, deadlineAtMs] = redis.eval.mock.calls[0]!;
    const lua = String(script);
    const deadlineBranchAt = lua.indexOf('if now_ms >= tonumber(ARGV[3]) then');
    const firstSetAt = lua.indexOf("redis.call('SET'");
    expect(deadlineBranchAt).toBeGreaterThanOrEqual(0);
    expect(firstSetAt).toBeGreaterThan(deadlineBranchAt);
    expect([keyCount, key, token, ttlMs, deadlineAtMs]).toEqual([
      1,
      'lock-key',
      'caller-token',
      '45000',
      '1800000000000',
    ]);
  });

  it.each([
    { response: 0, expected: { kind: 'deadline_exceeded' } },
    { response: 1, expected: { kind: 'acquired' } },
    { response: 2, expected: { kind: 'busy' } },
  ])('maps deadline lock status $response', async ({ response, expected }) => {
    const { service } = createService(response);

    await expect(
      service.acquireLockBeforeDeadline('lock-key', 'caller-token', 45_000, Date.now() + 1_000),
    ).resolves.toEqual(expected);
  });

  it('rejects malformed lock results instead of treating them as contention', async () => {
    const { service } = createService(3);

    await expect(
      service.acquireLockBeforeDeadline('lock-key', 'caller-token', 45_000, Date.now() + 1_000),
    ).rejects.toThrow('invalid deadline lock acquisition result');
  });
});
