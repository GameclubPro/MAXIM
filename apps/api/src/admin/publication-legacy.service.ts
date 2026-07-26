import type { ChatSummary } from '@maxim/contracts';
import {
  decodeLegacyPublicationListCursor,
  encodeLegacyPublicationListCursor,
  legacyPublicationSourceSchema,
  listLegacyPublicationsQuerySchema,
  listLegacyPublicationsResponseSchema,
  type LegacyPublicationKind,
  type LegacyPublicationListCursorPayload,
  type LegacyPublicationSource,
  type LegacyPublicationSummary,
  type ListLegacyPublicationsResponse,
} from '@maxim/contracts/publication';
import { BadRequestException, Injectable } from '@nestjs/common';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import {
  ChatEntityType,
  ManagedAutopostMaterializationStatus,
  ManagedAutopostRuleStatus,
  ManagedBroadcastDeliveryStatus,
  ManagedBroadcastStatus,
  Prisma,
} from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { ManagedEntitiesService } from './managed-entities.service';

type LegacySourceClause = {
  entityType: ChatEntityType;
  sourceChatId: { in: string[] };
};

type LegacyAutopostRow = {
  id: string;
  sourceChatId: string;
  entityType: ChatEntityType;
  status: ManagedAutopostRuleStatus;
  revision: number;
  title: string;
  text: string;
  targetMode: string;
  targetChatIds: Prisma.JsonValue;
  imageEnabled: boolean;
  imageCount: number;
  mediaType: string | null;
  scheduleTimezone: string;
  scheduledSlots: Prisma.JsonValue;
  nextMaterializeAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  executionEnabled: boolean;
};

type LegacyAutopostContentProjection = Pick<
  LegacyAutopostRow,
  | 'id'
  | 'text'
  | 'targetMode'
  | 'targetChatIds'
  | 'imageEnabled'
  | 'imageCount'
  | 'mediaType'
  | 'scheduleTimezone'
  | 'scheduledSlots'
>;

type LegacyAutopostDeliveryRollup = {
  hasAmbiguousDelivery: boolean;
  lastError: string;
};

