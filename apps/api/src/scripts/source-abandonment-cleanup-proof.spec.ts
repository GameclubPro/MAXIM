import type { MessageDuplicateNoticeProof } from '../moderation/message-duplicate/message-duplicate-notice-proof';
import { MESSAGE_DUPLICATE_MEDIA_VERSION } from '../moderation/message-duplicate/message-duplicate-state';
import { LEGACY_RECOVERY_LIVE_BUDGET } from './legacy-recovery-live-budget';
import { LEGACY_RECOVERY_LIVE_QUEUE_NAMES } from './legacy-recovery-live-registry';
import {
  classifySourceAbandonmentAction,
  inventorySourceAbandonmentRedis,
  type SourceAbandonmentRedisResolver,
} from './source-abandonment-live-redis';
import { sourceAbandonmentDigest } from './source-abandonment-live-protocol';
import { SOURCE_ABANDONMENT_COMMANDSTATS_PROJECTION_SCRIPT } from './source-abandonment-redis-catalog';

const source = { chatId: '-100', messageId: 'source-message', userId: 'source-user' };
const otherChat = '-200';
const createdAt = '2026-10-01T00:00:00.000Z';
const completedAt = '2026-10-01T00:00:01.000Z';
const selection = {
  protocol: 'source-abandonment-v1' as const,
  abandonBefore: '2026-10-07T00:00:00.000Z',
  ownerWebhookEventIds: ['owner-1'],
  majorBotIds: ['major-1'],
};
function fixture(chatId = otherChat, context: Record<string, unknown> = {}) {
  const ledgerContext = { moderationNoticeEnvelope: { version: 1 }, ...context };
  const marker: Record<string, unknown> = {
    version: 2,
    sourceSendJobId: 'parent-send',
    sourceChatId: chatId,
    sourceMessageId: null,
    sourceUserId: null,
    sourceCreatedAt: createdAt,
    sourceSendCompletedAt: completedAt,
    requestedDelayMs: 10_000,
    originBotId: 'major-1',
  };
  const data: Record<string, unknown> = {
    actionType: 'DELETE_MESSAGE',
    chatId,
    messageId: 'sent-notice',
    botId: 'major-1',
    sourceTag: 'moderation_notice',
    idempotencyKey: 'cleanup-delete',
    sendAutoDelete: marker,
    ledgerContext,
  };
  const metadata: Record<string, unknown> = {
    createdAt,
    autoDeleteDelayMs: 10_000,
    sendAutoDelete: null,
    hasOptions: true,
    optionKeys: ['textFormat'],
    ledgerContext: structuredClone(ledgerContext),
  };
  const ledger: Record<string, unknown> = {
    jobId: 'parent-send',
    actionType: 'SEND_MESSAGE',
    chatId,
    messageId: null,
    userId: null,
    sourceTag: 'moderation_notice',
    status: 'SUCCEEDED',
    terminal: true,
    ambiguous: false,
    remoteMessageId: 'sent-notice',
    dispatchBotId: 'major-1',
    completedAt: new Date(completedAt),
    // Database insertion time is not the original action's immutable source time.
    createdAt: new Date('2026-10-01T00:00:00.100Z'),
    metadata,
  };
  const parent = { ledger, majorBotIds: selection.majorBotIds };
  const job = () => ({
    id: 'redis-cleanup',
    state: 'delayed',
    hash: { data: JSON.stringify(data) },
    data,
    position: 0,
    score: '1',
  });
  const classify = () => classifySourceAbandonmentAction(job(), [source], parent);
  return { data, marker, metadata, ledger, parent, job, classify };
}
function duplicateProof(chatId = source.chatId): MessageDuplicateNoticeProof {
  const eventTimestampMs = Date.parse(createdAt) - 10_000;
  return {
    version: 3,
    chatId,
    intentId: 'intent',
    reasonKey: `MESSAGE_DUPLICATE:v1:${eventTimestampMs}`,
    deadlineAtMs: eventTimestampMs + 600_000,
    noticePolicySha256: '1'.repeat(64),
    stage: { kind: 'hit', repeatCount: 1, threshold: null },
    binding: {
      version: 3,
      enforcementScope: 'full',
      lifecycleRevision: 'a'.repeat(64),
      policyRevision: 1,
      authorization: { eventTimestampMs, deadlineAtMs: eventTimestampMs + 600_000 },
      original: {
        member: 'b'.repeat(64),
        author: 'c'.repeat(64),
        messageId: 'baseline-message',
        senderId: 'baseline-user',
        publishedAtMs: eventTimestampMs - 1_000,
        observedAtMs: eventTimestampMs - 1_000,
        expiresAtMs: eventTimestampMs + 3_600_000,
        sourceDigest: 'd'.repeat(64),
        contentDigest: 'e'.repeat(64),
        mediaHashes: [],
        epoch: 0,
        revision: 'f'.repeat(64),
        originalId: '0'.repeat(64),
      },
      senderId: source.userId,
      messageId: source.messageId,
      eventTimestampMs,
      controlRevision: 1,
      settingsDigest: '1'.repeat(64),
      sourceDigest: 'd'.repeat(64),
      contentDigest: 'e'.repeat(64),
      fingerprint: '2'.repeat(64),
      compareMode: 'TEXT',
      mediaHashes: [],
      mediaVersion: MESSAGE_DUPLICATE_MEDIA_VERSION,
      hasPhotos: false,
      photoControlRevision: null,
      windowSeconds: 3_600,
      requiredCount: 2,
    },
  };
}

