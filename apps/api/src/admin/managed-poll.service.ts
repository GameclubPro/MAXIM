import {
  createManagedPollRequestSchema,
  managedPollDetailsSchema,
  managedPollListQuerySchema,
  managedPollListResponseSchema,
  managedPollSummarySchema,
  managedPollVotersQuerySchema,
  managedPollVotersResponseSchema,
  updateManagedPollRequestSchema,
  type ManagedPollDetails,
  type ManagedPollListResponse,
  type ManagedPollVotersResponse,
} from '@maxim/contracts/poll';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import {
  buildManagedPollButtons,
  buildManagedPollMessageText,
  buildManagedPollOptionResults,
  parseManagedPollCallbackPayload,
} from '../common/managed-poll.util';
import { MAX_API_SOURCE_TAGS, MaxClientService } from '../max/max-client.service';
import { isAmbiguousMaxSendError } from '../max/max-send-ambiguity.util';
import { ManagedEntityAccessLossService } from '../max/managed-entity-access-loss.service';
import { RedisCounterService } from '../moderation/redis-counter.service';
import {
  ChatEntityType,
  ManagedPollStatus,
  ManagedPollVisibility,
  Prisma,
  type ManagedPoll,
  type ManagedPollOption,
} from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import type { MaxUpdate } from '@maxim/contracts';
import { extractMaxApiErrorMessage } from './admin-chat-rules';
import { isPrismaKnownError } from './admin-legacy-utils';
import { AdminService } from './admin.service';

const MANAGED_POLL_SEND_TIMEOUT_MS = 12_000;
const MANAGED_POLL_EDIT_TIMEOUT_MS = 8_000;
const MANAGED_POLL_PUBLICATION_CLAIM_TTL_MS = 60_000;
const MANAGED_POLL_RENDER_LOCK_TTL_MS = 120_000;
const MANAGED_POLL_RENDER_LOCK_HEARTBEAT_MS = 30_000;
const MANAGED_POLL_RENDER_LOCK_WAIT_MS = 4_000;
const MANAGED_POLL_RENDER_MAX_ATTEMPTS = 2;
const MANAGED_POLL_RENDER_REPAIR_ATTEMPTS = 3;
const MANAGED_POLL_RENDER_REPAIR_DELAY_MS = 250;
const MANAGED_POLL_RECENT_EVENT_HASH_LIMIT = 16;
const MANAGED_POLL_AMBIGUOUS_PUBLICATION_ERROR = 'Публикация требует ручной проверки.';

type PollWithOptions = ManagedPoll & { options: ManagedPollOption[] };
type PollCallbackUser = {
  userId: string;
  displayName: string | null;
  username: string | null;
};
type PollCallbackOutcome =
  | {
      kind: 'recorded';
      changed: boolean;
      replayed?: boolean;
      pollId: string;
      needsRender: boolean;
    }
  | { kind: 'closed'; pollId: string; needsRender: boolean }
  | { kind: 'stale' };

