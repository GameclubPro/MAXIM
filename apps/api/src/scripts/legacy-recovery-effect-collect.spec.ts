import { Readable, Writable } from 'node:stream';
import Redis, { type RedisOptions } from 'ioredis';
import { createPrismaClient, Prisma, type PrismaClient } from '../prisma/prisma-client';
import { RUNTIME_SERVICE_NAMES } from '../runtime/runtime-topology';
import { type LegacyRecoveryCandidate } from '../webhook/webhook-legacy-cold-install';
import * as sqlInventory from './legacy-recovery-live-sql';
import * as redisInventory from './legacy-recovery-live-redis';
import {
  LEGACY_RECOVERY_LIVE_OUTPUT_MAX_BYTES,
  LEGACY_RECOVERY_LIVE_REQUEST_MAX_BYTES,
  legacyRecoveryLiveDigest,
  parseLegacyRecoveryLiveRequest,
  type LegacyRecoveryLiveRequest,
} from './legacy-recovery-live-protocol';
import {
  LEGACY_RECOVERY_LIVE_BUDGET,
  collectLegacyRecoveryLiveEvidence,
  readLegacyRecoveryLiveStdin,
  runLegacyRecoveryLiveCli,
} from './legacy-recovery-effect-collect';

jest.mock('ioredis', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../prisma/prisma-client', () => ({
  ...jest.requireActual<typeof import('../prisma/prisma-client')>('../prisma/prisma-client'),
  createPrismaClient: jest.fn(),
}));

type Adapters = NonNullable<Parameters<typeof collectLegacyRecoveryLiveEvidence>[3]>;
type SqlResult = Awaited<ReturnType<Adapters['sql']>>;
type RedisResult = Awaited<ReturnType<Adapters['redis']>>;
type RedisReader = Parameters<typeof collectLegacyRecoveryLiveEvidence>[1];
const noCost = { pages: 0, rows: 0, probes: 0, bytes: 0 };
const stageCost = { pages: 1, rows: 2, probes: 3, bytes: 64 };
const storeSecret = 'postgresql://fixture-user:DO_NOT_EXPOSE@offline.invalid/fixture';

function requestFixture(): LegacyRecoveryLiveRequest {
  const imageId = `sha256:${'b'.repeat(64)}`;
  const sourceSha = 'a'.repeat(40);
  const serviceNames = [
    ...RUNTIME_SERVICE_NAMES.filter((name) => name !== 'api-all'),
    'ocr-native-sandbox',
    'photo-native-sandbox',
  ];
  return parseLegacyRecoveryLiveRequest(
    JSON.stringify({
      version: 1,
      operation: 'inventory_preview',
      binding: {
        maintenanceId: '11111111-1111-4111-8111-111111111111',
        queueFenceNonce: 'fixture-offline-fence-20261006',
        transitionJournalSha256: 'c'.repeat(64),
        sourceSha,
        imageId,
        stoppedGenerations: serviceNames.map((serviceName, index) => ({
          serviceName,
          containerId: (index + 1).toString(16).padStart(64, '0'),
          imageId,
          sourceSha,
          stopped: true,
        })),
      },
      selection: { ownerWebhookEventIds: ['owner-a', 'owner-z'], majorBotIds: ['major-a'] },
    }),
  );
}

function candidate(ownerId: string): LegacyRecoveryCandidate {
  // The coordinator consumes identities/digests only; source validation belongs to the SQL adapter.
  return {
    owner: { id: ownerId, semanticKey: `semantic-${ownerId}` },
    claim: { id: `claim-${ownerId}` },
    source: {
      chatId: '-100',
      messageId: `message-${ownerId}`,
      userId: 'fixture-user',
      sourceAt: new Date('2026-10-06T00:00:00Z'),
    },
    rawPayloadDigest: 'd'.repeat(64),
    normalizedPayloadDigest: 'e'.repeat(64),
  } as LegacyRecoveryCandidate;
}

