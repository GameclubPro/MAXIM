import { LEGACY_RECOVERY_LIVE_QUEUE_NAMES } from './legacy-recovery-live-registry';
import { LEGACY_RECOVERY_LIVE_BUDGET } from './legacy-recovery-live-budget';
import {
  classifySourceAbandonmentAction,
  inventorySourceAbandonmentRedis,
} from './source-abandonment-live-redis';
import { mergeSourceAbandonmentChildren } from './source-abandonment-collect';
import {
  assertSourceAbandonmentCatalogProofs,
  inventorySourceAbandonmentNamespaces,
  readMeasuredSourceCatalogScript,
  SOURCE_ABANDONMENT_COMMANDSTATS_PROJECTION_SCRIPT,
  type SourceAbandonmentCatalogReader,
} from './source-abandonment-redis-catalog';
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
const commandstats = (calls = 10, usec = 100, rejected = 0, failed = 0) =>
  `# Commandstats\r\ncmdstat_eval_ro:calls=${calls},usec=${usec},usec_per_call=10.00,rejected_calls=${rejected},failed_calls=${failed}\r\n`;
function measuredFixture<T extends SourceAbandonmentCatalogReader>(reader: T) {
  return Object.assign(reader, {
    multi() {
      const commands: Array<{ script: string; keys: number; args: string[] }> = [];
      const transaction = {
        eval_ro(nextScript: string, nextKeys: number, ...nextArgs: string[]) {
          commands.push({ script: nextScript, keys: nextKeys, args: nextArgs });
          return transaction;
        },
        async exec() {
          expect(commands).toHaveLength(3);
          const projection = {
            script: SOURCE_ABANDONMENT_COMMANDSTATS_PROJECTION_SCRIPT,
            keys: 0,
            args: [],
          };
          expect(commands[0]).toEqual(projection);
          expect(commands[2]).toEqual(projection);
          const { script, keys, args } = commands[1];
          let reply = await reader.eval_ro(script, keys, ...args);
          if (
            script.startsWith('-- source-abandonment:namespace-catalog') &&
            Array.isArray(reply) &&
            reply[0] === 1 &&
            reply.length === 7
          ) {
            const cursor = reply[2] as string;
            reply = [...reply, [cursor]];
          }
          return [
            [null, commandstats()],
            [null, reply],
            [null, commandstats(12, 200)],
          ];
        },
      };
      return transaction;
    },
  });
}
function redisFixture(keys: string[] = []) {
  return measuredFixture({
    eval_ro: jest.fn(async (script: string, _keyCount: number, ...args: string[]) => {
      if (script.startsWith('-- source-abandonment:headers'))
        return [
          1,
          1,
          [...LEGACY_RECOVERY_LIVE_QUEUE_NAMES]
            .sort()
            .map((name) => [name, '', '1', '', 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        ];
      if (script.startsWith('-- source-abandonment:namespace-catalog-v2'))
        return keys.length ? [0, 'UNKNOWN_QUEUE_NAMESPACE'] : [1, 0, '0', 0, 0, 0, []];
      if (script.startsWith('-- source-abandonment:owners'))
        return [1, 1, JSON.parse(args[1]).length, []];
      throw new Error('Unexpected read');
    }),
  });
}

describe('exact source abandonment bounded evidence', () => {
  it('records actual server cost despite delayed delivery and frozen Lua TIME', async () => {
    const reader = measuredFixture({
      eval_ro: async () => {
        await new Promise((resolve) => setTimeout(resolve, 70));
        return [1, 0, '0', 0, 0, 0, []];
      },
    });
    const proof = await inventorySourceAbandonmentNamespaces(reader, Date.now() + 1000);
    expect(proof).toMatchObject({
      complete: true,
      issue: null,
      cost: { serverDurationUs: 100, maxCallDurationUs: 100 },
    });
  });
  it.each([[], ['0', '2'], ['1'], ['1', '2', '3']])(
    'rejects malformed single page cursor accounting',
    async (...cursors) => {
      const reader = measuredFixture({ eval_ro: async () => [1, 0, '2', 0, 0, 0, [], cursors] });
      expect(await inventorySourceAbandonmentNamespaces(reader, Date.now() + 1000)).toMatchObject({
        complete: false,
        issue: 'CATALOG_REPLY_UNPROVED',
      });
    },
  );
  it.each([
    [commandstats(12, 50_101), 'CATALOG_CALL_LATENCY_LIMIT'],
    [commandstats(0, 0), 'CATALOG_SERVER_COST_UNPROVED'],
    [commandstats(11, 200), 'CATALOG_SERVER_COST_UNPROVED'],
    [commandstats(13, 200), 'CATALOG_SERVER_COST_UNPROVED'],
    [commandstats(12, 99), 'CATALOG_SERVER_COST_UNPROVED'],
    [commandstats(12, 200, 1), 'CATALOG_SERVER_COST_UNPROVED'],
    [commandstats(12, 200, 0, 1), 'CATALOG_SERVER_COST_UNPROVED'],
    [commandstats(12, Number.MAX_SAFE_INTEGER + 1), 'CATALOG_SERVER_COST_UNPROVED'],
    [commandstats(Number.MAX_SAFE_INTEGER + 1, 200), 'CATALOG_SERVER_COST_UNPROVED'],
    [`${commandstats(12, 200)}${commandstats(12, 200)}`, 'CATALOG_SERVER_COST_UNPROVED'],
    [`${commandstats(12, 200)}${'x'.repeat(512)}`, 'CATALOG_SERVER_COST_UNPROVED'],
    ['secret raw error', 'CATALOG_SERVER_COST_UNPROVED'],
  ])(
    'refuses invalid commandstats rather than accepting a zero Lua duration',
    async (after, issue) => {
      const reader = measuredFixture({ eval_ro: async () => [1, 0, '0', 0, 0, 0, []] });
      const multi = reader.multi.bind(reader);
      reader.multi = () => {
        const transaction = multi();
        const exec = transaction.exec.bind(transaction);
        transaction.exec = async () => {
          const rows = await exec();
          rows[2][1] = after;
          return rows;
        };
        return transaction;
      };
      await expect(readMeasuredSourceCatalogScript(reader, 'read', 0)).rejects.toThrow(issue);
    },
  );
  it.each([0, 1, 2])('refuses an error in measured transaction command %i', async (index) => {
    const reader = measuredFixture({ eval_ro: async () => 'target reply' });
    const multi = reader.multi.bind(reader);
    reader.multi = () => {
      const transaction = multi();
      const exec = transaction.exec.bind(transaction);
      transaction.exec = async () => {
        const rows = await exec();
        rows[index][0] = new Error('private Redis error');
        return rows;
      };
      return transaction;
    };
    await expect(readMeasuredSourceCatalogScript(reader, 'read', 0)).rejects.toThrow(
      'CATALOG_SERVER_COST_UNPROVED',
    );
  });
  it('accepts a canonical absent baseline and charges only the bounded projections', async () => {
    const reader = measuredFixture({ eval_ro: async () => 'target reply' });
    const multi = reader.multi.bind(reader);
    const before = '# Commandstats\r\n';
    const after = commandstats(2, 50_000);
    reader.multi = () => {
      const transaction = multi();
      const exec = transaction.exec.bind(transaction);
      transaction.exec = async () => {
        const rows = await exec();
        rows[0][1] = before;
        rows[2][1] = after;
        return rows;
      };
      return transaction;
    };
    await expect(readMeasuredSourceCatalogScript(reader, 'read', 0)).resolves.toEqual({
      reply: 'target reply',
      serverDurationUs: 50_000,
      measurementBytes: Buffer.byteLength(before) + Buffer.byteLength(after),
    });
  });
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
      const redis = measuredFixture({
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
      });
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

  it('completes sparse namespace pages without spending the finite effect proof budget', async () => {
    const base = redisFixture();
    let pages = 0;
    const redis = measuredFixture({
      eval_ro: jest.fn(async (script: string, keyCount: number, ...args: string[]) => {
        if (script.startsWith('-- source-abandonment:namespace-catalog-v2')) {
          expect(args[1]).toBe('1');
          pages += 1;
          const cursor = pages === 600 ? '0' : String(pages);
          return [1, 9_212_720, cursor, 0, 0, 100, [], [cursor]];
        }
        return base.eval_ro(script, keyCount, ...args);
      }),
    });
    const result = await inventorySourceAbandonmentRedis(
      redis,
      selection,
      [source],
      allowance(),
      resolve,
      'nonce',
    );
    expect(result.issues).toEqual([]);
    expect(result.catalog).toMatchObject({ complete: true, cost: { pages: 600 } });
    expect(result.catalog?.cost.measurementBytes).toBe(
      600 * (Buffer.byteLength(commandstats()) + Buffer.byteLength(commandstats(12, 200))),
    );
    expect(result.cost.pages).toBeLessThan(100);
    expect(result.cost.probes).toBeLessThan(50_000);
  });

  it.each([
    { reply: [0, 'CATALOG_DATABASE_LIMIT'], code: 'CATALOG_DATABASE_LIMIT' },
    { reply: [0, 'CATALOG_CALL_LATENCY_LIMIT'], code: 'CATALOG_CALL_LATENCY_LIMIT' },
    { reply: [1, 10, '0', 2, 50, 1, [['moderation', 1]]], code: 'CATALOG_ACCOUNTING_UNPROVED' },
    { reply: [1, 10, '0', 1, 50, 1, [['unknown', 1]]], code: 'CATALOG_NAMESPACE_UNPROVED' },
  ])('refuses incomplete structural proof: $code', async ({ reply, code }) => {
    const result = await inventorySourceAbandonmentNamespaces(
      measuredFixture({ eval_ro: jest.fn(async () => reply) }),
      Date.now() + 30_000,
    );
    expect(result).toMatchObject({ complete: false, issue: code });
  });

  it('refuses a repeated cursor and retains the common SQL/job deadline', async () => {
    const redis = measuredFixture({ eval_ro: jest.fn(async () => [1, 100, '12', 0, 0, 1, []]) });
    expect(await inventorySourceAbandonmentNamespaces(redis, Date.now() + 30_000)).toMatchObject({
      complete: false,
      issue: 'CATALOG_CURSOR_REPEAT',
    });
    expect(redis.eval_ro).toHaveBeenCalledTimes(2);
    redis.eval_ro.mockClear();
    expect(await inventorySourceAbandonmentNamespaces(redis, Date.now() - 1)).toMatchObject({
      complete: false,
      issue: 'CATALOG_DEADLINE_EXCEEDED',
    });
    expect(redis.eval_ro).not.toHaveBeenCalled();
  });

  it('verifies both bounded catalog artifacts rather than trusting their completion labels', async () => {
    const proof = await inventorySourceAbandonmentNamespaces(
      measuredFixture({
        eval_ro: jest.fn(async () => [1, 1, '0', 1, 32, 1, [['moderation', 1]]]),
      }),
      Date.now() + 30_000,
    );
    expect(() => assertSourceAbandonmentCatalogProofs([proof, proof])).not.toThrow();
    const invalid = [
      { ...proof, complete: false },
      { ...proof, issue: 'UNKNOWN_QUEUE_NAMESPACE' },
      { ...proof, namespaceKeyCounts: { unknown: 1 } },
      { ...proof, namespaceKeyCounts: { moderation: NaN } },
      { ...proof, namespaceKeyCounts: { moderation: -1 } },
      { ...proof, cost: { ...proof.cost, pages: 4097 } },
      { ...proof, cost: { ...proof.cost, scanCountHints: 0 } },
      { ...proof, cost: { ...proof.cost, matchedKeys: 300_001 } },
      { ...proof, cost: { ...proof.cost, databaseKeysMax: 12_000_001 } },
      { ...proof, cost: { ...proof.cost, durationMs: 15_001 } },
      { ...proof, cost: { ...proof.cost, maxCallDurationUs: 50_001 } },
      { ...proof, cost: { ...proof.cost, measurementBytes: 16 * 1024 * 1024 + 1 } },
      { ...proof, cost: { ...proof.cost, measurementBytes: 0 } },
      {
        ...proof,
        cost: Object.fromEntries(
          Object.entries(proof.cost).filter(([key]) => key !== 'measurementBytes'),
        ),
      },
      { ...proof, cost: { ...proof.cost, bytes: Infinity } },
      { ...proof, cost: { ...proof.cost, keyBytes: 64 * 1024 * 1024 + 1 } },
      { ...proof, namespaceKeyCounts: { moderation: 2 }, cost: { ...proof.cost, matchedKeys: 2 } },
      { ...proof, extra: true },
    ];
    for (const other of invalid)
      expect(() => assertSourceAbandonmentCatalogProofs([proof, other])).toThrow('catalog proof');
    expect(() => assertSourceAbandonmentCatalogProofs([proof])).toThrow('catalog proof');
  });
});