@Injectable()
export class ManagedPollService {
  private readonly logger = new Logger(ManagedPollService.name);
  private readonly localRenderChains = new Map<string, Promise<void>>();
  private readonly scheduledRenderRepairs = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    private readonly adminService: AdminService,
    private readonly chatContextCache: ChatContextCacheService,
    @Optional() private readonly managedEntityAccessLossService?: ManagedEntityAccessLossService,
    @Optional() private readonly redisCounter?: RedisCounterService,
  ) {}

  async listChannelPolls(
    chatId: string,
    user: AuthUser,
    query: unknown,
  ): Promise<ManagedPollListResponse> {
    await this.adminService.assertManagedEntityReadAccess(chatId, user.userId, 'channel');
    const parsed = managedPollListQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    const polls = await this.prisma.managedPoll.findMany({
      where: { chatId },
      include: { options: { orderBy: { position: 'asc' } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...(parsed.data.cursor ? { cursor: { id: parsed.data.cursor }, skip: 1 } : {}),
      take: parsed.data.limit + 1,
    });
    const hasMore = polls.length > parsed.data.limit;
    const page = hasMore ? polls.slice(0, parsed.data.limit) : polls;
    const counts = await this.loadVoteCounts(page.map((poll) => poll.id));
    const response = managedPollListResponseSchema.parse({
      items: page.map((poll) => managedPollSummarySchema.parse(this.mapPoll(poll, counts))),
      nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
    });
    for (const [index, poll] of page.entries()) {
      if (
        poll.publicationMessageId &&
        !poll.lastRenderError &&
        poll.renderedRevision < poll.renderRevision &&
        response.items[index]?.renderRepairNeeded
      ) {
        this.schedulePollRenderRepair(chatId, poll.id);
      }
    }
    return response;
  }

  async getChannelPoll(
    chatId: string,
    pollId: string,
    user: AuthUser,
  ): Promise<ManagedPollDetails> {
    await this.adminService.assertManagedEntityReadAccess(chatId, user.userId, 'channel');
    return this.readPollDetails(chatId, pollId);
  }

  async createChannelPoll(
    chatId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<ManagedPollDetails> {
    await this.adminService.assertManagedEntityAdminAccess(chatId, user.userId, 'channel');
    const parsed = createManagedPollRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const current = await tx.managedPoll.findFirst({
          where: {
            chatId,
            status: { in: [ManagedPollStatus.DRAFT, ManagedPollStatus.ACTIVE] },
          },
          select: { id: true },
        });
        if (current) {
          throw new ConflictException('Сначала завершите текущий опрос.');
        }

        const poll = await tx.managedPoll.create({
          data: {
            chat: { connect: { id: chatId } },
            actorUserId: user.userId,
            question: parsed.data.question,
            visibility: parsed.data.visibility,
            identitySalt: randomUUID().replace(/-/gu, ''),
            options: {
              create: parsed.data.options.map((option, position) => ({
                position,
                text: option.text,
              })),
            },
          },
          include: { options: { orderBy: { position: 'asc' } } },
        });
        await tx.auditLog.create({
          data: {
            chatId,
            actorUserId: user.userId,
            action: 'CREATE_CHANNEL_POLL',
            payload: {
              pollId: poll.id,
              visibility: poll.visibility,
              optionsCount: poll.options.length,
            },
          },
        });
        return poll;
      });
      await this.chatContextCache.invalidate(chatId);
      return managedPollDetailsSchema.parse(this.mapPoll(created, new Map()));
    } catch (error: unknown) {
      if (error instanceof ConflictException) {
        throw error;
      }
      if (isPrismaKnownError(error, 'P2002')) {
        throw new ConflictException('Сначала завершите текущий опрос.');
      }
      throw error;
    }
  }

  async updateChannelPoll(
    chatId: string,
    pollId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<ManagedPollDetails> {
    await this.adminService.assertManagedEntityAdminAccess(chatId, user.userId, 'channel');
    const parsed = updateManagedPollRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      await this.lockPollRow(tx, pollId);
      const poll = await tx.managedPoll.findFirst({
        where: { id: pollId, chatId },
        include: { options: true },
      });
      if (!poll) {
        throw new NotFoundException('Опрос не найден.');
      }
      if (poll.status !== ManagedPollStatus.DRAFT || poll.lockedAt) {
        throw new BadRequestException('Опубликованный опрос нельзя изменить.');
      }

      const knownOptionIds = new Set(poll.options.map((option) => option.id));
      for (const option of parsed.data.options) {
        if (option.id && !knownOptionIds.has(option.id)) {
          throw new BadRequestException('Вариант ответа больше не существует.');
        }
      }

      await tx.managedPollOption.deleteMany({ where: { pollId } });
      await tx.managedPollOption.createMany({
        data: parsed.data.options.map((option, position) => ({
          ...(option.id ? { id: option.id } : {}),
          pollId,
          position,
          text: option.text,
        })),
      });
      await tx.managedPoll.update({
        where: { id: pollId },
        data: {
          actorUserId: user.userId,
          question: parsed.data.question,
          visibility: parsed.data.visibility,
          lastError: null,
          lastRenderError: null,
        },
      });
      await tx.auditLog.create({
        data: {
          chatId,
          actorUserId: user.userId,
          action: 'UPDATE_CHANNEL_POLL',
          payload: {
            pollId,
            visibility: parsed.data.visibility,
            optionsCount: parsed.data.options.length,
          },
        },
      });
      return tx.managedPoll.findUniqueOrThrow({
        where: { id: pollId },
        include: { options: { orderBy: { position: 'asc' } } },
      });
    });
    await this.chatContextCache.invalidate(chatId);
    return managedPollDetailsSchema.parse(this.mapPoll(updated, new Map()));
  }

  async deleteChannelPoll(chatId: string, pollId: string, user: AuthUser): Promise<{ ok: true }> {
    await this.adminService.assertManagedEntityAdminAccess(chatId, user.userId, 'channel');
    await this.prisma.$transaction(async (tx) => {
      await this.lockPollRow(tx, pollId);
      const poll = await tx.managedPoll.findFirst({ where: { id: pollId, chatId } });
      if (!poll) {
        throw new NotFoundException('Опрос не найден.');
      }
      if (poll.status !== ManagedPollStatus.DRAFT || poll.publicationMessageId || poll.lockedAt) {
        throw new BadRequestException('Удалить можно только неопубликованный черновик.');
      }
      await tx.managedPoll.delete({ where: { id: pollId } });
      await tx.auditLog.create({
        data: {
          chatId,
          actorUserId: user.userId,
          action: 'DELETE_CHANNEL_POLL',
          payload: { pollId },
        },
      });
    });
    await this.chatContextCache.invalidate(chatId);
    return { ok: true };
  }

  async publishChannelPoll(
    chatId: string,
    pollId: string,
    user: AuthUser,
  ): Promise<ManagedPollDetails> {
    await this.adminService.assertManagedEntityAdminAccess(chatId, user.userId, 'channel');
    const poll = await this.findPoll(chatId, pollId);
    if (poll.status !== ManagedPollStatus.DRAFT) {
      throw new BadRequestException('Опубликовать можно только черновик.');
    }
    if (poll.lockedAt) {
      throw new ConflictException(
        this.publicationNeedsReview(poll)
          ? 'Публикация уже отправлялась и требует проверки.'
          : 'Публикация уже выполняется.',
      );
    }

    const publicationBotId = await this.adminService.resolveChannelPollBotId(chatId);
    const lockToken = randomUUID();
    const lockedAt = new Date();
    const lock = await this.prisma.managedPoll.updateMany({
      where: { id: poll.id, chatId, status: ManagedPollStatus.DRAFT, lockedAt: null },
      data: {
        lockedAt,
        lockToken,
        publicationBotId: publicationBotId ?? null,
        lastError: null,
      },
    });
    if (lock.count === 0) {
      throw new ConflictException('Публикация уже выполняется.');
    }

    let attempted = false;
    let accepted = false;
    try {
      const publicationPoll = await this.findPoll(chatId, poll.id);
      const result = buildManagedPollOptionResults(publicationPoll.options, new Map());
      const text = buildManagedPollMessageText({
        question: publicationPoll.question,
        options: result.options,
        status: 'ACTIVE',
        visibility: publicationPoll.visibility,
        totalVotes: 0,
      });
      attempted = true;
      const published = await this.maxClient.sendMessageImmediateWithResolvedLink(
        chatId,
        text,
        {
          buttons: buildManagedPollButtons(publicationPoll.id, result.options),
          debugContext: { screen: 'managed-poll', action: 'publish' },
        },
        this.buildMaxOptions(publicationBotId, MANAGED_POLL_SEND_TIMEOUT_MS),
      );
      accepted = true;
      const publishedAt = new Date();
      await this.prisma.$transaction([
        this.prisma.managedPoll.update({
          where: { id: poll.id },
          data: {
            actorUserId: user.userId,
            status: ManagedPollStatus.ACTIVE,
            publicationMessageId: published.messageId,
            publicationBotId: publicationBotId ?? null,
            publicationUrl: published.url,
            publishedAt,
            renderedRevision: publicationPoll.renderRevision,
            lockedAt: null,
            lockToken: null,
            lastError: null,
            lastRenderError: null,
          },
        }),
        this.prisma.auditLog.create({
          data: {
            chatId,
            actorUserId: user.userId,
            action: 'PUBLISH_CHANNEL_POLL',
            payload: {
              pollId: poll.id,
              visibility: publicationPoll.visibility,
              optionsCount: publicationPoll.options.length,
              publicationMessageId: published.messageId,
            },
          },
        }),
      ]);
      await this.chatContextCache.invalidate(chatId);
      return this.readPollDetails(chatId, poll.id);
    } catch (error: unknown) {
      const ambiguous = accepted || (attempted && isAmbiguousMaxSendError(error));
      const message = extractMaxApiErrorMessage(error) || this.formatError(error);
      const released = await this.prisma.managedPoll.updateMany({
        where: { id: poll.id, lockToken },
        data: ambiguous
          ? { lastError: MANAGED_POLL_AMBIGUOUS_PUBLICATION_ERROR }
          : {
              lockedAt: null,
              lockToken: null,
              publicationBotId: null,
              lastError: message,
            },
      });
      if (released.count === 0) {
        try {
          const recovered = await this.findPoll(chatId, poll.id);
          if (recovered.status === ManagedPollStatus.ACTIVE && recovered.publicationMessageId) {
            await this.chatContextCache.invalidate(chatId);
            return this.readPollDetails(chatId, poll.id);
          }
        } catch (recoveryError: unknown) {
          this.logger.debug(
            { pollId: poll.id, err: this.formatError(recoveryError) },
            'Failed to read callback-recovered managed poll publication',
          );
        }
      }
      if (attempted && !ambiguous) {
        await this.recordAccessLoss(poll, publicationBotId ?? null, 'send', error);
      }
      throw new BadRequestException(
        ambiguous
          ? 'MAX мог принять публикацию. Проверьте канал перед повтором.'
          : message || 'Не удалось опубликовать опрос.',
      );
    }
  }

  async closeChannelPoll(
    chatId: string,
    pollId: string,
    user: AuthUser,
  ): Promise<ManagedPollDetails> {
    await this.adminService.assertManagedEntityAdminAccess(chatId, user.userId, 'channel');
    const serialized = await this.runPollRenderSerialized(pollId, async () => {
      const closeResult = await this.prisma.$transaction(async (tx) => {
        await this.lockPollRow(tx, pollId);
        const poll = await tx.managedPoll.findFirst({ where: { id: pollId, chatId } });
        if (!poll) {
          throw new NotFoundException('Опрос не найден.');
        }
        if (poll.status === ManagedPollStatus.DRAFT) {
          throw new BadRequestException('Черновик ещё не опубликован.');
        }
        if (poll.status === ManagedPollStatus.CLOSED) {
          return { changed: false };
        }

        await tx.managedPoll.update({
          where: { id: poll.id },
          data: {
            status: ManagedPollStatus.CLOSED,
            closedAt: new Date(),
            renderRevision: { increment: 1 },
          },
        });
        await tx.auditLog.create({
          data: {
            chatId,
            actorUserId: user.userId,
            action: 'CLOSE_CHANNEL_POLL',
            payload: { pollId: poll.id },
          },
        });
        return { changed: true };
      });

      await this.renderPollPublication(
        chatId,
        pollId,
        closeResult.changed ? 'close' : 'retry-close',
      );
    });
    if (!serialized) {
      throw new ConflictException('Опрос сейчас обновляется. Повторите закрытие.');
    }
    await this.chatContextCache.invalidate(chatId);
    return this.readPollDetails(chatId, pollId);
  }

  async refreshChannelPollPublication(
    chatId: string,
    pollId: string,
    user: AuthUser,
  ): Promise<ManagedPollDetails> {
    await this.adminService.assertManagedEntityAdminAccess(chatId, user.userId, 'channel');
    const poll = await this.findPoll(chatId, pollId);
    if (poll.status === ManagedPollStatus.DRAFT) {
      throw new BadRequestException('Черновик ещё не опубликован.');
    }

    const serialized = await this.runPollRenderSerialized(pollId, () =>
      this.renderPollPublication(chatId, pollId, 'manual-refresh'),
    );
    if (!serialized) {
      throw new ConflictException('Опрос сейчас обновляется. Повторите попытку.');
    }
    return this.readPollDetails(chatId, pollId);
  }

  async resetChannelPollPublication(
    chatId: string,
    pollId: string,
    user: AuthUser,
  ): Promise<ManagedPollDetails> {
    await this.adminService.assertManagedEntityAdminAccess(chatId, user.userId, 'channel');
    await this.prisma.$transaction(async (tx) => {
      await this.lockPollRow(tx, pollId);
      const poll = await tx.managedPoll.findFirst({ where: { id: pollId, chatId } });
      if (!poll) {
        throw new NotFoundException('Опрос не найден.');
      }
      if (
        poll.status !== ManagedPollStatus.DRAFT ||
        !poll.lockedAt ||
        !this.publicationNeedsReview(poll)
      ) {
        throw new BadRequestException('Публикация не требует сброса.');
      }

      await tx.managedPoll.update({
        where: { id: poll.id },
        data: {
          lockedAt: null,
          lockToken: null,
          publicationBotId: null,
          lastError: null,
        },
      });
      await tx.auditLog.create({
        data: {
          chatId,
          actorUserId: user.userId,
          action: 'RESET_CHANNEL_POLL_PUBLICATION',
          payload: { pollId: poll.id },
        },
      });
    });
    await this.chatContextCache.invalidate(chatId);
    return this.readPollDetails(chatId, pollId);
  }

  async getChannelPollVoters(
    chatId: string,
    pollId: string,
    user: AuthUser,
    query: unknown,
  ): Promise<ManagedPollVotersResponse> {
    await this.adminService.assertManagedEntityAdminAccess(chatId, user.userId, 'channel');
    const parsed = managedPollVotersQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    const poll = await this.prisma.managedPoll.findFirst({
      where: { id: pollId, chatId },
      select: { id: true, visibility: true },
    });
    if (!poll) {
      throw new NotFoundException('Опрос не найден.');
    }
    if (poll.visibility !== ManagedPollVisibility.OPEN) {
      throw new BadRequestException('В анонимном опросе список участников скрыт.');
    }

    const rows = await this.prisma.managedPollVoter.findMany({
      where: { pollId, vote: { isNot: null } },
      include: { vote: { select: { optionId: true, createdAt: true, updatedAt: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...(parsed.data.cursor ? { cursor: { id: parsed.data.cursor }, skip: 1 } : {}),
      take: parsed.data.limit + 1,
    });
    const hasMore = rows.length > parsed.data.limit;
    const page = hasMore ? rows.slice(0, parsed.data.limit) : rows;
    return managedPollVotersResponseSchema.parse({
      items: page.flatMap((row) =>
        row.vote
          ? [
              {
                id: row.id,
                pollId: row.pollId,
                optionId: row.vote.optionId,
                userId: row.userId,
                displayName: row.displayName,
                username: row.username,
                votedAt: row.vote.createdAt.toISOString(),
                updatedAt: row.vote.updatedAt.toISOString(),
              },
            ]
          : [],
      ),
      nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
    });
  }

  async tryHandleCallback(update: MaxUpdate): Promise<boolean> {
    const callback = this.extractCallbackNode(update);
    const payload = this.readString(callback?.payload ?? callback?.data);
    const parsed = parseManagedPollCallbackPayload(payload);
    if (!parsed) {
      return false;
    }

    const callbackId = this.readString(
      callback?.callback_id ?? callback?.callbackId ?? callback?.id,
    );
    const callbackUser = this.extractCallbackUser(callback);
    const chatId = update.message?.chatId?.trim() ?? '';
    const messageId = update.message?.messageId?.trim() ?? '';
    if (!callbackUser || !chatId || !messageId) {
      await this.answerCallback(callbackId, 'Опрос уже недоступен', update.botId);
      return true;
    }

    const voteParams = {
      pollId: parsed.pollId,
      optionId: parsed.optionId,
      chatId,
      messageId,
      callbackBotId: update.botId?.trim() || null,
      eventId: this.buildCallbackEventId(update, callbackId),
      eventAt: this.extractCallbackOccurredAt(update, callback),
      voter: callbackUser,
    };
    const serialized = await this.runPollRenderSerialized(parsed.pollId, async () => {
      const outcome = await this.recordVote(voteParams);
      if (outcome.kind === 'stale') {
        await this.answerCallback(callbackId, 'Опрос уже неактуален', update.botId);
        return;
      }
      if (outcome.kind === 'closed') {
        await this.answerCallback(callbackId, 'Опрос закрыт', update.botId);
        if (outcome.needsRender) {
          await this.renderPollPublication(chatId, outcome.pollId, 'closed-callback');
        }
        return;
      }

      const notification =
        outcome.replayed || outcome.changed ? 'Голос учтён' : 'Вы уже выбрали этот вариант';
      if (!outcome.needsRender) {
        await this.answerCallback(callbackId, notification, update.botId);
        return;
      }
      const poll = await this.loadPollAggregate(chatId, outcome.pollId);
      if (!callbackId) {
        await this.renderPollPublication(chatId, poll.id, 'vote-without-callback');
        return;
      }
      const messageEdit = this.buildCallbackMessageEdit(poll);
      try {
        await this.maxClient.answerCallback(callbackId, notification, messageEdit, {
          ...this.buildMaxOptions(
            poll.publicationBotId ?? update.botId,
            MANAGED_POLL_EDIT_TIMEOUT_MS,
          ),
          trafficClass: 'critical',
        });
        if (!(await this.markPollRendered(poll.id, poll.renderRevision))) {
          this.schedulePollRenderRepair(chatId, poll.id);
        }
      } catch (error: unknown) {
        if (!this.isTerminalCallbackError(error)) {
          this.logger.warn(
            {
              pollId: poll.id,
              callbackId,
              err: this.formatError(error),
            },
            'Managed poll callback answer failed ambiguously; direct edit was skipped',
          );
          this.schedulePollRenderRepair(chatId, poll.id);
          return;
        }
        this.logger.debug(
          {
            pollId: poll.id,
            callbackId,
            err: this.formatError(error),
          },
          'Managed poll callback answer failed; falling back to direct edit',
        );
        await this.renderPollPublication(chatId, poll.id, 'vote-fallback');
      }
    });
    if (!serialized) {
      const outcome = await this.recordVote(voteParams);
      const notification =
        outcome.kind === 'stale'
          ? 'Опрос уже неактуален'
          : outcome.kind === 'closed'
            ? 'Опрос закрыт'
            : outcome.replayed || outcome.changed
              ? 'Голос учтён'
              : 'Вы уже выбрали этот вариант';
      await this.answerCallback(callbackId, notification, update.botId);
      if (
        (outcome.kind === 'recorded' && outcome.needsRender) ||
        (outcome.kind === 'closed' && outcome.needsRender)
      ) {
        this.schedulePollRenderRepair(chatId, parsed.pollId);
      }
    }
    return true;
  }

  private async recordVote(params: {
    pollId: string;
    optionId: string;
    chatId: string;
    messageId: string;
    callbackBotId: string | null;
    eventId: string;
    eventAt: Date;
    voter: PollCallbackUser;
  }): Promise<PollCallbackOutcome> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockPollRow(tx, params.pollId);
      let poll = await tx.managedPoll.findUnique({
        where: { id: params.pollId },
        include: { options: true },
      });
      if (!poll || poll.chatId !== params.chatId) {
        return { kind: 'stale' };
      }
      if (
        poll.publicationBotId &&
        params.callbackBotId &&
        poll.publicationBotId !== params.callbackBotId
      ) {
        return { kind: 'stale' };
      }

      // FLAG: A matching callback is proof that a claimed draft reached MAX, even if the sender
      // crashed before persisting the message id or before its timeout was classified.
      if (
        poll.status === ManagedPollStatus.DRAFT &&
        poll.lockedAt &&
        poll.lockToken &&
        poll.publicationBotId &&
        params.callbackBotId === poll.publicationBotId &&
        !poll.publicationMessageId
      ) {
        const publishedAt = new Date();
        await tx.managedPoll.update({
          where: { id: poll.id },
          data: {
            status: ManagedPollStatus.ACTIVE,
            publicationMessageId: params.messageId,
            publishedAt,
            lockedAt: null,
            lockToken: null,
            lastError: null,
          },
        });
        await tx.auditLog.create({
          data: {
            chatId: poll.chatId,
            actorUserId: poll.actorUserId,
            action: 'RECOVER_CHANNEL_POLL_PUBLICATION',
            payload: {
              pollId: poll.id,
              publicationMessageId: params.messageId,
              source: 'message_callback',
            },
          },
        });
        poll = {
          ...poll,
          status: ManagedPollStatus.ACTIVE,
          publicationMessageId: params.messageId,
          publishedAt,
          lockedAt: null,
          lockToken: null,
          lastError: null,
        };
      }

      if ((poll.publicationMessageId?.trim() ?? '') !== params.messageId) {
        return { kind: 'stale' };
      }
      if (poll.status !== ManagedPollStatus.ACTIVE) {
        return {
          kind: 'closed',
          pollId: poll.id,
          needsRender: Boolean(poll.lastRenderError) || poll.renderedRevision < poll.renderRevision,
        };
      }
      if (!poll.options.some((option) => option.id === params.optionId)) {
        return { kind: 'stale' };
      }

      const needsRender =
        Boolean(poll.lastRenderError) || poll.renderedRevision < poll.renderRevision;
      const identityHash = this.buildIdentityHash(poll.identitySalt, params.voter.userId);
      const eventHash = this.buildVoteEventHash(poll.identitySalt, params.eventId);
      const existingVoter = await tx.managedPollVoter.findUnique({
        where: { pollId_identityHash: { pollId: poll.id, identityHash } },
        include: { vote: { select: { optionId: true } } },
      });
      if (existingVoter?.recentEventHashes.includes(eventHash)) {
        return {
          kind: 'recorded',
          changed: false,
          replayed: true,
          pollId: poll.id,
          needsRender,
        };
      }
      const recentEventHashes = this.appendRecentEventHash(
        existingVoter?.recentEventHashes ?? [],
        eventHash,
      );
      if (existingVoter?.lastEventAt && params.eventAt < existingVoter.lastEventAt) {
        await tx.managedPollVoter.update({
          where: { id: existingVoter.id },
          data: { recentEventHashes },
        });
        return {
          kind: 'recorded',
          changed: false,
          replayed: true,
          pollId: poll.id,
          needsRender,
        };
      }

      const changed = existingVoter?.vote?.optionId !== params.optionId;
      if (changed) {
        await tx.managedPoll.update({
          where: { id: poll.id },
          data: { renderRevision: { increment: 1 } },
        });
      }
      const exposeIdentity = poll.visibility === ManagedPollVisibility.OPEN;
      const voter = await tx.managedPollVoter.upsert({
        where: { pollId_identityHash: { pollId: poll.id, identityHash } },
        create: {
          pollId: poll.id,
          identityHash,
          userId: exposeIdentity ? params.voter.userId : null,
          displayName: exposeIdentity ? params.voter.displayName : null,
          username: exposeIdentity ? params.voter.username : null,
          lastEventAt: params.eventAt,
          recentEventHashes,
        },
        update: {
          userId: exposeIdentity ? params.voter.userId : null,
          displayName: exposeIdentity ? params.voter.displayName : null,
          username: exposeIdentity ? params.voter.username : null,
          lastEventAt: params.eventAt,
          recentEventHashes,
        },
      });
      if (changed) {
        await tx.managedPollVote.upsert({
          where: { pollId_voterId: { pollId: poll.id, voterId: voter.id } },
          create: {
            pollId: poll.id,
            voterId: voter.id,
            optionId: params.optionId,
          },
          update: { optionId: params.optionId },
        });
      }
      return {
        kind: 'recorded',
        changed,
        pollId: poll.id,
        needsRender: changed || needsRender,
      };
    });
  }

  private async renderPollPublication(
    chatId: string,
    pollId: string,
    action: string,
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= MANAGED_POLL_RENDER_MAX_ATTEMPTS; attempt += 1) {
      const poll = await this.loadPollAggregate(chatId, pollId);
      if (!poll.publicationMessageId) {
        return true;
      }
      const text = buildManagedPollMessageText({
        question: poll.question,
        options: poll.resultOptions,
        status: poll.status,
        visibility: poll.visibility,
        totalVotes: poll.totalVotes,
      });
      const options =
        poll.status === ManagedPollStatus.ACTIVE
          ? {
              buttons: buildManagedPollButtons(poll.id, poll.resultOptions),
              debugContext: { screen: 'managed-poll', action },
            }
          : undefined;
      const botId =
        poll.publicationBotId ?? (await this.adminService.resolveChannelPollBotId(chatId));
      try {
        await this.maxClient.editMessageInlineKeyboard(
          chatId,
          poll.publicationMessageId,
          text,
          options,
          this.buildMaxOptions(botId, MANAGED_POLL_EDIT_TIMEOUT_MS),
        );
        if (await this.markPollRendered(poll.id, poll.renderRevision)) {
          return true;
        }
      } catch (error: unknown) {
        const message = extractMaxApiErrorMessage(error) || this.formatError(error);
        await this.prisma.managedPoll.updateMany({
          where: { id: poll.id },
          data: { lastRenderError: message },
        });
        await this.recordAccessLoss(poll, botId ?? null, 'edit', error);
        this.logger.warn(
          { pollId: poll.id, chatId, action, err: message },
          'Failed to render managed poll publication',
        );
        if (action !== 'coalesced-repair') {
          this.schedulePollRenderRepair(chatId, poll.id);
        }
        return false;
      }
    }
    if (action !== 'coalesced-repair') {
      this.schedulePollRenderRepair(chatId, pollId);
    }
    return false;
  }

  private buildCallbackMessageEdit(
    poll: Awaited<ReturnType<ManagedPollService['loadPollAggregate']>>,
  ) {
    const text = buildManagedPollMessageText({
      question: poll.question,
      options: poll.resultOptions,
      status: poll.status,
      visibility: poll.visibility,
      totalVotes: poll.totalVotes,
    });
    return {
      text,
      ...(poll.status === ManagedPollStatus.ACTIVE
        ? {
            options: {
              buttons: buildManagedPollButtons(poll.id, poll.resultOptions),
              debugContext: { screen: 'managed-poll', action: 'vote' },
            },
          }
        : {}),
    };
  }

  private async loadPollAggregate(chatId: string, pollId: string) {
    const poll = await this.findPoll(chatId, pollId);
    const counts = await this.loadVoteCounts([poll.id]);
    const mapped = this.mapPoll(poll, counts);
    return {
      ...poll,
      totalVotes: mapped.totalVotes,
      resultOptions: mapped.options,
    };
  }

  private async readPollDetails(chatId: string, pollId: string): Promise<ManagedPollDetails> {
    const poll = await this.findPoll(chatId, pollId);
    const counts = await this.loadVoteCounts([poll.id]);
    const details = managedPollDetailsSchema.parse(this.mapPoll(poll, counts));
    if (
      poll.publicationMessageId &&
      !poll.lastRenderError &&
      poll.renderedRevision < poll.renderRevision &&
      details.renderRepairNeeded
    ) {
      this.schedulePollRenderRepair(chatId, poll.id);
    }
    return details;
  }

  private async findPoll(chatId: string, pollId: string): Promise<PollWithOptions> {
    const poll = await this.prisma.managedPoll.findFirst({
      where: { id: pollId, chatId },
      include: { options: { orderBy: { position: 'asc' } } },
    });
    if (!poll) {
      throw new NotFoundException('Опрос не найден.');
    }
    return poll;
  }

  private async loadVoteCounts(pollIds: readonly string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (pollIds.length === 0) {
      return counts;
    }
    const rows = await this.prisma.managedPollVote.groupBy({
      by: ['pollId', 'optionId'],
      where: { pollId: { in: [...pollIds] } },
      _count: { _all: true },
    });
    for (const row of rows) {
      counts.set(`${row.pollId}:${row.optionId}`, row._count._all);
    }
    return counts;
  }

  private mapPoll(poll: PollWithOptions, counts: ReadonlyMap<string, number>) {
    const optionCounts = new Map(
      poll.options.map((option) => [option.id, counts.get(`${poll.id}:${option.id}`) ?? 0]),
    );
    const result = buildManagedPollOptionResults(poll.options, optionCounts);
    const publicationNeedsReview = this.publicationNeedsReview(poll);
    return {
      id: poll.id,
      channelId: poll.chatId,
      question: poll.question,
      status: poll.status,
      visibility: poll.visibility,
      totalVotes: result.totalVotes,
      options: result.options,
      publicationMessageId: poll.publicationMessageId,
      publicationUrl: poll.publicationUrl,
      publicationPending: Boolean(poll.lockedAt) && !publicationNeedsReview,
      publicationNeedsReview,
      renderRepairNeeded:
        Boolean(poll.lastRenderError) || poll.renderedRevision < poll.renderRevision,
      publishedAt: poll.publishedAt?.toISOString() ?? null,
      closedAt: poll.closedAt?.toISOString() ?? null,
      createdAt: poll.createdAt.toISOString(),
      updatedAt: poll.updatedAt.toISOString(),
      lastError: poll.lastError,
      lastRenderError: poll.lastRenderError,
    };
  }

  private async lockPollRow(tx: Prisma.TransactionClient, pollId: string): Promise<void> {
    await tx.$queryRaw`SELECT "id" FROM "managed_polls" WHERE "id" = ${pollId} FOR UPDATE`;
  }

  private buildIdentityHash(identitySalt: string, userId: string): string {
    return createHmac('sha256', identitySalt).update(userId).digest('hex');
  }

  private buildVoteEventHash(identitySalt: string, eventId: string): string {
    return createHmac('sha256', identitySalt).update(`event:${eventId}`).digest('hex');
  }

  private appendRecentEventHash(existing: readonly string[], eventHash: string): string[] {
    return [eventHash, ...existing.filter((value) => value !== eventHash)].slice(
      0,
      MANAGED_POLL_RECENT_EVENT_HASH_LIMIT,
    );
  }

  private buildCallbackEventId(update: MaxUpdate, callbackId: string | null): string {
    const fallbackDigest = createHash('sha256')
      .update(JSON.stringify(update.raw ?? update))
      .digest('hex');
    const updateId =
      this.readString(update.updateId) ?? callbackId ?? `synthetic:${fallbackDigest}`;
    const botId = this.readString(update.botId) ?? 'default';
    const scopedId = `${botId}:${updateId}`;
    return scopedId.length <= 256
      ? scopedId
      : `sha256:${createHash('sha256').update(scopedId).digest('hex')}`;
  }

  private extractCallbackOccurredAt(
    update: MaxUpdate,
    callback: Record<string, unknown> | null,
  ): Date {
    const raw = this.asRecord(update.raw);
    const data = this.asRecord(raw?.data);
    const event = this.asRecord(raw?.event);
    const candidates = [
      callback?.timestamp,
      callback?.created_at,
      callback?.createdAt,
      raw?.timestamp,
      raw?.created_at,
      raw?.createdAt,
      data?.timestamp,
      event?.timestamp,
    ];
    for (const candidate of candidates) {
      const parsed = this.parseCallbackDate(candidate);
      if (parsed) {
        return parsed;
      }
    }
    return new Date();
  }

  private parseCallbackDate(value: unknown): Date | null {
    if (value instanceof Date && Number.isFinite(value.getTime())) {
      return value;
    }
    if (typeof value === 'string' && value.trim() && !/^\d+(?:\.\d+)?$/u.test(value.trim())) {
      const parsed = new Date(value);
      return Number.isFinite(parsed.getTime()) ? parsed : null;
    }
    const numeric =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim()
          ? Number(value)
          : Number.NaN;
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return null;
    }
    const timestampMs = numeric < 100_000_000_000 ? numeric * 1_000 : numeric;
    const parsed = new Date(timestampMs);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }

  private publicationNeedsReview(
    poll: Pick<ManagedPoll, 'status' | 'lockedAt' | 'lastError'>,
  ): boolean {
    if (poll.status !== ManagedPollStatus.DRAFT || !poll.lockedAt) {
      return false;
    }
    return (
      poll.lastError === MANAGED_POLL_AMBIGUOUS_PUBLICATION_ERROR ||
      Date.now() - poll.lockedAt.getTime() >= MANAGED_POLL_PUBLICATION_CLAIM_TTL_MS
    );
  }

  private buildMaxOptions(botId: string | null | undefined, timeoutMs: number) {
    return {
      ...(botId?.trim() ? { botId: botId.trim() } : {}),
      trafficClass: 'interactive' as const,
      actionHealthLane: 'interactive' as const,
      sourceTag: MAX_API_SOURCE_TAGS.MANAGED_POLL,
      timeoutMs,
    };
  }

  private async answerCallback(
    callbackId: string | null,
    notification: string,
    botId?: string | null,
  ): Promise<void> {
    if (!callbackId) {
      return;
    }
    try {
      await this.maxClient.answerCallback(callbackId, notification, undefined, {
        ...this.buildMaxOptions(botId, MANAGED_POLL_EDIT_TIMEOUT_MS),
        trafficClass: 'critical',
      });
    } catch (error: unknown) {
      this.logger.debug(
        { callbackId, err: this.formatError(error) },
        'Failed to answer managed poll callback',
      );
    }
  }

  private async markPollRendered(pollId: string, renderRevision: number): Promise<boolean> {
    const updated = await this.prisma.managedPoll.updateMany({
      where: { id: pollId, renderRevision },
      data: { renderedRevision: renderRevision, lastRenderError: null },
    });
    return updated.count > 0;
  }

  private async runPollRenderSerialized(
    pollId: string,
    operation: () => Promise<unknown>,
  ): Promise<boolean> {
    if (this.redisCounter) {
      const key = `managed-poll:render:v1:${pollId}`;
      let token: string | null = null;
      try {
        const deadline = Date.now() + MANAGED_POLL_RENDER_LOCK_WAIT_MS;
        do {
          token = await this.redisCounter.acquireLock(key, MANAGED_POLL_RENDER_LOCK_TTL_MS);
          if (token) {
            break;
          }
          await this.delay(50);
        } while (Date.now() < deadline);
      } catch (error: unknown) {
        this.logger.warn(
          { pollId, err: this.formatError(error) },
          'Managed poll Redis render lock failed; deferring publication repair',
        );
        return false;
      }

      if (!token) {
        this.logger.debug({ pollId }, 'Managed poll render lock wait timed out');
        return false;
      }
      let lockHealthy = true;
      let renewalChain = Promise.resolve();
      const renewLock = this.redisCounter.renewLock?.bind(this.redisCounter);
      const heartbeat = renewLock
        ? setInterval(() => {
            renewalChain = renewalChain
              .then(async () => {
                if (!(await renewLock(key, token, MANAGED_POLL_RENDER_LOCK_TTL_MS))) {
                  lockHealthy = false;
                }
              })
              .catch((error: unknown) => {
                lockHealthy = false;
                this.logger.warn(
                  { pollId, err: this.formatError(error) },
                  'Managed poll Redis render lock renewal failed',
                );
              });
          }, MANAGED_POLL_RENDER_LOCK_HEARTBEAT_MS)
        : null;
      heartbeat?.unref?.();
      try {
        await operation();
        await renewalChain;
        return lockHealthy;
      } finally {
        if (heartbeat) {
          clearInterval(heartbeat);
        }
        await renewalChain.catch(() => undefined);
        await this.redisCounter.releaseLock(key, token).catch(() => undefined);
      }
    }

    return this.runPollRenderLocally(pollId, operation);
  }

  private schedulePollRenderRepair(chatId: string, pollId: string): void {
    if (this.scheduledRenderRepairs.has(pollId)) {
      return;
    }

    const repair = (async () => {
      for (let attempt = 0; attempt < MANAGED_POLL_RENDER_REPAIR_ATTEMPTS; attempt += 1) {
        await this.delay(MANAGED_POLL_RENDER_REPAIR_DELAY_MS * (attempt + 1));
        let renderSucceeded = false;
        const serialized = await this.runPollRenderSerialized(pollId, async () => {
          renderSucceeded = await this.renderPollPublication(chatId, pollId, 'coalesced-repair');
        });
        if (serialized && renderSucceeded) {
          return;
        }
      }
    })()
      .catch((error: unknown) => {
        this.logger.warn(
          { pollId, chatId, err: this.formatError(error) },
          'Managed poll coalesced render repair failed',
        );
      })
      .finally(() => {
        if (this.scheduledRenderRepairs.get(pollId) === repair) {
          this.scheduledRenderRepairs.delete(pollId);
        }
      });
    this.scheduledRenderRepairs.set(pollId, repair);
  }

  private async runPollRenderLocally(
    pollId: string,
    operation: () => Promise<unknown>,
  ): Promise<boolean> {
    const previous = this.localRenderChains.get(pollId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = previous.catch(() => undefined).then(() => current);
    this.localRenderChains.set(pollId, chain);
    await previous.catch(() => undefined);
    try {
      await operation();
      return true;
    } finally {
      release();
      if (this.localRenderChains.get(pollId) === chain) {
        this.localRenderChains.delete(pollId);
      }
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private extractCallbackNode(update: MaxUpdate): Record<string, unknown> | null {
    const raw = this.asRecord(update.raw);
    const data = this.asRecord(raw?.data);
    const event = this.asRecord(raw?.event);
    const candidates = [
      this.asRecord(raw?.callback),
      this.asRecord(raw?.message_callback),
      this.asRecord(data?.callback),
      this.asRecord(data?.message_callback),
      this.asRecord(event?.callback),
      this.asRecord(event?.message_callback),
    ];
    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }
      const nested = this.asRecord(candidate.callback);
      if (nested) {
        return nested;
      }
      if (candidate.payload !== undefined || candidate.callback_id !== undefined) {
        return candidate;
      }
    }
    return null;
  }

  private extractCallbackUser(callback: Record<string, unknown> | null): PollCallbackUser | null {
    const user = this.asRecord(callback?.user);
    const userId = this.readString(user?.user_id ?? user?.userId ?? user?.id);
    if (!userId) {
      return null;
    }
    const directName = this.readString(
      user?.display_name ?? user?.displayName ?? user?.name ?? user?.full_name ?? user?.fullName,
    );
    const firstName = this.readString(user?.first_name ?? user?.firstName);
    const lastName = this.readString(user?.last_name ?? user?.lastName);
    return {
      userId,
      displayName: directName ?? ([firstName, lastName].filter(Boolean).join(' ').trim() || null),
      username: this.readString(user?.username),
    };
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private readString(value: unknown): string | null {
    if (typeof value !== 'string' && typeof value !== 'number') {
      return null;
    }
    const normalized = String(value).trim();
    return normalized || null;
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private isTerminalCallbackError(error: unknown): boolean {
    const status = (error as { response?: { status?: unknown } } | null)?.response?.status;
    if (status === 400 || status === 404) {
      return true;
    }
    const data = (error as { response?: { data?: unknown } } | null)?.response?.data;
    const normalized = JSON.stringify(data ?? this.formatError(error)).toLowerCase();
    return (
      normalized.includes('callback.not.found') ||
      normalized.includes('message_callback.not_found') ||
      (normalized.includes('callback') && normalized.includes('not found'))
    );
  }

  private async recordAccessLoss(
    poll: Pick<ManagedPoll, 'id' | 'chatId'>,
    botId: string | null,
    operation: 'send' | 'edit',
    error: unknown,
  ): Promise<void> {
    try {
      await this.managedEntityAccessLossService?.recordIfManagedEntityAccessLost({
        chatId: poll.chatId,
        botId,
        entityType: ChatEntityType.CHANNEL,
        source: `managed_poll:${operation}`,
        operation,
        error,
      });
    } catch (accessLossError: unknown) {
      this.logger.debug(
        { pollId: poll.id, err: this.formatError(accessLossError) },
        'Failed to record managed poll access loss',
      );
    }
  }
}
