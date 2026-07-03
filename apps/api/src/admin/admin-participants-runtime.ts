import {
  chatParticipantImmunitySchema,
  chatParticipantImmunityUpdateRequestSchema,
  chatParticipantImmunityUpdateResultSchema,
  chatParticipantsPageSchema,
  chatParticipantsQuerySchema,
  type ChatParticipantImmunity,
  type ChatParticipantImmunityUpdateResult,
  type ChatParticipantItem,
  type ChatParticipantsPage,
  type ChatParticipantsQuery,
  type ManagedEntityType,
} from '@maxim/contracts';
import { BadRequestException } from '@nestjs/common';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import {
  MAX_API_SOURCE_TAGS,
  type MaxClientService,
  type MaxChatMemberAccess,
  type MaxChatMemberRole,
  type MaxChatRosterMember,
} from '../max/max-client.service';
import type { Prisma } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  buildChatParticipantsPageCacheKey,
  isMaxApiThrottleError,
  isMaxApiTimeoutError,
} from './admin-legacy-utils';
import type { AdminParticipantsRuntimeContext } from './admin-participants-runtime-context';
import {
  ADMIN_ACTION_HEALTH_LANE,
  ADMIN_FALLBACK_READ_FAILURE_METRIC_STATUSES,
  CHAT_PARTICIPANTS_SEARCH_MAX_API_WAIT_MS,
  CHAT_PARTICIPANTS_SEARCH_REMOTE_PAGES_PER_RESPONSE,
  DEFAULT_PARTICIPANT_IMMUNITY_TIMEZONE,
  EVENTS_FEED_PAGE_CACHE_TTL_MS,
  ONE_HOUR_MS,
  type ChatParticipantsSearchCursor,
  type TimedPromiseCacheEntry,
} from './admin.service.support';

export class AdminParticipantsRuntime {
  constructor(private readonly context: AdminParticipantsRuntimeContext) {}

  private get prisma(): PrismaService {
    return this.context.prisma;
  }

  private get maxClient(): MaxClientService {
    return this.context.maxClient;
  }

  private get logger(): AdminParticipantsRuntimeContext['logger'] {
    return this.context.logger;
  }

  private get chatParticipantsPageCache(): Map<
    string,
    TimedPromiseCacheEntry<ChatParticipantsPage>
  > {
    return this.context.chatParticipantsPageCache;
  }

  private assertReadOnlyChatAdmin(
    chatId: string,
    userId: string,
    entityType?: ManagedEntityType | null,
    options?: Parameters<AdminParticipantsRuntimeContext['assertReadOnlyChatAdmin']>[3],
  ): Promise<void> {
    return this.context.assertReadOnlyChatAdmin(chatId, userId, entityType, options);
  }

  private buildParticipantViolationCountWhere(
    chatId: string,
    userIds: readonly string[],
    from: Date,
    to: Date,
  ): Prisma.ModerationEventWhereInput {
    return this.context.buildParticipantViolationCountWhere(chatId, userIds, from, to);
  }

  private buildProfileMentionHandoffUrl(
    chatId: string,
    entityType: ManagedEntityType,
    userId: string,
    displayName: string | null,
    botId?: string | null,
  ): string | null {
    return this.context.buildProfileMentionHandoffUrl(
      chatId,
      entityType,
      userId,
      displayName,
      botId,
    );
  }

  private buildUserProfileUrl(username: string | null): string | null {
    return this.context.buildUserProfileUrl(username);
  }

  private ensureEntityType(
    chatId: string,
    userId: string,
    expectedEntityType: ManagedEntityType,
  ): Promise<void> {
    return this.context.ensureEntityType(chatId, userId, expectedEntityType);
  }

  private getManagedEntityHeader(
    ...args: Parameters<AdminParticipantsRuntimeContext['getManagedEntityHeader']>
  ): ReturnType<AdminParticipantsRuntimeContext['getManagedEntityHeader']> {
    return this.context.getManagedEntityHeader(...args);
  }

  private normalizeMaxProfileUrl(value: string | null): string | null {
    return this.context.normalizeMaxProfileUrl(value);
  }

