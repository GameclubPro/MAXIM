import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { monitorEventLoopDelay, performance, PerformanceObserver } from 'node:perf_hooks';

import { createPrismaAdapter, Prisma, PrismaClient } from '../../src/prisma/prisma-client';
import type { PrismaService } from '../../src/prisma/prisma.service';

type Factory = Prisma.PrismaClientOptionsWithAdapter['adapter'];
type Adapter = Awaited<ReturnType<Factory['connect']>>;
type Transaction = Awaited<ReturnType<Adapter['startTransaction']>>;
type Query = Parameters<Adapter['queryRaw']>[0];
type Method =
  | 'queryRaw'
  | 'executeRaw'
  | 'startTransaction'
  | 'commit'
  | 'rollback'
  | 'createSavepoint'
  | 'rollbackToSavepoint'
  | 'releaseSavepoint'
  | 'executeScript';

export interface AdapterMetric {
  fingerprint: string;
  method: Method;
  calls: number;
  errors: number;
  awaitMs: number;
  returnedSqlRows: number;
  returnedSqlCells: number;
  affectedRows: number;
  directDeliverySelect: boolean;
}

interface Scope {
  metrics: Map<string, AdapterMetric>;
  droppedFamilies: number;
  calls: number;
  errors: number;
  returnedSqlRows: number;
  affectedRows: number;
  deliverySqlRows: number;
  captures: Map<string, Query>;
}

const scopes = new AsyncLocalStorage<Scope>();
let activeScope: Scope | undefined;
const MAX_FAMILIES = 128;
const MAX_CAPTURES = 8;
let deliveryRowsCalibrated = false;

// FLAG: Only a direct, nonaggregating generated delivery SELECT proves row cardinality.
function isDirectDeliverySelect(sql: string): boolean {
  const from = sql.indexOf(' FROM ');
  return (
    /^SELECT\s/u.test(sql) &&
    from > 0 &&
    !sql.slice(0, from).includes('(') &&
    /\bFROM\s+(?:"public"\.)?"managed_broadcast_deliveries"(?:\s+AS\s+"[a-zA-Z0-9_]+")?\s+WHERE\b/u.test(
      sql,
    ) &&
    !/\b(?:JOIN|GROUP|UNION|FOR|json_agg|jsonb_agg|count|array_agg)\b/iu.test(sql)
  );
}

async function observed<T>(
  method: Method,
  operation: () => Promise<T>,
  query?: Query,
  cardinality?: (value: T) => { rows: number; cells: number; affected: number },
): Promise<T> {
  // Prisma's engine can invoke the adapter from an AsyncResource created before run().
  // This test process permits exactly one fully awaited turn and no application workers.
  const scope = scopes.getStore() ?? activeScope;
  if (!scope) return operation();
  const sql = query?.sql ?? method;
  const fingerprint = createHash('sha256').update(sql).digest('hex').slice(0, 20);
  const key = `${method}:${fingerprint}`;
  let metric = scope.metrics.get(key);
  if (!metric && scope.metrics.size < MAX_FAMILIES) {
    metric = {
      fingerprint,
      method,
      calls: 0,
      errors: 0,
      awaitMs: 0,
      returnedSqlRows: 0,
      returnedSqlCells: 0,
      affectedRows: 0,
      directDeliverySelect: !!query && isDirectDeliverySelect(sql),
    };
    scope.metrics.set(key, metric);
  } else if (!metric) scope.droppedFamilies++;
  if (
    query &&
    metric?.directDeliverySelect &&
    !scope.captures.has(fingerprint) &&
    scope.captures.size < MAX_CAPTURES &&
    query.args.length <= 64 &&
    sql.length <= 65536
  ) {
    // Parameters stay in this disposable process, never in the report.
    scope.captures.set(fingerprint, query);
  }
  scope.calls++;
  if (metric) metric.calls++;
  const started = performance.now();
  try {
    const result = await operation();
    const size = cardinality?.(result);
    if (size) {
      scope.returnedSqlRows += size.rows;
      scope.affectedRows += size.affected;
      if (metric) {
        metric.returnedSqlRows += size.rows;
        metric.returnedSqlCells += size.cells;
        metric.affectedRows += size.affected;
      }
      if (query && isDirectDeliverySelect(sql)) scope.deliverySqlRows += size.rows;
    }
    return result;
  } catch (error) {
    scope.errors++;
    if (metric) metric.errors++;
    throw error;
  } finally {
    if (metric) metric.awaitMs += performance.now() - started;
  }
}

