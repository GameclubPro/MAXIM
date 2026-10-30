import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  StatsEntity,
  StatsHealth,
  StatsMetricKey,
  StatsReadContext,
  StatsReadAccess,
  StatsReadRevision,
  StatsHistoryRequest,
  StatsHistoryResult,
  StatsSummaryRequest,
  StatsSummaryResult,
  StatsPeriod,
  StatsCoverage,
  StatsAudienceValue,
} from '@maxim/contracts/statistics-central';
import { PrismaService } from '../prisma/prisma.service';
import type { Prisma } from '../prisma/prisma-client';
import { StatsAccessService } from './stats-access.service';
import { MaximNativeStatsAdapter } from './maxim-native-stats.adapter';
import {
  allKeys,
  asKey,
  assertBytes,
  DAY_MS,
  compareTimes,
  hash,
  keyOf,
  StatsFailure,
  unknownHealth,
} from './stats-common';
import { decodeCursor, encodeCursor } from './stats-cursor';
import { historyRow, selectStats, summarizeStats } from './stats-selector';
import type { StatsCandidate, StatsValue } from './stats-types';
import { readLocalAudienceCurrent } from './stats-local-audience';

type View = Awaited<ReturnType<StatsAccessService['currentView']>>;
export type PreparedStatsView = {
  context: StatsReadContext;
  id: string;
  revision: StatsReadRevision;
  access: StatsReadAccess;
  fingerprint: string;
  health: Record<string, StatsHealth>;
  view: View;
};
type ReadCursor = {
  type: 'history' | 'summary';
  filter: string;
  revisionDigest: string;
  position: number;
  asOf: string;
  expires: number;
};
@Injectable()
export class StatsReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: StatsAccessService,
    private readonly native: MaximNativeStatsAdapter,
    private readonly config: ConfigService,
  ) {}
  localAudienceCurrent(
    entities: StatsEntity[],
    actor: string,
    asOf: Date,
    tx?: Prisma.TransactionClient,
  ) {
    return readLocalAudienceCurrent(
      this.prisma,
      this.access,
      this.config,
      entities,
      actor,
      asOf,
      tx,
    );
  }
  private secret() {
    return this.config.get<string>('SVYAZKA_ANALYTICS_TOKEN') ?? 'local-stats-cursor-disabled';
  }
  private prepare(context: StatsReadContext, consumer: 'MAXIM' | 'EXCHANGE') {
    return this.prisma.$transaction((tx) => this.prepareWithin(tx, context, consumer));
  }
  async prepareWithin(
    tx: Prisma.TransactionClient,
    context: StatsReadContext,
    consumer: 'MAXIM' | 'EXCHANGE',
    selectedKeys: StatsMetricKey[] = allKeys,
  ): Promise<PreparedStatsView | null> {
    const e = (
      await tx.$queryRaw<
        Array<{
          id: string;
          data_revision: bigint;
          health: Record<string, { health: StatsHealth }>;
        }>
      >`SELECT id,data_revision,health FROM stats_entities WHERE kind=${context.entity.kind} AND max_id=${context.entity.maxId} FOR SHARE`
    )[0];
    if (!e) return null;
    const view = await this.access.currentView(tx, e.id, context, consumer);
    const deps = selectedKeys.flatMap((k) =>
      ['MAXIM', 'EXCHANGE'].flatMap((p) =>
        this.access.dependencies(view, p as 'MAXIM' | 'EXCHANGE', k),
      ),
    );
    const validUntil = new Date(
      Math.min(
        view.consumer.peer_valid_until.getTime(),
        ...deps.map((d) => Date.parse(d.peerValidUntil)),
      ),
    ).toISOString();
    return {
      context,
      id: e.id,
      revision: {
        canonicalRevision: e.data_revision.toString(),
        entityRevision: e.data_revision.toString(),
        selectorVersion: 1,
      },
      access: { viewId: view.consumer.id, sourceAuthorityDependencies: deps, validUntil },
      view,
      health: Object.fromEntries(
        Object.entries(e.health)
          .filter(([key]) =>
            selectedKeys.some(
              (k) => keyOf(k) === key && this.access.dependencies(view, 'EXCHANGE', k).length,
            ),
          )
          .map(([key, v]) => [key, v.health]),
      ),
      fingerprint: hash({
        revision: e.data_revision.toString(),
        consumer: {
          id: view.consumer.id,
          epoch: view.consumer.epoch.toString(),
          fence: view.consumer.local_access_fence,
        },
        sources: view.sources
          .map((s) => ({
            id: s.id,
            epoch: s.epoch.toString(),
            scopes: s.scopes,
            fence: s.local_access_fence,
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      }),
    };
  }
  private async prepared(contexts: StatsReadContext[], consumer: 'MAXIM' | 'EXCHANGE') {
    const result: Array<PreparedStatsView | null> = [];
    for (const context of contexts) {
      try {
        result.push(await this.prepare(context, consumer));
      } catch (error) {
        if (error instanceof StatsFailure && error.getStatus() === 403) result.push(null);
        else throw error;
      }
    }
    return result;
  }
  private async verify(
    prepared: Array<PreparedStatsView | null>,
    contexts: StatsReadContext[],
    consumer: 'MAXIM' | 'EXCHANGE',
  ) {
    const current = await this.prepared(contexts, consumer);
    if (
      current.some(
        (v, i) => (v?.fingerprint ?? 'FORBIDDEN') !== (prepared[i]?.fingerprint ?? 'FORBIDDEN'),
      )
    )
      throw new StatsFailure('READ_RESTART', 409);
  }
  private candidates(
    prepared: PreparedStatsView,
    keys: StatsMetricKey[],
    from: string,
    to: string,
  ) {
    return this.candidatesWithin(this.prisma, prepared, keys, from, to);
  }
  async candidatesWithin(
    tx: Prisma.TransactionClient | PrismaService,
    prepared: PreparedStatsView,
    keys: StatsMetricKey[],
    from: string,
    to: string,
    snapshot?: { asOf: Date; retentionFloor: string },
  ): Promise<StatsCandidate[]> {
    const allowed = keys.filter((k) =>
      ['MAXIM', 'EXCHANGE'].some(
        (p) => this.access.dependencies(prepared.view, p as 'MAXIM' | 'EXCHANGE', k).length,
      ),
    );
    if (!allowed.length) return [];
    const nativeKeys = allowed.filter(
      (k) => this.access.dependencies(prepared.view, 'MAXIM', k).length,
    );
    const nativeRows = nativeKeys.length
      ? snapshot
        ? await this.native.readInSnapshot(
            tx,
            prepared.context.entity,
            nativeKeys,
            from,
            to,
            snapshot,
          )
        : await this.native.read(prepared.context.entity, nativeKeys, from, to)
      : [];
    const filters = JSON.stringify(allowed.map(asKey));
    const rowBound = snapshot ? allowed.length * 90 * 2 : 1440;
    const stored = await tx.$queryRaw<
      Array<{
        producer: 'MAXIM' | 'EXCHANGE';
        metric: StatsMetricKey['metric'];
        horizon: 0 | 24 | 48;
        method_id: StatsMetricKey['method']['id'];
        method_version: 1;
        day: string;
        value: StatsValue;
        coverage: StatsCoverage;
      }>
    >`
   SELECT m.producer,m.metric,m.horizon,m.method_id,m.method_version,m.day::text AS day,m.value,m.coverage
   FROM stats_measurements m WHERE m.entity_id=${prepared.id}::uuid AND m.day BETWEEN ${from}::date AND ${to}::date AND m.deleted=false
    AND EXISTS(SELECT 1 FROM jsonb_to_recordset(${filters}::jsonb) AS f(metric text,horizon integer,method jsonb) WHERE f.metric=m.metric AND f.horizon=m.horizon AND f.method->>'id'=m.method_id)
   ORDER BY m.day,m.metric,m.horizon,m.method_id LIMIT ${rowBound + (snapshot ? 1 : 0)}`;
    if (stored.length > rowBound) throw new StatsFailure('UNAVAILABLE', 503);
    const health =
      (
        await tx.$queryRaw<
          Array<{ health: Record<string, { health: StatsHealth }> }>
        >`SELECT health FROM stats_entities WHERE id=${prepared.id}::uuid`
      )[0]?.health ?? {};
    const facts: StatsCandidate[] = [
      ...nativeRows,
      ...stored.map((r) => ({
        producer: r.producer,
        scope: {
          metric: r.metric,
          horizon: r.horizon,
          method: { id: r.method_id, version: r.method_version },
          day: r.day,
        } as StatsCandidate['scope'],
        value: r.value,
        coverage: r.coverage,
        health:
          health[
            keyOf({
              metric: r.metric,
              horizon: r.horizon,
              method: { id: r.method_id, version: 1 },
            } as StatsMetricKey)
          ]?.health ?? unknownHealth(),
      })),
    ];
    const uniqueNative = new Set(nativeRows.map((r) => `${r.scope.day}:${keyOf(r.scope)}`));
    return selectStats(
      facts
        .filter((r) => {
          if (!snapshot || nativeRows.includes(r)) return true;
          const value = r.value;
          const observed =
            'observedAt' in value
              ? value.observedAt
              : 'observedTo' in value
                ? value.observedTo
                : null;
          if (observed && compareTimes(observed, snapshot.asOf.toISOString()) > 0) return false;
          return (
            !('fetchedAt' in value) ||
            compareTimes(value.fetchedAt, snapshot.asOf.toISOString()) <= 0
          );
        })
        .filter(
          (r) =>
            r.producer !== 'MAXIM' ||
            nativeRows.includes(r) ||
            !uniqueNative.has(`${r.scope.day}:${keyOf(r.scope)}`),
        )
        .flatMap((r) => {
          const deps = this.access.dependencies(prepared.view, r.producer, r.scope);
          return deps.length ? [{ ...r, dependencies: deps }] : [];
        }),
    );
  }
  private cursor(
    request: StatsHistoryRequest | StatsSummaryRequest,
    kind: 'history' | 'summary',
    prepared: Array<PreparedStatsView | null>,
  ): ReadCursor {
    const filterBody: Partial<typeof request> = { ...request };
    delete filterBody.cursor;
    const filter = hash(filterBody);
    const revisions = prepared.map((p) => p?.fingerprint ?? 'FORBIDDEN');
    if (!request.cursor)
      return {
        type: kind,
        filter,
        revisionDigest: hash(revisions),
        position: 0,
        asOf: new Date().toISOString(),
        expires: Date.now() + 300_000,
      };
    const c = decodeCursor<ReadCursor>(request.cursor, this.secret());
    if (
      c.type !== kind ||
      c.filter !== filter ||
      !Number.isSafeInteger(c.position) ||
      c.position < 0 ||
      typeof c.revisionDigest !== 'string' ||
      typeof c.asOf !== 'string' ||
      !Number.isFinite(c.expires)
    )
      throw new StatsFailure('INVALID_REQUEST', 400);
    if (c.expires <= Date.now()) throw new StatsFailure('CURSOR_EXPIRED', 410);
    if (c.revisionDigest !== hash(revisions)) throw new StatsFailure('READ_RESTART', 409);
    return c;
  }
  async summaries(
    request: StatsSummaryRequest,
    consumer: 'MAXIM' | 'EXCHANGE' = 'EXCHANGE',
  ): Promise<StatsSummaryResult> {
    const prepared = await this.prepared(request.contexts, consumer);
    const cursor = this.cursor(request, 'summary', prepared);
    const today = cursor.asOf.slice(0, 10),
      maxPeriod = Math.max(...request.periods);
    const from = new Date(Date.parse(`${today}T00:00:00Z`) - (maxPeriod - 1) * DAY_MS)
      .toISOString()
      .slice(0, 10);
    const keys = allKeys.filter(
      (k) => request.metrics.includes(k.metric) && request.horizons.includes(k.horizon),
    );
    const result: StatsSummaryResult = {
      contractVersion: 1,
      asOf: cursor.asOf,
      results: [],
      nextCursor: null,
    };
    const total = request.contexts.length * request.periods.length;
    let position = cursor.position;
    const cache = new Map<number, StatsCandidate[]>();
    for (; position < total; position++) {
      const index = Math.floor(position / request.periods.length),
        period = request.periods[position % request.periods.length]!;
      const context = request.contexts[index]!,
        p = prepared[index];
      if (!p) {
        result.results.push({
          contextId: context.contextId,
          entity: context.entity,
          periodDays: period,
          status: 'FORBIDDEN',
          reason: 'FORBIDDEN',
        });
        continue;
      }
      let rows = cache.get(index);
      if (!rows) {
        rows = await this.candidates(p, keys, from, today);
        cache.set(index, rows);
      }
      const periodFrom = new Date(Date.parse(`${today}T00:00:00Z`) - (period - 1) * DAY_MS)
        .toISOString()
        .slice(0, 10);
      const item: StatsSummaryResult['results'][number] = {
        contextId: context.contextId,
        entity: context.entity,
        periodDays: period,
        status: 'READY',
        revision: p.revision,
        access: p.access,
        summary: summarizeStats(
          rows.filter((r) => r.scope.day >= periodFrom),
          period,
          context.entity.kind,
          request.metrics,
          request.horizons,
          p.health,
        ),
      };
      result.results.push(item);
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 490_000) {
        result.results.pop();
        if (!result.results.length) throw new StatsFailure('BODY_TOO_LARGE', 413);
        break;
      }
    }
    await this.verify(prepared, request.contexts, consumer);
    if (position < total) result.nextCursor = encodeCursor({ ...cursor, position }, this.secret());
    result.asOf = new Date().toISOString();
    assertBytes(result, 524_288);
    return result;
  }
  async history(
    request: StatsHistoryRequest,
    consumer: 'MAXIM' | 'EXCHANGE' = 'EXCHANGE',
  ): Promise<StatsHistoryResult> {
    const prepared = await this.prepared(request.contexts, consumer);
    const cursor = this.cursor(request, 'history', prepared);
    const today = cursor.asOf.slice(0, 10),
      from = new Date(Date.parse(`${today}T00:00:00Z`) - (request.periodDays - 1) * DAY_MS)
        .toISOString()
        .slice(0, 10);
    const keys = allKeys
      .filter(
        (k) =>
          request.metrics.includes(k.metric) &&
          request.horizons.includes(k.horizon) &&
          request.methods.includes(k.method.id),
      )
      .sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
    const queryKeys = [...keys];
    if (
      keys.some((k) => k.method.id === 'AUDIENCE_SNAPSHOT') &&
      keys.some((k) => k.method.id === 'MAXFRAME_EXTERNAL_CALENDAR')
    )
      keys.splice(
        keys.findIndex((k) => k.method.id === 'MAXFRAME_EXTERNAL_CALENDAR'),
        1,
      );
    const perContext = request.periodDays * keys.length,
      total = perContext * request.contexts.length;
    const result: StatsHistoryResult = {
      contractVersion: 1,
      asOf: cursor.asOf,
      results: [],
      nextCursor: null,
    };
    let position = cursor.position,
      count = 0;
    if (!keys.length) return result;
    while (position < total && count < request.rowLimit) {
      const index = Math.floor(position / perContext),
        offset = position % perContext,
        context = request.contexts[index]!,
        p = prepared[index];
      if (!p) {
        result.results.push({
          contextId: context.contextId,
          entity: context.entity,
          status: 'FORBIDDEN',
          reason: 'FORBIDDEN',
        });
        position = (index + 1) * perContext;
        continue;
      }
      const take = Math.min(request.rowLimit - count, perContext - offset);
      const firstDayIndex = Math.floor(offset / keys.length),
        lastDayIndex = Math.floor((offset + take - 1) / keys.length);
      const firstDay = new Date(Date.parse(`${from}T00:00:00Z`) + firstDayIndex * DAY_MS)
          .toISOString()
          .slice(0, 10),
        lastDay = new Date(Date.parse(`${from}T00:00:00Z`) + lastDayIndex * DAY_MS)
          .toISOString()
          .slice(0, 10);
      const lookupFrom =
        firstDayIndex > 0
          ? new Date(Date.parse(`${firstDay}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10)
          : firstDay;
      const rows = await this.candidates(p, queryKeys, lookupFrom, lastDay);
      const map = new Map(rows.map((r) => [`${r.scope.day}:${keyOf(r.scope)}`, r]));
      const item: Extract<StatsHistoryResult['results'][number], { status: 'READY' }> = {
        contextId: context.contextId,
        entity: context.entity,
        status: 'READY',
        revision: p.revision,
        access: p.access,
        rows: [],
      };
      result.results.push(item);
      for (let n = 0; n < take; n++) {
        const dayIndex = Math.floor((offset + n) / keys.length),
          key = keys[(offset + n) % keys.length]!;
        const day = new Date(Date.parse(`${from}T00:00:00Z`) + dayIndex * DAY_MS)
            .toISOString()
            .slice(0, 10),
          previousDay = new Date(Date.parse(`${day}T00:00:00Z`) - DAY_MS)
            .toISOString()
            .slice(0, 10);
        const scope = { ...key, day } as StatsCandidate['scope'];
        const selected =
          map.get(`${day}:${keyOf(key)}`) ??
          (key.method.id === 'AUDIENCE_SNAPSHOT' &&
          queryKeys.some((k) => k.method.id === 'MAXFRAME_EXTERNAL_CALENDAR')
            ? rows.find((r) => r.scope.day === day && r.scope.metric === 'AUDIENCE')
            : undefined);
        const r = historyRow(
          selected?.scope ?? scope,
          selected,
          map.get(`${previousDay}:${keyOf(key)}`),
          context.entity.kind === 'CHAT' &&
            (key.metric === 'REACH' || key.metric === 'PUBLICATION_HOUR'),
        );
        if (r.state === 'UNKNOWN' && p.health[keyOf(key)]) r.health = p.health[keyOf(key)]!;
        item.rows.push(r);
        position++;
        count++;
        if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 490_000) {
          item.rows.pop();
          position--;
          count--;
          if (!count) throw new StatsFailure('BODY_TOO_LARGE', 413);
          break;
        }
      }
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 475_000) break;
    }
    await this.verify(prepared, request.contexts, consumer);
    if (position < total) result.nextCursor = encodeCursor({ ...cursor, position }, this.secret());
    result.asOf = new Date().toISOString();
    assertBytes(result, 524_288);
    return result;
  }
  async localSummary(entity: StatsEntity, actor: string, bot: string, period: StatsPeriod = 90) {
    const context = await this.access.localContext(entity, actor, bot, allKeys);
    return this.summaries(
      {
        contractVersion: 1,
        contexts: [context],
        periods: [period],
        metrics: ['AUDIENCE', 'MEMBERSHIP', 'REACH', 'PUBLICATION_HOUR'],
        horizons: [0, 24, 48],
        cursor: null,
      },
      'MAXIM',
    );
  }
  async localHistory(entity: StatsEntity, actor: string, bot: string, period: StatsPeriod = 90) {
    const context = await this.access.localContext(entity, actor, bot, allKeys);
    const rows: StatsHistoryResult['results'] = [];
    let cursor: string | null = null;
    do {
      const result = await this.history(
        {
          contractVersion: 1,
          contexts: [context],
          periodDays: period,
          metrics: ['AUDIENCE'],
          horizons: [0],
          methods: ['AUDIENCE_SNAPSHOT'],
          rowLimit: 256,
          cursor,
        },
        'MAXIM',
      );
      rows.push(...result.results);
      cursor = result.nextCursor;
    } while (cursor);
    return rows
      .flatMap((item) => (item.status === 'READY' ? item.rows : []))
      .flatMap((r) =>
        r.state === 'VALUE' &&
        r.method.id === 'AUDIENCE_SNAPSHOT' &&
        (r.value as StatsAudienceValue).value !== null &&
        (r.value as StatsAudienceValue).observedAt
          ? [
              {
                capturedAt: new Date((r.value as StatsAudienceValue).observedAt!),
                participantsCount: (r.value as StatsAudienceValue).value!,
              },
            ]
          : [],
      );
  }
}
