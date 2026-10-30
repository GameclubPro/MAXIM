import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  StatsAnalyticsCursorBody,
  StatsAnalyticsHeader,
  StatsAnalyticsHistoryRow,
  StatsAnalyticsRequest,
  StatsAnalyticsResult,
  StatsAnalyticsSelection,
} from '@maxim/contracts/statistics-analytics';
import { STATS_ANALYTICS_LIMITS } from '@maxim/contracts/statistics-analytics';
import {
  statsAnalyticsCursorSchema,
  statsAnalyticsResultSchema,
} from '@maxim/contracts/statistics-analytics-validation';
import type { StatsMetric, StatsMetricKey } from '@maxim/contracts/statistics-central';
import { PrismaService } from '../prisma/prisma.service';
import { StatsReadService } from './stats-read.service';
import { allKeys, DAY_MS, hash } from './stats-common';
import { decodeCursor, encodeCursor } from './stats-cursor';
import {
  calculateStatsAnalytics,
  calculateStatsAnalyticsHistory,
  planAnalyticsWindows,
} from './stats-analytics-calculator';
import {
  analyticsFailure,
  StatsAnalyticsFailure,
  StatsReadBudget,
  statsReadTransaction,
} from './stats-read-budget';

type Slot = { day: string; selection: StatsAnalyticsSelection };
type Ready = Extract<StatsAnalyticsResult, { status: 'READY' }>;
const metricOrder: StatsMetric[] = ['AUDIENCE', 'MEMBERSHIP', 'PUBLICATION_HOUR', 'REACH'];
const slotKey = (slot: Slot) => `${slot.day}:${slot.selection.metric}:${slot.selection.horizon}`;
const rowSlot = (row: StatsAnalyticsHistoryRow): Slot => ({
  day: row.day,
  selection: { metric: row.metric, horizon: row.horizon } as StatsAnalyticsSelection,
});
const utcDay = (date: Date) => date.toISOString().slice(0, 10);
const shiftDay = (day: string, offset: number) =>
  utcDay(new Date(Date.parse(`${day}T00:00:00Z`) + offset * DAY_MS));
const retentionFloor = (now: Date) => shiftDay(utcDay(now), -89);

function historySlots(plan: ReturnType<typeof planAnalyticsWindows>): Slot[] {
  const slots: Slot[] = [];
  for (const window of plan.windows) {
    for (
      let day = window.current.fromDay;
      day < window.current.toDayExclusive;
      day = shiftDay(day, 1)
    )
      slots.push({ day, selection: window.selection });
  }
  return slots.sort(
    (a, b) =>
      a.day.localeCompare(b.day) ||
      metricOrder.indexOf(a.selection.metric) - metricOrder.indexOf(b.selection.metric) ||
      a.selection.horizon - b.selection.horizon,
  );
}
function pageRange(slots: Slot[], floor: string, today: string) {
  const fromDays = slots.map((slot) =>
    shiftDay(
      slot.day,
      slot.selection.metric === 'PUBLICATION_HOUR' || slot.selection.metric === 'AUDIENCE' ? -1 : 0,
    ),
  );
  const toDays = slots.map((slot) => slot.day);
  return {
    fromDay: [floor, fromDays.sort()[0]!].sort().at(-1)!,
    toDay: [today, toDays.sort().at(-1)!].sort()[0]!,
  };
}

