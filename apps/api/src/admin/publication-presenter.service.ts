import {
  publicationDetailsSchema,
  publicationOccurrenceSummarySchema,
  publicationScheduleInputSchema,
  publicationScheduleSchema,
  publicationSummarySchema,
  type PublicationDelivery,
  type PublicationDeliveryStats,
  type PublicationDetails,
  type PublicationSummary,
} from '@maxim/contracts/publication';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import {
  ChatEntityType,
  ManagedBroadcastDeliveryStatus,
  Prisma,
  PublicationContentFormat,
  PublicationLifecycle,
  PublicationOccurrenceStatus,
  PublicationScheduleStatus,
} from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { readStoredPublicationButtons } from './publication-buttons';

const PUBLICATION_LIST_PREVIEW_TARGETS = 6;
const PUBLICATION_OCCURRENCE_HISTORY_LIMIT = 50;
const PUBLICATION_UNRESOLVED_OCCURRENCE_STATUSES: PublicationOccurrenceStatus[] = [
  PublicationOccurrenceStatus.SCHEDULED,
  PublicationOccurrenceStatus.IN_PROGRESS,
  PublicationOccurrenceStatus.FAILED,
  PublicationOccurrenceStatus.PARTIAL,
  PublicationOccurrenceStatus.AMBIGUOUS,
];

@Injectable()
export class PublicationPresenterService {
  constructor(private readonly prisma: PrismaService) {}

  publicationSummaryInclude() {
    return {
      canonicalContentRevision: {
        include: {
          assets: { orderBy: { position: 'asc' }, include: { asset: true } },
        },
      },
      targets: { orderBy: { position: 'asc' }, include: { chat: true } },
      schedule: true,
      occurrences: {
        where: { status: PublicationOccurrenceStatus.SCHEDULED },
        orderBy: { scheduledAt: 'asc' },
        take: 1,
      },
    } as const;
  }

  async loadPublicationDetailsRow(publicationId: string, actorUserId: string) {
    const row = await this.prisma.publication.findFirst({
      where: { id: publicationId, actorUserId },
      include: {
        canonicalContentRevision: {
          include: {
            assets: { orderBy: { position: 'asc' }, include: { asset: true } },
          },
        },
        targets: { orderBy: { position: 'asc' }, include: { chat: true } },
        schedule: true,
        occurrences: {
          orderBy: [{ scheduledAt: 'desc' }, { id: 'desc' }],
          take: PUBLICATION_OCCURRENCE_HISTORY_LIMIT,
          include: { contentRevision: { select: { revision: true } } },
        },
      },
    });
    if (!row) {
      return null;
    }
    const [nextOccurrence, unresolvedOccurrences, deliveryStats, actionableDeliveryStats] =
      await Promise.all([
        this.prisma.publicationOccurrence.findFirst({
          where: { publicationId, status: PublicationOccurrenceStatus.SCHEDULED },
          orderBy: { scheduledAt: 'asc' },
          select: { scheduledAt: true },
        }),
        this.prisma.publicationOccurrence.findMany({
          where: {
            publicationId,
            status: { in: PUBLICATION_UNRESOLVED_OCCURRENCE_STATUSES },
          },
          orderBy: [{ scheduledAt: 'desc' }, { id: 'desc' }],
          include: { contentRevision: { select: { revision: true } } },
        }),
        this.loadDeliveryStats(publicationId),
        this.loadActionableDeliveryStatsByPublicationIds([publicationId]),
      ]);
    const occurrenceById = new Map<string, (typeof row.occurrences)[number]>();
    for (const occurrence of [...row.occurrences, ...unresolvedOccurrences]) {
      occurrenceById.set(occurrence.id, occurrence);
    }
    const orderedOccurrences = [...occurrenceById.values()].sort((left, right) => {
      const scheduledAtDifference = right.scheduledAt.getTime() - left.scheduledAt.getTime();
      if (scheduledAtDifference !== 0) {
        return scheduledAtDifference;
      }
      if (left.id === right.id) {
        return 0;
      }
      return left.id < right.id ? 1 : -1;
    });
    const occurrenceDeliveryStats = await this.loadOccurrenceDeliveryStats(
      orderedOccurrences.map((occurrence) => occurrence.id),
    );
    const occurrences = orderedOccurrences.map((occurrence) => ({
      ...occurrence,
      deliveryStats: occurrenceDeliveryStats.get(occurrence.id) ?? this.emptyDeliveryStats(),
    }));
    return {
      ...row,
      occurrences,
      nextOccurrenceAt: nextOccurrence?.scheduledAt ?? null,
      deliveryStats,
      actionableDeliveryStats:
        actionableDeliveryStats.get(publicationId) ?? this.emptyDeliveryStats(),
    };
  }

