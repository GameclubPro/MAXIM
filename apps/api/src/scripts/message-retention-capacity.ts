import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { ConfigService } from '@nestjs/config';
import { Client, type ClientConfig } from 'pg';
import { createPrismaAdapter, PrismaClient, Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { retentionBindingQuery } from '../message-retention/message-retention-binding';
import { captureRetentionMessage } from '../message-retention/message-retention-capture';
import { purgeRetentionPage } from '../message-retention/message-retention-purge';
import { MessageRetentionStore } from '../message-retention/message-retention-store.service';
import { retentionQuotaShard } from '../message-retention/message-retention.policy';

type Scenario = 'uniform' | 'hot' | 'retry' | 'skew' | 'removed';
type Options = {
  postgresUrl: string;
  chats: number;
  candidates: number;
  samples: number;
  scenario: Scenario;
  seed: number;
  jsonOutput: string | null;
  transportRps: number;
};
type Statement = { sql: string; values: unknown[] };
type Sample = { operation: string; samples: number; p50Ms: number; p95Ms: number; maxMs: number };

export function readRetentionCapacityOptions(argv: readonly string[]): Options {
  const args = new Map<string, string>();
  const allowed = new Set([
    '--postgres-url',
    '--chats',
    '--candidates',
    '--samples',
    '--scenario',
    '--seed',
    '--json-output',
    '--transport-rps',
  ]);
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]!;
    const value = argv[i + 1];
    if (!allowed.has(name) || args.has(name) || !value || value.startsWith('--'))
      throw new Error(
        'Use --postgres-url <localhost URL> [--chats 1..20000] [--candidates 1..2000000] [--samples 1..200] [--scenario uniform|hot|retry|skew|removed] [--seed 0..2147483647] [--transport-rps 1..30] [--json-output /tmp/<new-file>.json]',
      );
    args.set(name, value);
  }
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const raw = args.get(name) ?? String(fallback);
    if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw new Error(`${name} must be between ${min} and ${max}`);
    return value;
  };
  const postgresUrl = args.get('--postgres-url');
  if (!postgresUrl) throw new Error('--postgres-url is required; DATABASE_URL is never used');
  localConnection(postgresUrl);
  const scenario = args.get('--scenario') ?? 'uniform';
  if (!['uniform', 'hot', 'retry', 'skew', 'removed'].includes(scenario))
    throw new Error('Invalid scenario');
  const jsonOutput = args.has('--json-output') ? resolve(args.get('--json-output')!) : null;
  if (jsonOutput && (dirname(jsonOutput) !== '/tmp' || !jsonOutput.endsWith('.json')))
    throw new Error('--json-output must be a new JSON file directly under /tmp');
  return {
    postgresUrl,
    chats: integer('--chats', 2000, 1, 20_000),
    candidates: integer('--candidates', 100_000, 1, 2_000_000),
    samples: integer('--samples', 20, 1, 200),
    scenario: scenario as Scenario,
    seed: integer('--seed', 1, 0, 2_147_483_647),
    jsonOutput,
    transportRps: integer('--transport-rps', 2, 1, 30),
  };
}

function localConnection(input: string): { config: ClientConfig; canonicalUrl: URL } {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('Invalid PostgreSQL URL');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.search ||
    url.hash ||
    !/^\/[^/]+$/.test(url.pathname)
  )
    throw new Error('Capacity runs require an explicit localhost database URL without URL options');
  const port = Number(url.port || 5432);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local port');
  // FLAG: Force loopback even when localhost DNS or libpq options are customized.
  url.hostname = url.hostname === '[::1]' ? '[::1]' : '127.0.0.1';
  return {
    config: {
      host: url.hostname === '[::1]' ? '::1' : '127.0.0.1',
      port,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: decodeURIComponent(url.pathname.slice(1)),
      ssl: false,
      connectionTimeoutMillis: 3000,
      statement_timeout: 5000,
      application_name: 'maxim-retention-capacity',
    },
    canonicalUrl: url,
  };
}

const parameters = (values: unknown[]) =>
  values.map((value) => (value instanceof Date ? value.toISOString() : value));
const rounded = (value: number) => Math.round(value * 1000) / 1000;