describe('nullable cleanup source requires exact retained SEND provenance', () => {
  it('excludes another group only with the completed parent and fully retained same-chat producer', () => {
    const s = fixture();
    expect(() => classifySourceAbandonmentAction(s.job(), [source])).toThrow(
      'CLEANUP_ORIGINAL_SOURCE_UNPROVED',
    );
    expect(s.classify()).toBeNull();
  });
  it('does not invent an original message in the same group from explicit null fields', () => {
    expect(fixture(source.chatId).classify).toThrow('CLEANUP_ORIGINAL_SOURCE_UNPROVED');
  });
  it('keeps the exact duplicate source despite a different cleanup target and null SEND fields', () => {
    const s = fixture(source.chatId, { duplicateNotice: duplicateProof() });
    expect(s.classify()).toMatchObject({ ...source, jobKey: 'cleanup-delete' });
    const unrelated = { ...source, messageId: 'different-source' };
    expect(classifySourceAbandonmentAction(s.job(), [unrelated], s.parent)).toBeNull();
  });
  it('rejects a copied cross-chat source even if the cleanup target group differs', () => {
    const s = fixture(otherChat, { duplicateNotice: duplicateProof(source.chatId) });
    expect(s.classify).toThrow('CLEANUP_ORIGINAL_SOURCE_UNPROVED');
  });
  it('retains shared-parser subject conflicts on the exact duplicate source', () => {
    const proof = duplicateProof();
    proof.binding.senderId = 'conflicting-user';
    const s = fixture(source.chatId, { duplicateNotice: proof });
    expect(s.classify).toThrow('ACTION_SUBJECT_CONFLICT');
  });
  it.each([
    [
      'missing parent',
      (s: ReturnType<typeof fixture>) => {
        s.parent.ledger = null as never;
      },
    ],
    [
      'different parent key',
      (s: ReturnType<typeof fixture>) => {
        s.ledger.jobId = 'other-parent';
      },
    ],
    [
      'different parent type',
      (s: ReturnType<typeof fixture>) => {
        s.ledger.actionType = 'DELETE_MESSAGE';
      },
    ],
    [
      'different parent chat',
      (s: ReturnType<typeof fixture>) => {
        s.ledger.chatId = source.chatId;
      },
    ],
    [
      'lost original message',
      (s: ReturnType<typeof fixture>) => {
        s.ledger.messageId = source.messageId;
      },
    ],
    [
      'missing nullable message',
      (s: ReturnType<typeof fixture>) => {
        delete s.ledger.messageId;
      },
    ],
    [
      'lost original user',
      (s: ReturnType<typeof fixture>) => {
        s.ledger.userId = source.userId;
      },
    ],
    [
      'missing nullable user',
      (s: ReturnType<typeof fixture>) => {
        delete s.marker.sourceUserId;
      },
    ],
    [
      'missing original message',
      (s: ReturnType<typeof fixture>) => {
        delete s.marker.sourceMessageId;
      },
    ],
    [
      'wrong marker version',
      (s: ReturnType<typeof fixture>) => {
        s.marker.version = 3;
      },
    ],
    [
      'invalid marker delay',
      (s: ReturnType<typeof fixture>) => {
        s.marker.requestedDelayMs = -1;
      },
    ],
    [
      'ambiguous receipt',
      (s: ReturnType<typeof fixture>) => {
        s.ledger.ambiguous = true;
      },
    ],
    [
      'unfinished receipt',
      (s: ReturnType<typeof fixture>) => {
        s.ledger.status = 'IN_PROGRESS';
      },
    ],
    [
      'nonterminal receipt',
      (s: ReturnType<typeof fixture>) => {
        s.ledger.terminal = false;
      },
    ],
    [
      'another remote target',
      (s: ReturnType<typeof fixture>) => {
        s.ledger.remoteMessageId = 'other-target';
      },
    ],
    [
      'another dispatch bot',
      (s: ReturnType<typeof fixture>) => {
        s.ledger.dispatchBotId = 'major-2';
      },
    ],
    [
      'unknown original bot',
      (s: ReturnType<typeof fixture>) => {
        s.parent.majorBotIds = [];
      },
    ],
    [
      'missing completion time',
      (s: ReturnType<typeof fixture>) => {
        s.ledger.completedAt = null;
      },
    ],
    [
      'different completion time',
      (s: ReturnType<typeof fixture>) => {
        s.ledger.completedAt = new Date(createdAt);
      },
    ],
    [
      'metadata source clock mismatch',
      (s: ReturnType<typeof fixture>) => {
        s.metadata.createdAt = completedAt;
      },
    ],
    [
      'missing metadata source clock',
      (s: ReturnType<typeof fixture>) => {
        delete s.metadata.createdAt;
      },
    ],
    [
      'parent cleanup ancestry',
      (s: ReturnType<typeof fixture>) => {
        s.metadata.sendAutoDelete = s.marker;
      },
    ],
    [
      'different delay',
      (s: ReturnType<typeof fixture>) => {
        s.metadata.autoDeleteDelayMs = 20_000;
      },
    ],
    [
      'lost parent context',
      (s: ReturnType<typeof fixture>) => {
        s.metadata.ledgerContext = null;
      },
    ],
    [
      'rewritten child context',
      (s: ReturnType<typeof fixture>) => {
        s.data.ledgerContext = {};
      },
    ],
    [
      'lost parent options',
      (s: ReturnType<typeof fixture>) => {
        delete s.metadata.optionKeys;
      },
    ],
    [
      'parent reply',
      (s: ReturnType<typeof fixture>) => {
        s.metadata.optionKeys = ['messageLink'];
      },
    ],
    [
      'truncated option keys',
      (s: ReturnType<typeof fixture>) => {
        s.metadata.optionKeys = Array.from({ length: 20 }, (_, i) => `field-${i}`);
      },
    ],
    [
      'child-supplied reply',
      (s: ReturnType<typeof fixture>) => {
        s.data.options = { messageLink: { type: 'reply', mid: source.messageId } };
      },
    ],
    [
      'inconsistent option metadata',
      (s: ReturnType<typeof fixture>) => {
        s.metadata.hasOptions = false;
      },
    ],
    [
      'unknown parent producer',
      (s: ReturnType<typeof fixture>) => {
        s.ledger.sourceTag = 'publisher';
      },
    ],
  ])('refuses %s without inferring unrelatedness', (_label, mutate) => {
    const s = fixture();
    (mutate as (value: ReturnType<typeof fixture>) => void)(s);
    expect(s.classify).toThrow('CLEANUP_ORIGINAL_SOURCE_UNPROVED');
  });
  it.each(['user:123', '123', 'unknown-chat'])('excludes unsupported target %s', (chatId) => {
    expect(fixture(chatId).classify).toThrow('CLEANUP_ORIGINAL_SOURCE_UNPROVED');
  });
  it.each([
    { moderationNoticeEnvelope: { version: 1, messageId: source.messageId } },
    { moderationNoticeEnvelope: { version: 2 } },
    { duplicateNotice: { version: 3 } },
    { moderationSource: { ...source, version: 1 } },
  ])('refuses missing or unsupported copied producer scope %#', (context) => {
    expect(fixture(otherChat, context).classify).toThrow('CLEANUP_ORIGINAL_SOURCE_UNPROVED');
  });
});