  async mapPublicationSummary(
    row: any,
    preloadedDeliveryStats?: PublicationDeliveryStats,
    preloadedActionableDeliveryStats?: PublicationDeliveryStats,
  ): Promise<PublicationSummary> {
    const delivery =
      preloadedDeliveryStats ?? row.deliveryStats ?? (await this.loadDeliveryStats(row.id));
    const content = row.canonicalContentRevision;
    const targets = row.targets.map((target: any) => this.mapTarget(target));
    const targetPreviews = this.selectTargetPreviews(targets);
    const nextOccurrenceAt =
      row.nextOccurrenceAt !== undefined
        ? row.nextOccurrenceAt
        : row.occurrences.reduce(
            (earliest: Date | null, occurrence: any) =>
              occurrence.status === PublicationOccurrenceStatus.SCHEDULED &&
              (!earliest || occurrence.scheduledAt < earliest)
                ? occurrence.scheduledAt
                : earliest,
            null,
          );
    return publicationSummarySchema.parse({
      id: row.id,
      title: row.title,
      lifecycle: row.lifecycle,
      version: row.version,
      contentPreview: content?.text.trim().slice(0, 160) ?? '',
      targetCount: targets.length,
      targetPreviews,
      targetOverflowCount: Math.max(0, targets.length - targetPreviews.length),
      audienceSelection: row.audienceSelection,
      audienceMode: row.audienceMode,
      mediaCount: content?.assets.length ?? 0,
      hasVideo:
        content?.assets.some(
          (link: any) =>
            link.asset.durablePayload !== null ||
            link.asset.mimeType.toLowerCase().startsWith('video/'),
        ) ?? false,
      schedule:
        row.schedule && !(row.lifecycle === 'DRAFT' && row.schedule.status === 'DRAFT')
          ? this.mapSchedule(row.schedule, nextOccurrenceAt)
          : null,
      delivery,
      actionableDelivery:
        preloadedActionableDeliveryStats ?? row.actionableDeliveryStats ?? delivery,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    });
  }

  async mapPublicationDetails(row: any): Promise<PublicationDetails> {
    const summary = await this.mapPublicationSummary(row);
    const content = row.canonicalContentRevision;
    if (!content) {
      throw new ServiceUnavailableException('Содержимое публикации не найдено.');
    }
    return publicationDetailsSchema.parse({
      ...summary,
      content: {
        revision: content.revision,
        text: content.text,
        textFormat: content.textFormat === PublicationContentFormat.MARKDOWN ? 'markdown' : 'plain',
        buttons: readStoredPublicationButtons(content.buttons),
        media: content.assets.map((link: any) => ({
          id: link.asset.id,
          type:
            link.asset.durablePayload !== null ||
            link.asset.mimeType.toLowerCase().startsWith('video/')
              ? 'video'
              : 'image',
          mimeType: link.asset.mimeType,
          fileName: link.asset.fileName,
          sizeBytes: link.asset.sizeBytes,
        })),
      },
      targets: row.targets.map((target: any) => this.mapTarget(target)),
      occurrences: row.occurrences.map((occurrence: any) => {
        const delivery =
          occurrence.deliveryStats ?? this.buildDeliveryStats(occurrence.deliveries ?? []);
        const usesLatestContent =
          typeof row.canonicalContentRevisionId === 'string' &&
          occurrence.contentRevisionId === row.canonicalContentRevisionId;
        const canRetry =
          delivery.failed > 0 &&
          (row.lifecycle === PublicationLifecycle.ACTIVE ||
            row.lifecycle === PublicationLifecycle.ERROR) &&
          (row.schedule?.status === PublicationScheduleStatus.ACTIVE ||
            row.schedule?.status === PublicationScheduleStatus.ERROR) &&
          occurrence.scheduleId === row.schedule?.id &&
          occurrence.scheduleRevision === row.schedule?.revision &&
          (occurrence.status === PublicationOccurrenceStatus.FAILED ||
            occurrence.status === PublicationOccurrenceStatus.PARTIAL);
        return publicationOccurrenceSummarySchema.parse({
          id: occurrence.id,
          scheduledAt: occurrence.scheduledAt.toISOString(),
          status: occurrence.status,
          delivery,
          canRetry,
          contentRevision: occurrence.contentRevision?.revision,
          usesLatestContent,
        });
      }),
    });
  }