function sqlFixture(): SqlResult {
  const candidates = ['owner-a', 'owner-z'].map(candidate);
  return {
    candidates,
    selectedOwners: candidates.map((row) => ({
      ownerWebhookEventId: row.owner.id,
      semanticKey: row.owner.semanticKey!,
      claimId: row.claim.id,
      chatId: row.source.chatId,
      messageId: row.source.messageId,
      userId: row.source.userId,
      sourceAt: row.source.sourceAt.toISOString(),
      rawPayloadSha256: row.rawPayloadDigest,
      normalizedPayloadSha256: row.normalizedPayloadDigest,
      ownerSnapshotSha256: 'f'.repeat(64),
      claimSnapshotSha256: '0'.repeat(64),
    })),
    proofs: [],
    stableDigest: '1'.repeat(64),
    cost: { ...stageCost },
    issues: [],
  };
}

function redisFixture(): RedisResult {
  return {
    children: [
      {
        jobKey: 'child-a',
        queueName: 'max-action',
        jobPayloadDigest: '2'.repeat(64),
        chatId: '-100',
        messageId: 'message-owner-a',
        userId: 'fixture-user',
      },
    ],
    proofs: [],
    stableDigest: '3'.repeat(64),
    cost: { ...stageCost },
    issues: [],
  };
}

function adapterFixture() {
  return {
    sql: jest
      .fn<ReturnType<Adapters['sql']>, Parameters<Adapters['sql']>>()
      .mockResolvedValue(sqlFixture()),
    redis: jest
      .fn<ReturnType<Adapters['redis']>, Parameters<Adapters['redis']>>()
      .mockResolvedValue(redisFixture()),
  } satisfies Adapters;
}

function outputFixture() {
  let text = '';
  const output = new Writable({
    write(chunk, _encoding, done) {
      text += chunk.toString();
      done();
    },
  });
  return { output, text: () => text, json: () => JSON.parse(text) as Record<string, unknown> };
}

