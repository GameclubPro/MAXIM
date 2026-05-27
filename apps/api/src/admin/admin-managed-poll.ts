import {
  managedPollSchema,
  updateManagedPollRequestSchema,
  type ManagedEntityType,
  type ManagedPoll,
} from '@maxim/contracts';
import { BadRequestException } from '@nestjs/common';
import type { Logger } from '@nestjs/common';
import type { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import {
  buildManagedPollButtons,
  buildManagedPollMessageText,
  buildManagedPollOptionSummaries,
  normalizeManagedPollDraft,
  validateManagedPollForPublish,
} from '../common/managed-poll.util';
import type { MaxClientService } from '../max/max-client.service';
import {
  ManagedPollStatus as PrismaManagedPollStatus,
  Prisma,
  type ManagedPoll as PersistedManagedPoll,
} from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  extractMaxApiErrorMessage,
  normalizePublishedRulesUrl,
} from './admin-chat-rules';
import { shouldRecreateEditableMessage } from './admin-editable-message';
import {
  MANAGED_POLL_ACTION_CLOSE,
  MANAGED_POLL_ACTION_PUBLISH,
  MANAGED_POLL_ACTION_UPDATE,
  type AdminActionSource,
} from './admin.service.support';

type ManagedPollMaxClient = Pick<
  MaxClientService,
  'editMessageInlineKeyboard' | 'resolveMessageLink' | 'sendMessageImmediateWithResolvedLink'
>;

function readManagedPollOptions(value: Prisma.JsonValue): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === 'string');
}

async function ensureManagedPoll(params: {
  prisma: PrismaService;
  chatId: string;
}): Promise<PersistedManagedPoll> {
  return params.prisma.managedPoll.upsert({
    where: { chatId: params.chatId },
    create: {
      chatId: params.chatId,
    },
    update: {},
  });
}

async function loadManagedPollVoteCounts(params: {
  prisma: PrismaService;
  pollId: string;
  pollVersion: number;
  optionCount: number;
}): Promise<number[]> {
  const counts = Array.from({ length: params.optionCount }, () => 0);
  const votes = await params.prisma.managedPollVote.groupBy({
    where: {
      pollId: params.pollId,
      pollVersion: params.pollVersion,
    },
    by: ['optionIndex'],
    _count: {
      _all: true,
    },
  });

  for (const vote of votes) {
    if (vote.optionIndex >= 0 && vote.optionIndex < counts.length) {
      counts[vote.optionIndex] = vote._count._all;
    }
  }

  return counts;
}

export async function mapManagedPoll(params: {
  prisma: PrismaService;
  poll: PersistedManagedPoll;
}): Promise<ManagedPoll> {
  const normalizedDraft = normalizeManagedPollDraft(
    params.poll.question,
    readManagedPollOptions(params.poll.options),
  );
  const voteCounts =
    params.poll.status === PrismaManagedPollStatus.ACTIVE ||
    params.poll.status === PrismaManagedPollStatus.CLOSED
      ? await loadManagedPollVoteCounts({
          prisma: params.prisma,
          pollId: params.poll.id,
          pollVersion: params.poll.activeVersion,
          optionCount: normalizedDraft.options.length,
        })
      : normalizedDraft.options.map(() => 0);
  const summary = buildManagedPollOptionSummaries(normalizedDraft.options, voteCounts);

  return managedPollSchema.parse({
    question: normalizedDraft.question,
    options: normalizedDraft.options,
    status: params.poll.status,
    activeVersion: params.poll.activeVersion,
    publishedMessageId: params.poll.publishedMessageId?.trim() || null,
    publishedUrl: normalizePublishedRulesUrl(params.poll.publishedUrl),
    publishedAt: params.poll.publishedAt ? params.poll.publishedAt.toISOString() : null,
    closedAt: params.poll.closedAt ? params.poll.closedAt.toISOString() : null,
    totalVotes: summary.totalVotes,
    optionResults: summary.optionResults,
  });
}

