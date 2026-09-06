import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MaxActionLedgerStatus, ModerationDeleteIntentStatus } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';

const DEFAULT_ACTION_LATENCY_WINDOW_SEC = 15 * 60;
const DEFAULT_ACTION_LATENCY_SAMPLE_LIMIT = 5_000;
const MAX_ACTION_LATENCY_SAMPLE_LIMIT = 5_000;
const ACTION_LATENCY_CACHE_TTL_MS = 10_000;
const MISSING_DIMENSION_KEY = '(none)';
const BOT_MESSAGE_AUTO_DELETE_RULE_CODE = 'BOT_MESSAGE_AUTO_DELETE';
const COMMERCIAL_OCR_DELETE_RULE_CODE = 'COMMERCIAL_OCR_DELETE';

const TERMINAL_ACTION_STATUSES = [
  MaxActionLedgerStatus.SUCCEEDED,
  MaxActionLedgerStatus.SKIPPED,
  MaxActionLedgerStatus.AMBIGUOUS,
  MaxActionLedgerStatus.FAILED_RETRYABLE,
  MaxActionLedgerStatus.FAILED_TERMINAL,
] as const;

const TERMINAL_DELETE_INTENT_STATUSES = [
  ModerationDeleteIntentStatus.SUCCEEDED,
  ModerationDeleteIntentStatus.ALREADY_ABSENT,
  ModerationDeleteIntentStatus.EXPIRED,
  ModerationDeleteIntentStatus.FAILED_TERMINAL,
] as const;

export type LatencyPercentiles = {
  sampleCount: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
};

export type ActionLatencyMetrics = {
  effectiveReadyToLastAttempt: LatencyPercentiles;
  lastAttemptToTerminal: LatencyPercentiles;
  effectiveReadyToTerminal: LatencyPercentiles;
};

export type ActionLatencyGroup = ActionLatencyMetrics & {
  key: string;
  rowCount: number;
};

export type DeleteLatencyMetrics = {
  messageToFirstAttempt: LatencyPercentiles;
  firstAttemptToTerminal: LatencyPercentiles;
  messageToTerminal: LatencyPercentiles;
};

export type DeleteLatencyGroup = DeleteLatencyMetrics & {
  key: string;
  rowCount: number;
};

export type ActionLatencySnapshot = {
  basis: 'terminal_outcomes';
  windowBasis: 'completed_at';
  actionStartBasis: 'max_enqueued_at_scheduled_for';
  windowSec: number;
  windowStartedAt: string;
  sampleLimit: number;
  actionSampleCount: number;
  actionSampleTruncated: boolean;
  actionSampledFrom: string | null;
  overall: ActionLatencyMetrics;
  byAction: ActionLatencyGroup[];
  byOutcome: ActionLatencyGroup[];
  bySource: ActionLatencyGroup[];
  byBot: ActionLatencyGroup[];
  byTrafficClass: ActionLatencyGroup[];
  moderationDelete: {
    sampleCount: number;
    sampleTruncated: boolean;
    sampledFrom: string | null;
    overall: DeleteLatencyMetrics;
    byOutcome: DeleteLatencyGroup[];
  };
  generatedAt: string;
};

type ActionLatencyRow = {
  actionType: string;
  status: MaxActionLedgerStatus;
  sourceTag: string | null;
  botId: string | null;
  trafficClass: string | null;
  metadata: unknown;
  enqueuedAt: Date | null;
  lastAttemptAt: Date | null;
  completedAt: Date | null;
};

type DeleteLatencyRow = {
  status: ModerationDeleteIntentStatus;
  sourceMessageAt: Date | null;
  firstAttemptAt: Date | null;
  completedAt: Date | null;
};