describe('read-only legacy recovery evidence coordinator', () => {
  const tx = {} as Prisma.TransactionClient;
  const redis = {} as RedisReader;

  afterEach(() => jest.restoreAllMocks());

  it('uses one SQL snapshot, reads Redis twice and never authorizes installation or effects', async () => {
    const request = requestFixture();
    const adapters = adapterFixture();
    const result = await collectLegacyRecoveryLiveEvidence(tx, redis, request, adapters);
    expect(result).toMatchObject({
      applied: false,
      activationAuthorized: false,
      decision: 'READY_TO_INSTALL',
      cost: { pages: 3, rows: 6, probes: 9, bytes: 192 },
      issues: [],
      selectionSha256: legacyRecoveryLiveDigest(request.selection),
    });
    expect(result.inventorySha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(adapters.sql).toHaveBeenCalledTimes(1);
    expect(adapters.sql.mock.calls[0][0]).toBe(tx);
    expect(adapters.redis).toHaveBeenCalledTimes(2);
    expect(adapters.redis.mock.calls[0][0]).toBe(redis);
    expect(adapters.redis.mock.calls[0][2]).toEqual(
      sqlFixture().candidates.map((row) => row.source),
    );
    expect(adapters.redis.mock.calls[1][2]).toEqual(adapters.redis.mock.calls[0][2]);
    expect(adapters.redis.mock.calls[0][3]).toMatchObject({
      pages: LEGACY_RECOVERY_LIVE_BUDGET.pages - stageCost.pages,
      rows: LEGACY_RECOVERY_LIVE_BUDGET.rows - stageCost.rows,
      probes: LEGACY_RECOVERY_LIVE_BUDGET.probes - stageCost.probes,
      bytes: LEGACY_RECOVERY_LIVE_BUDGET.bytes - stageCost.bytes,
    });
    expect(adapters.redis.mock.calls[1][3].rows).toBe(LEGACY_RECOVERY_LIVE_BUDGET.rows - 4);
  });

  it('strictly revalidates direct callers before touching either store', async () => {
    const adapters = adapterFixture();
    const request = { ...requestFixture(), activate: true };
    await expect(collectLegacyRecoveryLiveEvidence(tx, redis, request, adapters)).rejects.toThrow(
      'Unknown offline inventory field',
    );
    expect(adapters.sql).not.toHaveBeenCalled();
    expect(adapters.redis).not.toHaveBeenCalled();
  });

  it('refuses a Redis race while preserving safe diagnostics from the first read', async () => {
    const adapters = adapterFixture();
    adapters.redis.mockResolvedValueOnce(redisFixture()).mockResolvedValueOnce({
      ...redisFixture(),
      stableDigest: '4'.repeat(64),
    });
    const result = await collectLegacyRecoveryLiveEvidence(tx, redis, requestFixture(), adapters);
    expect(result).toMatchObject({
      decision: 'DENY',
      inventorySha256: null,
      issues: [{ code: 'redis_inventory_changed', descriptor: 'redis:all' }],
      children: redisFixture().children,
    });
  });

  it('refuses an incomplete owner proof and still collects catalog diagnostics', async () => {
    const adapters = adapterFixture();
    adapters.sql.mockResolvedValue({ ...sqlFixture(), candidates: [candidate('owner-a')] });
    const result = await collectLegacyRecoveryLiveEvidence(tx, redis, requestFixture(), adapters);
    expect(result).toMatchObject({ decision: 'DENY', inventorySha256: null });
    expect(result.issues).toContainEqual({
      code: 'selected_owner_proof_incomplete',
      descriptor: 'sql:webhook_events',
    });
    expect(adapters.redis).toHaveBeenCalledTimes(2);
  });

  it.each(['duplicate', 'foreign'] as const)(
    'does not mistake an equal count of %s owners for the exact requested selection',
    async (kind) => {
      const adapters = adapterFixture();
      adapters.sql.mockResolvedValue({
        ...sqlFixture(),
        candidates: [
          candidate('owner-a'),
          candidate(kind === 'duplicate' ? 'owner-a' : 'foreign-owner'),
        ],
      });
      const result = await collectLegacyRecoveryLiveEvidence(tx, redis, requestFixture(), adapters);
      expect(result).toMatchObject({ decision: 'DENY', inventorySha256: null });
      expect(result.issues).toContainEqual({
        code: 'selected_owner_proof_incomplete',
        descriptor: 'sql:webhook_events',
      });
    },
  );

  it('deduplicates issues and returns them in a stable descriptor/code order', async () => {
    const adapters = adapterFixture();
    const first = { code: 'z-code', descriptor: 'sql:z' };
    adapters.sql.mockResolvedValue({
      ...sqlFixture(),
      issues: [first, { code: 'b-code', descriptor: 'sql:a' }],
    });
    adapters.redis.mockResolvedValue({
      ...redisFixture(),
      issues: [first, { code: 'a-code', descriptor: 'sql:a' }],
    });
    const result = await collectLegacyRecoveryLiveEvidence(tx, redis, requestFixture(), adapters);
    expect(result.issues).toEqual([
      { code: 'a-code', descriptor: 'sql:a' },
      { code: 'b-code', descriptor: 'sql:a' },
      first,
    ]);
    expect(result.inventorySha256).toBeNull();
  });

  it('requires an unchanged reviewed inventory digest on subsequent reads', async () => {
    const baseline = await collectLegacyRecoveryLiveEvidence(
      tx,
      redis,
      requestFixture(),
      adapterFixture(),
    );
    const request = { ...requestFixture(), expectedInventorySha256: baseline.inventorySha256! };
    const same = await collectLegacyRecoveryLiveEvidence(tx, redis, request, adapterFixture());
    expect(same.inventorySha256).toBe(baseline.inventorySha256);
    expect(same.decision).toBe('READY_TO_INSTALL');
    const adapters = adapterFixture();
    adapters.sql.mockResolvedValue({ ...sqlFixture(), stableDigest: '5'.repeat(64) });
    const changed = await collectLegacyRecoveryLiveEvidence(tx, redis, request, adapters);
    expect(changed).toMatchObject({
      decision: 'DENY',
      inventorySha256: null,
      issues: [{ code: 'reviewed_inventory_changed', descriptor: 'inventory' }],
    });
  });

  it.each(['pages', 'rows', 'probes', 'bytes'] as const)(
    'enforces one shared %s budget across SQL and both Redis reads',
    async (field) => {
      const adapters = adapterFixture();
      adapters.sql.mockResolvedValue({
        ...sqlFixture(),
        cost: { ...noCost, [field]: LEGACY_RECOVERY_LIVE_BUDGET[field] - 1 },
      });
      adapters.redis.mockResolvedValue({ ...redisFixture(), cost: { ...noCost, [field]: 1 } });
      const result = await collectLegacyRecoveryLiveEvidence(tx, redis, requestFixture(), adapters);
      expect(result).toMatchObject({
        decision: 'DENY',
        inventorySha256: null,
        issues: [{ code: 'inventory_store_or_budget_refused', descriptor: 'inventory' }],
      });
      expect(adapters.redis).toHaveBeenCalledTimes(2);
      expect(adapters.redis.mock.calls[1][3][field]).toBe(0);
    },
  );

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'refuses invalid adapter accounting %s',
    async (rows) => {
      const adapters = adapterFixture();
      adapters.sql.mockResolvedValue({ ...sqlFixture(), cost: { ...noCost, rows } });
      const result = await collectLegacyRecoveryLiveEvidence(tx, redis, requestFixture(), adapters);
      expect(result.decision).toBe('DENY');
      expect(result.issues).toContainEqual({
        code: 'inventory_store_or_budget_refused',
        descriptor: 'inventory',
      });
      expect(adapters.redis).not.toHaveBeenCalled();
    },
  );

  it('does not begin Redis work after SQL consumes the absolute deadline', async () => {
    let now = 1_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const adapters = adapterFixture();
    adapters.sql.mockImplementation(async () => {
      now += LEGACY_RECOVERY_LIVE_BUDGET.durationMs;
      return sqlFixture();
    });
    const result = await collectLegacyRecoveryLiveEvidence(tx, redis, requestFixture(), adapters);
    expect(result.decision).toBe('DENY');
    expect(adapters.redis).not.toHaveBeenCalled();
  });

  it('refuses a result that completes at the deadline even when both Redis digests agree', async () => {
    let now = 1_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const adapters = adapterFixture();
    adapters.redis.mockResolvedValueOnce(redisFixture()).mockImplementationOnce(async () => {
      now += LEGACY_RECOVERY_LIVE_BUDGET.durationMs;
      return redisFixture();
    });
    const result = await collectLegacyRecoveryLiveEvidence(tx, redis, requestFixture(), adapters);
    expect(result.decision).toBe('DENY');
    expect(result.inventorySha256).toBeNull();
  });

  it.each(['sql', 'first_redis', 'second_redis'] as const)(
    'sanitizes an asynchronous %s failure without printing raw store errors',
    async (phase) => {
      const adapters = adapterFixture();
      const error = new Error(storeSecret);
      if (phase === 'sql') adapters.sql.mockRejectedValue(error);
      if (phase === 'first_redis') adapters.redis.mockRejectedValueOnce(error);
      if (phase === 'second_redis')
        adapters.redis.mockResolvedValueOnce(redisFixture()).mockRejectedValueOnce(error);
      const result = await collectLegacyRecoveryLiveEvidence(tx, redis, requestFixture(), adapters);
      expect(result).toMatchObject({ decision: 'DENY', inventorySha256: null });
      expect(result.issues).toContainEqual({
        code: 'inventory_store_or_budget_refused',
        descriptor: 'inventory',
      });
      expect(JSON.stringify(result)).not.toContain('DO_NOT_EXPOSE');
      expect(JSON.stringify(result)).not.toContain(storeSecret);
    },
  );

  it('bounds actual serialized output separately from adapter byte accounting', async () => {
    const adapters = adapterFixture();
    adapters.redis.mockResolvedValue({
      ...redisFixture(),
      children: [
        {
          ...redisFixture().children[0],
          jobKey: 'x'.repeat(LEGACY_RECOVERY_LIVE_OUTPUT_MAX_BYTES),
        },
      ],
      cost: { ...noCost },
    });
    const result = await collectLegacyRecoveryLiveEvidence(tx, redis, requestFixture(), adapters);
    expect(result).toMatchObject({
      decision: 'DENY',
      inventorySha256: null,
      selectedOwners: [],
      children: [],
      sqlPlans: [],
      issues: [{ code: 'inventory_output_budget_exceeded', descriptor: 'inventory' }],
    });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(
      LEGACY_RECOVERY_LIVE_OUTPUT_MAX_BYTES,
    );
  });
});