async function hydrateManagedPollPublishedUrl(params: {
  prisma: PrismaService;
  chatContextCache: Pick<ChatContextCacheService, 'invalidate'>;
  maxClient: Pick<MaxClientService, 'resolveMessageLink'>;
  logger: Pick<Logger, 'warn'>;
  chatId: string;
  poll: PersistedManagedPoll;
  resolveReadBotId: () => Promise<string | undefined> | string | undefined;
}): Promise<PersistedManagedPoll> {
  const currentUrl = normalizePublishedRulesUrl(params.poll.publishedUrl);
  if (currentUrl || !params.poll.publishedMessageId?.trim()) {
    return {
      ...params.poll,
      publishedUrl: currentUrl,
    };
  }

  let resolvedUrl: string | null = null;
  try {
    const resolvedBotId = await params.resolveReadBotId();
    resolvedUrl = normalizePublishedRulesUrl(
      resolvedBotId
        ? await params.maxClient.resolveMessageLink(params.poll.publishedMessageId, {
            botId: resolvedBotId,
          })
        : await params.maxClient.resolveMessageLink(params.poll.publishedMessageId),
    );
  } catch (error: unknown) {
    params.logger.warn(
      {
        chatId: params.chatId,
        messageId: params.poll.publishedMessageId,
        err: error instanceof Error ? error.message : String(error),
      },
      'Failed to recover published managed poll url',
    );
    return params.poll;
  }

  if (!resolvedUrl) {
    return params.poll;
  }

  await params.prisma.managedPoll.update({
    where: { chatId: params.chatId },
    data: {
      publishedUrl: resolvedUrl,
    },
  });
  await params.chatContextCache.invalidate(params.chatId);

  return {
    ...params.poll,
    publishedUrl: resolvedUrl,
  };
}

export async function readManagedPoll(params: {
  prisma: PrismaService;
  chatContextCache: Pick<ChatContextCacheService, 'invalidate'>;
  maxClient: Pick<MaxClientService, 'resolveMessageLink'>;
  logger: Pick<Logger, 'warn'>;
  chatId: string;
  resolveReadBotId: () => Promise<string | undefined> | string | undefined;
}): Promise<ManagedPoll> {
  const poll = await ensureManagedPoll({
    prisma: params.prisma,
    chatId: params.chatId,
  });
  const hydrated = await hydrateManagedPollPublishedUrl({
    prisma: params.prisma,
    chatContextCache: params.chatContextCache,
    maxClient: params.maxClient,
    logger: params.logger,
    chatId: params.chatId,
    poll,
    resolveReadBotId: params.resolveReadBotId,
  });
  return mapManagedPoll({
    prisma: params.prisma,
    poll: hydrated,
  });
}

export async function saveManagedPollDraft(params: {
  prisma: PrismaService;
  chatContextCache: Pick<ChatContextCacheService, 'invalidate'>;
  chatId: string;
  actorUserId: string;
  entityType: ManagedEntityType;
  body: unknown;
  source: AdminActionSource;
}): Promise<ManagedPoll> {
  const parsed = updateManagedPollRequestSchema.safeParse(params.body);
  if (!parsed.success) {
    throw new BadRequestException(parsed.error.format());
  }

  const current = await ensureManagedPoll({
    prisma: params.prisma,
    chatId: params.chatId,
  });
  if (current.status === PrismaManagedPollStatus.ACTIVE) {
    throw new BadRequestException('Сначала закройте активный опрос.');
  }

  const normalizedDraft = normalizeManagedPollDraft(parsed.data.question, parsed.data.options);
  const currentDraft = normalizeManagedPollDraft(
    current.question,
    readManagedPollOptions(current.options),
  );
  const hasChanges =
    normalizedDraft.question !== currentDraft.question ||
    normalizedDraft.options.length !== currentDraft.options.length ||
    normalizedDraft.options.some((option, index) => option !== currentDraft.options[index]);

  const updated = await params.prisma.managedPoll.update({
    where: { chatId: params.chatId },
    data: {
      question: normalizedDraft.question,
      options: normalizedDraft.options as Prisma.InputJsonValue,
      ...(current.status === PrismaManagedPollStatus.CLOSED && hasChanges
        ? {
            status: PrismaManagedPollStatus.DRAFT,
            publishedMessageId: null,
            publishedUrl: null,
            publishedAt: null,
            closedAt: null,
          }
        : {}),
    },
  });

  await params.prisma.auditLog.create({
    data: {
      chatId: params.chatId,
      actorUserId: params.actorUserId,
      action: MANAGED_POLL_ACTION_UPDATE,
      payload: {
        entityType: params.entityType,
        questionLength: normalizedDraft.question.length,
        optionsCount: normalizedDraft.options.length,
        statusBefore: current.status,
        statusAfter:
          current.status === PrismaManagedPollStatus.CLOSED && hasChanges
            ? PrismaManagedPollStatus.DRAFT
            : current.status,
        source: params.source,
      },
    },
  });
  await params.chatContextCache.invalidate(params.chatId);

  return mapManagedPoll({
    prisma: params.prisma,
    poll: updated,
  });
}