export function retentionTransportCapacityModel(activeRows: number, requestedRps: number) {
  const effectiveRps = Math.min(requestedRps, 2);
  const fleetDeletesPerSecond = (effectiveRps * 5) / 7;
  return {
    kind: 'arithmetic_upper_bound_not_runtime_benchmark',
    assumptions: {
      oneBot: true,
      requestedRps,
      globalRetentionCeilingRps: 2,
      effectiveRps,
      perChatDeleteCeilingRps: 1,
      requestsPerFiveDeletes: 7,
      description:
        'Fleet bound across many chats: one batch author check, one pin check, five deletes; excludes retries, scheduler waits, latency and foreground traffic',
    },
    optimisticDeletesPerSecond: rounded(fleetDeletesPerSecond),
    optimisticSingleChatDeletesPerSecond: rounded(Math.min(fleetDeletesPerSecond, 1)),
    optimisticDrainSeconds: Math.ceil(activeRows / fleetDeletesPerSecond),
  };
}

function migrationDirectory(): string {
  for (const path of [
    resolve(__dirname, '../../prisma/migrations'),
    resolve(process.cwd(), 'apps/api/prisma/migrations'),
    resolve(process.cwd(), 'prisma/migrations'),
  ]) {
    try {
      readFileSync(resolve(path, '20260920190000_add_message_retention/migration.sql'));
      return path;
    } catch {
      /* Try the source checkout or workspace location. */
    }
  }
  throw new Error('Run capacity diagnostics from a source checkout with production migrations');
}

async function initialize(db: Client): Promise<void> {
  await db.query(`CREATE TABLE chats (id TEXT PRIMARY KEY, entity_type TEXT NOT NULL DEFAULT 'CHAT');
    CREATE TABLE managed_entity_admin_members (chat_id TEXT, user_id TEXT, entity_type TEXT, role TEXT, expires_at TIMESTAMP(3));
    CREATE INDEX admin_lookup ON managed_entity_admin_members(chat_id, user_id);
    CREATE TABLE audit_logs (id TEXT PRIMARY KEY, chat_id TEXT REFERENCES chats(id), actor_user_id TEXT, action TEXT, payload JSONB, created_at TIMESTAMP(3));
    CREATE TABLE moderation_delete_intents (id TEXT PRIMARY KEY, chat_id TEXT, message_id TEXT, subject_user_id TEXT,
      status TEXT DEFAULT 'PENDING', delete_dispatch_started_at TIMESTAMP(3), delete_dispatch_started_bot_id TEXT,
      remote_delete_succeeded_at TIMESTAMP(3), remote_delete_succeeded_bot_id TEXT, lease_expires_at TIMESTAMP(3));
    CREATE UNIQUE INDEX moderation_delete_intents_chat_message_key ON moderation_delete_intents(chat_id, message_id);
    CREATE TABLE moderation_delete_intent_reasons (id TEXT PRIMARY KEY, intent_id TEXT REFERENCES moderation_delete_intents(id) ON DELETE CASCADE,
      reason_key TEXT NOT NULL DEFAULT 'retention', rule_code TEXT NOT NULL);
    CREATE UNIQUE INDEX moderation_delete_intent_reasons_intent_reason_key ON moderation_delete_intent_reasons(intent_id, reason_key);`);
  const directory = migrationDirectory();
  for (const migration of [
    '20260920190000_add_message_retention',
    '20261002020000_add_retention_reconciliation',
    '20261002020100_index_retention_reconciliation',
  ]) {
    // Separate statements permit production CONCURRENTLY indexes outside transactions.
    for (const sql of readFileSync(resolve(directory, migration, 'migration.sql'), 'utf8')
      .replace(/^\s*--[^\n]*/gmu, '')
      .split(';'))
      if (sql.trim()) await db.query(sql);
  }
  await db.query("SET statement_timeout = '120s'; SET lock_timeout = '1s'; SET TIME ZONE 'UTC'");
}