describe('bounded legacy recovery stdin', () => {
  afterEach(() => jest.useRealTimers());

  it('preserves UTF-8 characters split across Buffer chunks', async () => {
    const bytes = Buffer.from('проверка');
    await expect(
      readLegacyRecoveryLiveStdin(Readable.from([bytes.subarray(0, 1), bytes.subarray(1)])),
    ).resolves.toBe('проверка');
  });

  it('accepts the exact byte bound and rejects a subsequent chunk', async () => {
    const bytes = Buffer.alloc(LEGACY_RECOVERY_LIVE_REQUEST_MAX_BYTES, ' ');
    await expect(readLegacyRecoveryLiveStdin(Readable.from([bytes]))).resolves.toHaveLength(
      bytes.byteLength,
    );
    await expect(
      readLegacyRecoveryLiveStdin(Readable.from([bytes, Buffer.from(' ')])),
    ).rejects.toThrow('Offline stdin request budget exceeded');
  });

  it('destroys a stalled input at its fixed deadline', async () => {
    jest.useFakeTimers();
    const input = new Readable({ read() {} });
    const pending = readLegacyRecoveryLiveStdin(input);
    const rejected = expect(pending).rejects.toThrow('Offline stdin deadline exceeded');
    await jest.advanceTimersByTimeAsync(5_000);
    await rejected;
    expect(input.destroyed).toBe(true);
  });
});

