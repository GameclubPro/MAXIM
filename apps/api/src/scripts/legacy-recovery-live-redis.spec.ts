import {
  inventoryLegacyRecoveryLiveRedis,
  type LegacyRecoveryLiveRedisSource,
  type LegacyRecoveryLiveRedisAllowance,
  type LegacyRecoveryLiveSourceResolver,
} from './legacy-recovery-live-redis';
import type { LegacyRecoveryLiveRequest } from './legacy-recovery-live-protocol';
import {
  LEGACY_RECOVERY_LIVE_QUEUE_NAMES,
  LEGACY_RECOVERY_LIVE_QUEUE_STATES,
} from './legacy-recovery-live-registry';
import { legacySnapshotDigest } from '../webhook/webhook-legacy-cold-install';

const request: LegacyRecoveryLiveRequest = {
  version: 1,
  operation: 'inventory_preview',
  binding: {
    maintenanceId: '11111111-1111-1111-1111-111111111111',
    queueFenceNonce: 'f'.repeat(32),
    transitionJournalSha256: 'a'.repeat(64),
    sourceSha: 'b'.repeat(40),
    imageId: `sha256:${'c'.repeat(64)}`,
    stoppedGenerations: [],
  },
  selection: { ownerWebhookEventIds: ['selected-owner'], majorBotIds: ['major-1'] },
};
const sources: LegacyRecoveryLiveRedisSource[] = [
  {
    chatId: 'chat-a',
    messageId: 'message-a',
    userId: 'user-u',
    sourceAt: new Date('2026-10-01T00:00:00Z'),
  },
];
const allowance = (): LegacyRecoveryLiveRedisAllowance => ({
  pages: 512,
  rows: 10_000,
  probes: 50_000,
  bytes: 8 * 1024 * 1024,
  deadlineAtMs: Date.now() + 60_000,
});
type FakeJob = {
  queue: string;
  id: string;
  state: string;
  data: unknown;
  fields?: Record<string, string>;
  score?: string;
};
function fixture(jobs: FakeJob[] = [], extraKeys: string[] = []) {
  const headers = (): unknown[][] =>
    [...LEGACY_RECOVERY_LIVE_QUEUE_NAMES]
      .sort()
      .map((name) => [
        name,
        '1',
        '1',
        'bullmq:5',
        ...LEGACY_RECOVERY_LIVE_QUEUE_STATES.map(
          (state) => jobs.filter((job) => job.queue === name && job.state === state).length,
        ),
        0,
      ]);
  const wire = (job: FakeJob): unknown[] => [
    job.id,
    job.state,
    Object.entries({
      data: JSON.stringify(job.data),
      opts: '{}',
      name: 'fixture',
      ...job.fields,
    }).flat(),
    0,
    job.score ?? (['wait', 'paused', 'active'].includes(job.state) ? '' : '1'),
  ];
  const redis = {
    eval_ro: jest.fn(
      async (script: string, keyCount: number, ...args: string[]): Promise<unknown> => {
        expect(keyCount).toBe(0);
        if (script.startsWith('-- legacy-live:catalog'))
          return [
            1,
            jobs.length + extraKeys.length + 1,
            '0',
            [...jobs.map((job) => `bull:${job.queue}:${job.id}`), ...extraKeys],
          ];
        if (script.startsWith('-- legacy-live:headers')) return [1, 100, headers()];
        if (script.startsWith('-- legacy-live:owners')) {
          const owners = JSON.parse(args[1]) as string[];
          const start = Number(args[2]);
          return [
            1,
            8,
            owners.length - start,
            jobs
              .filter(
                (job) => args[0] === `bull:${job.queue}:` && owners.slice(start).includes(job.id),
              )
              .map(wire),
          ];
        }
        if (script.startsWith('-- legacy-live:jobs')) {
          const selected = jobs
            .filter((job) => args[0] === `bull:${job.queue}:` && args[1] === job.state)
            .slice(Number(args[2]), Number(args[2]) + Number(args[3]));
          return [1, selected.length * 8 + 1, selected.length, selected.map(wire)];
        }
        throw new Error('Unexpected read');
      },
    ),
  };
  return { redis, jobs };
}
const action = (patch: Record<string, unknown> = {}) => ({
  actionType: 'DELETE_MESSAGE',
  chatId: 'chat-a',
  messageId: 'message-a',
  userId: 'user-u',
  idempotencyKey: 'effect-a',
  createdAt: '2026-10-01T00:00:01Z',
  attempt: 0,
  ...patch,
});