async function seed(db: Client, options: Options) {
  const shards = Array<number>(32).fill(0);
  const rows: Array<{ chatId: string; count: number; active: number; shard: number }> = [];
  let remaining = options.candidates;
  for (let i = 0; i < options.chats; i++) {
    const chatId = String(-1 - options.seed * 20_000 - i);
    const count =
      options.scenario === 'hot' && i === 0 && options.chats > 1
        ? Math.min(50_000, options.candidates)
        : Math.ceil(remaining / (options.chats - i));
    remaining -= count;
    const shard = retentionQuotaShard(chatId);
    const ratio = options.scenario === 'removed' ? 0.2 : options.scenario === 'retry' ? 0.9 : 0.8;
    const active = Math.min(Math.floor(count * ratio), 49_999, 62_499 - shards[shard]!);
    shards[shard]! += active;
    rows.push({ chatId, count, active, shard });
  }
  await db.query(
    'CREATE TEMP TABLE seed_chats(chat_id TEXT PRIMARY KEY, amount INTEGER, active INTEGER, shard INTEGER)',
  );
  await db.query(
    `INSERT INTO seed_chats SELECT * FROM unnest($1::text[], $2::int[], $3::int[], $4::int[])`,
    [
      rows.map((r) => r.chatId),
      rows.map((r) => r.count),
      rows.map((r) => r.active),
      rows.map((r) => r.shard),
    ],
  );
  await db.query(`INSERT INTO chats(id) SELECT chat_id FROM seed_chats;
    INSERT INTO message_retention_policies(chat_id, enabled, activation_id, enabled_at, capture_after, quota_shard, pending_count, next_run_at, last_status)
    SELECT chat_id, TRUE, 'activation', CURRENT_TIMESTAMP - INTERVAL '6 days', CURRENT_TIMESTAMP - INTERVAL '6 days', shard, active,
      CURRENT_TIMESTAMP - INTERVAL '1 hour', 'waiting' FROM seed_chats;
    UPDATE message_retention_quotas q SET pending_count = (SELECT COALESCE(SUM(active),0) FROM seed_chats s WHERE s.shard=q.shard);`);
  await db.query(
    `INSERT INTO message_retention_candidates(chat_id, message_id, author_id, origin_bot_id, source_at, activation_id,
      shadow_only, status, next_attempt_at, intent_id, completed_at, outcome_code, reconcile_after)
    SELECT s.chat_id, 'm' || lpad(g::text, 8, '0'), 'u' || (g % 200), 'local-fixture-bot',
      CASE WHEN g <= s.active THEN CURRENT_TIMESTAMP - INTERVAL '72 hours' + ((g + $2::bigint) % 4320) * INTERVAL '1 minute'
        ELSE CURRENT_TIMESTAMP - INTERVAL '10 days' END,
      CASE WHEN $1 = 'skew' AND g <= s.active AND g % 3 = 0 THEN 'old-activation' ELSE 'activation' END,
      $1 = 'skew' AND g % 2 = 0,
      CASE WHEN g > s.active THEN 'deleted' WHEN ($1 = 'retry' AND g % 5 <> 0) OR g % 5 = 0 THEN 'retry' ELSE 'pending' END,
      CURRENT_TIMESTAMP + CASE WHEN g % 3 = 0 THEN INTERVAL '1 hour' ELSE INTERVAL '-1 hour' END,
      CASE WHEN g % 5 = 0 THEN 'i:' || s.chat_id || ':' || g ELSE NULL END,
      CASE WHEN g > s.active THEN CURRENT_TIMESTAMP - INTERVAL '8 days' ELSE NULL END,
      CASE WHEN g > s.active AND g % 101 = 0 THEN 'reconciliation'
        WHEN g <= s.active AND g % 97 = 0 THEN 'worker_error'
        WHEN g <= s.active AND g % 89 = 0 THEN 'waiting_access'
        WHEN g > s.active THEN 'deleted' ELSE NULL END,
      CASE WHEN g > s.active AND g % 101 = 0 THEN CURRENT_TIMESTAMP - INTERVAL '1 minute' ELSE NULL END
    FROM seed_chats s CROSS JOIN LATERAL generate_series(1,s.amount) g`,
    [options.scenario, options.seed],
  );
  await db.query(`INSERT INTO moderation_delete_intents(id,chat_id,message_id,subject_user_id,status,retention_owned)
    SELECT intent_id,chat_id,message_id,author_id, CASE WHEN status='deleted' THEN 'SUCCEEDED' ELSE 'PENDING' END,TRUE
    FROM message_retention_candidates WHERE intent_id IS NOT NULL;
    INSERT INTO moderation_delete_intent_reasons(id,intent_id,rule_code)
    SELECT 'r:' || id,id,'MESSAGE_RETENTION_DELETE' FROM moderation_delete_intents;
    ANALYZE message_retention_candidates; ANALYZE message_retention_policies; ANALYZE moderation_delete_intents;
    ANALYZE moderation_delete_intent_reasons; ANALYZE message_retention_quotas; ANALYZE chats;
    SET statement_timeout = '5s'`);
  return {
    activeRows: rows.reduce((sum, r) => sum + r.active, 0),
    largestChat: Math.max(...rows.map((r) => r.count)),
    pausedAdmissionShards: shards.filter((value) => value >= 50_000).length,
    pausedAdmissionChats: rows.filter((r) => r.active >= 40_000).length,
    shardCounts: shards,
    chatIds: rows.map((r) => r.chatId),
  };
}