  private prepareManualModerationTarget(
    ...args: Parameters<AdminParticipantsRuntimeContext['prepareManualModerationTarget']>
  ): ReturnType<AdminParticipantsRuntimeContext['prepareManualModerationTarget']> {
    return this.context.prepareManualModerationTarget(...args);
  }

  private readTrimmedString(value: unknown): string | null {
    return this.context.readTrimmedString(value);
  }

  private resolveBackgroundReadBotAssignment(chatId: string): Promise<string | undefined> {
    return this.context.resolveBackgroundReadBotAssignment(chatId);
  }

  private resolveLogsDashboardFrom(range: ChatParticipantsQuery['range'], to: Date): Date {
    return this.context.resolveLogsDashboardFrom(range, to);
  }

  private toSafeInteger(value: unknown): number {
    return this.context.toSafeInteger(value);
  }

  async getChatParticipantsPage(
    chatId: string,
    user: AuthUser,
    query: unknown,
  ): Promise<ChatParticipantsPage> {
    await this.assertReadOnlyChatAdmin(chatId, user.userId, 'chat');
    await this.ensureEntityType(chatId, user.userId, 'chat');

    const parsed = chatParticipantsQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    return this.getCachedChatParticipantsPage(chatId, user.userId, parsed.data, 'chat');
  }

  async updateChatParticipantImmunity(
    chatId: string,
    targetUserIdRaw: string,
    user: AuthUser,
    body: unknown,
  ): Promise<ChatParticipantImmunityUpdateResult> {
    await this.ensureEntityType(chatId, user.userId, 'chat');

    const targetUserId = await this.prepareManualModerationTarget(chatId, targetUserIdRaw, user);
    const parsed = chatParticipantImmunityUpdateRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    if (!parsed.data.enabled) {
      await this.prisma.chatParticipantModerationImmunity.deleteMany({
        where: {
          chatId,
          userId: targetUserId,
        },
      });

      this.invalidateChatParticipantsPageCache(chatId);
      return chatParticipantImmunityUpdateResultSchema.parse({
        immunity: null,
        message: 'Иммунитет снят.',
      });
    }

    const participantLookupBotId = await this.resolveBackgroundReadBotAssignment(chatId);
    await this.assertTargetUserCanReceiveParticipantImmunity(
      chatId,
      targetUserId,
      participantLookupBotId,
    );

    const [settings, now] = await Promise.all([
      this.prisma.chatSettings.findUnique({
        where: { chatId },
        select: { nightModeTimezone: true },
      }),
      Promise.resolve(new Date()),
    ]);
    const timeZone = this.normalizeParticipantImmunityTimezone(settings?.nightModeTimezone ?? null);
    const usageDateKey = this.formatParticipantImmunityDateKey(now, timeZone);
    const expiresAt = new Date(now.getTime() + parsed.data.durationHours! * ONE_HOUR_MS);
    const immunity = await this.prisma.chatParticipantModerationImmunity.upsert({
      where: {
        chatId_userId: {
          chatId,
          userId: targetUserId,
        },
      },
      create: {
        chatId,
        userId: targetUserId,
        expiresAt,
        dailyViolationLimit: parsed.data.dailyViolationLimit!,
        dailyViolationUsage: 0,
        usageDateKey,
        createdByUserId: user.userId,
        updatedByUserId: user.userId,
      },
      update: {
        expiresAt,
        dailyViolationLimit: parsed.data.dailyViolationLimit!,
        dailyViolationUsage: 0,
        usageDateKey,
        updatedByUserId: user.userId,
      },
    });

    this.invalidateChatParticipantsPageCache(chatId);
    return chatParticipantImmunityUpdateResultSchema.parse({
      immunity: this.buildChatParticipantImmunitySummary(immunity, now, timeZone),
      message: 'Иммунитет обновлён.',
    });
  }

  invalidateChatParticipantsPageCache(chatId: string): void {
    const prefix = `${chatId}:`;
    for (const key of this.chatParticipantsPageCache.keys()) {
      if (key.startsWith(prefix)) {
        this.chatParticipantsPageCache.delete(key);
      }
    }
  }