export async function publishManagedPoll(params: {
  prisma: PrismaService;
  chatContextCache: Pick<ChatContextCacheService, 'invalidate'>;
  maxClient: Pick<MaxClientService, 'sendMessageImmediateWithResolvedLink'>;
  chatId: string;
  actorUserId: string;
  entityType: ManagedEntityType;
  source: AdminActionSource;
  resolveBotId: () => Promise<string | undefined> | string | undefined;
}): Promise<ManagedPoll> {
  const current = await ensureManagedPoll({
    prisma: params.prisma,
    chatId: params.chatId,
  });
  if (current.status === PrismaManagedPollStatus.ACTIVE && current.publishedMessageId?.trim()) {
    throw new BadRequestException('Сначала закройте активный опрос.');
  }

  let normalizedDraft: { question: string; options: string[] };
  try {
    normalizedDraft = validateManagedPollForPublish(
      current.question,
      readManagedPollOptions(current.options),
    );
  } catch (error: unknown) {
    throw new BadRequestException(
      error instanceof Error ? error.message : 'Опрос заполнен некорректно.',
    );
  }

  const nextVersion = Math.max(0, current.activeVersion) + 1;
  const zeroResults = buildManagedPollOptionSummaries(
    normalizedDraft.options,
    normalizedDraft.options.map(() => 0),
  );
  const buttons = buildManagedPollButtons(
    current.id,
    nextVersion,
    normalizedDraft.options,
    zeroResults.optionResults,
  );
  const messageText = buildManagedPollMessageText(
    normalizedDraft.question,
    zeroResults.optionResults,
    'ACTIVE',
  );
  const resolvedBotId = await params.resolveBotId();

  let published: { messageId: string; url: string | null };
  try {
    published = resolvedBotId
      ? await params.maxClient.sendMessageImmediateWithResolvedLink(
          params.chatId,
          messageText,
          {
            buttons,
          },
          { botId: resolvedBotId },
        )
      : await params.maxClient.sendMessageImmediateWithResolvedLink(params.chatId, messageText, {
          buttons,
        });
  } catch (error: unknown) {
    const maxApiMessage = extractMaxApiErrorMessage(error);
    throw new BadRequestException(maxApiMessage || 'Не удалось опубликовать опрос.');
  }

  const publishedAt = new Date();
  const updated = await params.prisma.managedPoll.update({
    where: { chatId: params.chatId },
    data: {
      question: normalizedDraft.question,
      options: normalizedDraft.options as Prisma.InputJsonValue,
      status: PrismaManagedPollStatus.ACTIVE,
      activeVersion: nextVersion,
      publishedMessageId: published.messageId,
      publishedUrl: normalizePublishedRulesUrl(published.url),
      publishedAt,
      closedAt: null,
    },
  });

  await params.prisma.auditLog.create({
    data: {
      chatId: params.chatId,
      actorUserId: params.actorUserId,
      action: MANAGED_POLL_ACTION_PUBLISH,
      payload: {
        entityType: params.entityType,
        messageId: published.messageId,
        url: published.url,
        questionLength: normalizedDraft.question.length,
        optionsCount: normalizedDraft.options.length,
        activeVersion: nextVersion,
        source: params.source,
      },
    },
  });
  await params.chatContextCache.invalidate(params.chatId);

  return mapManagedPoll({
    prisma: params.prisma,
    poll: updated,
  });
}

