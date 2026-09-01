import {
  MAX_PUBLICATION_TARGETS,
  publicationDetailsSchema,
  publicationOccurrenceSummarySchema,
  publicationScheduleInputSchema,
  publicationScheduleSchema,
  publicationSummarySchema,
  type PublicationDelivery,
  type PublicationDeliveryStats,
  type PublicationDetails,
  type PublicationDispatchIssue,
  type PublicationSummary,
} from '@maxim/contracts/publication';
import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { stripSupportedMarkdownToPlainText } from '../common/max-markdown.util';
import {
  ChatEntityType,
  ManagedBroadcastDeliveryStatus,
  Prisma,
  PublicationContentFormat,
  PublicationDispatchProfile,
  PublicationLifecycle,
  PublicationOccurrenceStatus,
  PublicationScheduleStatus,
} from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { readStoredPublicationButtons } from './publication-buttons';
import {
  buildPublicationDispatchIssueIndex,
  emptyPublicationDispatchIssueIndex,
  type PublicationDispatchBlockerRow,
  type PublicationDispatchIssueIndex,
} from './publication-dispatch-issue';
import { buildEffectivePublicationDeliveryStatusSql } from './publication-legacy-automated-absence';

const PUBLICATION_LIST_PREVIEW_TARGETS = 6;
const PUBLICATION_OCCURRENCE_HISTORY_LIMIT = 50;
const PUBLISHER_CATALOG_LOOKUP_BATCH_SIZE = 200;
const MAX_PRESENTATION_URL_LENGTH = 2_048;
const PUBLICATION_UNRESOLVED_OCCURRENCE_STATUSES: PublicationOccurrenceStatus[] = [
  PublicationOccurrenceStatus.SCHEDULED,
  PublicationOccurrenceStatus.IN_PROGRESS,
  PublicationOccurrenceStatus.FAILED,
  PublicationOccurrenceStatus.PARTIAL,
  PublicationOccurrenceStatus.AMBIGUOUS,
];
const PUBLICATION_SUMMARY_OCCURRENCE_SELECT = {
  scheduledAt: true,
  status: true,
} as const;
const PUBLICATION_DETAILS_OCCURRENCE_SELECT = {
  id: true,
  scheduleId: true,
  scheduleRevision: true,
  contentRevisionId: true,
  legacyBroadcastId: true,
  scheduledAt: true,
  status: true,
  contentRevision: { select: { revision: true } },
  _count: { select: { legacyBroadcasts: true } },
} as const;

const resolveEffectiveOccurrenceStatus = (
  status: PublicationOccurrenceStatus,
  delivery: PublicationDeliveryStats,
): PublicationOccurrenceStatus =>
  delivery.ambiguous > 0 &&
  (status === PublicationOccurrenceStatus.FAILED || status === PublicationOccurrenceStatus.PARTIAL)
    ? PublicationOccurrenceStatus.AMBIGUOUS
    : status;

type PublicationTargetRow = {
  targetChatId: string;
  entityType: ChatEntityType;
  chat?: { title?: string | null } | null;
};

export type PublisherTargetPresentation = {
  title: string;
  avatarUrl: string | null;
  link: string | null;
};

export type PublisherTargetPresentationMap = ReadonlyMap<string, PublisherTargetPresentation>;