  private async buildChatParticipantsPage(
    chatId: string,
    userId: string,
    query: ChatParticipantsQuery,
    entityType: ManagedEntityType = 'chat',
  ): Promise<ChatParticipantsPage> {
    const limit = Math.max(1, Math.min(100, query.limit));
    const search = this.normalizeChatParticipantsSearchText(query.search ?? '');
    const resolvedBotId = (await this.resolveBackgroundReadBotAssignment(chatId)) ?? null;
    const now = new Date();
    const from = this.resolveLogsDashboardFrom(query.range, now);
    const membersPagePromise = (
      search
        ? this.searchChatParticipantsMembersPage(chatId, query, search, resolvedBotId)
        : this.loadChatParticipantsMembersPage(chatId, limit, query.cursor ?? null, resolvedBotId)
    ).catch((error: unknown) => {
      if (!this.isTerminalChatParticipantsRosterAccessError(error)) {
        throw error;
      }

      this.logger.warn(
        {
          chatId,
          entityType,
          search: search ? true : undefined,
          statusCode: this.extractHttpStatusCode(error),
          code: this.extractMaxApiErrorCode(error),
          err: error instanceof Error ? error.message : String(error),
        },
        'Returning empty participant page after MAX denied roster access',
      );

      return {
        items: [],
        nextMarker: null,
      };
    });
    const [membersPage, header, settings] = await Promise.all([
      membersPagePromise,
      this.getManagedEntityHeader(
        chatId,
        {
          userId,
          username: null,
          displayName: null,
          chatTitle: null,
        },
        entityType,
        { skipAdminCheck: true, skipEntityCheck: true },
      ),
      this.prisma.chatSettings.findUnique({
        where: { chatId },
        select: { nightModeTimezone: true },
      }),
    ]);
    const participantUserIds = Array.from(
      new Set(
        membersPage.items
          .map((member) => member.userId.trim())
          .filter((memberUserId) => memberUserId.length > 0),
      ),
    );
    const timeZone = this.normalizeParticipantImmunityTimezone(settings?.nightModeTimezone ?? null);
    const [violationCountRows, immunityRows] = await Promise.all([
      participantUserIds.length > 0
        ? this.prisma.moderationEvent.groupBy({
            by: ['userId'],
            where: this.buildParticipantViolationCountWhere(chatId, participantUserIds, from, now),
            _count: { _all: true },
          })
        : Promise.resolve([]),
      participantUserIds.length > 0
        ? this.prisma.chatParticipantModerationImmunity.findMany({
            where: {
              chatId,
              userId: { in: participantUserIds },
              expiresAt: {
                gt: now,
              },
            },
          })
        : Promise.resolve([]),
    ]);
    const violationCountByUserId = new Map<string, number>();
    const immunityByUserId = new Map<string, ChatParticipantImmunity>();

    for (const row of violationCountRows) {
      const normalizedUserId = row.userId.trim();
      if (!normalizedUserId) {
        continue;
      }

      violationCountByUserId.set(normalizedUserId, this.toSafeInteger(row._count._all));
    }

    for (const immunity of immunityRows) {
      const normalizedUserId = immunity.userId.trim();
      if (!normalizedUserId) {
        continue;
      }

      const summary = this.buildChatParticipantImmunitySummary(immunity, now, timeZone);
      if (!summary) {
        continue;
      }

      immunityByUserId.set(normalizedUserId, summary);
    }

    return chatParticipantsPageSchema.parse({
      items: membersPage.items.map((member) => {
        const normalizedUsername = member.username?.replace(/^@+/u, '').trim() ?? '';
        const userDisplayName =
          member.displayName?.trim() ||
          normalizedUsername ||
          (member.isBot ? 'Бот MAX' : 'Участник');

        return {
          userId: member.userId,
          userDisplayName,
          username: normalizedUsername || null,
          avatarUrl: this.readTrimmedString(member.avatarUrl) ?? null,
          profileUrl:
            this.normalizeMaxProfileUrl(this.readTrimmedString(member.profileUrl) ?? null) ??
            this.buildUserProfileUrl(normalizedUsername || null),
          profileHandoffUrl: this.buildProfileMentionHandoffUrl(
            chatId,
            entityType,
            member.userId,
            userDisplayName,
            resolvedBotId,
          ),
          violationCount: violationCountByUserId.get(member.userId.trim()) ?? 0,
          immunity: immunityByUserId.get(member.userId.trim()) ?? null,
          role: this.mapChatMemberRole(member.role),
          isBot: member.isBot,
        } satisfies ChatParticipantItem;
      }),
      totalCount:
        typeof header.participantsCount === 'number' && Number.isFinite(header.participantsCount)
          ? Math.max(0, Math.trunc(header.participantsCount))
          : null,
      hasMore: Boolean(membersPage.nextMarker),
      nextCursor: membersPage.nextMarker,
    });
  }

