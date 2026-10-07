import { LEGACY_RECOVERY_LIVE_QUEUE_NAMES } from './legacy-recovery-live-registry';
import { LEGACY_RECOVERY_LIVE_BUDGET } from './legacy-recovery-live-budget';
import {
  classifySourceAbandonmentAction,
  inventorySourceAbandonmentRedis,
} from './source-abandonment-live-redis';
import { mergeSourceAbandonmentChildren } from './source-abandonment-collect';
import {
  parseSourceAbandonmentSelection,
  SOURCE_ABANDONMENT_OBSERVATION_QUEUE,
} from './source-abandonment-live-protocol';

const source = { chatId: 'chat-1', messageId: 'message-1', userId: 'user-1' };
const selection = {
  protocol: 'source-abandonment-v1' as const,
  abandonBefore: '2026-10-07T00:00:00.000Z',
  ownerWebhookEventIds: ['owner-1'],
  majorBotIds: ['major-1'],
};
const job = (data: Record<string, unknown>) => ({
  id: 'job-1',
  state: 'wait',
  hash: { data: JSON.stringify(data) },
  data,
  position: 0,
  score: '',
});
const action = (fields: Record<string, unknown> = {}) =>
  job({
    actionType: 'DELETE_MESSAGE',
    chatId: source.chatId,
    messageId: source.messageId,
    userId: source.userId,
    idempotencyKey: 'action-1',
    ...fields,
  });