function redisFixture(s: ReturnType<typeof fixture>) {
  const reader = {
    eval_ro: jest.fn(async (script: string) => {
      if (script.startsWith('-- source-abandonment:headers'))
        return [
          1,
          1,
          [...LEGACY_RECOVERY_LIVE_QUEUE_NAMES]
            .sort()
            .map((name) => [
              name,
              '',
              '1',
              '',
              0,
              0,
              0,
              name === 'max-actions-background' ? 1 : 0,
              0,
              0,
              0,
              0,
              0,
            ]),
        ];
      if (script.startsWith('-- source-abandonment:namespace-catalog'))
        return [1, 0, '0', 0, 0, 0, [], ['0']];
      if (script.startsWith('-- source-abandonment:owners')) return [1, 1, 1, []];
      if (script.startsWith('-- source-abandonment:jobs'))
        return [1, 1, 1, [['redis-cleanup', 'delayed', ['data', JSON.stringify(s.data)], 0, '1']]];
      throw new Error('Unexpected Redis read');
    }),
    multi() {
      const commands: string[] = [];
      const tx = {
        eval_ro(script: string) {
          commands.push(script);
          return tx;
        },
        async exec() {
          expect(commands[0]).toBe(SOURCE_ABANDONMENT_COMMANDSTATS_PROJECTION_SCRIPT);
          expect(commands[2]).toBe(SOURCE_ABANDONMENT_COMMANDSTATS_PROJECTION_SCRIPT);
          const stats = (calls: number, usec: number) =>
            `# Commandstats\r\ncmdstat_eval_ro:calls=${calls},usec=${usec},usec_per_call=10.00,rejected_calls=0,failed_calls=0\r\n`;
          return [
            [null, stats(10, 100)],
            [null, await reader.eval_ro(commands[1])],
            [null, stats(12, 200)],
          ];
        },
      };
      return tx;
    },
  };
  return reader;
}