  private loadChatParticipantsMembersPage(
    chatId: string,
    limit: number,
    marker: string | null,
    resolvedBotId: string | null,
    options: {
      search?: boolean;
    } = {},
  ): Promise<{ items: MaxChatRosterMember[]; nextMarker: string | null }> {
    return this.maxClient.getChatMembersPage(
      chatId,
      {
        limit,
        marker,
      },
      {
        trafficClass: 'interactive',
        actionHealthLane: 'background',
        ...(options.search
          ? {
              sourceTag: MAX_API_SOURCE_TAGS.PARTICIPANT_SEARCH,
              timeoutMs: CHAT_PARTICIPANTS_SEARCH_MAX_API_WAIT_MS,
            }
          : {}),
        ignoreFailureMetricStatuses: ADMIN_FALLBACK_READ_FAILURE_METRIC_STATUSES,
        ...(resolvedBotId ? { botId: resolvedBotId } : {}),
      },
    );
  }

  private isTerminalChatParticipantsRosterAccessError(error: unknown): boolean {
    const code = this.extractMaxApiErrorCode(error);
    if (code === 'chat.denied' || code === 'chat.not.found' || code === 'account.blocked') {
      return true;
    }

    const status = this.extractHttpStatusCode(error);
    return status === 403 || status === 404;
  }

  private extractHttpStatusCode(error: unknown): number | null {
    const status = (error as { response?: { status?: unknown } })?.response?.status;
    if (typeof status === 'number' && Number.isFinite(status)) {
      return status;
    }

    const directStatus = (error as { status?: unknown })?.status;
    return typeof directStatus === 'number' && Number.isFinite(directStatus) ? directStatus : null;
  }

  private extractMaxApiErrorCode(error: unknown): string | null {
    const code = (error as { response?: { data?: { code?: unknown } } })?.response?.data?.code;
    return typeof code === 'string' && code.trim().length > 0 ? code.trim().toLowerCase() : null;
  }

  private async searchChatParticipantsMembersPage(
    chatId: string,
    query: ChatParticipantsQuery,
    search: string,
    resolvedBotId: string | null,
  ): Promise<{ items: MaxChatRosterMember[]; nextMarker: string | null }> {
    const limit = Math.max(1, Math.min(100, query.limit));
    const cursor = this.decodeChatParticipantsSearchCursor(query.cursor, search);
    const items: MaxChatRosterMember[] = [];
    let marker = cursor?.marker ?? null;
    let skip = cursor?.skip ?? 0;
    let scannedRemotePages = 0;

    while (true) {
      const currentMarker = marker;
      let membersPage: { items: MaxChatRosterMember[]; nextMarker: string | null };
      try {
        membersPage = await this.loadChatParticipantsMembersPage(
          chatId,
          100,
          currentMarker,
          resolvedBotId,
          { search: true },
        );
      } catch (error: unknown) {
        if (!this.isTransientChatParticipantsSearchError(error)) {
          throw error;
        }

        this.logger.log(
          {
            chatId,
            marker: currentMarker,
            itemsReturned: items.length,
            scannedRemotePages,
            err: error instanceof Error ? error.message : String(error),
          },
          'Paused participant search page scan after MAX API throttling or timeout',
        );
        return {
          items,
          nextMarker: this.encodeChatParticipantsSearchCursor({
            marker: currentMarker,
            skip,
            search,
          }),
        };
      }
      scannedRemotePages += 1;
      const matches = membersPage.items.filter((member) =>
        this.chatParticipantMatchesSearch(member, search),
      );
      let matchIndex = 0;

      if (skip > 0) {
        matchIndex = Math.min(skip, matches.length);
        skip -= matchIndex;
      }

      if (skip > 0) {
        if (!membersPage.nextMarker) {
          return {
            items,
            nextMarker: null,
          };
        }

        marker = membersPage.nextMarker;
        if (scannedRemotePages >= CHAT_PARTICIPANTS_SEARCH_REMOTE_PAGES_PER_RESPONSE) {
          return {
            items,
            nextMarker: this.encodeChatParticipantsSearchCursor({
              marker,
              skip,
              search,
            }),
          };
        }

        continue;
      }

      for (; matchIndex < matches.length; matchIndex += 1) {
        if (items.length >= limit) {
          return {
            items,
            nextMarker: this.encodeChatParticipantsSearchCursor({
              marker: currentMarker,
              skip: matchIndex,
              search,
            }),
          };
        }

        items.push(matches[matchIndex]);
      }

      if (items.length >= limit) {
        return {
          items,
          nextMarker: membersPage.nextMarker
            ? this.encodeChatParticipantsSearchCursor({
                marker: membersPage.nextMarker,
                skip: 0,
                search,
              })
            : null,
        };
      }

      if (!membersPage.nextMarker) {
        return {
          items,
          nextMarker: null,
        };
      }

      marker = membersPage.nextMarker;
      skip = 0;

      if (scannedRemotePages >= CHAT_PARTICIPANTS_SEARCH_REMOTE_PAGES_PER_RESPONSE) {
        return {
          items,
          nextMarker: this.encodeChatParticipantsSearchCursor({
            marker,
            skip,
            search,
          }),
        };
      }
    }
  }

