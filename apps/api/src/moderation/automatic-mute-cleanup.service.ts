import { BackgroundRuntimeGovernorService } from '../system/background-runtime-governor.service';
import { MAX_API_SOURCE_TAGS } from '../max/max-client.service';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma, type AutomaticMuteCleanup } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { getAppRole, roleRunsAction } from '../runtime/app-role';
import { RuntimeWorkerOwner, type RuntimeWorker } from '../runtime/runtime-worker-shutdown';
import { WebhookLegacyHoldService } from '../webhook/webhook-legacy-hold.service';
import { ModerationDeleteIntentService } from './moderation-delete-intent.service';
import { automaticMuteHistoryPage, AUTOMATIC_MUTE_CLEANUP_RULE } from './automatic-mute-cleanup';

const PAGE_SIZE = 8;
const CAPACITY = 2;
const LEASE_MS = 30_000;
type HistoryRow = {
  id: string;
  created_at: Date;
  messageId: string | null;
  sourceAt: string | null;
};

@Injectable()
export class AutomaticMuteCleanupService
  extends RuntimeWorkerOwner
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(AutomaticMuteCleanupService.name);
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private selecting = false;
  private selectionDone: Promise<void> | null = null;
  private readonly active = new Set<Promise<unknown>>();
  private readonly activeIds = new Set<string>();
  constructor(
    private readonly prisma: PrismaService,
    private readonly deletes: ModerationDeleteIntentService,
    private readonly holds: WebhookLegacyHoldService,
    @Optional() private readonly governor?: BackgroundRuntimeGovernorService,
  ) {
    super();
  }

  onModuleInit(): void {
    if (!roleRunsAction(getAppRole())) return;
    this.timer = setInterval(
      () =>
        void this.sweep().catch(() => this.logger.warn('Automatic mute cleanup selection failed')),
      2000,
    );
    this.timer.unref();
  }
  stopWorkerAdmission(): readonly RuntimeWorker[] {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    return [
      {
        name: 'automatic-mute-cleanup',
        pause: () => this.drain(),
        close: async (force?: boolean) => {
          if (!force) await this.drain();
        },
      },
    ];
  }
  onModuleDestroy(): void {
    this.stopWorkerAdmission();
  }
  private async drain(): Promise<void> {
    await this.selectionDone;
    await Promise.allSettled([...this.active]);
  }

  async sweep(): Promise<number> {
    if (this.stopped || this.selecting || this.active.size >= CAPACITY) return 0;
    this.selecting = true;
    let releaseSelection!: () => void;
    this.selectionDone = new Promise<void>((resolve) => {
      releaseSelection = resolve;
    });
    const started: Promise<unknown>[] = [];
    try {
      const [clock] = await this.prisma.$queryRaw<{ now: Date }[]>(
        Prisma.sql`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`,
      );
      const rows = await this.prisma.automaticMuteCleanup.findMany({
        where: { status: 'PENDING', nextAttemptAt: { lte: clock!.now } },
        orderBy: [{ nextAttemptAt: 'asc' }, { eventId: 'asc' }],
        take: CAPACITY,
      });
      for (const row of rows) {
        if (this.stopped || this.active.size >= CAPACITY) break;
        if (this.activeIds.has(row.eventId)) continue;
        this.activeIds.add(row.eventId);
        const task = this.page(row)
          .catch(() => {
            this.logger.warn('Automatic mute cleanup page failed; persisted cursor retained');
          })
          .finally(() => {
            this.active.delete(task);
            this.activeIds.delete(row.eventId);
          });
        this.active.add(task);
        started.push(task);
      }
    } finally {
      this.selecting = false;
      this.selectionDone = null;
      releaseSelection();
    }
    // FLAG: Slow work keeps its slot until actual completion. Other ticks may fill a
    // free slot; they never release a lease or replay a started webhook handler.
    await Promise.allSettled(started);
    return started.length;
  }

  private async page(selected: AutomaticMuteCleanup): Promise<void> {
    const token = randomUUID();
    const claimed = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE automatic_mute_cleanups SET lease_token = ${token},
        next_attempt_at = (clock_timestamp() AT TIME ZONE 'UTC') + ${LEASE_MS} * INTERVAL '1 millisecond',
        attempt_count = attempt_count + 1, updated_at = clock_timestamp() AT TIME ZONE 'UTC'
      WHERE event_id = ${selected.eventId} AND status = 'PENDING'
        AND next_attempt_at <= (clock_timestamp() AT TIME ZONE 'UTC')
    `);
    if (!claimed) return;
    const row = await this.prisma.automaticMuteCleanup.findUniqueOrThrow({
      where: { eventId: selected.eventId },
    });
    try {
      if (Date.now() >= row.deadlineAt.getTime()) {
        await this.finish(row, token, 'EXPIRED');
        return;
      }
      if (await this.held(row)) {
        await this.finish(row, token, 'CANCELLED');
        return;
      }
      const latest = await this.prisma.moderationEvent.findFirst({
        where: {
          chatId: row.chatId,
          userId: row.userId,
          OR: [
            { action: { in: ['MUTE', 'BAN'] } },
            { ruleCode: { in: ['MANUAL_UNMUTE', 'MANUAL_UNBAN'] } },
          ],
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      });
      if (latest?.id !== row.eventId) {
        await this.finish(row, token, 'CANCELLED');
        return;
      }
      const budget = await this.governor?.decide({
        component: 'automatic-mute-history',
        sourceTag: MAX_API_SOURCE_TAGS.MODERATION_DELETE,
      });
      if (budget?.action === 'pause') {
        await this.prisma.automaticMuteCleanup.updateMany({
          where: { eventId: row.eventId, leaseToken: token, status: 'PENDING' },
          data: {
            leaseToken: null,
            nextAttemptAt: new Date(
              Math.min(row.deadlineAt.getTime(), Date.now() + Math.max(2000, budget.retryAfterMs)),
            ),
          },
        });
        return;
      }
      const pageSize = budget?.action === 'slow' ? 2 : PAGE_SIZE;
      const messages = await this.prisma.$queryRaw<HistoryRow[]>(
        automaticMuteHistoryPage(row, pageSize),
      );
      const seen = new Set<string>();
      for (const message of messages) {
        const at = Date.parse(message.sourceAt ?? '');
        if (
          !message.messageId ||
          seen.has(message.messageId) ||
          !Number.isSafeInteger(at) ||
          at < row.windowStart.getTime() ||
          at > row.windowEnd.getTime()
        )
          continue;
        seen.add(message.messageId);
        await this.assertOwned(row, token);
        if (await this.held(row)) {
          await this.finish(row, token, 'CANCELLED');
          return;
        }
        await this.deletes.ensureAutomaticMuteHistoryIntent({
          chatId: row.chatId,
          messageId: message.messageId,
          ruleCode: AUTOMATIC_MUTE_CLEANUP_RULE,
          reasonKey: `automatic-mute-history:${row.eventId}`,
          subjectUserId: row.userId,
          sourceMessageAt: new Date(at),
          entityType: 'CHAT',
          messageAuthorKind: 'user',
          originBotId: row.originBotId,
          routingPolicy: 'delete_capable',
          retryUntilAt: row.deadlineAt,
          event: {
            userId: row.userId,
            metadata: { muteEventId: row.eventId, automaticMuteCleanupId: row.eventId },
          },
        });
      }
      const last = messages.at(-1);
      // FLAG: Advance only after durable intent persistence. Queue failure is recovered
      // by the existing delete sweeper; crash before this CAS re-materializes exact keys.
      await this.prisma.automaticMuteCleanup.updateMany({
        where: {
          eventId: row.eventId,
          leaseToken: token,
          status: 'PENDING',
          nextAttemptAt: { gt: new Date() },
        },
        data: {
          ...(last ? { cursorCreatedAt: last.created_at, cursorId: last.id } : {}),
          scannedReceipts: { increment: messages.length },
          status: messages.length < pageSize ? 'SCANNED' : 'PENDING',
          completedAt: messages.length < pageSize ? new Date() : null,
          nextAttemptAt: new Date(Date.now() + 2000),
          leaseToken: null,
          lastErrorCode: null,
        },
      });
    } catch (error) {
      await this.prisma.automaticMuteCleanup.updateMany({
        where: { eventId: row.eventId, leaseToken: token, status: 'PENDING' },
        data: {
          nextAttemptAt: new Date(Date.now() + 5000),
          leaseToken: null,
          lastErrorCode: 'PAGE_RETRY',
        },
      });
      throw error;
    }
  }
  private async assertOwned(row: AutomaticMuteCleanup, token: string): Promise<void> {
    if (this.stopped) throw new Error('Automatic cleanup stopping');
    const owned = await this.prisma.$queryRaw<{ event_id: string }[]>(Prisma.sql`
      SELECT event_id FROM automatic_mute_cleanups WHERE event_id = ${row.eventId}
        AND status = 'PENDING' AND lease_token = ${token}
        AND next_attempt_at > (clock_timestamp() AT TIME ZONE 'UTC')
        AND deadline_at > (clock_timestamp() AT TIME ZONE 'UTC')
    `);
    if (!owned.length) throw new Error('Automatic cleanup lease or deadline lost');
  }
  private async held(row: AutomaticMuteCleanup): Promise<boolean> {
    return (
      (await this.holds.isMessageHeld(row.chatId, row.sourceMessageId)) ||
      (await this.holds.isMemberHeld(row.chatId, row.userId)) ||
      (await this.holds.isGlobalUserHeld(row.userId))
    );
  }
  private async finish(
    row: AutomaticMuteCleanup,
    token: string,
    status: 'CANCELLED' | 'EXPIRED',
  ): Promise<void> {
    await this.prisma.automaticMuteCleanup.updateMany({
      where: { eventId: row.eventId, leaseToken: token, status: 'PENDING' },
      data: { status, completedAt: new Date(), leaseToken: null },
    });
  }
}