describe('bounded read-only live Redis inventory', () => {
  it('includes message-retention and completed jobs without Queue construction', async () => {
    const data = action();
    const { redis } = fixture([
      { queue: 'max-actions-background', id: 'max-a', state: 'completed', data },
    ]);
    const result = await inventoryLegacyRecoveryLiveRedis(redis, request, sources, allowance());
    expect(result.issues).toEqual([]);
    expect(result.children).toEqual([
      {
        jobKey: 'effect-a',
        queueName: 'max-actions-background',
        jobPayloadDigest: legacySnapshotDigest(data),
        chatId: 'chat-a',
        messageId: 'message-a',
        userId: 'user-u',
      },
    ]);
    expect(result.proofs.some((proof) => proof.descriptor === 'message-retention')).toBe(true);
    expect(
      redis.eval_ro.mock.calls.every(
        (call) => !/redis\.call\('(SET|DEL|HSET|LPUSH|ZADD)'/u.test(call[0]),
      ),
    ).toBe(true);
  });

  it('retains proven independent member work and a concrete independent message source', async () => {
    const { redis } = fixture([
      {
        queue: 'moderation-actions',
        id: 'independent-member',
        state: 'wait',
        data: action({
          actionType: 'BAN_MEMBER',
          chatId: 'chat-b',
          userId: 'user-v',
          messageId: undefined,
          idempotencyKey: 'effect-v',
        }),
      },
      {
        queue: 'max-actions-critical',
        id: 'independent-message',
        state: 'failed',
        data: action({
          chatId: 'chat-b',
          userId: 'user-v',
          messageId: 'message-v',
          idempotencyKey: 'effect-v2',
        }),
      },
    ]);
    const result = await inventoryLegacyRecoveryLiveRedis(redis, request, sources, allowance());
    expect(result.issues).toEqual([]);
    expect(result.children).toEqual([]);
  });

  it('never lets an unrelated target hide nested related source ancestry', async () => {
    const { redis } = fixture([
      {
        queue: 'moderation-actions',
        id: 'nested',
        state: 'delayed',
        data: action({
          chatId: 'chat-b',
          userId: 'user-v',
          messageId: 'message-v',
          ledgerContext: {
            moderationSource: { chatId: 'chat-a', messageId: 'message-a', userId: 'user-u' },
          },
        }),
      },
    ]);
    const result = await inventoryLegacyRecoveryLiveRedis(redis, request, sources, allowance());
    expect(result.children).toHaveLength(1);
    expect(result.children[0].chatId).toBe('chat-b');
    expect(result.issues).toContainEqual({
      code: 'CROSS_CHAT_CHILD_INSTALL_UNSUPPORTED',
      descriptor: 'moderation-actions',
    });
  });

  it('denies unsupported nested origins and routing references even with an independent target', async () => {
    const { redis } = fixture([
      {
        queue: 'moderation-actions',
        id: 'opaque',
        state: 'wait',
        data: action({
          chatId: 'chat-b',
          userId: 'user-v',
          messageId: 'message-v',
          routing: { purpose: 'moderation_action', sourceJobId: 'old-child' },
          origin: { uid: 'user-u' },
        }),
      },
    ]);
    const result = await inventoryLegacyRecoveryLiveRedis(redis, request, sources, allowance());
    expect(result.issues).toContainEqual({
      code: 'MAX_CHILD_PARENT_PROVENANCE_UNKNOWN',
      descriptor: 'moderation-actions',
    });
  });

  it('denies opaque non-MAX parents and generic SEND provenance instead of inventing independence', async () => {
    const { redis } = fixture([
      {
        queue: 'publisher-suggestion-publication',
        id: 'publication',
        state: 'completed',
        data: { publicationId: 'opaque-parent', source: 'miniapp', actorAlreadyVerified: true },
      },
      {
        queue: 'max-actions-background',
        id: 'send',
        state: 'wait',
        data: action({
          actionType: 'SEND_MESSAGE',
          messageId: undefined,
          userId: undefined,
          text: 'fixture',
        }),
      },
    ]);
    const result = await inventoryLegacyRecoveryLiveRedis(redis, request, sources, allowance());
    expect(result.issues).toContainEqual({
      code: 'NON_MAX_PARENT_PROVENANCE_UNKNOWN',
      descriptor: 'publisher-suggestion-publication',
    });
    expect(result.issues).toContainEqual({
      code: 'MAX_CHILD_SOURCE_UNVERIFIED',
      descriptor: 'max-actions-background',
    });
  });

  it('validates exact selected webhook ownership, reading no unrelated webhook payloads', async () => {
    const { redis } = fixture([
      {
        queue: 'moderation-default-0',
        id: 'selected-owner',
        state: 'paused',
        data: { webhookEventId: 'selected-owner' },
      },
      ...Array.from({ length: 100 }, (_, i) => ({
        queue: 'moderation-default-0',
        id: `unrelated-${i}`,
        state: 'paused',
        data: { webhookEventId: `unrelated-${i}`, text: 'never read' },
      })),
    ]);
    const result = await inventoryLegacyRecoveryLiveRedis(redis, request, sources, allowance());
    expect(result.issues).toEqual([]);
    expect(result.cost.rows).toBe(1);
    expect(redis.eval_ro.mock.calls.some((call) => call[0].startsWith('-- legacy-live:jobs'))).toBe(
      false,
    );
    for (const call of redis.eval_ro.mock.calls.filter((call) =>
      call[0].startsWith('-- legacy-live:owners'),
    ))
      expect(JSON.parse(call[3])).toEqual(['selected-owner']);
  });

  it('denies ownership mismatch and the same owner appearing in two queues', async () => {
    const bad = fixture([
      {
        queue: 'moderation',
        id: 'selected-owner',
        state: 'failed',
        data: { webhookEventId: 'someone-else' },
      },
    ]);
    expect(
      (
        await inventoryLegacyRecoveryLiveRedis(bad.redis, request, sources, allowance())
      ).issues.some((issue) => issue.code === 'WEBHOOK_OWNER_PAYLOAD_MISMATCH'),
    ).toBe(true);
    const duplicate = fixture([
      {
        queue: 'moderation',
        id: 'selected-owner',
        state: 'failed',
        data: { webhookEventId: 'selected-owner' },
      },
      {
        queue: 'moderation-critical',
        id: 'selected-owner',
        state: 'failed',
        data: { webhookEventId: 'selected-owner' },
      },
    ]);
    expect(
      (
        await inventoryLegacyRecoveryLiveRedis(duplicate.redis, request, sources, allowance())
      ).issues.some((issue) => issue.code === 'WEBHOOK_OWNER_MULTIPLE_QUEUES'),
    ).toBe(true);
  });

  it('denies unknown namespaces, orphaned hashes and duplicate state membership', async () => {
    const unknown = fixture([], ['bull:unreviewed:1']);
    expect(
      (
        await inventoryLegacyRecoveryLiveRedis(unknown.redis, request, sources, allowance())
      ).issues.some((issue) => issue.code === 'UNKNOWN_QUEUE_NAMESPACE'),
    ).toBe(true);
    const orphan = fixture([], ['bull:message-retention:orphan']);
    expect(
      (await inventoryLegacyRecoveryLiveRedis(orphan.redis, request, sources, allowance())).issues,
    ).toContainEqual({ code: 'UNCLASSIFIED_QUEUE_KEY', descriptor: 'message-retention' });
    const inconsistent = fixture([
      { queue: 'moderation-actions', id: 'same', state: 'failed', data: action() },
      { queue: 'moderation-actions', id: 'same', state: 'completed', data: action() },
    ]);
    expect(
      (
        await inventoryLegacyRecoveryLiveRedis(inconsistent.redis, request, sources, allowance())
      ).issues.some((issue) => issue.code === 'JOB_MULTIPLE_STATES'),
    ).toBe(true);
  });

  it('denies expired/shared budgets and read failures', async () => {
    const { redis } = fixture();
    const expired = await inventoryLegacyRecoveryLiveRedis(redis, request, sources, {
      ...allowance(),
      deadlineAtMs: Date.now() - 1,
    });
    expect(expired.issues[0].code).toBe('REDIS_ALLOWANCE_INVALID');
    expect(redis.eval_ro).not.toHaveBeenCalled();
    const tiny = await inventoryLegacyRecoveryLiveRedis(redis, request, sources, {
      ...allowance(),
      pages: 1,
    });
    expect(tiny.issues.some((issue) => issue.code === 'REDIS_TOTAL_BUDGET_EXCEEDED')).toBe(true);
    redis.eval_ro.mockRejectedValueOnce(new Error('contains credentials that must stay private'));
    const failed = await inventoryLegacyRecoveryLiveRedis(redis, request, sources, allowance());
    expect(failed.issues).toContainEqual({
      code: 'REDIS_READ_FAILED',
      descriptor: 'redis-headers',
    });
    expect(JSON.stringify(failed)).not.toContain('credentials');
  });

  it('binds catalog and payload changes in stableDigest while excluding elapsed cost', async () => {
    const { redis, jobs } = fixture([
      { queue: 'moderation-actions', id: 'a', state: 'completed', data: action() },
    ]);
    const first = await inventoryLegacyRecoveryLiveRedis(redis, request, sources, allowance());
    const second = await inventoryLegacyRecoveryLiveRedis(redis, request, sources, allowance());
    expect(first.stableDigest).toBe(second.stableDigest);
    jobs[0].score = '2';
    const rescheduled = await inventoryLegacyRecoveryLiveRedis(
      redis,
      request,
      sources,
      allowance(),
    );
    expect(rescheduled.stableDigest).not.toBe(first.stableDigest);
    jobs[0].score = '1';
    jobs[0].fields = { parent: JSON.stringify({ id: 'opaque-parent' }) };
    const changed = await inventoryLegacyRecoveryLiveRedis(redis, request, sources, allowance());
    expect(changed.stableDigest).not.toBe(first.stableDigest);
    expect(
      changed.issues.some((issue) => issue.code === 'MAX_CHILD_PARENT_PROVENANCE_UNKNOWN'),
    ).toBe(true);
  });
});

describe('same-snapshot SQL source resolver handoff', () => {
  const job = {
    queue: 'message-duplicates',
    id: 'independent-job',
    state: 'delayed',
    data: {
      webhookEventId: 'independent-receipt',
      chatId: 'other-chat',
      messageId: 'other-message',
    },
  };
  const resolved = () => ({
    decision: 'INDEPENDENT' as const,
    source: {
      webhookEventId: 'independent-receipt',
      chatId: 'other-chat',
      messageId: 'other-message',
      userId: 'user-v',
      sourceAt: '2026-10-01T00:00:00.000Z',
      receiptSha256: 'a'.repeat(64),
    },
    proofSha256: 'b'.repeat(64),
    cost: { pages: 4, rows: 3, probes: 3, bytes: 1024 },
    plans: [],
    issues: [],
  });

  it('requires the server resolver and binds its proof to the stable inventory', async () => {
    const { redis } = fixture([job]);
    const resolve = jest
      .fn<
        ReturnType<LegacyRecoveryLiveSourceResolver>,
        Parameters<LegacyRecoveryLiveSourceResolver>
      >()
      .mockResolvedValue(resolved());
    const first = await inventoryLegacyRecoveryLiveRedis(
      redis,
      request,
      sources,
      allowance(),
      resolve,
    );
    expect(first.issues).toEqual([]);
    expect(resolve).toHaveBeenCalledWith(
      {
        queueName: job.queue,
        jobId: job.id,
        jobPayloadDigest: legacySnapshotDigest(job.data),
        data: job.data,
      },
      expect.objectContaining({
        pages: expect.any(Number),
        deadlineAtMs: expect.any(Number),
      }),
    );
    const unproved = await inventoryLegacyRecoveryLiveRedis(redis, request, sources, allowance());
    expect(unproved.issues.some((row) => row.code === 'NON_MAX_PARENT_PROVENANCE_UNKNOWN')).toBe(
      true,
    );
    resolve.mockResolvedValue({ ...resolved(), proofSha256: 'c'.repeat(64) });
    const changed = await inventoryLegacyRecoveryLiveRedis(
      redis,
      request,
      sources,
      allowance(),
      resolve,
    );
    expect(first.stableDigest).not.toBe(changed.stableDigest);
  });

  it('does not discharge Bull flow ancestry with an unrelated receipt', async () => {
    const { redis } = fixture([
      { ...job, fields: { opts: JSON.stringify({ parent: { id: 'opaque-parent' } }) } },
    ]);
    const resolve = jest.fn().mockResolvedValue(resolved());
    const result = await inventoryLegacyRecoveryLiveRedis(
      redis,
      request,
      sources,
      allowance(),
      resolve,
    );
    expect(result.issues.some((row) => row.code === 'NON_MAX_PARENT_PROVENANCE_UNKNOWN')).toBe(
      true,
    );
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each(['RELATED_UNSUPPORTED', 'DENY'] as const)(
    'retains refusal for %s SQL provenance',
    async (decision) => {
      const { redis } = fixture([job]);
      const result = await inventoryLegacyRecoveryLiveRedis(
        redis,
        request,
        sources,
        allowance(),
        jest.fn().mockResolvedValue({ ...resolved(), decision }),
      );
      expect(result.issues.length).toBeGreaterThan(0);
    },
  );

  it('enforces the shared remaining cost after the SQL callback', async () => {
    const { redis } = fixture([job]);
    const result = await inventoryLegacyRecoveryLiveRedis(
      redis,
      request,
      sources,
      allowance(),
      jest
        .fn()
        .mockResolvedValue({
          ...resolved(),
          cost: { pages: 513, rows: 3, probes: 3, bytes: 1024 },
        }),
    );
    expect(result.issues.some((row) => row.code === 'REDIS_TOTAL_BUDGET_EXCEEDED')).toBe(true);
  });
});