  private chatParticipantMatchesSearch(member: MaxChatRosterMember, search: string): boolean {
    const username = member.username?.replace(/^@+/u, '').trim() ?? '';
    const candidates = [
      member.displayName ?? '',
      username,
      username ? `@${username}` : '',
      member.userId,
    ];

    return candidates.some((candidate) =>
      this.normalizeChatParticipantsSearchText(candidate).includes(search),
    );
  }

  private isTransientChatParticipantsSearchError(error: unknown): boolean {
    return isMaxApiThrottleError(error) || isMaxApiTimeoutError(error);
  }

  private normalizeChatParticipantsSearchText(value: string): string {
    const normalized = value
      .normalize('NFKC')
      .trim()
      .replace(/\s+/gu, ' ')
      .toLocaleLowerCase('ru-RU');
    const withoutMentionPrefix = normalized.replace(/^@+/u, '');
    return withoutMentionPrefix || normalized;
  }

  private encodeChatParticipantsSearchCursor(cursor: ChatParticipantsSearchCursor): string {
    return Buffer.from(
      JSON.stringify({
        v: 1,
        marker: cursor.marker,
        skip: cursor.skip,
        search: cursor.search,
      }),
      'utf8',
    ).toString('base64url');
  }

  private decodeChatParticipantsSearchCursor(
    value: string | undefined,
    search: string,
  ): ChatParticipantsSearchCursor | null {
    if (!value) {
      return null;
    }

    try {
      const decoded = Buffer.from(value, 'base64url').toString('utf8');
      const parsed = JSON.parse(decoded) as Record<string, unknown>;
      const marker =
        typeof parsed.marker === 'string' && parsed.marker.trim()
          ? parsed.marker.trim()
          : parsed.marker === null
            ? null
            : null;
      const skip =
        typeof parsed.skip === 'number' && Number.isFinite(parsed.skip)
          ? Math.max(0, Math.trunc(parsed.skip))
          : 0;
      const cursorSearch =
        typeof parsed.search === 'string'
          ? this.normalizeChatParticipantsSearchText(parsed.search)
          : '';

      if (parsed.v !== 1 || cursorSearch !== search) {
        throw new Error('Invalid chat participants search cursor');
      }

      return {
        marker,
        skip,
        search,
      };
    } catch {
      throw new BadRequestException('Неверный cursor для поиска участников.');
    }
  }