export type PublisherTargetSearchMatch = {
  chatId: string;
  entityType: ChatEntityType;
};

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
        select: PUBLICATION_SUMMARY_OCCURRENCE_SELECT,
      },
    } as const;
  }

  async loadPublicationDetailsRow(
    publicationId: string,
    actorUserId: string,
    dispatchProfile?: PublicationDispatchProfile,
  ) {
    const row = await this.prisma.publication.findFirst({
      where: {
        id: publicationId,
        actorUserId,
        ...(dispatchProfile ? { dispatchProfile } : {}),
      },
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
          select: PUBLICATION_DETAILS_OCCURRENCE_SELECT,
        },
      },
    });
    if (!row) {
      return null;
    }
    const [
      nextOccurrence,
      unresolvedOccurrences,
      deliveryStats,
      actionableDeliveryStats,
      dispatchIssues,
    ] = await Promise.all([
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
        select: PUBLICATION_DETAILS_OCCURRENCE_SELECT,
      }),
      this.loadDeliveryStats(publicationId),
      this.loadActionableDeliveryStatsByPublicationIds([publicationId]),
      row.dispatchProfile === PublicationDispatchProfile.PUBLIK_V1
        ? this.loadPublicationDispatchIssues(
            [publicationId],
            actorUserId,
            PublicationDispatchProfile.PUBLIK_V1,
          )
        : Promise.resolve(emptyPublicationDispatchIssueIndex()),
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
    const occurrences = orderedOccurrences.map((occurrence) => {
      const deliveryStats = occurrenceDeliveryStats.get(occurrence.id) ?? this.emptyDeliveryStats();
      return {
        ...occurrence,
        status: resolveEffectiveOccurrenceStatus(occurrence.status, deliveryStats),
        deliveryStats,
        dispatchIssue: dispatchIssues.byOccurrenceId.get(occurrence.id) ?? null,
      };
    });
    return {
      ...row,
      occurrences,
      nextOccurrenceAt: nextOccurrence?.scheduledAt ?? null,
      dispatchIssue: dispatchIssues.byPublicationId.get(publicationId) ?? null,
      deliveryStats,
      actionableDeliveryStats:
        actionableDeliveryStats.get(publicationId) ?? this.emptyDeliveryStats(),
    };
  }

  async loadPublicationListPresentation(params: {
    rows: Array<{ id: string; targets: PublicationTargetRow[] }>;
    actorUserId: string;
    dispatchProfile?: PublicationDispatchProfile;
    publisherBotId?: string | null;
  }) {
    const publicationIds = params.rows.map((row) => row.id);
    const [deliveryStats, actionableDeliveryStats, publisherTargetPresentations, dispatchIssues] =
      await Promise.all([
        this.loadDeliveryStatsByPublicationIds(publicationIds),
        this.loadActionableDeliveryStatsByPublicationIds(publicationIds),
        params.publisherBotId
          ? this.loadPublisherTargetPresentations(
              params.rows.flatMap((row) => row.targets),
              params.publisherBotId,
            )
          : Promise.resolve(undefined),
        this.loadPublicationDispatchIssues(
          publicationIds,
          params.actorUserId,
          params.dispatchProfile,
        ),
      ]);
    return {
      actionableDeliveryStats,
      deliveryStats,
      dispatchIssues,
      publisherTargetPresentations,
    };
  }

  async mapPublicationSummary(
    row: any,
    preloadedDeliveryStats?: PublicationDeliveryStats,
    preloadedActionableDeliveryStats?: PublicationDeliveryStats,
    publisherTargetPresentations?: PublisherTargetPresentationMap,
    preloadedDispatchIssue?: PublicationDispatchIssue | null,
  ): Promise<PublicationSummary> {
    const delivery =
      preloadedDeliveryStats ?? row.deliveryStats ?? (await this.loadDeliveryStats(row.id));
    const content = row.canonicalContentRevision;
    const contentPreviewSource = content?.text?.trim() ?? '';
    const contentPreview =
      content?.textFormat === PublicationContentFormat.MARKDOWN
        ? stripSupportedMarkdownToPlainText(contentPreviewSource)
        : contentPreviewSource;
    const targets = row.targets.map((target: PublicationTargetRow) =>
      this.mapTarget(target, row.dispatchProfile, publisherTargetPresentations),
    );
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
      contentPreview: contentPreview.slice(0, 160),
      contentPreviewFormat: 'plain',
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
      dispatchIssue:
        row.dispatchProfile === PublicationDispatchProfile.PUBLIK_V1
          ? preloadedDispatchIssue !== undefined
            ? preloadedDispatchIssue
            : (row.dispatchIssue ?? null)
          : null,
      delivery,
      actionableDelivery:
        preloadedActionableDeliveryStats ?? row.actionableDeliveryStats ?? delivery,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    });
  }

  async mapPublicationDetails(
    row: any,
    publisherTargetPresentations?: PublisherTargetPresentationMap,
  ): Promise<PublicationDetails> {
    const summary = await this.mapPublicationSummary(
      row,
      undefined,
      undefined,
      publisherTargetPresentations,
      row.dispatchIssue ?? null,
    );
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
      targets: row.targets.map((target: PublicationTargetRow) =>
        this.mapTarget(target, row.dispatchProfile, publisherTargetPresentations),
      ),
      occurrences: row.occurrences.map((occurrence: any) => {
        const delivery =
          occurrence.deliveryStats ?? this.buildDeliveryStats(occurrence.deliveries ?? []);
        const effectiveOccurrenceStatus = resolveEffectiveOccurrenceStatus(
          occurrence.status,
          delivery,
        );
        const usesLatestContent =
          typeof row.canonicalContentRevisionId === 'string' &&
          occurrence.contentRevisionId === row.canonicalContentRevisionId;
        const hasRetryableMissingEnvelope =
          delivery.total === 0 &&
          occurrence.legacyBroadcastId === null &&
          occurrence._count?.legacyBroadcasts === 0 &&
          effectiveOccurrenceStatus === PublicationOccurrenceStatus.FAILED;
        const canRetry =
          (delivery.failed > 0 || hasRetryableMissingEnvelope) &&
          (row.lifecycle === PublicationLifecycle.ACTIVE ||
            row.lifecycle === PublicationLifecycle.ERROR) &&
          (row.schedule?.status === PublicationScheduleStatus.ACTIVE ||
            row.schedule?.status === PublicationScheduleStatus.ERROR) &&
          occurrence.scheduleId === row.schedule?.id &&
          occurrence.scheduleRevision === row.schedule?.revision &&
          (effectiveOccurrenceStatus === PublicationOccurrenceStatus.FAILED ||
            effectiveOccurrenceStatus === PublicationOccurrenceStatus.PARTIAL);
        return publicationOccurrenceSummarySchema.parse({
          id: occurrence.id,
          scheduledAt: occurrence.scheduledAt.toISOString(),
          status: effectiveOccurrenceStatus,
          dispatchIssue:
            row.dispatchProfile === PublicationDispatchProfile.PUBLIK_V1
              ? (occurrence.dispatchIssue ?? null)
              : null,
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

  async loadPublicationDispatchIssues(
    publicationIds: string[],
    actorUserId: string,
    dispatchProfile?: PublicationDispatchProfile,
  ): Promise<PublicationDispatchIssueIndex> {
    const uniquePublicationIds = [
      ...new Set(publicationIds.map((id) => id.trim()).filter(Boolean)),
    ];
    const normalizedActorUserId = actorUserId.trim();
    if (
      dispatchProfile !== PublicationDispatchProfile.PUBLIK_V1 ||
      uniquePublicationIds.length === 0 ||
      !normalizedActorUserId
    ) {
      return emptyPublicationDispatchIssueIndex();
    }

    // FLAG: Once execution deliveries exist, their pending rows are authoritative. A broadcast
    // envelope can exist before delivery rows, while the occurrence blocker is still current.
    const rows = await this.prisma.$queryRaw<PublicationDispatchBlockerRow[]>(Prisma.sql`
      WITH "currentOccurrences" AS (
        SELECT
          occurrence."id" AS "occurrenceId",
          occurrence."publication_id" AS "publicationId",
          occurrence."dispatch_blocker_code" AS "occurrenceBlockerCode",
          EXISTS (
            SELECT 1
            FROM "managed_broadcast_deliveries" AS delivery
            WHERE delivery."publication_occurrence_id" = occurrence."id"
          ) AS "hasExecutionDeliveries"
        FROM "publication_occurrences" AS occurrence
        INNER JOIN "publications" AS publication
          ON publication."id" = occurrence."publication_id"
        INNER JOIN "publication_schedules" AS schedule
          ON schedule."id" = occurrence."schedule_id"
          AND schedule."publication_id" = occurrence."publication_id"
          AND schedule."revision" = occurrence."schedule_revision"
        WHERE occurrence."publication_id" IN (${Prisma.join(uniquePublicationIds)})
          AND occurrence."status" IN (
            'SCHEDULED'::"PublicationOccurrenceStatus",
            'IN_PROGRESS'::"PublicationOccurrenceStatus"
          )
          AND occurrence."dispatch_profile" = 'PUBLIK_V1'::"PublicationDispatchProfile"
          AND publication."actor_user_id" = ${normalizedActorUserId}
          AND publication."dispatch_profile" = CAST(
            ${dispatchProfile} AS "PublicationDispatchProfile"
          )
          AND publication."lifecycle" IN (
            'ACTIVE'::"PublicationLifecycle",
            'ERROR'::"PublicationLifecycle"
          )
          AND schedule."status" IN (
            'ACTIVE'::"PublicationScheduleStatus",
            'ERROR'::"PublicationScheduleStatus"
          )
      )
      SELECT DISTINCT
        current_occurrence."publicationId",
        current_occurrence."occurrenceId",
        current_occurrence."occurrenceBlockerCode" AS "blockerCode"
      FROM "currentOccurrences" AS current_occurrence
      WHERE current_occurrence."hasExecutionDeliveries" = FALSE
        AND current_occurrence."occurrenceBlockerCode" IS NOT NULL
      UNION ALL
      SELECT DISTINCT
        current_occurrence."publicationId",
        current_occurrence."occurrenceId",
        delivery."dispatch_blocker_code" AS "blockerCode"
      FROM "currentOccurrences" AS current_occurrence
      INNER JOIN "managed_broadcast_deliveries" AS delivery
        ON delivery."publication_occurrence_id" = current_occurrence."occurrenceId"
      WHERE current_occurrence."hasExecutionDeliveries" = TRUE
        AND delivery."dispatch_profile" = 'PUBLIK_V1'::"PublicationDispatchProfile"
        AND delivery."status" IN (
          'PENDING'::"ManagedBroadcastDeliveryStatus",
          'SENDING'::"ManagedBroadcastDeliveryStatus"
        )
        AND delivery."dispatch_blocker_code" IS NOT NULL
    `);
    return buildPublicationDispatchIssueIndex(rows);
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

    const effectiveStatusSql = buildEffectivePublicationDeliveryStatusSql();
    const grouped = await this.prisma.$queryRaw<
      Array<{
        publicationId: string;
        status: ManagedBroadcastDeliveryStatus;
        count: bigint;
      }>
    >(Prisma.sql`
      SELECT
        occurrence."publication_id" AS "publicationId",
        ${effectiveStatusSql} AS "status",
        COUNT(*)::bigint AS "count"
      FROM "managed_broadcast_deliveries" AS delivery
      INNER JOIN "publication_occurrences" AS occurrence
        ON occurrence."id" = delivery."publication_occurrence_id"
      WHERE occurrence."publication_id" IN (${Prisma.join(uniquePublicationIds)})
      GROUP BY occurrence."publication_id", 2
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
    const effectiveStatusSql = buildEffectivePublicationDeliveryStatusSql();
    const grouped = await this.prisma.$queryRaw<
      Array<{ status: ManagedBroadcastDeliveryStatus; count: bigint }>
    >(Prisma.sql`
      SELECT
        ${effectiveStatusSql} AS "status",
        COUNT(*)::bigint AS "count"
      FROM "managed_broadcast_deliveries" AS delivery
      INNER JOIN "publication_occurrences" AS occurrence
        ON occurrence."id" = delivery."publication_occurrence_id"
      WHERE occurrence."publication_id" = ${publicationId}
      GROUP BY 1
    `);
    const stats = this.emptyDeliveryStats();
    for (const group of grouped) {
      this.addDeliveryCount(stats, group.status, Number(group.count));
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

    const effectiveStatusSql = buildEffectivePublicationDeliveryStatusSql();
    const grouped = await this.prisma.$queryRaw<
      Array<{
        publicationId: string;
        status: ManagedBroadcastDeliveryStatus;
        count: bigint;
      }>
    >(Prisma.sql`
      SELECT
        occurrence."publication_id" AS "publicationId",
        ${effectiveStatusSql} AS "status",
        COUNT(*)::bigint AS "count"
      FROM "managed_broadcast_deliveries" AS delivery
      INNER JOIN "publication_occurrences" AS occurrence
        ON occurrence."id" = delivery."publication_occurrence_id"
      INNER JOIN "publication_schedules" AS schedule
        ON schedule."id" = occurrence."schedule_id"
        AND schedule."publication_id" = occurrence."publication_id"
        AND schedule."revision" = occurrence."schedule_revision"
      WHERE occurrence."publication_id" IN (${Prisma.join(uniquePublicationIds)})
      GROUP BY occurrence."publication_id", 2
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

    const effectiveStatusSql = buildEffectivePublicationDeliveryStatusSql();
    const grouped = await this.prisma.$queryRaw<
      Array<{
        publicationOccurrenceId: string;
        status: ManagedBroadcastDeliveryStatus;
        count: bigint;
      }>
    >(Prisma.sql`
      SELECT
        delivery."publication_occurrence_id" AS "publicationOccurrenceId",
        ${effectiveStatusSql} AS "status",
        COUNT(*)::bigint AS "count"
      FROM "managed_broadcast_deliveries" AS delivery
      WHERE delivery."publication_occurrence_id" IN (${Prisma.join(uniqueOccurrenceIds)})
      GROUP BY delivery."publication_occurrence_id", 2
    `);
    for (const group of grouped) {
      const stats = statsByOccurrenceId.get(group.publicationOccurrenceId);
      if (stats) {
        this.addDeliveryCount(stats, group.status, Number(group.count));
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

  async loadPublisherTargetPresentations(
    targets: readonly PublicationTargetRow[],
    publisherBotId: string,
  ): Promise<Map<string, PublisherTargetPresentation>> {
    const normalizedBotId = publisherBotId.trim();
    const chatIds = [
      ...new Set(targets.map((target) => target.targetChatId.trim()).filter(Boolean)),
    ];
    if (!normalizedBotId || chatIds.length === 0) {
      return new Map();
    }

    const presentations = new Map<string, PublisherTargetPresentation>();
    for (let offset = 0; offset < chatIds.length; offset += PUBLISHER_CATALOG_LOOKUP_BATCH_SIZE) {
      const batch = chatIds.slice(offset, offset + PUBLISHER_CATALOG_LOOKUP_BATCH_SIZE);
      const rows = await this.prisma.managedBotChatCatalog.findMany({
        where: {
          botId: normalizedBotId,
          chatId: { in: batch },
          status: 'ACTIVE',
        },
        select: {
          chatId: true,
          entityType: true,
          title: true,
          avatarUrl: true,
          link: true,
        },
      });
      for (const row of rows) {
        presentations.set(this.targetKey(row.chatId, row.entityType), {
          title: row.title?.trim() || row.chatId,
          avatarUrl: this.normalizeHttpPresentationUrl(row.avatarUrl),
          link: this.normalizeMaxEntityUrl(row.link),
        });
      }
    }
    return presentations;
  }

  async findPublisherTargetSearchMatches(
    publisherBotId: string,
    query: string,
  ): Promise<PublisherTargetSearchMatch[]> {
    const normalizedBotId = publisherBotId.trim();
    const normalizedQuery = query.trim();
    if (!normalizedBotId || !normalizedQuery) {
      return [];
    }

    const rows = await this.prisma.$queryRaw<PublisherTargetSearchMatch[]>(Prisma.sql`
      SELECT
        catalog."chat_id" AS "chatId",
        catalog."entity_type" AS "entityType"
      FROM "managed_bot_chat_catalog" AS catalog
      WHERE catalog."bot_id" = ${normalizedBotId}
        AND catalog."status" = 'ACTIVE'
        AND COALESCE(NULLIF(BTRIM(catalog."title"), ''), catalog."chat_id")
          ILIKE ${`%${normalizedQuery}%`}
      ORDER BY catalog."entity_type" ASC, catalog."chat_id" ASC
      LIMIT ${MAX_PUBLICATION_TARGETS + 1}
    `);
    if (rows.length > MAX_PUBLICATION_TARGETS) {
      throw new BadRequestException('Уточните поиск по чатам и каналам.');
    }
    return rows;
  }

  mapTarget(
    target: PublicationTargetRow,
    dispatchProfile?: PublicationDispatchProfile,
    publisherTargetPresentations?: PublisherTargetPresentationMap,
  ) {
    if (dispatchProfile === PublicationDispatchProfile.PUBLIK_V1) {
      const presentation = publisherTargetPresentations?.get(
        this.targetKey(target.targetChatId, target.entityType),
      );
      return {
        chatId: target.targetChatId,
        entityType: this.fromPrismaEntityType(target.entityType),
        title: presentation?.title || target.targetChatId,
        avatarUrl: presentation?.avatarUrl ?? null,
        link: presentation?.link ?? null,
      };
    }

    return {
      chatId: target.targetChatId,
      entityType: this.fromPrismaEntityType(target.entityType),
      title: target.chat?.title ?? target.targetChatId,
      avatarUrl: null,
      link: null,
    };
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

  private targetKey(chatId: string, entityType: ChatEntityType): string {
    return JSON.stringify([entityType, chatId]);
  }

  private normalizeMaxEntityUrl(value: string | null): string | null {
    const parsed = this.parsePresentationUrl(value);
    if (
      !parsed ||
      parsed.protocol !== 'https:' ||
      (parsed.hostname !== 'max.ru' && parsed.hostname !== 'www.max.ru') ||
      parsed.port.length > 0 ||
      parsed.hash.length > 0 ||
      parsed.pathname === '/'
    ) {
      return null;
    }
    parsed.hostname = 'max.ru';
    return parsed.toString();
  }

  private normalizeHttpPresentationUrl(value: string | null): string | null {
    const parsed = this.parsePresentationUrl(value);
    if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
      return null;
    }
    return parsed.toString();
  }

  private parsePresentationUrl(value: string | null): URL | null {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (
      normalized.length === 0 ||
      normalized.length > MAX_PRESENTATION_URL_LENGTH ||
      [...normalized].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return (
          /\s/u.test(character) || codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
        );
      })
    ) {
      return null;
    }
    try {
      const parsed = new URL(normalized);
      return parsed.username.length === 0 && parsed.password.length === 0 ? parsed : null;
    } catch {
      return null;
    }
  }
}