export async function runRetentionCapacity(options: Options) {
  const schema = `retention_capacity_${randomUUID().replaceAll('-', '')}`;
  const connection = localConnection(options.postgresUrl);
  const db = new Client(connection.config);
  const scopedUrl = new URL(connection.canonicalUrl);
  scopedUrl.searchParams.set('schema', schema);
  const prisma = new PrismaClient({
    adapter: createPrismaAdapter(scopedUrl.href, {
      max: 2,
      statement_timeout: 5000,
      connectionTimeoutMillis: 3000,
      options: `-c search_path=${schema} -c lock_timeout=1000 -c timezone=UTC`,
      application_name: 'maxim-retention-capacity-orm',
    }),
    log: [{ emit: 'event', level: 'query' }],
  });
  const statements = new Map<string, Statement[]>();
  let operation = '';
  const record = (sql: string, values: unknown[]) => {
    if (!operation) return;
    const list = statements.get(operation) ?? [];
    const branch = (input: unknown[]) =>
      input.filter((value) => value === 'pending' || value === 'retry');
    if (
      !list.some(
        (s) => s.sql === sql && JSON.stringify(branch(s.values)) === JSON.stringify(branch(values)),
      )
    )
      list.push({ sql, values: parameters(values) });
    statements.set(operation, list);
  };
  prisma.$on('query', (event) => record(event.query, JSON.parse(event.params) as unknown[]));
  const adapter = {
    $queryRaw: async (query: Prisma.Sql) => {
      record(query.text, query.values);
      return (await db.query(query.text, parameters(query.values))).rows;
    },
    $executeRaw: async (query: Prisma.Sql) => {
      record(query.text, query.values);
      return (await db.query(query.text, parameters(query.values))).rowCount;
    },
  };
  const store = new MessageRetentionStore(
    prisma as unknown as PrismaService,
    new ConfigService({ MESSAGE_RETENTION_MODE: 'on' }),
  );
  const measurements: Sample[] = [];
  const measure = async (name: string, work: (i: number) => Promise<unknown>) => {
    const times: number[] = [];
    for (let i = 0; i < options.samples; i++) {
      operation = name;
      const start = performance.now();
      try {
        await work(i);
      } finally {
        operation = '';
      }
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    measurements.push({
      operation: name,
      samples: times.length,
      p50Ms: rounded(times[Math.ceil(times.length * 0.5) - 1]!),
      p95Ms: rounded(times[Math.ceil(times.length * 0.95) - 1]!),
      maxMs: rounded(times.at(-1)!),
    });
  };
  const transactionProbe = async (work: () => Promise<unknown>) => {
    await db.query('BEGIN');
    try {
      await work();
    } finally {
      await db.query('ROLLBACK');
    }
  };
  let owned = false;
  try {
    await db.connect();
    // FLAG: Every mutation is constrained to this newly created, privately owned schema.
    await db.query(`CREATE SCHEMA "${schema}"`);
    owned = true;
    await db.query(`SET search_path TO "${schema}"`);
    await initialize(db);
    const seedStart = performance.now();
    const dataset = await seed(db, options);
    const seedMs = rounded(performance.now() - seedStart);
    const probeChat = dataset.chatIds[0]!;
    await prisma.$connect();
    const policy = await prisma.messageRetentionPolicy.findUniqueOrThrow({
      where: { chatId: probeChat },
    });
    const sampledChat = (i: number) =>
      options.scenario === 'hot' ? probeChat : dataset.chatIds[i % dataset.chatIds.length]!;
    await measure('due_candidates', async (i) => {
      const chatId = sampledChat(i);
      return store.dueCandidates({ ...policy, chatId });
    });
    await measure('diagnostics', (i) => store.diagnostics(sampledChat(i)));
    const guardId = (
      await db.query(
        `SELECT intent_id FROM message_retention_candidates
      WHERE chat_id=$1 AND intent_id IS NOT NULL AND status IN ('pending','retry') LIMIT 1`,
        [probeChat],
      )
    ).rows[0]?.intent_id as string | undefined;
    if (guardId)
      await measure('binding_guard', async () => adapter.$queryRaw(retentionBindingQuery(guardId)));
    await measure('capture_transaction', async (i) =>
      transactionProbe(() =>
        captureRetentionMessage(
          adapter as never,
          {
            chatId: probeChat,
            messageId: `capture:${i}`,
            authorId: 'local-human',
            originBotId: 'local-fixture-bot',
            sourceAt: new Date(),
          },
          false,
        ),
      ),
    );
    await measure('purge_transaction', () =>
      transactionProbe(() => purgeRetentionPage(adapter as never, null)),
    );
    const plans: Array<{ operation: string; statement: number; plan: unknown }> = [];
    for (const [name, queries] of statements) {
      await db.query('BEGIN');
      try {
        for (let i = 0; i < queries.length; i++) {
          const query = queries[i]!;
          if (!/^\s*(SELECT|WITH|INSERT|UPDATE|DELETE)/i.test(query.sql)) continue;
          const result = await db.query(
            `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`,
            query.values,
          );
          plans.push({ operation: name, statement: i + 1, plan: result.rows[0]?.['QUERY PLAN'] });
        }
      } finally {
        await db.query('ROLLBACK');
      }
    }
    const storage = (
      await db.query(`SELECT pg_table_size('message_retention_candidates')::text AS table_bytes,
      pg_indexes_size('message_retention_candidates')::text AS index_bytes,
      pg_total_relation_size('message_retention_candidates')::text AS total_bytes,
      COUNT(*)::int AS rows FROM message_retention_candidates`)
    ).rows[0] as { table_bytes: string; index_bytes: string; total_bytes: string; rows: number };
    const server = (await db.query('SELECT version() AS version')).rows[0]?.version;
    const distribution = Object.fromEntries(
      Object.entries(dataset).filter(([key]) => key !== 'chatIds'),
    );
    return {
      kind: 'local_postgresql_capacity_probe',
      scenario: options.scenario,
      probeTarget: options.scenario === 'hot' ? 'hot_chat_every_sample' : 'bounded_chat_sample',
      seed: options.seed,
      chats: options.chats,
      candidates: options.candidates,
      seedMs,
      distribution,
      capturePath: statements
        .get('capture_transaction')
        ?.some((query) => query.sql.includes('INSERT INTO "message_retention_candidates"'))
        ? 'admitted'
        : 'capacity_paused',
      bindingProbeIncluded: Boolean(guardId),
      server,
      measurements,
      storage: {
        ...storage,
        totalBytesPerCandidate: rounded(Number(storage.total_bytes) / storage.rows),
      },
      plans,
      transportModel: retentionTransportCapacityModel(dataset.activeRows, options.transportRps),
    };
  } finally {
    try {
      await prisma.$disconnect();
    } finally {
      try {
        if (owned) {
          await db.query('ROLLBACK');
          await db.query("SET statement_timeout = '30s'");
          await db.query(`DROP SCHEMA "${schema}" CASCADE`);
        }
      } finally {
        await db.end();
      }
    }
  }
}

async function main(): Promise<void> {
  const options = readRetentionCapacityOptions(process.argv.slice(2));
  const result = await runRetentionCapacity(options);
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (options.jsonOutput) {
    if ((await realpath(dirname(options.jsonOutput))) !== '/tmp')
      throw new Error('Output directory must be /tmp');
    const output = await open(options.jsonOutput, 'wx', 0o600);
    try {
      await output.writeFile(json);
    } finally {
      await output.close();
    }
  }
  process.stdout.write(json);
}
if (require.main === module)
  void main().catch((error: unknown) => {
    // Connection errors can contain usernames or URLs; retain only the safe PostgreSQL code.
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : 'CAPACITY_FAILED';
    process.stderr.write(
      `Retention capacity probe failed (${code}); local schema cleanup was attempted.\n`,
    );
    process.exitCode = 1;
  });