@Injectable()
export class ActionLatencyService {
  private readonly windowSec: number;
  private readonly sampleLimit: number;
  private cachedSnapshot: ActionLatencySnapshot | null = null;
  private cachedAtMs = 0;
  private inFlightSnapshot: Promise<ActionLatencySnapshot> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
  ) {
    this.windowSec = this.readPositiveInt(
      configService.get('SYSTEM_WEBHOOK_SLO_WINDOW_SEC'),
      DEFAULT_ACTION_LATENCY_WINDOW_SEC,
    );
    this.sampleLimit = Math.min(
      MAX_ACTION_LATENCY_SAMPLE_LIMIT,
      this.readPositiveInt(
        configService.get('SYSTEM_WEBHOOK_SLO_SAMPLE_LIMIT'),
        DEFAULT_ACTION_LATENCY_SAMPLE_LIMIT,
      ),
    );
  }

  getSnapshot(): Promise<ActionLatencySnapshot> {
    const nowMs = Date.now();
    if (this.cachedSnapshot && nowMs - this.cachedAtMs <= ACTION_LATENCY_CACHE_TTL_MS) {
      return Promise.resolve(this.cachedSnapshot);
    }
    if (this.inFlightSnapshot) {
      return this.inFlightSnapshot;
    }

    const inFlight = this.buildSnapshot().then((snapshot) => {
      this.cachedSnapshot = snapshot;
      this.cachedAtMs = Date.now();
      return snapshot;
    });
    this.inFlightSnapshot = inFlight;
    const clearInFlight = () => {
      if (this.inFlightSnapshot === inFlight) {
        this.inFlightSnapshot = null;
      }
    };
    void inFlight.then(clearInFlight, clearInFlight);
    return inFlight;
  }

  private async buildSnapshot(): Promise<ActionLatencySnapshot> {
    const generatedAt = new Date();
    const from = new Date(generatedAt.getTime() - this.windowSec * 1_000);
    const [loadedActions, loadedDeleteIntents] = await Promise.all([
      this.loadActionRows(from, generatedAt),
      this.loadDeleteRows(from, generatedAt),
    ]);
    const actionSampleTruncated = loadedActions.length > this.sampleLimit;
    const deleteSampleTruncated = loadedDeleteIntents.length > this.sampleLimit;
    const actions = loadedActions.slice(0, this.sampleLimit);
    const deleteIntents = loadedDeleteIntents.slice(0, this.sampleLimit);

    return {
      basis: 'terminal_outcomes',
      windowBasis: 'completed_at',
      actionStartBasis: 'max_enqueued_at_scheduled_for',
      windowSec: this.windowSec,
      windowStartedAt: from.toISOString(),
      sampleLimit: this.sampleLimit,
      actionSampleCount: actions.length,
      actionSampleTruncated,
      actionSampledFrom: this.readOldestCompletion(actions),
      overall: this.aggregateActions(actions),
      byAction: this.aggregateActionGroups(actions, (row) => row.actionType),
      byOutcome: this.aggregateActionGroups(actions, (row) => row.status),
      bySource: this.aggregateActionGroups(actions, (row) => row.sourceTag),
      byBot: this.aggregateActionGroups(actions, (row) => row.botId),
      byTrafficClass: this.aggregateActionGroups(actions, (row) => row.trafficClass),
      moderationDelete: {
        sampleCount: deleteIntents.length,
        sampleTruncated: deleteSampleTruncated,
        sampledFrom: this.readOldestCompletion(deleteIntents),
        overall: this.aggregateDeletes(deleteIntents),
        byOutcome: this.aggregateDeleteGroups(deleteIntents, (row) => row.status),
      },
      generatedAt: generatedAt.toISOString(),
    };
  }

  private loadActionRows(from: Date, to: Date): Promise<ActionLatencyRow[]> {
    return this.prisma.maxActionLedgerEntry.findMany({
      where: {
        status: { in: [...TERMINAL_ACTION_STATUSES] },
        terminal: true,
        completedAt: { gte: from, lte: to },
      },
      select: {
        actionType: true,
        status: true,
        sourceTag: true,
        botId: true,
        trafficClass: true,
        metadata: true,
        enqueuedAt: true,
        lastAttemptAt: true,
        completedAt: true,
      },
      orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
      take: this.sampleLimit + 1,
    });
  }

  private loadDeleteRows(from: Date, to: Date): Promise<DeleteLatencyRow[]> {
    return this.prisma.moderationDeleteIntent.findMany({
      where: {
        status: { in: [...TERMINAL_DELETE_INTENT_STATUSES] },
        completedAt: { gte: from, lte: to },
        OR: [
          {
            reasons: {
              none: {
                ruleCode: {
                  in: [BOT_MESSAGE_AUTO_DELETE_RULE_CODE, COMMERCIAL_OCR_DELETE_RULE_CODE],
                },
              },
            },
          },
          {
            reasons: {
              some: {
                ruleCode: {
                  notIn: [BOT_MESSAGE_AUTO_DELETE_RULE_CODE, COMMERCIAL_OCR_DELETE_RULE_CODE],
                },
              },
            },
          },
          {
            reasons: {
              some: {
                ruleCode: COMMERCIAL_OCR_DELETE_RULE_CODE,
                metadata: { path: ['source'], equals: 'image_text_ocr' },
              },
            },
          },
        ],
      },
      select: {
        status: true,
        sourceMessageAt: true,
        firstAttemptAt: true,
        completedAt: true,
      },
      orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
      take: this.sampleLimit + 1,
    });
  }

  private aggregateActionGroups(
    rows: readonly ActionLatencyRow[],
    readKey: (row: ActionLatencyRow) => string | null,
  ): ActionLatencyGroup[] {
    return this.groupRows(rows, readKey).map(([key, group]) => ({
      key,
      rowCount: group.length,
      ...this.aggregateActions(group),
    }));
  }

  private aggregateDeleteGroups(
    rows: readonly DeleteLatencyRow[],
    readKey: (row: DeleteLatencyRow) => string | null,
  ): DeleteLatencyGroup[] {
    return this.groupRows(rows, readKey).map(([key, group]) => ({
      key,
      rowCount: group.length,
      ...this.aggregateDeletes(group),
    }));
  }

  private groupRows<Row>(
    rows: readonly Row[],
    readKey: (row: Row) => string | null,
  ): Array<[string, Row[]]> {
    const groups = new Map<string, Row[]>();
    for (const row of rows) {
      const key = readKey(row)?.trim() || MISSING_DIMENSION_KEY;
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    }
    return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
  }

  private aggregateActions(rows: readonly ActionLatencyRow[]): ActionLatencyMetrics {
    return {
      effectiveReadyToLastAttempt: this.toPercentiles(
        rows.map((row) => this.durationMs(this.resolveEffectiveReadyAt(row), row.lastAttemptAt)),
      ),
      lastAttemptToTerminal: this.toPercentiles(
        rows.map((row) => this.durationMs(row.lastAttemptAt, row.completedAt)),
      ),
      effectiveReadyToTerminal: this.toPercentiles(
        rows.map((row) => this.durationMs(this.resolveEffectiveReadyAt(row), row.completedAt)),
      ),
    };
  }

  private resolveEffectiveReadyAt(row: ActionLatencyRow): Date | null {
    const metadata =
      row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : null;
    const scheduledForValue = metadata?.scheduledFor;
    if (typeof scheduledForValue !== 'string') {
      return row.enqueuedAt;
    }
    const scheduledFor = new Date(scheduledForValue);
    if (!Number.isFinite(scheduledFor.getTime())) {
      return row.enqueuedAt;
    }
    if (!row.enqueuedAt || scheduledFor > row.enqueuedAt) {
      return scheduledFor;
    }
    return row.enqueuedAt;
  }

  private aggregateDeletes(rows: readonly DeleteLatencyRow[]): DeleteLatencyMetrics {
    return {
      messageToFirstAttempt: this.toPercentiles(
        rows.map((row) => this.durationMs(row.sourceMessageAt, row.firstAttemptAt)),
      ),
      firstAttemptToTerminal: this.toPercentiles(
        rows.map((row) => this.durationMs(row.firstAttemptAt, row.completedAt)),
      ),
      messageToTerminal: this.toPercentiles(
        rows.map((row) => this.durationMs(row.sourceMessageAt, row.completedAt)),
      ),
    };
  }

  private toPercentiles(values: ReadonlyArray<number | null>): LatencyPercentiles {
    const sorted = values
      .filter((value): value is number => value !== null && Number.isFinite(value))
      .sort((left, right) => left - right);
    return {
      sampleCount: sorted.length,
      p50Ms: this.percentile(sorted, 0.5),
      p95Ms: this.percentile(sorted, 0.95),
      p99Ms: this.percentile(sorted, 0.99),
    };
  }

  private percentile(sorted: readonly number[], percentile: number): number | null {
    if (sorted.length === 0) {
      return null;
    }
    const index = Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil(sorted.length * percentile) - 1),
    );
    return sorted[index] ?? null;
  }

  private durationMs(start: Date | null, end: Date | null): number | null {
    if (!start || !end) {
      return null;
    }
    const durationMs = end.getTime() - start.getTime();
    return Number.isFinite(durationMs) && durationMs >= 0 ? Math.trunc(durationMs) : null;
  }

  private readOldestCompletion(rows: ReadonlyArray<{ completedAt: Date | null }>): string | null {
    let oldest: Date | null = null;
    for (const row of rows) {
      const completedAt = row.completedAt;
      if (
        completedAt &&
        Number.isFinite(completedAt.getTime()) &&
        (!oldest || completedAt < oldest)
      ) {
        oldest = completedAt;
      }
    }
    return oldest?.toISOString() ?? null;
  }

  private readPositiveInt(value: unknown, fallback: number): number {
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.max(1, Math.trunc(parsed)) : fallback;
  }
}
