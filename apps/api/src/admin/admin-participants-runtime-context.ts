import type { Logger } from '@nestjs/common';
import type {
  ChatParticipantsPage,
  ChatParticipantsQuery,
  ManagedEntityHeader,
  ManagedEntityType,
} from '@maxim/contracts';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import type { MaxClientService } from '../max/max-client.service';
import type { Prisma } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { AdminReadBypassOptions, TimedPromiseCacheEntry } from './admin.service.support';

export type PrepareManualModerationTargetOptions = {
  skipActorAdminCheck?: boolean;
};

export type AdminParticipantsRuntimeContext = {
  readonly prisma: PrismaService;
  readonly maxClient: MaxClientService;
  readonly logger: Logger;
  readonly chatParticipantsPageCache: Map<
    string,
    TimedPromiseCacheEntry<ChatParticipantsPage>
  >;
  assertReadOnlyChatAdmin(
    chatId: string,
    userId: string,
    entityType?: ManagedEntityType | null,
    options?: {
      forceRemote?: boolean;
      timeoutMs?: number;
    },
  ): Promise<void>;
  buildParticipantViolationCountWhere(
    chatId: string,
    userIds: readonly string[],
    from: Date,
    to: Date,
  ): Prisma.ModerationEventWhereInput;
  buildProfileMentionHandoffUrl(
    chatId: string,
    entityType: ManagedEntityType,
    userId: string,
    displayName: string | null,
  ): string | null;
  buildUserProfileUrl(username: string | null): string | null;
  ensureEntityType(
    chatId: string,
    userId: string,
    expectedEntityType: ManagedEntityType,
  ): Promise<void>;
  getManagedEntityHeader(
    chatId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
    options?: AdminReadBypassOptions,
  ): Promise<ManagedEntityHeader>;
  normalizeMaxProfileUrl(value: string | null): string | null;
  prepareManualModerationTarget(
    chatId: string,
    targetUserIdRaw: string,
    user: AuthUser,
    options?: PrepareManualModerationTargetOptions,
  ): Promise<string>;
  readTrimmedString(value: unknown): string | null;
  resolveBackgroundReadBotAssignment(chatId: string): Promise<string | undefined>;
  resolveLogsDashboardFrom(range: ChatParticipantsQuery['range'], to: Date): Date;
  toSafeInteger(value: unknown): number;
};

type AdminParticipantsRuntimeContextTarget = AdminParticipantsRuntimeContext;

export function createAdminParticipantsRuntimeContext(
  target: object,
): AdminParticipantsRuntimeContext {
  const typedTarget = target as AdminParticipantsRuntimeContextTarget;

  return {
    get prisma(): PrismaService {
      return typedTarget.prisma;
    },
    get maxClient(): MaxClientService {
      return typedTarget.maxClient;
    },
    get logger(): Logger {
      return typedTarget.logger;
    },
    get chatParticipantsPageCache(): Map<
      string,
      TimedPromiseCacheEntry<ChatParticipantsPage>
    > {
      return typedTarget.chatParticipantsPageCache;
    },
    assertReadOnlyChatAdmin(
      chatId: string,
      userId: string,
      entityType?: ManagedEntityType | null,
      options?: {
        forceRemote?: boolean;
        timeoutMs?: number;
      },
    ): Promise<void> {
      return typedTarget.assertReadOnlyChatAdmin(chatId, userId, entityType, options);
    },
    buildParticipantViolationCountWhere(
      chatId: string,
      userIds: readonly string[],
      from: Date,
      to: Date,
    ): Prisma.ModerationEventWhereInput {
      return typedTarget.buildParticipantViolationCountWhere(chatId, userIds, from, to);
    },
    buildProfileMentionHandoffUrl(
      chatId: string,
      entityType: ManagedEntityType,
      userId: string,
      displayName: string | null,
    ): string | null {
      return typedTarget.buildProfileMentionHandoffUrl(chatId, entityType, userId, displayName);
    },
    buildUserProfileUrl(username: string | null): string | null {
      return typedTarget.buildUserProfileUrl(username);
    },
    ensureEntityType(
      chatId: string,
      userId: string,
      expectedEntityType: ManagedEntityType,
    ): Promise<void> {
      return typedTarget.ensureEntityType(chatId, userId, expectedEntityType);
    },
    getManagedEntityHeader(
      chatId: string,
      user: AuthUser,
      entityType: ManagedEntityType,
      options?: AdminReadBypassOptions,
    ): Promise<ManagedEntityHeader> {
      return typedTarget.getManagedEntityHeader(chatId, user, entityType, options);
    },
    normalizeMaxProfileUrl(value: string | null): string | null {
      return typedTarget.normalizeMaxProfileUrl(value);
    },
    prepareManualModerationTarget(
      chatId: string,
      targetUserIdRaw: string,
      user: AuthUser,
      options?: PrepareManualModerationTargetOptions,
    ): Promise<string> {
      return typedTarget.prepareManualModerationTarget(chatId, targetUserIdRaw, user, options);
    },
    readTrimmedString(value: unknown): string | null {
      return typedTarget.readTrimmedString(value);
    },
    resolveBackgroundReadBotAssignment(chatId: string): Promise<string | undefined> {
      return typedTarget.resolveBackgroundReadBotAssignment(chatId);
    },
    resolveLogsDashboardFrom(range: ChatParticipantsQuery['range'], to: Date): Date {
      return typedTarget.resolveLogsDashboardFrom(range, to);
    },
    toSafeInteger(value: unknown): number {
      return typedTarget.toSafeInteger(value);
    },
  };
}
