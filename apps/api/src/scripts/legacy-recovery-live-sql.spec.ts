import { Prisma } from '../prisma/prisma-client';
import * as inspector from '../webhook/webhook-legacy-cold-install';
import {
  inventoryLegacyRecoveryLiveSql,
  measureLegacyRecoverySqlPlan,
  admitLegacyRecoveryHistoryPlan,
  type Allowance,
  type LegacyRecoveryLiveSqlSelection,
} from './legacy-recovery-live-sql';

const source = {
  chatId: '-held',
  messageId: 'original',
  userId: 'held-user',
  sourceAt: new Date(0),
};
const candidate = {
  source,
  owner: {
    id: 'owner',
    botId: 'major',
    rawPayload: { privateBody: 'must remain internal' },
    normalizedPayload: {},
    createdAt: new Date(0),
  },
  claim: { id: 'claim', semanticKey: 'semantic', createdAt: new Date(0) },
  rawPayloadDigest: 'a'.repeat(64),
  normalizedPayloadDigest: 'b'.repeat(64),
} as unknown as inspector.LegacyRecoveryCandidate;
const request: LegacyRecoveryLiveSqlSelection = {
  selection: { ownerWebhookEventIds: ['owner'], majorBotIds: ['major'] },
};
function allowance(overrides: Partial<Allowance> = {}): Allowance {
  return {
    pages: 1000,
    rows: 10000,
    probes: 10000,
    bytes: 100_000_000,
    deadlineAtMs: Date.now() + 60_000,
    ...overrides,
  };
}
function plan(overrides: Record<string, unknown> = {}) {
  return [
    {
      Plan: {
        'Node Type': 'Index Scan',
        'Index Name': 'reviewed_pkey',
        'Actual Rows': 1,
        'Actual Loops': 1,
        'Shared Hit Blocks': 1,
        ...overrides,
      },
    },
  ];
}
function database(
  options: {
    rows?: Record<string, unknown[]>;
    oversize?: boolean;
    readOnly?: string;
    historySequential?: boolean;
    time?: number;
    exactRows?: Record<string, unknown>;
  } = {},
) {
  const queries: string[] = [];
  const $queryRaw = jest.fn(async (statement: Prisma.Sql) => {
    const sql = statement.sql;
    queries.push(sql);
    if (sql.startsWith('EXPLAIN'))
      return [
        {
          'QUERY PLAN': plan({
            ...(options.historySequential && sql.includes('"webhook_events"')
              ? { 'Node Type': 'Seq Scan', 'Relation Name': 'webhook_events' }
              : {}),
            'Actual Total Time': options.time ?? 1,
          }),
        },
      ];
    if (sql.includes("current_setting('transaction_read_only')"))
      return [
        { readOnly: options.readOnly ?? 'on', isolation: 'repeatable read', timeoutMs: 1000 },
      ];
    if (sql.includes('WITH page AS MATERIALIZED')) {
      const table = sql.match(/FROM "([a-z_]+)"/u)?.[1] ?? '';
      const rows = options.rows?.[table] ?? [];
      return [
        {
          rows: options.oversize
            ? null
            : rows.map((row) => ({ ...(row as Record<string, unknown>), _truncated: false })),
          count: rows.length,
          oversize: !!options.oversize,
          bytes: options.oversize ? 65537 : JSON.stringify(rows).length,
        },
      ];
    }
    if (sql.includes('FROM "message_retention_policies"')) return [{ activationId: 'activation' }];
    if (sql.includes('to_jsonb(t)')) {
      const table = sql.match(/FROM "([a-z_]+)"/u)?.[1] ?? '';
      return [{ row: options.exactRows?.[table], oversize: false }];
    }
    return [];
  });
  return { tx: { $queryRaw } as unknown as Prisma.TransactionClient, $queryRaw, queries };
}

