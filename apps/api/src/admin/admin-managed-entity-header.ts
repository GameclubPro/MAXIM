import type { ManagedEntityHeader, ManagedEntityType } from '@maxim/contracts';
import type { Logger } from '@nestjs/common';
import type { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import type { MaxClientService } from '../max/max-client.service';
import type { PrismaService } from '../prisma/prisma.service';
import { isFallbackTitle, readTrimmedString } from './admin-legacy-utils';
import {
  ADMIN_FALLBACK_READ_FAILURE_METRIC_STATUSES,
  type AdminReadBypassOptions,
} from './admin.service.support';

type ManagedEntityHeaderPrisma = Pick<PrismaService, 'chat'>;

type ManagedEntityHeaderCache = Pick<
  ChatContextCacheService,
  'getManagedEntityHeader' | 'setManagedEntityHeader'
>;

function createManagedEntityHeader(params: {
  id: string;
  title: string;
  entityType: ManagedEntityType;
  link?: string | null;
  participantsCount?: number | null;
  avatarUrl?: string | null;
  primaryBotId?: string | null;
  assignedBots?: ManagedEntityHeader['assignedBots'];
  sharedMode?: ManagedEntityHeader['sharedMode'];
}): ManagedEntityHeader {
  const assignedBots = [...(params.assignedBots ?? [])];
  return {
    id: params.id,
    title: params.title,
    entityType: params.entityType,
    link: params.link ?? null,
    participantsCount: params.participantsCount ?? null,
    ...(readTrimmedString(params.avatarUrl) ? { avatarUrl: params.avatarUrl } : {}),
    primaryBotId: readTrimmedString(params.primaryBotId) ?? null,
    assignedBots,
    sharedMode: params.sharedMode ?? (assignedBots.length > 1 ? 'shared-standby' : 'owned'),
    accessDiagnostics: {
      state: 'ok',
      lastDetectedAt: null,
      lostBots: [],
    },
  };
}

function isManagedEntityHeaderStale(
  header: ManagedEntityHeader | null,
  options: {
    refreshMissingLink?: boolean;
  } = {},
): boolean {
  if (!header) {
    return true;
  }

  return (
    isFallbackTitle(header.id, header.title) ||
    !readTrimmedString(header.avatarUrl) ||
    (options.refreshMissingLink === true && !readTrimmedString(header.link))
  );
}

export async function getManagedEntityHeaderValue(params: {
  prisma: ManagedEntityHeaderPrisma;
  chatContextCache: ManagedEntityHeaderCache;
  maxClient: Pick<MaxClientService, 'getChatSnapshot'>;
  logger: Pick<Logger, 'warn'>;
  chatId: string;
  entityType: ManagedEntityType;
  options?: AdminReadBypassOptions;
  assertReadAccess: (options: AdminReadBypassOptions) => Promise<void>;
  resolveReadBotId: () => Promise<string | undefined> | string | undefined;
  attachBotAssignments: (header: ManagedEntityHeader) => Promise<ManagedEntityHeader>;
}): Promise<ManagedEntityHeader> {
  await params.assertReadAccess(params.options ?? {});

  const cached = await params.chatContextCache.getManagedEntityHeader?.(
    params.chatId,
    params.entityType,
  );
  if (
    cached &&
    !isManagedEntityHeaderStale(cached, {
      refreshMissingLink: params.entityType === 'channel',
    })
  ) {
    return params.attachBotAssignments(cached);
  }

  const persistedChat = await params.prisma.chat.findUnique({
    where: { id: params.chatId },
    select: {
      id: true,
      title: true,
    },
  });

  try {
    const resolvedBotId = await params.resolveReadBotId();
    const snapshot = await params.maxClient.getChatSnapshot(params.chatId, {
      trafficClass: 'interactive',
      actionHealthLane: 'background',
      ignoreFailureMetricStatuses: ADMIN_FALLBACK_READ_FAILURE_METRIC_STATUSES,
      ...(resolvedBotId ? { botId: resolvedBotId } : {}),
    });
    const title = snapshot.title?.trim() || persistedChat?.title?.trim() || params.chatId;

    if (
      persistedChat &&
      title &&
      title !== persistedChat.title &&
      !isFallbackTitle(params.chatId, title)
    ) {
      await params.prisma.chat.update({
        where: { id: params.chatId },
        data: { title },
      });
    }

    const header = createManagedEntityHeader({
      id: params.chatId,
      title,
      entityType: params.entityType,
      link: snapshot.link,
      participantsCount: snapshot.participantsCount,
      avatarUrl: snapshot.avatarUrl,
    });
    const enrichedHeader = await params.attachBotAssignments(header);
    await params.chatContextCache.setManagedEntityHeader?.(enrichedHeader);
    return enrichedHeader;
  } catch (error: unknown) {
    params.logger.warn(
      {
        chatId: params.chatId,
        entityType: params.entityType,
        err: error instanceof Error ? error.message : String(error),
      },
      'Failed to load managed entity header snapshot from MAX API',
    );
  }

  if (cached) {
    return params.attachBotAssignments(cached);
  }

  const fallbackHeader = createManagedEntityHeader({
    id: params.chatId,
    title: persistedChat?.title?.trim() || params.chatId,
    entityType: params.entityType,
    link: null,
    participantsCount: null,
    avatarUrl: null,
  });
  const enrichedHeader = await params.attachBotAssignments(fallbackHeader);
  await params.chatContextCache.setManagedEntityHeader?.(enrichedHeader);
  return enrichedHeader;
}
