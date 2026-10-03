import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import { Prisma } from '../prisma/prisma-client';
import { ModerationDeleteIntentService } from './moderation-delete-intent.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const describePostgres = databaseUrl ? describe : describe.skip;
type Plan = { [key: string]: unknown; Plans?: Plan[] };

describePostgres('PostgreSQL delete due selection', () => {
  const schema = `delete_due_${randomUUID().replaceAll('-', '')}`;
  let client: Client;
  let locker: Client;
  let query: Prisma.Sql;
  let explain = false;
  let plan: Plan;
  let service: ModerationDeleteIntentService;

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Disposable local race_test database required');
    client = new Client({ connectionString: databaseUrl });
    locker = new Client({ connectionString: databaseUrl });
    await client.connect();
    await locker.connect();
    await client.query(`CREATE SCHEMA "${schema}"`);
    for (const connection of [client, locker]) {
      await connection.query(`SET search_path TO "${schema}", public`);
      await connection.query('SET statement_timeout = 15000');
      await connection.query('SET max_parallel_workers_per_gather = 0');
    }
    await client.query(`CREATE TABLE moderation_delete_intents (
      id text PRIMARY KEY, chat_id text NOT NULL DEFAULT 'fixture',
      status "ModerationDeleteIntentStatus" NOT NULL,
      next_attempt_at timestamp NOT NULL, execute_at timestamp NOT NULL DEFAULT '2026-01-01',
      created_at timestamp NOT NULL, retry_until_at timestamp NOT NULL DEFAULT '2099-01-01',
      retention_owned boolean NOT NULL DEFAULT false,
      remote_delete_succeeded_at timestamp, remote_delete_succeeded_bot_id text,
      delete_dispatch_started_at timestamp, delete_dispatch_started_bot_id text,
      lease_expires_at timestamp DEFAULT '2026-01-01', suggestion_subscription_id text,
      attempt_count integer NOT NULL DEFAULT 0, commercial_ocr_guard_required boolean NOT NULL DEFAULT false
    )`);
    // Use the production index, including its execute_at rather than created_at suffix.
    await client.query(
      'CREATE INDEX due_idx ON moderation_delete_intents(status, next_attempt_at, execute_at)',
    );
    await client.query(`CREATE TABLE moderation_delete_intent_reasons (
      intent_id text NOT NULL, rule_code text NOT NULL, reason_key text NOT NULL, metadata jsonb
    )`);
    await client.query(
      'CREATE INDEX reason_idx ON moderation_delete_intent_reasons(intent_id, reason_key)',
    );
    const prisma = {
      $queryRaw: async (value: Prisma.Sql) => {
        query = value;
        const result = await client.query(
          `${explain ? 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' : ''}${value.text}`,
          value.values,
        );
        if (explain) {
          plan = result.rows[0]['QUERY PLAN'][0].Plan as Plan;
          return [];
        }
        return result.rows;
      },
    };
    service = new ModerationDeleteIntentService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      new ConfigService({
        MODERATION_DELETE_INTENT_MODE: 'shadow',
        COMMERCIAL_OCR_ROLLOUT_MODE: 'baseline',
        MODERATION_DELETE_INTENT_REPLACEMENT_CLEANUP_ENABLED: false,
        MODERATION_DELETE_INTENT_REQUIRED_SUBSCRIPTION_ENABLED: false,
      }),
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  });

  afterAll(async () => {
    await locker?.query('ROLLBACK');
    await locker?.end();
    if (client) {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await client.end();
    }
  });

  beforeEach(async () => {
    explain = false;
    await client.query('TRUNCATE moderation_delete_intent_reasons, moderation_delete_intents');
  });

  const select = () =>
    (
      service as unknown as { selectDueIntentIds(): Promise<Array<{ id: string }>> }
    ).selectDueIntentIds();

  async function seed(count: number) {
    await client.query(
      `INSERT INTO moderation_delete_intents (id, status, next_attempt_at, created_at)
      SELECT n::text, (ARRAY['PENDING', 'RETRYABLE', 'WAITING_CAPABILITY', 'AMBIGUOUS', 'IN_PROGRESS'])[1+n%5]::"ModerationDeleteIntentStatus",
        TIMESTAMP '2026-01-01' + n * INTERVAL '1 millisecond', TIMESTAMP '2026-01-01' + n * INTERVAL '1 millisecond'
      FROM generate_series(1, $1::int) n`,
      [count],
    );
    await client.query(`INSERT INTO moderation_delete_intent_reasons
      SELECT id, 'BOT_MESSAGE_AUTO_DELETE', 'fixture', '{}'::jsonb FROM moderation_delete_intents`);
    await client.query('ANALYZE moderation_delete_intents');
    await client.query('ANALYZE moderation_delete_intent_reasons');
  }

  it('finds the first mixed-status batch without scanning the complete due population', async () => {
    await seed(50_000);
    explain = true;
    await select();
    const scans: Plan[] = [];
    const visit = (node: Plan) => {
      if (node['Relation Name'] === 'moderation_delete_intents') scans.push(node);
      node.Plans?.forEach(visit);
    };
    visit(plan);
    const visited = scans.reduce(
      (sum, node) =>
        sum +
        (Number(node['Actual Rows']) + Number(node['Rows Removed by Filter'] ?? 0)) *
          Number(node['Actual Loops']),
      0,
    );
    expect(visited).toBeLessThan(2_000);
    explain = false;
    expect(await select()).toEqual(Array.from({ length: 100 }, (_, n) => ({ id: String(n + 1) })));
  });

  it('keeps due, lease, retention, rollout and retry-evidence predicates in every status lane', async () => {
    await seed(30);
    await client.query(
      `UPDATE moderation_delete_intents SET next_attempt_at='2099-01-01' WHERE id='1'`,
    );
    await client.query(`UPDATE moderation_delete_intents SET execute_at='2099-01-01' WHERE id='2'`);
    await client.query(`UPDATE moderation_delete_intents SET retention_owned=true WHERE id='3'`);
    await client.query(
      `UPDATE moderation_delete_intents SET retry_until_at='2025-01-01' WHERE id IN ('4','6')`,
    );
    await client.query(
      `UPDATE moderation_delete_intents SET lease_expires_at='2099-01-01' WHERE id='9'`,
    );
    await client.query(
      `UPDATE moderation_delete_intents SET delete_dispatch_started_at='2026-01-01', attempt_count=5 WHERE id='6'`,
    );
    await client.query(`UPDATE moderation_delete_intents SET attempt_count=5 WHERE id='7'`);
    await client.query(
      `UPDATE moderation_delete_intent_reasons SET rule_code='UNENABLED_FIXTURE' WHERE intent_id='8'`,
    );
    const result = (await select()).map((row) => row.id);
    expect(result).toContain('6'); // Unknown dispatch remains reconciliation work, never a new send.
    for (const id of ['1', '2', '3', '4', '7', '8', '9']) expect(result).not.toContain(id);
    expect(result).toHaveLength(23);
  });

  it('skips rows locked by another worker and preserves global due ordering and the total batch cap', async () => {
    await seed(600);
    await locker.query('BEGIN');
    try {
      await locker.query(
        `SELECT id FROM moderation_delete_intents WHERE id::int <= 120 FOR UPDATE`,
      );
      expect(await select()).toEqual(
        Array.from({ length: 100 }, (_, n) => ({ id: String(n + 121) })),
      );
      expect(query.text).toContain('SKIP LOCKED');
    } finally {
      await locker.query('ROLLBACK');
    }
  });
});