describe('cleanup parent evidence participates in bounded repeated inventory', () => {
  it('refuses an existing child whose exact parent is missing without resolving another key', async () => {
    const s = fixture();
    const resolve = jest.fn<
      ReturnType<SourceAbandonmentRedisResolver>,
      Parameters<SourceAbandonmentRedisResolver>
    >(async () => ({
      row: null,
      digest: 'f'.repeat(64),
      cost: { pages: 2, rows: 0, probes: 2, bytes: 256 },
      plans: [],
    }));
    const result = await inventorySourceAbandonmentRedis(
      redisFixture(s),
      selection,
      [source],
      { ...LEGACY_RECOVERY_LIVE_BUDGET, deadlineAtMs: Date.now() + 30_000 },
      resolve,
    );
    expect(result.issues).toContainEqual({
      code: 'CLEANUP_ORIGINAL_SOURCE_UNPROVED',
      descriptor: 'redis:max-actions-background',
    });
    expect(result.children).toEqual([]);
    expect(resolve.mock.calls.map(([kind, key]) => [kind, key])).toEqual([
      ['action', 'cleanup-delete'],
      ['action', 'parent-send'],
    ]);
  });
  it('resolves only the child and exact parent, charges parent costs and retains its digest', async () => {
    const s = fixture();
    const resolve = jest.fn<
      ReturnType<SourceAbandonmentRedisResolver>,
      Parameters<SourceAbandonmentRedisResolver>
    >(async (_kind, key) => ({
      row: key === 'parent-send' ? s.ledger : null,
      digest: sourceAbandonmentDigest(key === 'parent-send' ? s.ledger : null),
      cost: { pages: 2, rows: 1, probes: 2, bytes: 256 },
      plans: [],
    }));
    const run = () =>
      inventorySourceAbandonmentRedis(
        redisFixture(s),
        selection,
        [source],
        { ...LEGACY_RECOVERY_LIVE_BUDGET, deadlineAtMs: Date.now() + 30_000 },
        resolve,
      );
    const first = await run();
    expect(first.issues).toEqual([]);
    expect(first.children).toEqual([]);
    expect(resolve.mock.calls.map(([kind, key]) => [kind, key])).toEqual([
      ['action', 'cleanup-delete'],
      ['action', 'parent-send'],
    ]);
    expect(first.cost.rows).toBe(3);
    expect(first.cost.pages).toBeGreaterThanOrEqual(4);
    s.ledger.updatedAt = new Date('2026-10-01T00:00:02.000Z');
    const changed = await run();
    expect(changed.issues).toEqual([]);
    expect(changed.stableDigest).not.toBe(first.stableDigest);
  });
  it('keeps unresolved parent denial and propagates the unchanged shared budget', async () => {
    const s = fixture();
    const resolve: SourceAbandonmentRedisResolver = async (_kind, key, allowance) => ({
      row: key === 'parent-send' ? s.ledger : null,
      digest: 'f'.repeat(64),
      cost: {
        pages: key === 'parent-send' ? allowance.pages + 1 : 0,
        rows: 0,
        probes: 0,
        bytes: 0,
      },
      plans: [],
    });
    const result = await inventorySourceAbandonmentRedis(
      redisFixture(s),
      selection,
      [source],
      { ...LEGACY_RECOVERY_LIVE_BUDGET, deadlineAtMs: Date.now() + 30_000 },
      resolve,
    );
    expect(result.issues).toContainEqual({
      code: 'REDIS_BUDGET_EXCEEDED',
      descriptor: 'redis:max-actions-background',
    });
    expect(result.children).toEqual([]);
  });
});