  mapDeliveryContentRevision(row: {
    contentRevision: { id: string; revision: number } | null;
    publicationOccurrence: {
      publication: { canonicalContentRevisionId: string | null };
    } | null;
  }): Pick<PublicationDelivery, 'contentRevision' | 'usesLatestContent'> {
    if (!row.contentRevision) {
      return {};
    }
    return {
      contentRevision: row.contentRevision.revision,
      usesLatestContent:
        row.contentRevision.id ===
        row.publicationOccurrence?.publication.canonicalContentRevisionId,
    };
  }

  async loadDeliveryStatsByPublicationIds(
    publicationIds: string[],
  ): Promise<Map<string, PublicationDeliveryStats>> {
    const uniquePublicationIds = [...new Set(publicationIds)];
    const statsByPublicationId = new Map<string, PublicationDeliveryStats>(
      uniquePublicationIds.map((publicationId) => [publicationId, this.emptyDeliveryStats()]),
    );
    if (uniquePublicationIds.length === 0) {
      return statsByPublicationId;
    }

    const grouped = await this.prisma.$queryRaw<
      Array<{
        publicationId: string;
        status: ManagedBroadcastDeliveryStatus;
        count: bigint;
      }>
    >(Prisma.sql`
      SELECT
        occurrence."publication_id" AS "publicationId",
        delivery."status" AS "status",
        COUNT(*)::bigint AS "count"
      FROM "managed_broadcast_deliveries" AS delivery
      INNER JOIN "publication_occurrences" AS occurrence
        ON occurrence."id" = delivery."publication_occurrence_id"
      WHERE occurrence."publication_id" IN (${Prisma.join(uniquePublicationIds)})
      GROUP BY occurrence."publication_id", delivery."status"
    `);

    for (const group of grouped) {
      const stats = statsByPublicationId.get(group.publicationId);
      if (stats) {
        this.addDeliveryCount(stats, group.status, Number(group.count));
      }
    }
    return statsByPublicationId;
  }

  async loadDeliveryStats(publicationId: string): Promise<PublicationDeliveryStats> {
    const grouped = await this.prisma.managedBroadcastDelivery.groupBy({
      by: ['status'],
      where: { publicationOccurrence: { is: { publicationId } } },
      _count: { _all: true },
    });
    const stats = this.emptyDeliveryStats();
    for (const group of grouped) {
      this.addDeliveryCount(stats, group.status, group._count._all);
    }
    return stats;
  }

  async loadActionableDeliveryStatsByPublicationIds(
    publicationIds: string[],
  ): Promise<Map<string, PublicationDeliveryStats>> {
    const uniquePublicationIds = [...new Set(publicationIds)];
    const statsByPublicationId = new Map<string, PublicationDeliveryStats>(
      uniquePublicationIds.map((publicationId) => [publicationId, this.emptyDeliveryStats()]),
    );
    if (uniquePublicationIds.length === 0) {
      return statsByPublicationId;
    }

    const grouped = await this.prisma.$queryRaw<
      Array<{
        publicationId: string;
        status: ManagedBroadcastDeliveryStatus;
        count: bigint;
      }>
    >(Prisma.sql`
      SELECT
        occurrence."publication_id" AS "publicationId",
        delivery."status" AS "status",
        COUNT(*)::bigint AS "count"
      FROM "managed_broadcast_deliveries" AS delivery
      INNER JOIN "publication_occurrences" AS occurrence
        ON occurrence."id" = delivery."publication_occurrence_id"
      INNER JOIN "publication_schedules" AS schedule
        ON schedule."id" = occurrence."schedule_id"
        AND schedule."publication_id" = occurrence."publication_id"
        AND schedule."revision" = occurrence."schedule_revision"
      WHERE occurrence."publication_id" IN (${Prisma.join(uniquePublicationIds)})
      GROUP BY occurrence."publication_id", delivery."status"
    `);

    for (const group of grouped) {
      const stats = statsByPublicationId.get(group.publicationId);
      if (stats) {
        this.addDeliveryCount(stats, group.status, Number(group.count));
      }
    }
    return statsByPublicationId;
  }

