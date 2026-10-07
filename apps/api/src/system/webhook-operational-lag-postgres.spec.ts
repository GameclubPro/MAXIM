import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createPrismaClient, Prisma, type PrismaClient } from '../prisma/prisma-client';
import { MULTIBOT_EXECUTION_AUTHORITY_VERSION } from '../webhook/webhook-semantic-authority';
import {
  buildWebhookOperationalLagQuery,
  resolveWebhookOperationalLag,
  WEBHOOK_READINESS_LAG_HEAD_LIMIT,
  type WebhookOperationalLagHead,
} from './webhook-operational-lag';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const describePostgres = databaseUrl ? describe : describe.skip;
const now = new Date('2035-01-01T00:10:00.000Z');
const deadline = new Date(now.getTime() + 10_000);
const prefix = `operational-lag-${randomUUID()}-`;

function explainNodes(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== 'object') return [];
  return [
    ...('Node Type' in value ? [value as Record<string, unknown>] : []),
    ...Object.values(value).flatMap(explainNodes),
  ];
}

describePostgres('bounded PostgreSQL webhook operational lag', () => {
  let prisma: PrismaClient;
  let pool: Pool;
  jest.setTimeout(60_000);

  beforeAll(async () => {
    const parsed = new URL(databaseUrl);
    if (
      !['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname) ||
      !parsed.pathname.includes('race_test')
    )
      throw new Error('Disposable local race_test database required');
    prisma = createPrismaClient(databaseUrl, { max: 2, statement_timeout: 15_000 });
    pool = new Pool({ connectionString: databaseUrl, max: 2, statement_timeout: 15_000 });
    await prisma.$connect();
    await pool.query(
      `
      INSERT INTO webhook_events (id, dedup_key, status, raw_payload, normalized_payload, created_at)
      SELECT $1 || 'history-' || n, $1 || 'history-' || n, 'PROCESSED', '{}', '{}', '2020-01-01'
      FROM generate_series(1, 30000) n`,
      [prefix],
    );
    await pool.query(
      `
      INSERT INTO webhook_execution_claims (id, kind, semantic_key, status, updated_at)
      SELECT $1 || 'history-' || n, 'EXECUTION', $1 || 'history-' || n, 'COMPLETED', CURRENT_TIMESTAMP
      FROM generate_series(1, 30000) n`,
      [prefix],
    );
  });

  afterEach(async () => {
    await pool.query('DELETE FROM webhook_execution_claims WHERE id LIKE $1', [prefix + 'live-%']);
    await pool.query('DELETE FROM webhook_events WHERE id LIKE $1', [prefix + 'live-%']);
  });

  afterAll(async () => {
    if (pool) {
      await pool.query('DELETE FROM webhook_execution_claims WHERE id LIKE $1', [prefix + '%']);
      await pool.query('DELETE FROM webhook_events WHERE id LIKE $1', [prefix + '%']);
    }
    await prisma?.$disconnect();
    await pool?.end();
  });

  async function seed(suffix: string, ageSec = 290, waiting = true): Promise<string> {
    const id = prefix + 'live-' + suffix;
    const semanticKey = `join:${id}`;
    await pool.query(
      `
      INSERT INTO webhook_events (id, dedup_key, semantic_key, status, raw_payload, normalized_payload,
        created_at, execution_deadline_at, next_enqueue_at)
      VALUES ($1, $1, $2, 'RECEIVED', '{}', '{"type":"user_added"}', $3, $4, $5)`,
      [
        id,
        semanticKey,
        new Date(now.getTime() - ageSec * 1_000),
        deadline,
        waiting ? new Date(now.getTime() + 5_000) : null,
      ],
    );
    if (waiting)
      await pool.query(
        `
      INSERT INTO webhook_execution_claims (id, kind, semantic_key, webhook_event_id, enforced,
        status, command_result, updated_at)
      VALUES ($1, 'EXECUTION', $2, $1, true, 'PENDING', $3::jsonb, CURRENT_TIMESTAMP)`,
        [
          id,
          semanticKey,
          JSON.stringify({
            kind: 'EXECUTION_WAITING',
            authorityVersion: MULTIBOT_EXECUTION_AUTHORITY_VERSION,
            webhookEventId: id,
            semanticKey,
            deadlineAt: deadline.toISOString(),
          }),
        ],
      );
    return id;
  }

  async function sample(at = now) {
    const heads = await prisma.$queryRaw<WebhookOperationalLagHead[]>(
      buildWebhookOperationalLagQuery(),
    );
    return { heads, ...resolveWebhookOperationalLag(heads, at) };
  }

  it('keeps a 290-second exact wait visible while measuring fresh independent work', async () => {
    await seed('wait');
    await seed('fresh', 1, false);
    const snapshot = await sample();
    expect(snapshot.heads).toHaveLength(2);
    expect(snapshot.heads[0].createdAt).toEqual(new Date(now.getTime() - 290_000));
    expect(snapshot.lagSec).toBe(1);
    expect(snapshot.readinessWaitingCount).toBe(1);
  });

  it('retains a genuinely stuck unrelated receipt behind a valid wait', async () => {
    await seed('wait');
    await seed('stuck', 120, false);
    expect((await sample()).lagSec).toBe(120);
  });

  it('detects missed retries and never resets expiry lateness when retries advance', async () => {
    const id = await seed('wait');
    await pool.query('UPDATE webhook_events SET next_enqueue_at = $2 WHERE id = $1', [
      id,
      new Date(now.getTime() - 35_000),
    ]);
    expect((await sample()).lagSec).toBe(35);
    await pool.query('UPDATE webhook_events SET next_enqueue_at = $2 WHERE id = $1', [
      id,
      new Date(now.getTime() + 60_000),
    ]);
    expect((await sample(deadline)).lagSec).toBe(0);
    expect((await sample(new Date(deadline.getTime() + 11_000))).lagSec).toBe(11);
    await pool.query('UPDATE webhook_events SET next_enqueue_at = $2 WHERE id = $1', [
      id,
      new Date(now.getTime() + 3600_000),
    ]);
    expect((await sample(new Date(deadline.getTime() + 31_000))).lagSec).toBe(31);
    expect((await sample(new Date(deadline.getTime() + 61_000))).lagSec).toBe(61);
  });

  it.each([
    ['wrong marker', `UPDATE webhook_execution_claims SET command_result = '{}' WHERE id = $1`],
    [
      'wrong authority',
      `UPDATE webhook_execution_claims SET command_result = jsonb_set(command_result, '{authorityVersion}', '"old"') WHERE id = $1`,
    ],
    [
      'wrong event',
      `UPDATE webhook_execution_claims SET command_result = jsonb_set(command_result, '{webhookEventId}', '"other"') WHERE id = $1`,
    ],
    [
      'wrong semantic key',
      `UPDATE webhook_execution_claims SET command_result = jsonb_set(command_result, '{semanticKey}', '"other"') WHERE id = $1`,
    ],
    [
      'wrong deadline',
      `UPDATE webhook_execution_claims SET command_result = jsonb_set(command_result, '{deadlineAt}', '"2035-01-01T00:11:00.000Z"') WHERE id = $1`,
    ],
    [
      'started effects',
      `UPDATE webhook_execution_claims SET business_started_at = CURRENT_TIMESTAMP WHERE id = $1`,
    ],
    ['completed owner', `UPDATE webhook_execution_claims SET status = 'COMPLETED' WHERE id = $1`],
    ['unenforced owner', `UPDATE webhook_execution_claims SET enforced = false WHERE id = $1`],
    ['missing owner', `DELETE FROM webhook_execution_claims WHERE id = $1`],
    ['generic retry', `UPDATE webhook_execution_claims SET command_result = NULL WHERE id = $1`],
    [
      'ambiguous effect',
      `UPDATE webhook_events SET error_message = 'Ambiguous MAX effect' WHERE id = $1`,
    ],
    [
      'quarantine',
      `UPDATE webhook_events SET timeout_quarantine_expires_at = CURRENT_TIMESTAMP WHERE id = $1`,
    ],
    [
      'renewed deadline',
      `WITH renewed AS (
        UPDATE webhook_events SET execution_deadline_at = execution_deadline_at + INTERVAL '1 hour'
        WHERE id = $1 RETURNING id, execution_deadline_at
      ) UPDATE webhook_execution_claims AS claim SET command_result = jsonb_set(
        command_result, '{deadlineAt}', to_jsonb(to_char(renewed.execution_deadline_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      ) FROM renewed WHERE claim.id = renewed.id`,
    ],
    [
      'unsupported event',
      `UPDATE webhook_events SET normalized_payload = '{"type":"bot_added"}' WHERE id = $1`,
    ],
  ])('does not discount %s', async (_label, mutation) => {
    const id = await seed('invalid');
    await pool.query(mutation, [id]);
    expect((await sample()).lagSec).toBe(290);
  });

  it('keeps the uninspected sentinel at raw age and proves bounded native index work', async () => {
    for (let i = 0; i < WEBHOOK_READINESS_LAG_HEAD_LIMIT + 2; i += 1) {
      await seed(String(i).padStart(3, '0'));
    }
    await pool.query('ANALYZE webhook_events');
    await pool.query('ANALYZE webhook_execution_claims');
    const snapshot = await sample();
    expect(snapshot.heads).toHaveLength(65);
    expect(snapshot.readinessWaitingCount).toBe(64);
    expect(snapshot.readinessHeadLimitReached).toBe(true);
    expect(snapshot.lagSec).toBe(290);
    const result = await prisma.$queryRaw<Array<{ 'QUERY PLAN': unknown }>>(Prisma.sql`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${buildWebhookOperationalLagQuery()}
    `);
    const nodes = explainNodes(result[0]['QUERY PLAN']);
    const receiptScan = nodes.find((node) => node['Relation Name'] === 'webhook_events');
    expect([
      'webhook_events_status_created_at_idx',
      'webhook_events_status_created_at_id_idx',
    ]).toContain(receiptScan?.['Index Name']);
    expect(Number(receiptScan?.['Actual Rows'])).toBeLessThanOrEqual(65);
    expect(Number(receiptScan?.['Rows Removed by Filter'] ?? 0)).toBe(0);
    const claimScan = nodes.find((node) => node['Relation Name'] === 'webhook_execution_claims');
    expect(String(claimScan?.['Node Type'])).toMatch(/Index/);
    expect(Number(claimScan?.['Actual Loops'])).toBeLessThanOrEqual(65);
    expect(Number(claimScan?.['Actual Rows'])).toBeLessThanOrEqual(1);
    expect(
      nodes.some(
        (node) =>
          node['Node Type'] === 'Seq Scan' &&
          ['webhook_events', 'webhook_execution_claims'].includes(String(node['Relation Name'])),
      ),
    ).toBe(false);
  });
});