function queryMethods(adapter: Pick<Adapter, 'queryRaw' | 'executeRaw'>) {
  return {
    queryRaw: (query: Query) =>
      observed(
        'queryRaw',
        () => adapter.queryRaw(query),
        query,
        (result) => ({
          rows: result.rows.length,
          cells: result.rows.length * result.columnNames.length,
          affected: 0,
        }),
      ),
    executeRaw: (query: Query) =>
      observed(
        'executeRaw',
        () => adapter.executeRaw(query),
        query,
        (affected) => ({ rows: 0, cells: 0, affected }),
      ),
  };
}

function wrapTransaction(tx: Transaction): Transaction {
  const createSavepoint = tx.createSavepoint;
  const rollbackToSavepoint = tx.rollbackToSavepoint;
  const releaseSavepoint = tx.releaseSavepoint;
  return {
    provider: tx.provider,
    adapterName: tx.adapterName,
    options: tx.options,
    ...queryMethods(tx),
    commit: () => observed('commit', () => tx.commit()),
    rollback: () => observed('rollback', () => tx.rollback()),
    ...(createSavepoint
      ? {
          createSavepoint: (name: string) =>
            observed('createSavepoint', () => createSavepoint.call(tx, name)),
        }
      : {}),
    ...(rollbackToSavepoint
      ? {
          rollbackToSavepoint: (name: string) =>
            observed('rollbackToSavepoint', () => rollbackToSavepoint.call(tx, name)),
        }
      : {}),
    ...(releaseSavepoint
      ? {
          releaseSavepoint: (name: string) =>
            observed('releaseSavepoint', () => releaseSavepoint.call(tx, name)),
        }
      : {}),
  };
}

function wrapFactory(factory: Factory): Factory {
  return {
    provider: factory.provider,
    adapterName: factory.adapterName,
    async connect(): Promise<Adapter> {
      const adapter = await factory.connect();
      const getConnectionInfo = adapter.getConnectionInfo;
      return {
        provider: adapter.provider,
        adapterName: adapter.adapterName,
        ...queryMethods(adapter),
        startTransaction: (isolation) =>
          observed('startTransaction', async () =>
            wrapTransaction(await adapter.startTransaction(isolation)),
          ),
        executeScript: (script) => observed('executeScript', () => adapter.executeScript(script)),
        dispose: () => adapter.dispose(),
        ...(getConnectionInfo ? { getConnectionInfo: () => getConnectionInfo.call(adapter) } : {}),
      };
    },
  };
}