const allowance = () => ({ ...LEGACY_RECOVERY_LIVE_BUDGET, deadlineAtMs: Date.now() + 30000 });
const resolve = jest.fn(async () => ({
  row: null,
  digest: 'f'.repeat(64),
  cost: { pages: 0, rows: 0, probes: 0, bytes: 0 },
  plans: [],
}));
function redisFixture(keys: string[] = []) {
  return {
    eval_ro: jest.fn(async (script: string, _keyCount: number, ...args: string[]) => {
      if (script.startsWith('-- source-abandonment:headers'))
        return [
          1,
          1,
          [...LEGACY_RECOVERY_LIVE_QUEUE_NAMES]
            .sort()
            .map((name) => [name, '', '1', '', 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        ];
      if (script.startsWith('-- source-abandonment:catalog')) return [1, 1, '0', keys];
      if (script.startsWith('-- source-abandonment:owners'))
        return [1, 1, JSON.parse(args[1]).length, []];
      throw new Error('Unexpected read');
    }),
  };
}

describe('exact source abandonment bounded evidence', () => {
  it('binds an exact original message and never a distinct message by the same member', () => {
    expect(classifySourceAbandonmentAction(action(), [source])).toMatchObject({
      ...source,
      jobKey: 'action-1',
    });
    expect(
      classifySourceAbandonmentAction(action({ messageId: 'other-message' }), [source]),
    ).toBeNull();
  });
  it('binds an explicit notice original source even when action target differs', () => {
    expect(
      classifySourceAbandonmentAction(
        action({
          actionType: 'SEND_MESSAGE',
          messageId: undefined,
          ledgerContext: { moderationSource: source },
        }),
        [source],
      ),
    ).toMatchObject(source);
  });
  it.each([
    { actionType: 'BAN_MEMBER', messageId: undefined },
    { actionType: 'SEND_MESSAGE', messageId: undefined },
    { ledgerContext: { unknownProducer: { ...source } } },
    { userId: 'different-user' },
    { sendAutoDelete: { sourceSendJobId: 'old-send' } },
  ])('refuses unattributed or conflicting continuation %#', (fields) => {
    expect(() => classifySourceAbandonmentAction(action(fields), [source])).toThrow();
  });
  it('rejects parent/repeat work before source attribution', () => {
    const input = action();
    input.hash = {
      ...input.hash,
      opts: JSON.stringify({ repeat: { every: 1000 } }),
    } as typeof input.hash;
    expect(() => classifySourceAbandonmentAction(input, [source])).toThrow('JOB_PARENT_UNPROVED');
  });
  it('deduplicates the exact persisted observation across SQL and Redis while rejecting conflicting content', () => {
    const child = {
      ...source,
      jobKey: 'observation-1',
      queueName: SOURCE_ABANDONMENT_OBSERVATION_QUEUE,
      jobPayloadDigest: 'a'.repeat(64),
    };
    expect(mergeSourceAbandonmentChildren([[child], [child]])).toEqual([child]);
    expect(() =>
      mergeSourceAbandonmentChildren([[child], [{ ...child, jobPayloadDigest: 'b'.repeat(64) }]]),
    ).toThrow();
  });
  it('rejects a noncanonical cutoff and a source selection beyond eight owners', () => {
    expect(() =>
      parseSourceAbandonmentSelection({ ...selection, abandonBefore: '2026-10-07' }),
    ).toThrow();
    expect(() =>
      parseSourceAbandonmentSelection({
        ...selection,
        ownerWebhookEventIds: Array.from({ length: 9 }, (_, i) => `owner-${i}`),
      }),
    ).toThrow();
    expect(parseSourceAbandonmentSelection(selection)).toEqual(selection);
  });
  it('requires a complete finite namespace catalog before cold admission', async () => {
    const valid = await inventorySourceAbandonmentRedis(
      redisFixture(),
      selection,
      [source],
      allowance(),
      resolve,
      'nonce',
    );
    expect(valid.issues).toEqual([]);
    const unknown = await inventorySourceAbandonmentRedis(
      redisFixture(['bull:unexpected-queue:wait']),
      selection,
      [source],
      allowance(),
      resolve,
      'nonce',
    );
    expect(unknown.issues).toContainEqual({
      code: 'UNKNOWN_QUEUE_NAMESPACE',
      descriptor: 'redis:namespace-catalog',
    });
  });

  it.each([
    {
      actionType: 'SEND_MESSAGE',
      status: 'FAILED_TERMINAL',
      ambiguous: false,
      terminal: true,
      remoteMessageId: null,
      expected: 'DENY',
    },
    {
      actionType: 'SEND_MESSAGE',
      status: 'SUCCEEDED',
      ambiguous: false,
      terminal: true,
      remoteMessageId: 'sent-notice',
      expected: 'DENY',
    },
    {
      actionType: 'SEND_MESSAGE',
      status: 'AMBIGUOUS',
      ambiguous: true,
      terminal: true,
      remoteMessageId: 'sent-notice',
      expected: 'DENY',
    },
    {
      actionType: 'BAN_MEMBER',
      status: 'AMBIGUOUS',
      ambiguous: true,
      terminal: false,
      remoteMessageId: null,
      expected: 'ALLOW_FENCED',
    },
    {
      actionType: 'KICK_MEMBER',
      status: 'IN_PROGRESS',
      ambiguous: false,
      terminal: false,
      remoteMessageId: null,
      expected: 'ALLOW_FENCED',
    },
  ])(
    'preserves a real effect fence without authorizing resumable $actionType/$status',
    async (state) => {
      const data = {
        actionType: state.actionType,
        chatId: source.chatId,
        userId: source.userId,
        idempotencyKey: 'action-1',
        autoDeleteDelayMs: 1000,
      };
      const base = redisFixture();
      const redis = {
        eval_ro: jest.fn(async (script: string, keyCount: number, ...args: string[]) => {
          if (script.startsWith('-- source-abandonment:jobs'))
            return [1, 1, 1, [['job-1', 'wait', ['data', JSON.stringify(data)], 0, '']]];
          const reply = await base.eval_ro(script, keyCount, ...args);
          if (script.startsWith('-- source-abandonment:headers')) {
            const rows = reply[2] as unknown as Array<Array<string | number>>;
            const queue = rows.find((row) => row[0] === 'max-actions-critical')!;
            queue[4] = 1;
          }
          return reply;
        }),
      };
      const resolver = async () => ({
        row: {
          jobId: 'action-1',
          chatId: source.chatId,
          userId: source.userId,
          messageId: null,
          ...state,
        },
        digest: 'f'.repeat(64),
        cost: { pages: 0, rows: 0, probes: 0, bytes: 0 },
        plans: [],
      });
      const result = await inventorySourceAbandonmentRedis(
        redis,
        selection,
        [source],
        allowance(),
        resolver,
        'nonce',
      );
      if (state.expected === 'DENY') expect(result.issues[0]?.code).toBe('ACTION_SOURCE_UNPROVED');
      else {
        expect(result.issues).toEqual([]);
        expect(result.children).toEqual([]);
      }
    },
  );
  it('reserves probes before issuing Redis work', async () => {
    const redis = redisFixture();
    const result = await inventorySourceAbandonmentRedis(
      redis,
      selection,
      [source],
      { ...allowance(), probes: 1 },
      resolve,
      'nonce',
    );
    expect(result.issues[0]?.code).toBe('REDIS_BUDGET_EXCEEDED');
    expect(redis.eval_ro).not.toHaveBeenCalled();
  });
});