describe('bounded read-only live SQL inventory', () => {
  beforeEach(() => {
    jest.spyOn(inspector, 'inspectLegacyRecoveryCandidate').mockImplementation(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT 1`);
      return candidate;
    });
  });
  afterEach(() => jest.restoreAllMocks());

  it.each(['', '2026-10-05T19:11:00.000Z'])(
    'preserves string expiry setting %j while hydrating actual date columns',
    async (expiry) => {
      const timestamp = '2026-10-05T19:11:00';
      const { tx } = database({
        exactRows: {
          chat_settings: {
            chat_id: '-held',
            required_subscription_expires_at: expiry,
            traffic_policy_effective_at: timestamp,
            link_policy_effective_at: null,
            created_at: timestamp,
            updated_at: timestamp,
          },
        },
      });
      jest
        .mocked(inspector.inspectLegacyRecoveryCandidate)
        .mockImplementationOnce(async (reader) => {
          const settings = await reader.chatSettings.findUnique({ where: { chatId: '-held' } });
          expect(settings).toEqual({
            chatId: '-held',
            requiredSubscriptionExpiresAt: expiry,
            trafficPolicyEffectiveAt: new Date(`${timestamp}Z`),
            linkPolicyEffectiveAt: null,
            createdAt: new Date(`${timestamp}Z`),
            updatedAt: new Date(`${timestamp}Z`),
          });
          return null;
        });
      const result = await inventoryLegacyRecoveryLiveSql(tx, request, allowance());
      expect(result.issues).toContainEqual({
        code: 'sql_selected_owner_unproved',
        descriptor: 'sql:webhook_events',
      });
      expect(inspector.inspectLegacyRecoveryCandidate).toHaveBeenCalledTimes(1);
    },
  );

  it('propagates only the fixed deciding refusal code with the existing generic denial', async () => {
    jest
      .mocked(inspector.inspectLegacyRecoveryCandidate)
      .mockImplementationOnce(async (_tx, _id, _bots, onRefusal) => {
        onRefusal?.('source_recipient_keys');
        return null;
      });
    const result = await inventoryLegacyRecoveryLiveSql(database().tx, request, allowance());
    expect(result.issues).toEqual([
      { code: 'sql_selected_owner_source_recipient_keys', descriptor: 'sql:webhook_events' },
      { code: 'sql_selected_owner_unproved', descriptor: 'sql:webhook_events' },
    ]);
  });

  it('charges filtered leaf rows, loop work, probes and inclusive buffers without double counting ancestors', () => {
    const measured = measureLegacyRecoverySqlPlan([
      {
        Plan: {
          'Node Type': 'Nested Loop',
          'Actual Rows': 6,
          'Actual Loops': 1,
          'Shared Hit Blocks': 5,
          Plans: [
            {
              'Node Type': 'Seq Scan',
              'Actual Rows': 2,
              'Actual Loops': 3,
              'Rows Removed by Filter': 4,
              'Shared Hit Blocks': 4,
            },
            {
              'Node Type': 'Index Scan',
              'Index Name': 'fixture_idx',
              'Actual Rows': 1,
              'Actual Loops': 6,
              'Rows Removed by Index Recheck': 2,
              'Shared Hit Blocks': 1,
            },
          ],
        },
        Planning: { 'Shared Hit Blocks': 2 },
      },
    ]);
    expect(measured).toEqual({
      indexes: ['fixture_idx'],
      returnedRows: 6,
      examinedRows: 36,
      probes: 9,
      bufferBytes: 7 * 8192,
    });
  });

  it('rejects estimated, malformed or missing execution evidence', () => {
    for (const value of [
      null,
      [],
      [{ Plan: { 'Node Type': 'Index Scan', 'Plan Rows': 1 } }],
      plan({ 'Actual Loops': NaN }),
      plan({ Plans: [null] }),
    ])
      expect(() => measureLegacyRecoverySqlPlan(value)).toThrow('sql_plan_unproved');
  });

  it('rejects a primary-key history scan whose semantic source is only a filter', () => {
    expect(() =>
      admitLegacyRecoveryHistoryPlan(
        plan({
          'Relation Name': 'webhook_events',
          'Index Cond': "(id > 'cursor'::text)",
          Filter: "(semantic_key = 'selected'::text)",
        }),
        'semantic_key',
      ),
    ).toThrow('sql_history_scan_refused');
    expect(
      admitLegacyRecoveryHistoryPlan(
        plan({
          'Relation Name': 'webhook_events',
          'Index Cond': "(semantic_key = 'selected'::text)",
        }),
        'semantic_key',
      ),
    ).toEqual(['reviewed_pkey']);
    expect(() =>
      admitLegacyRecoveryHistoryPlan(
        plan({
          'Relation Name': 'webhook_events',
          'Index Cond': "(id = 'semantic_key = spoof'::text)",
        }),
        'semantic_key',
      ),
    ).toThrow('sql_history_scan_refused');
  });

  it('uses only the caller read-only repeatable snapshot and meters every candidate read', async () => {
    const db = database();
    const result = await inventoryLegacyRecoveryLiveSql(db.tx, request, allowance());
    expect(inspector.inspectLegacyRecoveryCandidate).toHaveBeenCalledTimes(1);
    expect(result.selectedOwners).toHaveLength(1);
    expect(result.candidates).toEqual([candidate]);
    expect(result.issues).toEqual([]);
    expect(result.proofs.some((proof) => proof.descriptor === 'sql:owner-inspection')).toBe(true);
    expect(result.cost.pages).toBe(db.queries.length);
    expect(db.queries.every((sql) => /^(?:EXPLAIN|\s*SELECT|\s*WITH)/u.test(sql))).toBe(true);
    expect(
      db.queries
        .filter((sql) => sql.includes('"webhook_events"'))
        .every((sql) => sql.includes('"semantic_key" =')),
    ).toBe(true);
    const publicProjection = Object.fromEntries(
      Object.entries(result).filter(([key]) => key !== 'candidates'),
    );
    expect(JSON.stringify(publicProjection)).not.toContain('must remain internal');
  });

  it('keeps stable inventory hashes independent of EXPLAIN timing and plan hashes', async () => {
    const first = await inventoryLegacyRecoveryLiveSql(
      database({ time: 1 }).tx,
      request,
      allowance(),
    );
    const second = await inventoryLegacyRecoveryLiveSql(
      database({ time: 99 }).tx,
      request,
      allowance(),
    );
    expect(first.stableDigest).toBe(second.stableDigest);
    expect(first.proofs[0]!.planSha256).not.toBe(second.proofs[0]!.planSha256);
  });

  it('refuses an unrelated destination and Publisher label without positive source ancestry', async () => {
    const db = database({
      rows: {
        max_action_ledger: [
          {
            id: 'job',
            chat_id: '-independent',
            bot_id: 'publisher',
            status: 'ENQUEUED',
            source_tag: 'publisher',
          },
        ],
      },
    });
    const result = await inventoryLegacyRecoveryLiveSql(db.tx, request, allowance());
    expect(result.issues).toContainEqual({
      code: 'sql_source_unresolved',
      descriptor: 'sql:max_action_ledger',
    });
  });

  it('preserves exact independent retention source metadata and denies the globally held author', async () => {
    const retained = {
      chat_id: '-independent',
      message_id: 'new',
      author_id: 'independent',
      origin_bot_id: 'major',
      source_at: new Date(0).toISOString(),
      activation_id: 'activation',
      intent_id: null,
    };
    const independent = await inventoryLegacyRecoveryLiveSql(
      database({ rows: { message_retention_candidates: [retained] } }).tx,
      request,
      allowance(),
    );
    expect(independent.issues).toEqual([]);
    const affected = await inventoryLegacyRecoveryLiveSql(
      database({
        rows: { message_retention_candidates: [{ ...retained, author_id: source.userId }] },
      }).tx,
      request,
      allowance(),
    );
    expect(affected.issues).toContainEqual({
      code: 'sql_source_unresolved',
      descriptor: 'sql:message_retention_candidates',
    });
  });

  it('refuses global history sequential scans before ANALYZE or fetching any history', async () => {
    const db = database({ historySequential: true });
    const result = await inventoryLegacyRecoveryLiveSql(db.tx, request, allowance());
    expect(result.issues).toContainEqual({
      code: 'sql_history_scan_refused',
      descriptor: 'sql:webhook_events',
    });
    expect(db.queries.filter((sql) => sql.includes('"webhook_events"'))).toHaveLength(1);
    expect(db.queries.at(-1)).toMatch(/^EXPLAIN \(FORMAT JSON\)/u);
  });

  it.each(['pages', 'rows', 'probes', 'bytes'] as const)(
    'refuses exhaustion of %s without representing a partial page as complete',
    async (key) => {
      const result = await inventoryLegacyRecoveryLiveSql(
        database().tx,
        request,
        allowance({ [key]: 1 }),
      );
      expect(result.issues.some((issue) => issue.code === 'sql_budget_exceeded')).toBe(true);
    },
  );

  it('refuses oversized server metadata and an expired deadline', async () => {
    const oversized = await inventoryLegacyRecoveryLiveSql(
      database({ oversize: true }).tx,
      request,
      allowance(),
    );
    expect(oversized.issues).toContainEqual({
      code: 'sql_metadata_reply_unproved',
      descriptor: 'sql:webhook_events',
    });
    const db = database();
    const expired = await inventoryLegacyRecoveryLiveSql(
      db.tx,
      request,
      allowance({ deadlineAtMs: Date.now() - 1 }),
    );
    expect(expired.issues).toContainEqual({
      code: 'sql_deadline_exceeded',
      descriptor: 'sql:snapshot',
    });
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it('refuses a writable snapshot before owner inspection', async () => {
    const db = database({ readOnly: 'off' });
    const result = await inventoryLegacyRecoveryLiveSql(db.tx, request, allowance());
    expect(result.issues).toContainEqual({
      code: 'sql_snapshot_unproved',
      descriptor: 'sql:inventory',
    });
    expect(inspector.inspectLegacyRecoveryCandidate).not.toHaveBeenCalled();
  });
});