describe('offline legacy recovery CLI boundary', () => {
  const savedDatabaseUrl = process.env.DATABASE_URL;
  const savedRedisUrl = process.env.REDIS_URL;
  const mockCreatePrisma = jest.mocked(createPrismaClient);
  const mockRedisConstructor = Redis as unknown as jest.Mock<Redis, [string, RedisOptions]>;

  beforeEach(() => {
    mockCreatePrisma.mockReset();
    mockRedisConstructor.mockReset();
    process.env.DATABASE_URL = 'postgresql://fixture@localhost/fixture';
    process.env.REDIS_URL = 'redis://localhost:6379';
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDatabaseUrl;
    if (savedRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = savedRedisUrl;
  });

  it.each(['invalid JSON', 'unknown operation', 'unknown nested field', 'oversize'])(
    'refuses %s before constructing either store client',
    async (failure) => {
      const request = requestFixture();
      let input = '!';
      if (failure === 'unknown operation')
        input = JSON.stringify({ ...request, operation: 'apply' });
      if (failure === 'unknown nested field')
        input = JSON.stringify({ ...request, selection: { ...request.selection, all: true } });
      if (failure === 'oversize') input = ' '.repeat(LEGACY_RECOVERY_LIVE_REQUEST_MAX_BYTES + 1);
      const sink = outputFixture();
      await expect(runLegacyRecoveryLiveCli(Readable.from([input]), sink.output)).resolves.toBe(1);
      expect(sink.json()).toMatchObject({
        applied: false,
        activationAuthorized: false,
        decision: 'DENY',
        refused: true,
        code: 'inventory_request_or_store_refused',
      });
      expect(sink.text().trim().split('\n')).toHaveLength(1);
      expect(mockCreatePrisma).not.toHaveBeenCalled();
      expect(mockRedisConstructor).not.toHaveBeenCalled();
    },
  );

  it('refuses a valid request without both configured stores before opening a client', async () => {
    delete process.env.REDIS_URL;
    const sink = outputFixture();
    await expect(
      runLegacyRecoveryLiveCli(Readable.from([JSON.stringify(requestFixture())]), sink.output),
    ).resolves.toBe(1);
    expect(mockCreatePrisma).not.toHaveBeenCalled();
    expect(mockRedisConstructor).not.toHaveBeenCalled();
  });

  it('never places a store constructor error or credentials in stdout', async () => {
    mockCreatePrisma.mockImplementation(() => {
      throw new Error(storeSecret);
    });
    const sink = outputFixture();
    await expect(
      runLegacyRecoveryLiveCli(Readable.from([JSON.stringify(requestFixture())]), sink.output),
    ).resolves.toBe(1);
    expect(sink.json()).toMatchObject({ code: 'inventory_request_or_store_refused' });
    expect(sink.text()).not.toContain('DO_NOT_EXPOSE');
    expect(sink.text()).not.toContain(storeSecret);
    expect(mockRedisConstructor).not.toHaveBeenCalled();
  });

  it('sanitizes Redis connection errors and closes clients before exiting', async () => {
    const prisma = { $transaction: jest.fn(), $disconnect: jest.fn().mockResolvedValue(undefined) };
    const redis = {
      connect: jest.fn().mockRejectedValue(new Error(storeSecret)),
      on: jest.fn(),
      disconnect: jest.fn(),
    };
    mockCreatePrisma.mockReturnValue(prisma as unknown as PrismaClient);
    mockRedisConstructor.mockImplementation(() => redis as unknown as Redis);
    const sink = outputFixture();
    await expect(
      runLegacyRecoveryLiveCli(Readable.from([JSON.stringify(requestFixture())]), sink.output),
    ).resolves.toBe(1);
    expect(sink.json()).toMatchObject({
      decision: 'DENY',
      code: 'inventory_request_or_store_refused',
    });
    expect(sink.text()).not.toContain('DO_NOT_EXPOSE');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(redis.disconnect).toHaveBeenCalledTimes(1);
    expect(prisma.$disconnect).toHaveBeenCalledTimes(1);
  });

  it('uses read-only repeatable SQL, disables Redis retries and closes both clients', async () => {
    const tx = { $executeRaw: jest.fn().mockResolvedValue(0) };
    const prisma = {
      $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) =>
        callback(tx),
      ),
      $disconnect: jest.fn().mockResolvedValue(undefined),
    };
    const redis = {
      connect: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
      disconnect: jest.fn(),
    };
    mockCreatePrisma.mockReturnValue(prisma as unknown as PrismaClient);
    mockRedisConstructor.mockImplementation(() => redis as unknown as Redis);
    jest.spyOn(sqlInventory, 'inventoryLegacyRecoveryLiveSql').mockResolvedValue(sqlFixture());
    jest
      .spyOn(redisInventory, 'inventoryLegacyRecoveryLiveRedis')
      .mockResolvedValue(redisFixture());
    const sink = outputFixture();
    await expect(
      runLegacyRecoveryLiveCli(Readable.from([JSON.stringify(requestFixture())]), sink.output),
    ).resolves.toBe(0);
    expect(sink.json()).toMatchObject({
      decision: 'READY_TO_INSTALL',
      applied: false,
      activationAuthorized: false,
    });
    expect(mockCreatePrisma).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        max: 1,
        options: '-c default_transaction_read_only=on',
        statement_timeout: 5_000,
      }),
    );
    expect(mockRedisConstructor).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 0,
      }),
    );
    const connectionOptions = mockRedisConstructor.mock.calls[0][1];
    expect(connectionOptions).toEqual(
      expect.objectContaining({ retryStrategy: expect.any(Function) }),
    );
    expect((connectionOptions as { retryStrategy: () => null }).retryStrategy()).toBeNull();
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      maxWait: 3_000,
      timeout: LEGACY_RECOVERY_LIVE_BUDGET.durationMs + 5_000,
    });
    expect(tx.$executeRaw.mock.calls.map((call) => String(call[0]))).toEqual([
      'SET TRANSACTION READ ONLY',
      "SET LOCAL lock_timeout = '1s'",
      "SET LOCAL statement_timeout = '5s'",
      "SET LOCAL idle_in_transaction_session_timeout = '35s'",
    ]);
    expect(redis.disconnect).toHaveBeenCalledTimes(1);
    expect(prisma.$disconnect).toHaveBeenCalledTimes(1);
  });
});