type LegacyBroadcastRow = {
  id: string;
  sourceChatId: string;
  entityType: ChatEntityType;
  status: ManagedBroadcastStatus;
  text: string;
  applyToAllChats: boolean;
  targetChatIds: Prisma.JsonValue;
  imageEnabled: boolean;
  mediaType: string | null;
  scheduleTimezone: string;
  nextSendAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type SourceBundle = {
  byKey: Map<string, LegacyPublicationSource>;
  chatCount: number;
};

@Injectable()
export class PublicationLegacyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly managedEntitiesService: ManagedEntitiesService,
  ) {}

  async list(user: AuthUser, query: unknown): Promise<ListLegacyPublicationsResponse> {
    const parsed = listLegacyPublicationsQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    const request = parsed.data;
    const cursor = request.cursor ? decodeLegacyPublicationListCursor(request.cursor) : null;
    if (
      request.cursor &&
      (!cursor ||
        cursor.view !== request.view ||
        cursor.kind !== request.kind ||
        cursor.entityType !== request.entityType ||
        cursor.query !== request.query)
    ) {
      throw new BadRequestException('Курсор списка ранее созданных публикаций недействителен.');
    }

    const sources = await this.loadAccessibleSources(user);
    const sourceClauses = this.buildSourceClauses(sources, request.entityType);
    if (sourceClauses.length === 0) {
      return listLegacyPublicationsResponseSchema.parse({
        items: [],
        nextCursor: null,
        totalCount: 0,
      });
    }

    const take = request.limit + 1;
    const [autopostRows, broadcastRows, autopostCount, broadcastCount] = await Promise.all([
      request.kind === 'broadcast'
        ? Promise.resolve([] as LegacyAutopostRow[])
        : this.loadAutopostRows(sourceClauses, request.view, request.query, cursor, take),
      request.kind === 'autopost'
        ? Promise.resolve([] as LegacyBroadcastRow[])
        : this.loadBroadcastRows(sourceClauses, request.view, request.query, cursor, take),
      request.kind === 'broadcast'
        ? Promise.resolve(0)
        : this.prisma.managedAutopostRule.count({
            where: this.buildAutopostWhere(sourceClauses, request.view, request.query, null),
          }),
      request.kind === 'autopost'
        ? Promise.resolve(0)
        : this.prisma.managedBroadcast.count({
            where: this.buildBroadcastWhere(sourceClauses, request.view, request.query, null),
          }),
    ]);

    const candidates = [
      ...autopostRows.flatMap((row) => this.mapAutopost(row, sources)),
      ...broadcastRows.flatMap((row) => this.mapBroadcast(row, sources)),
    ].sort((left, right) => this.compareItems(left, right));
    const items = candidates.slice(0, request.limit);
    const last = items.at(-1);

    return listLegacyPublicationsResponseSchema.parse({
      items,
      nextCursor:
        candidates.length > request.limit && last
          ? encodeLegacyPublicationListCursor({
              v: 1,
              updatedAt: last.updatedAt,
              id: last.id,
              itemKind: last.kind,
              view: request.view,
              kind: request.kind,
              entityType: request.entityType,
              query: request.query,
            })
          : null,
      totalCount: autopostCount + broadcastCount,
    });
  }

  private async loadAutopostRows(
    sourceClauses: LegacySourceClause[],
    view: 'active' | 'history',
    query: string,
    cursor: LegacyPublicationListCursorPayload | null,
    take: number,
  ): Promise<LegacyAutopostRow[]> {
    const rows = await this.prisma.managedAutopostRule.findMany({
      where: this.buildAutopostWhere(sourceClauses, view, query, cursor),
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take,
      select: {
        id: true,
        sourceChatId: true,
        entityType: true,
        status: true,
        revision: true,
        title: true,
        nextMaterializeAt: true,
        lastError: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (rows.length === 0) {
      return [];
    }

    // Keep large image/video payloads inside Postgres; the compatibility list only needs metadata.
    const projections = await this.prisma.$queryRaw<LegacyAutopostContentProjection[]>(Prisma.sql`
      SELECT
        "id",
        COALESCE("payload"->>'text', '') AS "text",
        COALESCE("payload"->>'targetMode', 'current') AS "targetMode",
        CASE
          WHEN jsonb_typeof("payload"->'targetChatIds') = 'array'
            THEN "payload"->'targetChatIds'
          ELSE '[]'::jsonb
        END AS "targetChatIds",
        COALESCE(("payload"->>'imageEnabled') = 'true', false) AS "imageEnabled",
        CASE
          WHEN jsonb_typeof("payload"->'images') = 'array'
            THEN jsonb_array_length("payload"->'images')
          ELSE 0
        END AS "imageCount",
        NULLIF(BTRIM(COALESCE("payload"->>'mediaType', '')), '') AS "mediaType",
        COALESCE(
          NULLIF(BTRIM(COALESCE("payload"->>'scheduleTimezone', '')), ''),
          'Europe/Moscow'
        ) AS "scheduleTimezone",
        CASE
          WHEN jsonb_typeof("payload"->'scheduledSlots') = 'array'
            THEN "payload"->'scheduledSlots'
          ELSE '[]'::jsonb
        END AS "scheduledSlots"
      FROM "managed_autopost_rules"
      WHERE "id" IN (${Prisma.join(rows.map((row) => row.id))})
    `);
    const projectionById = new Map(projections.map((projection) => [projection.id, projection]));
    const deliveryRollups = await this.loadAutopostDeliveryRollups(rows);

    return rows.map((row) => {
      const projection = projectionById.get(row.id);
      const deliveryRollup = deliveryRollups.get(row.id);
      const deliveryFailureVisible = Boolean(deliveryRollup);
      return {
        ...row,
        executionEnabled:
          row.status === ManagedAutopostRuleStatus.ACTIVE ||
          row.status === ManagedAutopostRuleStatus.ERROR,
        status: deliveryFailureVisible ? ManagedAutopostRuleStatus.ERROR : row.status,
        text: projection?.text ?? '',
        targetMode: projection?.targetMode ?? 'current',
        targetChatIds: projection?.targetChatIds ?? [],
        imageEnabled: projection?.imageEnabled ?? false,
        imageCount: projection?.imageCount ?? 0,
        mediaType: projection?.mediaType ?? null,
        scheduleTimezone: projection?.scheduleTimezone ?? 'Europe/Moscow',
        scheduledSlots: projection?.scheduledSlots ?? [],
        lastError: deliveryFailureVisible ? (deliveryRollup?.lastError ?? null) : row.lastError,
      };
    });
  }

  private async loadAutopostDeliveryRollups(
    rows: Array<Pick<LegacyAutopostRow, 'id' | 'revision'>>,
  ): Promise<Map<string, LegacyAutopostDeliveryRollup>> {
    if (rows.length === 0) {
      return new Map();
    }

    const materializations = await this.prisma.managedAutopostMaterialization.findMany({
      where: {
        status: ManagedAutopostMaterializationStatus.CREATED,
        broadcastId: { not: null },
        OR: rows.map((row) => ({ ruleId: row.id, revision: row.revision })),
        broadcast: {
          is: {
            OR: [
              {
                status: {
                  in: [ManagedBroadcastStatus.FAILED, ManagedBroadcastStatus.PARTIAL],
                },
              },
              {
                deliveries: {
                  some: { status: ManagedBroadcastDeliveryStatus.AMBIGUOUS },
                },
              },
            ],
          },
        },
      },
      select: {
        ruleId: true,
        broadcast: {
          select: {
            status: true,
            lastError: true,
            deliveries: {
              where: { status: ManagedBroadcastDeliveryStatus.AMBIGUOUS },
              select: { id: true },
              take: 1,
            },
          },
        },
      },
    });
    const rollups = new Map<string, LegacyAutopostDeliveryRollup>();

    for (const materialization of materializations) {
      const broadcast = materialization.broadcast;
      if (!broadcast) {
        continue;
      }
      const hasAmbiguousDelivery = broadcast.deliveries.length > 0;
      const existing = rollups.get(materialization.ruleId);
      const lastError = hasAmbiguousDelivery
        ? 'Есть неоднозначная доставка после таймаута MAX. Проверьте публикацию вручную.'
        : broadcast.lastError?.trim() ||
          (broadcast.status === ManagedBroadcastStatus.PARTIAL
            ? 'Публикация доставлена не всем получателям.'
            : 'Не удалось доставить публикацию.');
      rollups.set(materialization.ruleId, {
        hasAmbiguousDelivery: existing?.hasAmbiguousDelivery === true || hasAmbiguousDelivery,
        lastError:
          existing?.hasAmbiguousDelivery === true && !hasAmbiguousDelivery
            ? existing.lastError
            : lastError,
      });
    }

    return rollups;
  }

  private loadBroadcastRows(
    sourceClauses: LegacySourceClause[],
    view: 'active' | 'history',
    query: string,
    cursor: LegacyPublicationListCursorPayload | null,
    take: number,
  ): Promise<LegacyBroadcastRow[]> {
    return this.prisma.managedBroadcast.findMany({
      where: this.buildBroadcastWhere(sourceClauses, view, query, cursor),
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take,
      select: {
        id: true,
        sourceChatId: true,
        entityType: true,
        status: true,
        text: true,
        applyToAllChats: true,
        targetChatIds: true,
        imageEnabled: true,
        mediaType: true,
        scheduleTimezone: true,
        nextSendAt: true,
        lastError: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  private buildAutopostWhere(
    sourceClauses: LegacySourceClause[],
    view: 'active' | 'history',
    query: string,
    cursor: LegacyPublicationListCursorPayload | null,
  ): Prisma.ManagedAutopostRuleWhereInput {
    const filters: Prisma.ManagedAutopostRuleWhereInput[] = [];
    if (query) {
      filters.push({
        OR: [
          { title: { contains: query, mode: 'insensitive' } },
          { chat: { is: { title: { contains: query, mode: 'insensitive' } } } },
          {
            payload: {
              path: ['text'],
              string_contains: query,
              mode: 'insensitive',
            } satisfies Prisma.JsonFilter,
          },
        ],
      });
    }
    if (cursor) {
      filters.push(this.buildCursorPredicate(cursor, 'autopost'));
    }

    return {
      OR: sourceClauses,
      status: {
        in:
          view === 'active'
            ? [
                ManagedAutopostRuleStatus.ACTIVE,
                ManagedAutopostRuleStatus.PAUSED,
                ManagedAutopostRuleStatus.ERROR,
              ]
            : [ManagedAutopostRuleStatus.COMPLETED],
      },
      ...(filters.length > 0 ? { AND: filters } : {}),
    };
  }

  private buildBroadcastWhere(
    sourceClauses: LegacySourceClause[],
    view: 'active' | 'history',
    query: string,
    cursor: LegacyPublicationListCursorPayload | null,
  ): Prisma.ManagedBroadcastWhereInput {
    const filters: Prisma.ManagedBroadcastWhereInput[] = [];
    if (query) {
      filters.push({
        OR: [
          { text: { contains: query, mode: 'insensitive' } },
          { chat: { is: { title: { contains: query, mode: 'insensitive' } } } },
        ],
      });
    }
    if (cursor) {
      filters.push(this.buildCursorPredicate(cursor, 'broadcast'));
    }

    return {
      OR: sourceClauses,
      status: {
        in:
          view === 'active'
            ? [
                ManagedBroadcastStatus.ACTIVE,
                ManagedBroadcastStatus.PARTIAL,
                ManagedBroadcastStatus.FAILED,
              ]
            : [ManagedBroadcastStatus.COMPLETED, ManagedBroadcastStatus.CANCELED],
      },
      publicationOccurrenceId: null,
      autopostMaterializations: { none: {} },
      ...(filters.length > 0 ? { AND: filters } : {}),
    };
  }

  private buildCursorPredicate(
    cursor: LegacyPublicationListCursorPayload,
    itemKind: LegacyPublicationKind,
  ): Prisma.ManagedAutopostRuleWhereInput & Prisma.ManagedBroadcastWhereInput {
    const updatedAt = new Date(cursor.updatedAt);
    return {
      OR: [
        { updatedAt: { lt: updatedAt } },
        { updatedAt, id: { lt: cursor.id } },
        ...(itemKind.localeCompare(cursor.itemKind) < 0 ? [{ updatedAt, id: cursor.id }] : []),
      ],
    };
  }

  private async loadAccessibleSources(user: AuthUser): Promise<SourceBundle> {
    const [chats, channels] = await Promise.all([
      this.managedEntitiesService.listChats(user, { fresh: false }),
      this.managedEntitiesService.listChannels(user, { fresh: false }),
    ]);
    const normalizedChats = chats.filter((source) => source.entityType === 'chat');
    const normalizedChannels = channels.filter((source) => source.entityType === 'channel');
    const sourcePreviews = [
      ...normalizedChats.map((source) => this.mapSource(source, 'chat')),
      ...normalizedChannels.map((source) => this.mapSource(source, 'channel')),
    ];

    return {
      byKey: new Map(
        sourcePreviews.map((source) => [this.sourceKey(source.entityType, source.chatId), source]),
      ),
      chatCount: normalizedChats.length,
    };
  }

  private buildSourceClauses(
    sources: SourceBundle,
    entityType?: 'chat' | 'channel',
  ): LegacySourceClause[] {
    const chatIds: string[] = [];
    const channelIds: string[] = [];
    for (const source of sources.byKey.values()) {
      if (!entityType || source.entityType === entityType) {
        (source.entityType === 'channel' ? channelIds : chatIds).push(source.chatId);
      }
    }

    return [
      ...(chatIds.length > 0
        ? [{ entityType: ChatEntityType.CHAT, sourceChatId: { in: chatIds } }]
        : []),
      ...(channelIds.length > 0
        ? [{ entityType: ChatEntityType.CHANNEL, sourceChatId: { in: channelIds } }]
        : []),
    ];
  }

  private mapAutopost(row: LegacyAutopostRow, sources: SourceBundle): LegacyPublicationSummary[] {
    if (row.status === ManagedAutopostRuleStatus.DISABLED) {
      return [];
    }
    const source = sources.byKey.get(
      this.sourceKey(this.fromPrismaEntityType(row.entityType), row.sourceChatId),
    );
    if (!source) {
      return [];
    }

    const hasVideo = row.mediaType?.trim().toLowerCase() === 'video';
    const imageCount = row.imageCount || (row.imageEnabled ? 1 : 0);
    const targetCount = this.resolveTargetCount(
      this.normalizeTargetMode(row.targetMode),
      this.readStringArray(row.targetChatIds),
      source,
      sources.chatCount,
    );
    const nextRunAt = row.executionEnabled
      ? (this.resolveNextScheduledSlot(this.readStringArray(row.scheduledSlots)) ??
        row.nextMaterializeAt)
      : null;

    return [
      {
        kind: 'autopost',
        id: row.id,
        source,
        status: row.status,
        title: row.title.trim(),
        contentPreview: this.resolveContentPreview(row.text, imageCount, hasVideo),
        targetCount,
        mediaCount: hasVideo ? 1 : imageCount,
        hasVideo,
        scheduleTimezone: row.scheduleTimezone,
        nextRunAt: nextRunAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        lastError: this.normalizeOptionalText(row.lastError),
      },
    ];
  }

  private mapBroadcast(row: LegacyBroadcastRow, sources: SourceBundle): LegacyPublicationSummary[] {
    const source = sources.byKey.get(
      this.sourceKey(this.fromPrismaEntityType(row.entityType), row.sourceChatId),
    );
    if (!source) {
      return [];
    }

    const hasVideo = row.mediaType?.trim().toLowerCase() === 'video';
    const imageCount = this.readBroadcastImageCount(row);
    const targetChatIds = this.readStringArray(row.targetChatIds);
    const targetCount =
      source.entityType === 'channel'
        ? 1
        : row.applyToAllChats
          ? Math.max(1, sources.chatCount)
          : Math.max(1, targetChatIds.length);

    return [
      {
        kind: 'broadcast',
        id: row.id,
        source,
        status: row.status,
        title: '',
        contentPreview: this.resolveContentPreview(row.text, imageCount, hasVideo),
        targetCount,
        mediaCount: hasVideo ? 1 : imageCount,
        hasVideo,
        scheduleTimezone: row.scheduleTimezone.trim() || 'Europe/Moscow',
        nextRunAt: row.nextSendAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        lastError: this.normalizeOptionalText(row.lastError),
      },
    ];
  }

  private mapSource(source: ChatSummary, entityType: 'chat' | 'channel'): LegacyPublicationSource {
    return legacyPublicationSourceSchema.parse({
      chatId: source.id,
      entityType,
      title: source.title,
      avatarUrl: source.avatarUrl ?? null,
      link: source.link?.trim() || null,
    });
  }

  private resolveTargetCount(
    targetMode: 'current' | 'all' | 'selected',
    targetChatIds: string[],
    source: LegacyPublicationSource,
    chatCount: number,
  ): number {
    if (source.entityType === 'channel' || targetMode === 'current') {
      return 1;
    }
    if (targetMode === 'all') {
      return Math.max(1, chatCount);
    }
    return Math.max(1, new Set(targetChatIds.map((id) => id.trim()).filter(Boolean)).size);
  }

  private normalizeTargetMode(value: string): 'current' | 'all' | 'selected' {
    return value === 'all' || value === 'selected' ? value : 'current';
  }

  private resolveNextScheduledSlot(slots: string[]): Date | null {
    const now = Date.now();
    const timestamps = slots
      .map((slot) => Date.parse(slot))
      .filter((timestamp) => Number.isFinite(timestamp) && timestamp >= now)
      .sort((left, right) => left - right);
    return timestamps[0] === undefined ? null : new Date(timestamps[0]);
  }

  private readBroadcastImageCount(row: LegacyBroadcastRow): number {
    return row.mediaType?.trim().toLowerCase() === 'image' || row.imageEnabled ? 1 : 0;
  }

  private readStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return Array.from(
      new Set(value.map((item) => this.readString(item).trim()).filter((item) => item.length > 0)),
    );
  }

  private readString(value: unknown): string {
    return typeof value === 'string' ? value : '';
  }

  private resolveContentPreview(text: string, imageCount: number, hasVideo: boolean): string {
    const normalized = text.replace(/\s+/gu, ' ').trim();
    if (normalized) {
      return normalized.slice(0, 160);
    }
    if (hasVideo) {
      return 'Видео без текста';
    }
    if (imageCount > 0) {
      return 'Фото без текста';
    }
    return 'Пустая публикация';
  }

  private normalizeOptionalText(value: string | null): string | null {
    const normalized = value?.trim() ?? '';
    return normalized || null;
  }

  private compareItems(left: LegacyPublicationSummary, right: LegacyPublicationSummary): number {
    const updatedDiff = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    if (updatedDiff !== 0) {
      return updatedDiff;
    }
    const idDiff = right.id.localeCompare(left.id);
    return idDiff !== 0 ? idDiff : right.kind.localeCompare(left.kind);
  }

  private sourceKey(entityType: 'chat' | 'channel', chatId: string): string {
    return `${entityType}:${chatId}`;
  }

  private fromPrismaEntityType(entityType: ChatEntityType): 'chat' | 'channel' {
    return entityType === ChatEntityType.CHANNEL ? 'channel' : 'chat';
  }
}
