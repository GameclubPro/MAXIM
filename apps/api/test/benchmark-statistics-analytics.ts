/** Bounded synthetic native PostgreSQL benchmark; never accepts a production database. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { z } from 'zod';
import type {
  StatsAuthorityOperation,
  StatsReadContext,
  StatsReplaceDay,
} from '@maxim/contracts/statistics-central';
import { statsAnalyticsResultSchema } from '@maxim/contracts/statistics-analytics-validation';
import { PrismaClient, createPrismaAdapter } from '../src/prisma/prisma-client';
import type { PrismaService } from '../src/prisma/prisma.service';
import { StatsAccessService } from '../src/statistics/stats-access.service';
import { StatsIngestService } from '../src/statistics/stats-ingest.service';
import { StatsReadService } from '../src/statistics/stats-read.service';
import { StatsAnalyticsService } from '../src/statistics/stats-analytics.service';
import { MaximNativeStatsAdapter } from '../src/statistics/maxim-native-stats.adapter';
import { StatsReadBudget } from '../src/statistics/stats-read-budget';

export const ANALYTICS_BENCHMARK_PROFILE = Object.freeze({
  entities: 1000,
  retainedEntities: 100,
  denseChannels: 10,
  days: 90,
  postsPerDay: 24,
  summaries: 100,
  histories: 20,
  concurrency: 1,
  p95Ms: 2000,
  p99Ms: 5000,
  deadlineMs: 12 * 60_000,
});
export function analyticsBenchmarkDistribution(values: number[]) {
  assert.equal(values.length, ANALYTICS_BENCHMARK_PROFILE.summaries, 'Incomplete benchmark');
  assert(
    values.every((value) => Number.isFinite(value) && value >= 0),
    'Invalid latency',
  );
  const sorted = [...values].sort((a, b) => a - b);
  const result = {
    count: sorted.length,
    p50Ms: sorted[49]!,
    p95Ms: sorted[94]!,
    p99Ms: sorted[98]!,
    maxMs: sorted[99]!,
  };
  assert(result.p95Ms <= ANALYTICS_BENCHMARK_PROFILE.p95Ms, 'Summary p95 exceeds 2000ms');
  assert(result.p99Ms <= ANALYTICS_BENCHMARK_PROFILE.p99Ms, 'Summary p99 exceeds 5000ms');
  return result;
}
const capturedSchema = z.object({ strings: z.array(z.string()), values: z.array(z.unknown()) });
type Statement = { text: string; values: unknown[] };
function statement(args: unknown[]): Statement | null {
  const first = args[0];
  if (Array.isArray(first) && first.every((value) => typeof value === 'string'))
    return {
      text: first.map((part, i) => `${part}${i < first.length - 1 ? `$${i + 1}` : ''}`).join(''),
      values: args.slice(1),
    };
  const parsed = capturedSchema.safeParse(first);
  return parsed.success
    ? {
        text: parsed.data.strings
          .map((part, i) => `${part}${i < parsed.data.strings.length - 1 ? `$${i + 1}` : ''}`)
          .join(''),
        values: parsed.data.values,
      }
    : null;
}
const planSchema: z.ZodType<{
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Actual Rows': number;
  'Actual Loops': number;
  'Rows Removed by Filter'?: number;
  Plans?: Plan[];
}> = z.lazy(() =>
  z.object({
    'Node Type': z.string(),
    'Relation Name': z.string().optional(),
    'Index Name': z.string().optional(),
    'Actual Rows': z.number(),
    'Actual Loops': z.number(),
    'Rows Removed by Filter': z.number().optional(),
    Plans: z.array(planSchema).optional(),
  }),
);
type Plan = z.infer<typeof planSchema>;
export function summarizeAnalyticsBenchmarkPlan(raw: unknown) {
  const root = planSchema.parse(raw),
    nodes: Plan[] = [];
  const visit = (node: Plan) => {
    nodes.push(node);
    node.Plans?.forEach(visit);
  };
  visit(root);
  const touched = (table: string) =>
    nodes
      .filter((node) => node['Relation Name'] === table)
      .reduce(
        (sum, node) =>
          sum +
          (node['Actual Rows'] + (node['Rows Removed by Filter'] ?? 0)) * node['Actual Loops'],
        0,
      );
  assert(touched('stats_measurements') <= 500, 'Measurement query scans unrelated history');
  assert(touched('channel_posts') <= 15_000, 'Native query scans unrelated channel history');
  return {
    nodes: nodes.length,
    returnedRows: root['Actual Rows'],
    processedRows: nodes.reduce((sum, node) => sum + node['Actual Rows'] * node['Actual Loops'], 0),
    measurementsVisited: touched('stats_measurements'),
    postsVisited: touched('channel_posts'),
    indexes: [
      ...new Set(nodes.flatMap((node) => (node['Index Name'] ? [node['Index Name']] : []))),
    ],
  };
}
export async function runStatisticsAnalyticsBenchmark(
  databaseUrl: string,
  emit: (value: unknown) => void = console.log,
) {
  const url = new URL(databaseUrl);
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    !/^\/maxim_race_test_[a-zA-Z0-9_]+$/.test(url.pathname) ||
    url.searchParams.has('host')
  )
    throw new Error('Disposable local maxim_race_test database required');
  const started = performance.now(),
    runId = randomUUID(),
    epoch = randomUUID(),
    actor = '323459159';
  const deadline = started + ANALYTICS_BENCHMARK_PROFILE.deadlineMs;
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), ANALYTICS_BENCHMARK_PROFILE.deadlineMs);
  timer.unref();
  let stage = 'setup',
    completed = 0,
    lastSuccessAt: string | null = null,
    sqlCalls = 0,
    sqlRows = 0,
    measured = false;
  const heartbeat = setInterval(
    () =>
      emit({
        event: 'analytics-benchmark-heartbeat',
        runId,
        stage,
        completed,
        lastSuccessAt,
        remainingMs: Math.max(0, Math.floor(deadline - performance.now())),
      }),
    10_000,
  );
  heartbeat.unref();
  const check = () => {
    if (controller.signal.aborted || performance.now() >= deadline)
      throw new Error('Benchmark deadline exceeded');
  };
  const db = new PrismaClient({
    adapter: createPrismaAdapter(databaseUrl, {
      max: 4,
      statement_timeout: 5000,
      connectionTimeoutMillis: 500,
      application_name: 'synthetic-analytics-benchmark',
    }),
  });
  const verifier = new Pool({
    connectionString: databaseUrl,
    max: 1,
    statement_timeout: 5000,
    connectionTimeoutMillis: 1000,
  });
  const captured = new Map<string, Statement>();
  function tracked<T extends object>(target: T): T {
    return new Proxy(target, {
      get(object, key, receiver) {
        const value: unknown = Reflect.get(object, key, receiver);
        if (typeof value !== 'function') return value;
        if (key === '$transaction')
          return (run: (tx: object) => Promise<unknown>, options: unknown) =>
            Reflect.apply(value, object, [(tx: object) => run(tracked(tx)), options]);
        if (key === '$queryRaw' || key === '$executeRaw')
          return async (...args: unknown[]) => {
            const result: unknown = await Reflect.apply(value, object, args);
            if (measured) {
              sqlCalls++;
              if (Array.isArray(result)) sqlRows += result.length;
              const query = statement(args);
              if (
                query &&
                /\bSELECT\b/i.test(query.text) &&
                /\b(stats_measurements|channel_posts)\b/.test(query.text) &&
                captured.size < 16
              )
                captured.set(createHash('sha256').update(query.text).digest('hex'), query);
            }
            return result;
          };
        return value.bind(object);
      },
    });
  }
  const source = tracked(db) as unknown as PrismaService;
  const config = new ConfigService({
    STATISTICS_CENTRAL_ENABLED: 'true',
    STATISTICS_CENTRAL_MODE: 'CENTRAL',
    STATISTICS_CENTRAL_EXCHANGE_EPOCH: epoch,
    SVYAZKA_ANALYTICS_TOKEN: 'synthetic-benchmark-token',
  });
  const access = new StatsAccessService(source, config),
    ingest = new StatsIngestService(source, access);
  const reader = new StatsReadService(source, access, new MaximNativeStatsAdapter(source), config),
    analytics = new StatsAnalyticsService(source, reader, config);
  const salt = BigInt('0x' + runId.replaceAll('-', '').slice(0, 12)) * 10_000n;
  const entities = Array.from({ length: 1000 }, (_, index) => ({
    kind: 'CHANNEL' as const,
    maxId: `-${salt + BigInt(index + 1)}`,
  }));
  const contexts: StatsReadContext[] = [];
  const scope = {
    metric: 'PUBLICATION_HOUR' as const,
    horizon: 0 as const,
    method: { id: 'PUBLICATION_DAY_HOURS' as const, version: 1 as const },
  };
  const setupAt = new Date(),
    midnight = Math.floor(setupAt.getTime() / 86_400_000) * 86_400_000;
  try {
    await db.$connect();
    const timezone = await verifier.query(
      "SELECT current_setting('TimeZone') timezone,current_setting('server_version_num') version",
    );
    assert.equal(timezone.rows[0].timezone, 'UTC');
    assert(Number(timezone.rows[0].version) >= 160000);
    await db.statsEntity.createMany({
      data: entities.map((entity) => ({ kind: entity.kind, maxId: entity.maxId })),
    });
    for (let index = 0; index < 100; index++) {
      check();
      const entity = entities[index]!;
      if (index < 10) {
        await db.chat.create({
          data: { id: entity.maxId, title: 'Synthetic analytics benchmark', entityType: 'CHANNEL' },
        });
        await db.chatBotMembership.create({
          data: {
            chatId: entity.maxId,
            botId: runId,
            status: 'ACTIVE',
            botAccessState: 'CONFIRMED_ADMIN',
          },
        });
        await db.managedEntityAccessEdge.create({
          data: {
            chatId: entity.maxId,
            userId: actor,
            botId: runId,
            entityType: 'CHANNEL',
            state: 'GRANTED',
            userRole: 'ADMIN',
            botRole: 'ADMIN',
            checkedAt: setupAt,
          },
        });
        await db.channelPost.createMany({
          data: Array.from({ length: 90 * 24 }, (_, slot) => ({
            chatId: entity.maxId,
            messageId: `synthetic-${slot}`,
            publishedAt: new Date(midnight - 89 * 86_400_000 + slot * 3_600_000),
            latestSnapshotAt: setupAt,
            latestViews: 10,
          })),
        });
        await db.channelViewArchiveState.create({
          data: {
            chatId: entity.maxId,
            discoveryCompleteAt: setupAt,
            fullRefreshAt: setupAt,
            lastSuccessAt: setupAt,
          },
        });
      }
      const operation: StatsAuthorityOperation = {
        id: randomUUID(),
        revision: '1',
        operation: 'ATTEST',
        entity,
        role: 'SOURCE',
        actorMaxUserId: actor,
        botRef: runId,
        consumer: 'EXCHANGE',
        purpose: 'OWNER_ANALYTICS',
        scopes: [scope],
        checkedAt: new Date().toISOString(),
        producerEpoch: epoch,
        localAccessFence: 'synthetic-benchmark-fence',
      };
      const consumer = { ...operation, id: randomUUID(), role: 'CONSUMER' as const };
      const grants = await access.attest({
        contractVersion: 1,
        requestId: randomUUID(),
        operations: [operation, consumer],
      });
      assert(grants.results.every((result) => result.errorCode === null));
      if (index < 10)
        contexts.push({
          contextId: randomUUID(),
          entity,
          actorMaxUserId: actor,
          purpose: 'OWNER_ANALYTICS',
          consumerAuthority: { id: consumer.id, epoch: grants.results[1]!.epoch },
        });
      const operations: StatsReplaceDay[] = Array.from({ length: 90 }, (_, offset) => {
        const start = midnight - offset * 86_400_000;
        return {
          ...scope,
          operation: 'REPLACE_DAY',
          day: new Date(start).toISOString().slice(0, 10),
          sourceRevision: '1',
          authority: { id: operation.id, epoch: grants.results[0]!.epoch },
          value: {
            hours: Array.from({ length: 24 }, (_, hour) =>
              start + (hour + 1) * 3_600_000 <= setupAt.getTime() ? 1 : null,
            ),
            observedFrom: new Date(start).toISOString(),
            observedTo: new Date(Math.min(start + 86_400_000, setupAt.getTime())).toISOString(),
          },
          coverage: {
            state: offset ? 'COMPLETE' : 'PARTIAL',
            intervals: [
              {
                from: new Date(start).toISOString(),
                to: new Date(Math.min(start + 86_400_000, setupAt.getTime())).toISOString(),
              },
            ],
            populationComplete: offset > 0,
          },
        };
      });
      for (let offset = 0; offset < operations.length; offset += 30)
        await ingest.ingest({
          contractVersion: 1,
          requestId: randomUUID(),
          producerEpoch: epoch,
          entity,
          operations: operations.slice(offset, offset + 30),
        });
      lastSuccessAt = new Date().toISOString();
    }
    const fixture = {
      entities: await db.statsEntity.count({
        where: { maxId: { in: entities.map((entity) => entity.maxId) } },
      }),
      measurements: await db.statsMeasurement.count({ where: { producerEpoch: epoch } }),
      posts: await db.channelPost.count({
        where: { chatId: { in: entities.slice(0, 10).map((entity) => entity.maxId) } },
      }),
    };
    assert.deepEqual(fixture, { entities: 1000, measurements: 9000, posts: 21600 });
    await verifier.query('ANALYZE stats_measurements');
    await verifier.query('ANALYZE channel_posts');
    // Refresh only synthetic benchmark grants after setup; no measurements or measured requests are retried.
    for (const context of contexts) {
      const row = await db.statsAuthority.findUniqueOrThrow({
        where: { id: context.consumerAuthority.id },
      });
      await access.attest({
        contractVersion: 1,
        requestId: randomUUID(),
        operations: [
          {
            id: row.id,
            revision: row.revision.toString(),
            operation: 'ATTEST',
            entity: context.entity,
            role: 'CONSUMER',
            actorMaxUserId: actor,
            botRef: runId,
            consumer: 'EXCHANGE',
            purpose: 'OWNER_ANALYTICS',
            scopes: [scope],
            checkedAt: new Date().toISOString(),
            producerEpoch: epoch,
            localAccessFence: row.localAccessFence,
          },
        ],
      });
    }
    const samples: number[] = [],
      responseBytes: number[] = [],
      requestBytes: number[] = [];
    stage = 'measured-reads';
    measured = true;
    for (let index = 0; index < 120; index++) {
      check();
      const context = contexts[index % contexts.length]!;
      const request = {
        contractVersion: 1 as const,
        analyticsVersion: 1 as const,
        context,
        periodDays: 90 as const,
        metrics: ['PUBLICATION_HOUR' as const],
        horizons: [],
        includeComparison: true,
        includeHistory: index >= 100,
        cursor: null,
      };
      const begin = performance.now();
      const raw = await analytics.read(request, StatsReadBudget.start(5000, controller.signal));
      const elapsed = performance.now() - begin;
      const result = statsAnalyticsResultSchema.parse(raw);
      assert('status' in result && result.page === 'INITIAL');
      assert.equal(result.metrics.length, 1);
      const metric = result.metrics[0]!;
      assert.equal(metric.metric, 'PUBLICATION_HOUR');
      assert.equal(metric.current.state, 'AVAILABLE');
      assert(
        metric.comparison.state === 'UNAVAILABLE' &&
          metric.comparison.reason === 'OUTSIDE_RETENTION',
      );
      const bytes = Buffer.byteLength(JSON.stringify(result));
      assert(bytes <= 524288);
      responseBytes.push(bytes);
      requestBytes.push(Buffer.byteLength(JSON.stringify(request)));
      if (index < 100) {
        samples.push(elapsed);
        assert.equal(result.history.state, 'NOT_REQUESTED');
      } else {
        assert(result.history.state === 'READY');
        assert.equal(result.history.rows.length, 90);
        assert.equal(new Set(result.history.rows.map((row) => row.day)).size, 90);
        assert.equal(result.history.nextCursor, null);
      }
      const independent = await verifier.query(
        "SELECT count(*)::int total FROM channel_posts WHERE chat_id=$1 AND published_at>=greatest($2::timestamptz, date_trunc('day',$4::timestamptz)-interval '89 days') AND published_at<$3::timestamptz AND published_at<=$4::timestamptz",
        [context.entity.maxId, metric.current.window.from, metric.current.window.to, result.asOf],
      );
      if (
        metric.current.state === 'AVAILABLE' &&
        metric.current.value.metric === 'PUBLICATION_HOUR'
      )
        assert.equal(metric.current.value.count, independent.rows[0].total);
      completed++;
      lastSuccessAt = new Date().toISOString();
    }
    measured = false;
    stage = 'query-plans';
    assert(captured.size > 0);
    const plans = [];
    for (const [shapeHash, query] of captured) {
      check();
      const result = await verifier.query(
        `EXPLAIN (ANALYZE,BUFFERS,WAL,FORMAT JSON) ${query.text}`,
        query.values,
      );
      const output = z
        .array(z.object({ Plan: z.unknown(), 'Execution Time': z.number() }))
        .parse(result.rows[0]['QUERY PLAN']);
      plans.push({
        shapeHash,
        executionMs: output[0]!['Execution Time'],
        ...summarizeAnalyticsBenchmarkPlan(output[0]!.Plan),
      });
    }
    const result = {
      ok: true,
      kind: 'CANONICAL_ANALYTICS_NATIVE_PG',
      runId,
      profile: ANALYTICS_BENCHMARK_PROFILE,
      fixture,
      summary: analyticsBenchmarkDistribution(samples),
      histories: 20,
      maxResponseBytes: Math.max(...responseBytes),
      maxRequestBytes: Math.max(...requestBytes),
      sqlCalls,
      sqlRows,
      plans,
      elapsedMs: Math.round(performance.now() - started),
      lastSuccessAt,
      productionReads: 0,
      productionWrites: 0,
      httpLatencyMeasured: false,
    };
    emit(result);
    return result;
  } finally {
    measured = false;
    clearInterval(heartbeat);
    clearTimeout(timer);
    controller.abort();
    await db.statsEntity
      .deleteMany({ where: { maxId: { in: entities.map((entity) => entity.maxId) } } })
      .catch(() => undefined);
    await db.statsIngestRequest
      .deleteMany({ where: { producerEpoch: epoch } })
      .catch(() => undefined);
    await db.chat
      .deleteMany({ where: { id: { in: entities.slice(0, 10).map((entity) => entity.maxId) } } })
      .catch(() => undefined);
    await db.$disconnect();
    await verifier.end();
  }
}
if (require.main === module) {
  runStatisticsAnalyticsBenchmark(
    process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL ??
      process.env.MAXIM_TEST_POSTGRES_URL ??
      '',
    (value) => console.log(JSON.stringify(value)),
  ).catch(() => {
    console.error(
      JSON.stringify({
        ok: false,
        kind: 'CANONICAL_ANALYTICS_NATIVE_PG',
        code: 'BENCHMARK_FAILED',
      }),
    );
    process.exitCode = 1;
  });
}