@Injectable()
export class StatsAnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reader: StatsReadService,
    private readonly config: ConfigService,
  ) {}

  async read(
    request: StatsAnalyticsRequest,
    budget: StatsReadBudget,
  ): Promise<StatsAnalyticsResult> {
    try {
      return await this.readPage(request, budget);
    } catch (error) {
      throw analyticsFailure(error);
    }
  }

  private async readPage(request: StatsAnalyticsRequest, budget: StatsReadBudget): Promise<Ready> {
    budget.check();
    if (request.includeHistory && request.context.purpose !== 'OWNER_ANALYTICS')
      throw new StatsAnalyticsFailure('FORBIDDEN', 403);
    if (request.cursor && !request.includeHistory)
      throw new StatsAnalyticsFailure('INVALID_REQUEST', 400);
    const secret = this.config.get<string>('SVYAZKA_ANALYTICS_TOKEN');
    if (!secret) throw new StatsAnalyticsFailure('UNAVAILABLE', 503);
    const filterHash = hash({
      ...request,
      cursor: null,
      metrics: [...request.metrics].sort(),
      horizons: [...request.horizons].sort((a, b) => a - b),
    });
    const cursor = request.cursor
      ? statsAnalyticsCursorSchema.safeParse(decodeCursor<unknown>(request.cursor, secret))
      : null;
    if (cursor && !cursor.success) throw new StatsAnalyticsFailure('INVALID_REQUEST', 400);
    const previous = cursor?.success ? cursor.data : null;
    if (previous && previous.filterHash !== filterHash)
      throw new StatsAnalyticsFailure('INVALID_REQUEST', 400);

    const selectedKeys = allKeys.filter(
      (key) =>
        request.metrics.includes(key.metric) &&
        key.method.id !== 'RECENT_POST_SAMPLE_20' &&
        (key.metric !== 'REACH' || request.horizons.includes(key.horizon)) &&
        (request.context.entity.kind !== 'CHAT' || key.metric === 'AUDIENCE'),
    );
    // FLAG: Reserve a fresh authority check after releasing the data snapshot. Old ACL
    // proofs and a completed earlier page never authorize a new response by themselves.
    const snapshot = await statsReadTransaction(this.prisma, budget.reserve(650), async (tx) => {
      const prepared = await this.reader.prepareWithin(
        tx,
        request.context,
        'EXCHANGE',
        selectedKeys,
      );
      if (!prepared) throw new StatsAnalyticsFailure('FORBIDDEN', 403);
      const [clock] = await tx.$queryRaw<Array<{ as_of: Date }>>`SELECT clock_timestamp() AS as_of`;
      const now = clock!.as_of;
      const floor = retentionFloor(now);
      if (previous) {
        if (Date.parse(previous.expiresAt) <= now.getTime())
          throw new StatsAnalyticsFailure('CURSOR_EXPIRED', 410);
        if (Date.parse(previous.asOf) > now.getTime())
          throw new StatsAnalyticsFailure('INVALID_REQUEST', 400);
        if (previous.retentionFloor !== floor || previous.revisionDigest !== prepared.fingerprint)
          throw new StatsAnalyticsFailure('READ_RESTART', 409);
      }
      const asOf = previous?.asOf ?? now.toISOString();
      const plan = planAnalyticsWindows(
        asOf,
        request.periodDays,
        request.metrics,
        request.horizons,
        request.includeComparison,
      );
      const allSlots = request.includeHistory ? historySlots(plan) : [];
      const afterIndex = previous
        ? allSlots.findIndex((slot) => slotKey(slot) === slotKey(previous.after))
        : -1;
      if (previous && (afterIndex < 0 || afterIndex >= allSlots.length - 1))
        throw new StatsAnalyticsFailure('INVALID_REQUEST', 400);
      const slots = allSlots.slice(afterIndex + 1, afterIndex + 1 + STATS_ANALYTICS_LIMITS.rows);
      const range = previous
        ? pageRange(slots, floor, utcDay(new Date(asOf)))
        : {
            fromDay: plan.fromDay,
            toDay: plan.toDay,
          };
      const keys: StatsMetricKey[] = previous
        ? selectedKeys.filter((key) =>
            slots.some(
              (slot) =>
                slot.selection.metric === key.metric && slot.selection.horizon === key.horizon,
            ),
          )
        : selectedKeys;
      const clockScope = { asOf: new Date(asOf), retentionFloor: floor };
      const candidates =
        previous && keys.some((key) => key.metric === 'AUDIENCE')
          ? [
              ...(await this.reader.candidatesWithin(
                tx,
                prepared,
                keys.filter((key) => key.metric !== 'AUDIENCE'),
                range.fromDay,
                range.toDay,
                clockScope,
              )),
              // The preceding actual observation may be separated by a gap. Retain its
              // interval across pages using only the selected, retained audience source.
              ...(await this.reader.candidatesWithin(
                tx,
                prepared,
                keys.filter((key) => key.metric === 'AUDIENCE'),
                plan.fromDay,
                range.toDay,
                clockScope,
              )),
            ]
          : await this.reader.candidatesWithin(
              tx,
              prepared,
              keys,
              range.fromDay,
              range.toDay,
              clockScope,
            );
      const input = {
        candidates,
        asOf,
        periodDays: request.periodDays,
        metrics: request.metrics,
        horizons: request.horizons,
        includeComparison: request.includeComparison,
        includeHistory: request.includeHistory,
        entityKind: request.context.entity.kind,
        health: prepared.health,
        purpose: request.context.purpose,
      };
      const calculated = previous ? null : calculateStatsAnalytics(input);
      const rows = previous
        ? calculateStatsAnalyticsHistory({ ...input, slots })
        : calculated!.rows;
      const bySlot = new Map(rows.map((row) => [slotKey(rowSlot(row)), row]));
      const pageRows = slots.map((slot) => {
        const row = bySlot.get(slotKey(slot));
        if (!row) throw new StatsAnalyticsFailure('UNAVAILABLE', 503);
        return row;
      });
      return {
        prepared,
        asOf,
        floor,
        allSlots,
        afterIndex,
        rows: pageRows,
        calculated,
        expiresAt:
          previous?.expiresAt ??
          new Date(
            Math.min(
              new Date(asOf).getTime() + 300_000,
              Date.parse(`${shiftDay(utcDay(now), 1)}T00:00:00Z`),
              Date.parse(prepared.access.validUntil),
            ),
          ).toISOString(),
      };
    });

    const current = await statsReadTransaction(this.prisma, budget.reserve(50), async (tx) => {
      const prepared = await this.reader.prepareWithin(
        tx,
        request.context,
        'EXCHANGE',
        selectedKeys,
      );
      if (!prepared) throw new StatsAnalyticsFailure('FORBIDDEN', 403);
      const [clock] = await tx.$queryRaw<Array<{ as_of: Date }>>`SELECT clock_timestamp() AS as_of`;
      if (
        prepared.fingerprint !== snapshot.prepared.fingerprint ||
        retentionFloor(clock!.as_of) !== snapshot.floor
      )
        throw new StatsAnalyticsFailure('READ_RESTART', 409);
      if (Date.parse(prepared.access.validUntil) <= clock!.as_of.getTime())
        throw new StatsAnalyticsFailure('FORBIDDEN', 403);
      return prepared;
    });
    budget.check();
    const header: StatsAnalyticsHeader & { status: 'READY' } = {
      contractVersion: 1,
      analyticsVersion: 1,
      status: 'READY',
      asOf: snapshot.asOf,
      revision: snapshot.prepared.revision,
      contextId: request.context.contextId,
      entity: request.context.entity,
      purpose: request.context.purpose,
      periodDays: request.periodDays,
      access: current.access,
      historyAllowed: request.context.purpose === 'OWNER_ANALYTICS',
    };
    const rows = [...snapshot.rows];
    const resultFor = (): Ready => {
      const hasMore = snapshot.afterIndex + 1 + rows.length < snapshot.allSlots.length;
      const last = rows.at(-1);
      const nextCursor =
        hasMore && last
          ? encodeCursor(
              {
                type: 'analytics',
                analyticsVersion: 1,
                filterHash,
                revisionDigest: snapshot.prepared.fingerprint,
                asOf: snapshot.asOf,
                retentionFloor: snapshot.floor,
                after: rowSlot(last),
                expiresAt: snapshot.expiresAt,
              } satisfies StatsAnalyticsCursorBody,
              secret,
            )
          : null;
      const history = {
        state: 'READY' as const,
        rows,
        nextCursor,
        publicationBreakdown: previous ? null : snapshot.calculated!.publicationBreakdown,
      };
      return previous
        ? { ...header, page: 'HISTORY', history }
        : {
            ...header,
            page: 'INITIAL',
            metrics: snapshot.calculated!.metrics,
            history: request.includeHistory ? history : { state: 'NOT_REQUESTED' },
          };
    };
    let result = resultFor();
    while (Buffer.byteLength(JSON.stringify(result)) > STATS_ANALYTICS_LIMITS.responseBytes) {
      if (rows.length <= 1) throw new StatsAnalyticsFailure('UNAVAILABLE', 503);
      rows.pop();
      result = resultFor();
    }
    if (Date.parse(current.access.validUntil) <= Date.now())
      throw new StatsAnalyticsFailure('FORBIDDEN', 403);
    const valid = statsAnalyticsResultSchema.safeParse(result);
    if (!valid.success) throw new StatsAnalyticsFailure('UNAVAILABLE', 503);
    budget.check();
    return result;
  }
}