  private async getCachedChatParticipantsPage(
    chatId: string,
    userId: string,
    query: ChatParticipantsQuery,
    entityType: ManagedEntityType,
  ): Promise<ChatParticipantsPage> {
    const cacheKey = buildChatParticipantsPageCacheKey(chatId, userId, entityType, query);
    const cached = this.chatParticipantsPageCache.get(cacheKey);
    if (cached && cached.expiresAtMs > Date.now()) {
      return cached.promise;
    }

    const pending = this.buildChatParticipantsPage(chatId, userId, query, entityType).catch(
      (error: unknown) => {
        const current = this.chatParticipantsPageCache.get(cacheKey);
        if (current?.promise === pending) {
          this.chatParticipantsPageCache.delete(cacheKey);
        }
        throw error;
      },
    );

    this.chatParticipantsPageCache.set(cacheKey, {
      expiresAtMs: Date.now() + EVENTS_FEED_PAGE_CACHE_TTL_MS,
      promise: pending,
    });

    return pending;
  }

  private mapChatMemberRole(role: MaxChatMemberRole): ChatParticipantItem['role'] {
    if (role === 'owner' || role === 'admin') {
      return role;
    }

    return 'member';
  }

  private normalizeParticipantImmunityTimezone(value: string | null | undefined): string {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized) {
      return DEFAULT_PARTICIPANT_IMMUNITY_TIMEZONE;
    }

    try {
      Intl.DateTimeFormat('ru-RU', { timeZone: normalized }).format(new Date());
      return normalized;
    } catch {
      return DEFAULT_PARTICIPANT_IMMUNITY_TIMEZONE;
    }
  }

  private formatParticipantImmunityDateKey(date: Date, timeZone: string): string {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(date);
      const year = parts.find((item) => item.type === 'year')?.value;
      const month = parts.find((item) => item.type === 'month')?.value;
      const day = parts.find((item) => item.type === 'day')?.value;
      if (!year || !month || !day) {
        return date.toISOString().slice(0, 10);
      }

      return `${year}-${month}-${day}`;
    } catch {
      return date.toISOString().slice(0, 10);
    }
  }

  private buildChatParticipantImmunitySummary(
    immunity: {
      expiresAt: Date;
      dailyViolationLimit: number;
      dailyViolationUsage: number;
      usageDateKey: string | null;
    },
    now: Date,
    timeZone: string,
  ): ChatParticipantImmunity | null {
    if (!(immunity.expiresAt instanceof Date) || !Number.isFinite(immunity.expiresAt.getTime())) {
      return null;
    }

    if (immunity.expiresAt.getTime() <= now.getTime()) {
      return null;
    }

    const todayKey = this.formatParticipantImmunityDateKey(now, timeZone);
    const dailyViolationLimit = Math.max(
      1,
      Math.min(10, this.toSafeInteger(immunity.dailyViolationLimit)),
    );
    const usedViolatingMessagesToday =
      immunity.usageDateKey === todayKey ? this.toSafeInteger(immunity.dailyViolationUsage) : 0;

    return chatParticipantImmunitySchema.parse({
      expiresAt: immunity.expiresAt.toISOString(),
      dailyViolationLimit,
      usedViolatingMessagesToday,
      remainingViolatingMessagesToday: Math.max(
        0,
        dailyViolationLimit - usedViolatingMessagesToday,
      ),
    });
  }

  private async assertTargetUserCanReceiveParticipantImmunity(
    chatId: string,
    targetUserId: string,
    botId?: string,
  ): Promise<void> {
    const maxClientWithMemberAccess = this.maxClient as {
      getChatMemberAccess?: (
        chatId: string,
        userId: string,
        options?: {
          actionHealthLane?: string;
          botId?: string;
          trafficClass?: 'critical' | 'interactive' | 'background';
          timeoutMs?: number;
        },
      ) => Promise<MaxChatMemberAccess | null>;
    };
    if (typeof maxClientWithMemberAccess.getChatMemberAccess !== 'function') {
      return;
    }

    const targetAccess = await maxClientWithMemberAccess.getChatMemberAccess(chatId, targetUserId, {
      actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
      ...(botId ? { botId } : {}),
    });
    if (!targetAccess) {
      throw new BadRequestException('Пользователь уже не состоит в этом чате.');
    }

    if (targetAccess.isOwner || targetAccess.isAdmin) {
      throw new BadRequestException('Иммунитет можно выдать только обычному участнику.');
    }
  }
}