export class ProfilePrisma extends PrismaClient {
  constructor(url: string) {
    super({
      adapter: wrapFactory(
        createPrismaAdapter(url, {
          max: 3,
          statement_timeout: 10000,
          options: '-c timezone=UTC',
          application_name: 'publisher-turn-profile',
        }),
      ),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }
  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

// Compile-time proof of the dependency boundary, without casts or runtime instantiation.
export function asPrismaService(client: ProfilePrisma): PrismaService {
  return client;
}

export async function profileTurn<T>(operation: () => Promise<T>) {
  if (activeScope) throw new Error('Profile scopes must not overlap');
  const scope: Scope = {
    metrics: new Map(),
    captures: new Map(),
    droppedFamilies: 0,
    calls: 0,
    errors: 0,
    returnedSqlRows: 0,
    affectedRows: 0,
    deliverySqlRows: 0,
  };
  const memoryBefore = process.memoryUsage();
  const cpuBefore = process.cpuUsage();
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  let gcCount = 0;
  let gcMs = 0;
  const gc = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      gcCount++;
      gcMs += entry.duration;
    }
  });
  gc.observe({ entryTypes: ['gc'] });
  let sampledRssPeak = memoryBefore.rss;
  let memorySamples = 0;
  let largestSampleGapMs = 0;
  let previousSample = performance.now();
  const sampler = setInterval(() => {
    const now = performance.now();
    largestSampleGapMs = Math.max(largestSampleGapMs, now - previousSample);
    previousSample = now;
    memorySamples++;
    sampledRssPeak = Math.max(sampledRssPeak, process.memoryUsage().rss);
  }, 20);
  const startedAt = new Date().toISOString();
  const start = performance.now();
  let result: T | undefined;
  let failure: unknown;
  let failed = false;
  activeScope = scope;
  try {
    result = await scopes.run(scope, operation);
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    activeScope = undefined;
    clearInterval(sampler);
    histogram.disable();
    for (const entry of gc.takeRecords()) {
      gcCount++;
      gcMs += entry.duration;
    }
    gc.disconnect();
  }
  const elapsedMs = performance.now() - start;
  const memoryAfter = process.memoryUsage();
  sampledRssPeak = Math.max(sampledRssPeak, memoryAfter.rss);
  largestSampleGapMs = Math.max(largestSampleGapMs, performance.now() - previousSample);
  const metrics = {
    startedAt,
    endedAt: new Date().toISOString(),
    elapsedMs,
    failed,
    adapterCalls: scope.calls,
    adapterErrors: scope.errors,
    returnedSqlRows: scope.returnedSqlRows,
    affectedRows: scope.affectedRows,
    deliverySqlRows: deliveryRowsCalibrated ? scope.deliverySqlRows : null,
    hydratedDeliveryCount: null,
    hydrationLimitation: 'Driver rows do not expose hydrated Prisma relation cardinality.',
    adapterLimitation:
      'Adapter await includes admission/connection waits; internal BEGIN/isolation/savepoint SQL is not separately observed.',
    droppedFamilyObservations: scope.droppedFamilies,
    families: [...scope.metrics.values()].sort(
      (a, b) => b.returnedSqlRows - a.returnedSqlRows || b.awaitMs - a.awaitMs,
    ),
    memoryBefore,
    memoryAfter,
    sampledRssPeak,
    memorySamples,
    memorySampleIntervalMs: 20,
    largestSampleGapMs,
    cpuMicros: process.cpuUsage(cpuBefore),
    gcObservedCount: gcCount,
    gcObservedMs: gcMs,
    eventLoop: {
      samples: histogram.count,
      maxMs: histogram.count ? histogram.max / 1e6 : null,
      meanMs: histogram.count ? histogram.mean / 1e6 : null,
    },
  };
  return { result, failure, metrics, captures: scope.captures };
}

export async function calibrateDeliveryRows(
  prisma: PrismaService,
  broadcastId: string,
  expected: number,
) {
  const measured = await profileTurn(() =>
    prisma.managedBroadcast.findUniqueOrThrow({
      where: { id: broadcastId },
      select: { deliveries: { select: { id: true } } },
    }),
  );
  if (measured.metrics.failed) throw measured.failure;
  const observed = measured.metrics.families
    .filter((row) => row.directDeliverySelect)
    .reduce((sum, row) => sum + row.returnedSqlRows, 0);
  deliveryRowsCalibrated = measured.result?.deliveries.length === expected && observed === expected;
  return {
    expected,
    observed,
    hydratedInCalibration: measured.result?.deliveries.length,
    directDeliverySelectProved: deliveryRowsCalibrated,
    adapterFamilies: measured.metrics.families,
  };
}

export async function explainCapturedDeliveryReads(
  prisma: PrismaService,
  captures: Map<string, Query>,
) {
  const summaries: { fingerprint: string; nodes: Record<string, unknown>[] }[] = [];
  for (const [fingerprint, query] of [...captures].slice(0, 3)) {
    if (!isDirectDeliverySelect(query.sql)) throw new Error('Unapproved profile plan query');
    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      return tx.$queryRawUnsafe<unknown>(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`,
        ...query.args,
      );
    });
    const nodes: Record<string, unknown>[] = [];
    const visit = (value: unknown): void => {
      if (!value || typeof value !== 'object' || nodes.length >= 64) return;
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      const row = Object.fromEntries(Object.entries(value));
      if (typeof row['Node Type'] === 'string') {
        nodes.push(
          Object.fromEntries(
            Object.entries(row).filter(([key]) =>
              [
                'Node Type',
                'Relation Name',
                'Index Name',
                'Actual Rows',
                'Actual Loops',
                'Actual Total Time',
                'Shared Hit Blocks',
                'Shared Read Blocks',
                'Rows Removed by Filter',
              ].includes(key),
            ),
          ),
        );
      }
      for (const key of ['QUERY PLAN', 'Plan', 'Plans']) if (row[key]) visit(row[key]);
    };
    visit(result);
    summaries.push({ fingerprint, nodes });
  }
  return summaries;
}