  async loadOccurrenceDeliveryStats(
    occurrenceIds: string[],
  ): Promise<Map<string, PublicationDeliveryStats>> {
    const uniqueOccurrenceIds = [...new Set(occurrenceIds)];
    const statsByOccurrenceId = new Map<string, PublicationDeliveryStats>(
      uniqueOccurrenceIds.map((occurrenceId) => [occurrenceId, this.emptyDeliveryStats()]),
    );
    if (uniqueOccurrenceIds.length === 0) {
      return statsByOccurrenceId;
    }

    const grouped = await this.prisma.managedBroadcastDelivery.groupBy({
      by: ['publicationOccurrenceId', 'status'],
      where: { publicationOccurrenceId: { in: uniqueOccurrenceIds } },
      _count: { _all: true },
    });
    for (const group of grouped) {
      if (!group.publicationOccurrenceId) {
        continue;
      }
      const stats = statsByOccurrenceId.get(group.publicationOccurrenceId);
      if (stats) {
        this.addDeliveryCount(stats, group.status, group._count._all);
      }
    }
    return statsByOccurrenceId;
  }

  buildDeliveryStats(
    rows: Array<{ status: ManagedBroadcastDeliveryStatus }>,
  ): PublicationDeliveryStats {
    const stats = this.emptyDeliveryStats();
    for (const row of rows) {
      this.addDeliveryCount(stats, row.status, 1);
    }
    return stats;
  }

  private mapSchedule(schedule: any, nextOccurrenceAt: Date | null) {
    const rule = publicationScheduleInputSchema.parse(schedule.rule);
    return publicationScheduleSchema.parse({
      ...rule,
      status: schedule.status,
      revision: schedule.revision,
      nextOccurrenceAt: nextOccurrenceAt?.toISOString() ?? null,
      lastError: schedule.lastError,
    });
  }

  private mapTarget(target: any) {
    return {
      chatId: target.targetChatId,
      entityType: this.fromPrismaEntityType(target.entityType),
      title: target.chat?.title ?? target.targetChatId,
      avatarUrl: null,
      link: null,
    };
  }

  private selectTargetPreviews<T extends { entityType: 'chat' | 'channel' }>(targets: T[]): T[] {
    const previews = targets.slice(0, PUBLICATION_LIST_PREVIEW_TARGETS);
    const hasChats = targets.some((target) => target.entityType === 'chat');
    const hasChannels = targets.some((target) => target.entityType === 'channel');
    if (!hasChats || !hasChannels || previews.length === 0) {
      return previews;
    }
    const previewTypes = new Set(previews.map((target) => target.entityType));
    const missingType = previewTypes.has('chat')
      ? 'channel'
      : previewTypes.has('channel')
        ? 'chat'
        : null;
    if (!missingType) {
      return previews;
    }
    const missingTarget = targets.find((target) => target.entityType === missingType);
    if (missingTarget) {
      previews[previews.length - 1] = missingTarget;
    }
    return previews;
  }

  private emptyDeliveryStats(): PublicationDeliveryStats {
    return {
      total: 0,
      pending: 0,
      sent: 0,
      failed: 0,
      ambiguous: 0,
      canceled: 0,
    };
  }

  private addDeliveryCount(
    stats: PublicationDeliveryStats,
    status: ManagedBroadcastDeliveryStatus,
    count: number,
  ): void {
    stats.total += count;
    switch (status) {
      case ManagedBroadcastDeliveryStatus.PENDING:
      case ManagedBroadcastDeliveryStatus.SENDING:
        stats.pending += count;
        return;
      case ManagedBroadcastDeliveryStatus.SENT:
        stats.sent += count;
        return;
      case ManagedBroadcastDeliveryStatus.FAILED:
        stats.failed += count;
        return;
      case ManagedBroadcastDeliveryStatus.AMBIGUOUS:
        stats.ambiguous += count;
        return;
      case ManagedBroadcastDeliveryStatus.CANCELED:
        stats.canceled += count;
    }
  }

  private fromPrismaEntityType(entityType: ChatEntityType): 'chat' | 'channel' {
    return entityType === ChatEntityType.CHANNEL ? 'channel' : 'chat';
  }
}