export async function closeManagedPoll(params: {
  prisma: PrismaService;
  chatContextCache: Pick<ChatContextCacheService, 'invalidate'>;
  maxClient: ManagedPollMaxClient;
  chatId: string;
  actorUserId: string;
  entityType: ManagedEntityType;
  source: AdminActionSource;
  resolveBotId: () => Promise<string | undefined> | string | undefined;
}): Promise<ManagedPoll> {
  const current = await ensureManagedPoll({
    prisma: params.prisma,
    chatId: params.chatId,
  });
  const publishedMessageId = current.publishedMessageId?.trim() ?? '';
  if (current.status !== PrismaManagedPollStatus.ACTIVE || !publishedMessageId) {
    throw new BadRequestException('Активного опроса нет.');
  }

  const normalizedDraft = normalizeManagedPollDraft(
    current.question,
    readManagedPollOptions(current.options),
  );
  const voteCounts = await loadManagedPollVoteCounts({
    prisma: params.prisma,
    pollId: current.id,
    pollVersion: current.activeVersion,
    optionCount: normalizedDraft.options.length,
  });
  const summary = buildManagedPollOptionSummaries(normalizedDraft.options, voteCounts);
  const messageText = buildManagedPollMessageText(
    normalizedDraft.question,
    summary.optionResults,
    'CLOSED',
  );
  const resolvedBotId = await params.resolveBotId();
  let nextPublishedMessageId = publishedMessageId;
  let nextPublishedUrl = normalizePublishedRulesUrl(current.publishedUrl);
  let recreatedFromMessageId: string | null = null;

  try {
    if (resolvedBotId) {
      await params.maxClient.editMessageInlineKeyboard(
        params.chatId,
        publishedMessageId,
        messageText,
        undefined,
        { botId: resolvedBotId },
      );
    } else {
      await params.maxClient.editMessageInlineKeyboard(
        params.chatId,
        publishedMessageId,
        messageText,
      );
    }
  } catch (error: unknown) {
    if (!shouldRecreateEditableMessage(error)) {
      const maxApiMessage = extractMaxApiErrorMessage(error);
      throw new BadRequestException(maxApiMessage || 'Не удалось закрыть опрос.');
    }

    recreatedFromMessageId = publishedMessageId;
    try {
      const recreated = resolvedBotId
        ? await params.maxClient.sendMessageImmediateWithResolvedLink(
            params.chatId,
            messageText,
            undefined,
            {
              botId: resolvedBotId,
            },
          )
        : await params.maxClient.sendMessageImmediateWithResolvedLink(params.chatId, messageText);
      nextPublishedMessageId = recreated.messageId;
      nextPublishedUrl = normalizePublishedRulesUrl(recreated.url);
    } catch (recreateError: unknown) {
      const maxApiMessage = extractMaxApiErrorMessage(recreateError);
      throw new BadRequestException(maxApiMessage || 'Не удалось закрыть опрос.');
    }
  }

  const closedAt = new Date();
  const updated = await params.prisma.managedPoll.update({
    where: { chatId: params.chatId },
    data: {
      status: PrismaManagedPollStatus.CLOSED,
      closedAt,
      ...(recreatedFromMessageId
        ? {
            publishedMessageId: nextPublishedMessageId,
            publishedUrl: nextPublishedUrl,
          }
        : {}),
    },
  });

  await params.prisma.auditLog.create({
    data: {
      chatId: params.chatId,
      actorUserId: params.actorUserId,
      action: MANAGED_POLL_ACTION_CLOSE,
      payload: {
        entityType: params.entityType,
        messageId: nextPublishedMessageId,
        activeVersion: current.activeVersion,
        totalVotes: summary.totalVotes,
        recreatedFromMessageId,
        source: params.source,
      },
    },
  });
  await params.chatContextCache.invalidate(params.chatId);

  return mapManagedPoll({
    prisma: params.prisma,
    poll: updated,
  });
}
