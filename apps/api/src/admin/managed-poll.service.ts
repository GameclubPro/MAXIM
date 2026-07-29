import {
  createManagedPollRequestSchema,
  managedPollDetailsSchema,
  managedPollImagesSchema,
  managedPollListQuerySchema,
  managedPollListResponseSchema,
  managedPollSummarySchema,
  managedPollVotersQuerySchema,
  managedPollVotersResponseSchema,
  updateManagedPollRequestSchema,
  type ManagedPollDetails,
  type ManagedPollImage,
  type ManagedPollListResponse,
  type ManagedPollQuestionFormat,
  type ManagedPollVotersResponse,
} from '@maxim/contracts/poll';
import type { ManagedEntityType, MaxUpdate } from '@maxim/contracts';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
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
import {
  MAX_API_SOURCE_TAGS,
  MaxClientService,
  type MaxApiTrafficClass,
  type MaxAttachmentPayload,
  type MaxSendMessageOptions,
} from '../max/max-client.service';
import { isAmbiguousMaxSendError } from '../max/max-send-ambiguity.util';
import {
  MaxRoutedPublicationService,
  type MaxRoutedPublicationResult,
} from '../max/max-routed-publication.service';
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
import { extractMaxApiErrorMessage } from './admin-chat-rules';
import { isPrismaKnownError } from './admin-legacy-utils';
import {
  decodeBroadcastImageBase64,
  resolveBroadcastImageFileName,
  resolveManagedBroadcastSendRetryDelayMs,
  resolveManagedBroadcastUploadRetryDelayMs,
} from './admin-managed-broadcast-media';
import { AdminService } from './admin.service';
import {
  BROADCAST_IMAGE_MAX_BYTES,
  BROADCAST_IMAGES_TOTAL_MAX_BYTES,
} from './admin.service.support';

const MANAGED_POLL_SEND_TIMEOUT_MS = 12_000;
const MANAGED_POLL_EDIT_TIMEOUT_MS = 8_000;
const MANAGED_POLL_UPLOAD_TIMEOUT_MS = 30_000;
const MANAGED_POLL_PUBLICATION_CLAIM_TTL_MS = 60_000;
const MANAGED_POLL_PUBLICATION_CLAIM_HEARTBEAT_MS = 15_000;
const MANAGED_POLL_RENDER_LOCK_TTL_MS = 120_000;
const MANAGED_POLL_RENDER_LOCK_HEARTBEAT_MS = 30_000;
const MANAGED_POLL_RENDER_LOCK_WAIT_MS = 4_000;
const MANAGED_POLL_RENDER_MAX_ATTEMPTS = 2;
const MANAGED_POLL_RENDER_REPAIR_ATTEMPTS = 3;
const MANAGED_POLL_RENDER_REPAIR_DELAY_MS = 250;
const MANAGED_POLL_BACKGROUND_REPAIR_BATCH_SIZE = 10;
const MANAGED_POLL_BACKGROUND_RETRY_DELAY_MS = 5 * 60_000;
const MANAGED_POLL_RECENT_EVENT_HASH_LIMIT = 16;
const MANAGED_POLL_AMBIGUOUS_PUBLICATION_ERROR = 'Публикация требует ручной проверки.';
const MANAGED_POLL_AUTHORED_CONTENT_FORMAT_VERSION = 2;

const MANAGED_POLL_LIST_SELECT = {
  id: true,
  chatId: true,
  question: true,
  questionFormat: true,
  imageCount: true,
  status: true,
  visibility: true,
  renderRevision: true,
  renderedRevision: true,
  renderFormatVersion: true,
  publicationMessageId: true,
  publicationUrl: true,
  publishedAt: true,
  closedAt: true,
  lockedAt: true,
  lastError: true,
  lastRenderError: true,
  createdAt: true,
  updatedAt: true,
  options: { orderBy: { position: 'asc' } },
} satisfies Prisma.ManagedPollSelect;

const MANAGED_POLL_HOT_PATH_SELECT = {
  ...MANAGED_POLL_LIST_SELECT,
  actorUserId: true,
  identitySalt: true,
  publicationBotId: true,
  lockToken: true,
  chat: { select: { entityType: true } },
} satisfies Prisma.ManagedPollSelect;

type PollWithOptions = ManagedPoll & { options: ManagedPollOption[] };
type PollListItem = Prisma.ManagedPollGetPayload<{ select: typeof MANAGED_POLL_LIST_SELECT }>;
type PollHotPathItem = Prisma.ManagedPollGetPayload<{
  select: typeof MANAGED_POLL_HOT_PATH_SELECT;
}>;
type PollPublicationMedia = Pick<MaxSendMessageOptions, 'imagePayload' | 'attachments'>;
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
    @Optional() private readonly maxRoutedPublicationService?: MaxRoutedPublicationService,
  ) {}

  async processPendingPollRenderRepairs(): Promise<number> {
    const retryBefore = new Date(Date.now() - MANAGED_POLL_BACKGROUND_RETRY_DELAY_MS);
    const rows = await this.prisma.$queryRaw<Array<{ id: string; chatId: string }>>`
      SELECT "id", "chat_id" AS "chatId"
      FROM "managed_polls"
      WHERE "publication_message_id" IS NOT NULL
        AND (
          "rendered_revision" < "render_revision"
          OR "render_format_version" < ${MANAGED_POLL_AUTHORED_CONTENT_FORMAT_VERSION}
          OR "last_render_error" IS NOT NULL
        )
        AND ("last_render_error" IS NULL OR "updated_at" <= ${retryBefore})
      ORDER BY "updated_at" ASC, "id" ASC
      LIMIT ${MANAGED_POLL_BACKGROUND_REPAIR_BATCH_SIZE}
    `;
    let repaired = 0;
    for (const row of rows) {
      try {
        let renderSucceeded = false;
        const serialized = await this.runPollRenderSerialized(row.id, async () => {
          renderSucceeded = await this.renderPollPublication(
            row.chatId,
            row.id,
            'background-repair',
          );
        });
        if (serialized && renderSucceeded) {
          repaired += 1;
        }
      } catch (error: unknown) {
        this.logger.warn(
          { pollId: row.id, chatId: row.chatId, err: this.formatError(error) },
          'Failed to repair managed poll publication in background',
        );
      }
    }
    return repaired;
  }

  async listChannelPolls(
    chatId: string,
    user: AuthUser,
    query: unknown,
    entityType: ManagedEntityType = 'channel',
  ): Promise<ManagedPollListResponse> {
    await this.adminService.assertManagedEntityReadAccess(chatId, user.userId, entityType);
    const parsed = managedPollListQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    const polls = await this.prisma.managedPoll.findMany({
      where: { chatId },
      select: MANAGED_POLL_LIST_SELECT,
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
        this.pollNeedsRenderRepair(poll) &&
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
    entityType: ManagedEntityType = 'channel',
  ): Promise<ManagedPollDetails> {
    await this.adminService.assertManagedEntityReadAccess(chatId, user.userId, entityType);
    return this.readPollDetails(chatId, pollId);
  }

  async createChannelPoll(
    chatId: string,
    user: AuthUser,
    body: unknown,
    entityType: ManagedEntityType = 'channel',
  ): Promise<ManagedPollDetails> {
    await this.adminService.assertManagedEntityAdminAccess(chatId, user.userId, entityType);
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
            questionFormat: parsed.data.questionFormat,
            visibility: parsed.data.visibility,
            imageCount: parsed.data.images.length,
            images: parsed.data.images as Prisma.InputJsonValue,
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
            action: `CREATE_${this.pollEntityAuditLabel(entityType)}_POLL`,
            payload: {
              pollId: poll.id,
              questionFormat: poll.questionFormat,
              visibility: poll.visibility,
              imageCount: parsed.data.images.length,
              optionsCount: poll.options.length,
            },
          },
        });
        return poll;
      });
      await this.chatContextCache.invalidate(chatId);
      return managedPollDetailsSchema.parse(this.mapPoll(created, new Map(), true));
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
    entityType: ManagedEntityType = 'channel',
  ): Promise<ManagedPollDetails> {
    await this.adminService.assertManagedEntityAdminAccess(chatId, user.userId, entityType);
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
      const questionFormat =
        parsed.data.questionFormat ?? this.normalizeQuestionFormat(poll.questionFormat);
      const images = parsed.data.images ?? this.readPollImages(poll.images);

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
          questionFormat,
          visibility: parsed.data.visibility,
          imageCount: images.length,
          images: images as Prisma.InputJsonValue,
          renderRevision: { increment: 1 },
          lastError: null,
          lastRenderError: null,
        },
      });
      await tx.auditLog.create({
        data: {
          chatId,
          actorUserId: user.userId,
          action: `UPDATE_${this.pollEntityAuditLabel(entityType)}_POLL`,
          payload: {
            pollId,
            questionFormat,
            visibility: parsed.data.visibility,
            imageCount: images.length,
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
    return managedPollDetailsSchema.parse(this.mapPoll(updated, new Map(), true));
  }

  async deleteChannelPoll(
    chatId: string,
    pollId: string,
    user: AuthUser,
    entityType: ManagedEntityType = 'channel',
  ): Promise<{ ok: true }> {
    await this.adminService.assertManagedEntityAdminAccess(chatId, user.userId, entityType);
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
          action: `DELETE_${this.pollEntityAuditLabel(entityType)}_POLL`,
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
    entityType: ManagedEntityType = 'channel',
  ): Promise<ManagedPollDetails> {
    await this.adminService.assertManagedEntityAdminAccess(chatId, user.userId, entityType);
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

    const publicationBotId = this.maxRoutedPublicationService
      ? null
      : await this.resolveFallbackPollBotId(chatId, entityType);
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

    const claimHeartbeat = this.startPublicationClaimHeartbeat(poll.id, lockToken);
    let attempted = false;
    let accepted = false;
    let attemptedPublicationBotId = publicationBotId;
    try {
      const publicationPoll = await this.findPoll(chatId, poll.id);
      const result = buildManagedPollOptionResults(publicationPoll.options, new Map());
      const text = buildManagedPollMessageText({
        question: publicationPoll.question,
        questionFormat: this.normalizeQuestionFormat(publicationPoll.questionFormat),
      });
      const textFormat = this.resolveQuestionTextFormat(publicationPoll.questionFormat);
      const messageOptions: MaxSendMessageOptions = {
        ...(textFormat ? { textFormat } : {}),
        buttons: buildManagedPollButtons(publicationPoll.id, result.options),
        debugContext: { screen: 'managed-poll', action: 'publish' },
      };
      if (!(await claimHeartbeat.renew())) {
        throw new ConflictException(
          `Публикация опроса была сброшена. Проверьте ${this.pollEntityName(entityType)}.`,
        );
      }
      const published = await this.sendPollPublicationWithRetry(
        chatId,
        publicationPoll.id,
        publicationPoll.renderRevision,
        text,
        messageOptions,
        this.readPollImages(publicationPoll.images),
        publicationBotId,
        async (botId) => {
          const boundAttempt = await this.prisma.managedPoll.updateMany({
            where: {
              id: poll.id,
              lockToken,
              status: ManagedPollStatus.DRAFT,
            },
            data: { publicationBotId: botId },
          });
          if (boundAttempt.count === 0) {
            throw new ConflictException(
              `Публикация опроса была сброшена. Проверьте ${this.pollEntityName(entityType)}.`,
            );
          }
          attempted = true;
          attemptedPublicationBotId = botId;
        },
      );
      accepted = true;
      if (!(await claimHeartbeat.stop())) {
        throw new ConflictException(
          `Публикация опроса была сброшена. Проверьте ${this.pollEntityName(entityType)}.`,
        );
      }
      const publishedAt = new Date();
      await this.prisma.$transaction(async (tx) => {
        const promoted = await tx.managedPoll.updateMany({
          where: {
            id: poll.id,
            lockToken,
            status: ManagedPollStatus.DRAFT,
          },
          data: {
            actorUserId: user.userId,
            status: ManagedPollStatus.ACTIVE,
            publicationMessageId: published.messageId,
            publicationBotId: published.botId,
            publicationUrl: published.url,
            publishedAt,
            renderedRevision: publicationPoll.renderRevision,
            renderFormatVersion: MANAGED_POLL_AUTHORED_CONTENT_FORMAT_VERSION,
            images: [],
            lockedAt: null,
            lockToken: null,
            lastError: null,
            lastRenderError: null,
          },
        });
        if (promoted.count === 0) {
          throw new ConflictException(
            `Публикация опроса была сброшена. Проверьте ${this.pollEntityName(entityType)}.`,
          );
        }
        await tx.auditLog.create({
          data: {
            chatId,
            actorUserId: user.userId,
            action: `PUBLISH_${this.pollEntityAuditLabel(entityType)}_POLL`,
            payload: {
              pollId: poll.id,
              questionFormat: this.normalizeQuestionFormat(publicationPoll.questionFormat),
              visibility: publicationPoll.visibility,
              imageCount: this.readPollImages(publicationPoll.images).length,
              optionsCount: publicationPoll.options.length,
              publicationMessageId: published.messageId,
            },
          },
        });
      });
      await this.chatContextCache.invalidate(chatId);
      return this.readPollDetails(chatId, poll.id);
    } catch (error: unknown) {
      await claimHeartbeat.stop();
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
        await this.recordAccessLoss(
          poll,
          attemptedPublicationBotId ?? null,
          'send',
          error,
          entityType,
        );
      }
      throw new BadRequestException(
        ambiguous
          ? `MAX мог принять публикацию. Проверьте ${this.pollEntityName(entityType)} перед повтором.`
          : message || 'Не удалось опубликовать опрос.',
      );
    } finally {
      await claimHeartbeat.stop();
    }
  }

  async closeChannelPoll(
    chatId: string,
    pollId: string,
    user: AuthUser,
    entityType: ManagedEntityType = 'channel',
  ): Promise<ManagedPollDetails> {
    await this.adminService.assertManagedEntityAdminAccess(chatId, user.userId, entityType);
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
            action: `CLOSE_${this.pollEntityAuditLabel(entityType)}_POLL`,
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
    entityType: ManagedEntityType = 'channel',
  ): Promise<ManagedPollDetails> {
    await this.adminService.assertManagedEntityAdminAccess(chatId, user.userId, entityType);
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
    entityType: ManagedEntityType = 'channel',
  ): Promise<ManagedPollDetails> {
    await this.adminService.assertManagedEntityAdminAccess(chatId, user.userId, entityType);
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
          action: `RESET_${this.pollEntityAuditLabel(entityType)}_POLL_PUBLICATION`,
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
    entityType: ManagedEntityType = 'channel',
  ): Promise<ManagedPollVotersResponse> {
    await this.adminService.assertManagedEntityAdminAccess(chatId, user.userId, entityType);
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
      if (poll.imageCount > 0) {
        await this.answerCallback(callbackId, notification, poll.publicationBotId ?? update.botId);
        await this.renderPollPublication(chatId, poll.id, 'vote-media');
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
        select: MANAGED_POLL_HOT_PATH_SELECT,
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
            images: [],
            lockedAt: null,
            lockToken: null,
            lastError: null,
          },
        });
        await tx.auditLog.create({
          data: {
            chatId: poll.chatId,
            actorUserId: poll.actorUserId,
            action: `RECOVER_${this.pollEntityAuditLabel(
              this.managedEntityTypeFromPrisma(poll.chat.entityType),
            )}_POLL_PUBLICATION`,
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
          needsRender: this.pollNeedsRenderRepair(poll),
        };
      }
      if (!poll.options.some((option) => option.id === params.optionId)) {
        return { kind: 'stale' };
      }

      const needsRender = this.pollNeedsRenderRepair(poll);
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
        needsRender,
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
        questionFormat: this.normalizeQuestionFormat(poll.questionFormat),
      });
      const textFormat = this.resolveQuestionTextFormat(poll.questionFormat);
      const options =
        poll.status === ManagedPollStatus.ACTIVE
          ? {
              ...(textFormat ? { textFormat } : {}),
              buttons: buildManagedPollButtons(poll.id, poll.resultOptions),
              debugContext: { screen: 'managed-poll', action },
            }
          : textFormat
            ? { textFormat }
            : undefined;
      const entityType = this.managedEntityTypeFromPrisma(poll.chat.entityType);
      const botId =
        poll.publicationBotId ?? (await this.resolveFallbackPollBotId(chatId, entityType));
      try {
        await this.maxClient.editMessageInlineKeyboard(
          chatId,
          poll.publicationMessageId,
          text,
          options,
          this.buildMaxOptions(
            botId,
            MANAGED_POLL_EDIT_TIMEOUT_MS,
            action === 'background-repair' ? 'background' : 'interactive',
          ),
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
        await this.recordAccessLoss(poll, botId ?? null, 'edit', error, entityType);
        this.logger.warn(
          { pollId: poll.id, chatId, action, err: message },
          'Failed to render managed poll publication',
        );
        if (this.shouldSchedulePollRenderRepair(action)) {
          this.schedulePollRenderRepair(chatId, poll.id);
        }
        return false;
      }
    }
    if (this.shouldSchedulePollRenderRepair(action)) {
      this.schedulePollRenderRepair(chatId, pollId);
    }
    return false;
  }

  private buildCallbackMessageEdit(
    poll: Awaited<ReturnType<ManagedPollService['loadPollAggregate']>>,
  ) {
    const text = buildManagedPollMessageText({
      question: poll.question,
      questionFormat: this.normalizeQuestionFormat(poll.questionFormat),
    });
    const textFormat = this.resolveQuestionTextFormat(poll.questionFormat);
    return {
      text,
      ...(poll.status === ManagedPollStatus.ACTIVE || textFormat
        ? {
            options: {
              ...(textFormat ? { textFormat } : {}),
              ...(poll.status === ManagedPollStatus.ACTIVE
                ? {
                    buttons: buildManagedPollButtons(poll.id, poll.resultOptions),
                    debugContext: { screen: 'managed-poll', action: 'vote' },
                  }
                : {}),
            },
          }
        : {}),
    };
  }

  private async loadPollAggregate(chatId: string, pollId: string) {
    const poll = await this.findPollForHotPath(chatId, pollId);
    const counts = await this.loadVoteCounts([poll.id]);
    const result = buildManagedPollOptionResults(
      poll.options,
      new Map(
        poll.options.map((option) => [option.id, counts.get(`${poll.id}:${option.id}`) ?? 0]),
      ),
    );
    return {
      ...poll,
      totalVotes: result.totalVotes,
      resultOptions: result.options,
    };
  }

  private async readPollDetails(chatId: string, pollId: string): Promise<ManagedPollDetails> {
    const poll = await this.findPoll(chatId, pollId);
    const counts = await this.loadVoteCounts([poll.id]);
    const details = managedPollDetailsSchema.parse(this.mapPoll(poll, counts, true));
    if (
      poll.publicationMessageId &&
      !poll.lastRenderError &&
      this.pollNeedsRenderRepair(poll) &&
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

  private async findPollForHotPath(chatId: string, pollId: string): Promise<PollHotPathItem> {
    const poll = await this.prisma.managedPoll.findFirst({
      where: { id: pollId, chatId },
      select: MANAGED_POLL_HOT_PATH_SELECT,
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

  private mapPoll(
    poll: PollWithOptions | PollListItem,
    counts: ReadonlyMap<string, number>,
    includeImages = false,
  ) {
    const optionCounts = new Map(
      poll.options.map((option) => [option.id, counts.get(`${poll.id}:${option.id}`) ?? 0]),
    );
    const result = buildManagedPollOptionResults(poll.options, optionCounts);
    const publicationNeedsReview = this.publicationNeedsReview(poll);
    const images = includeImages && 'images' in poll ? this.readPollImages(poll.images) : [];
    return {
      id: poll.id,
      channelId: poll.chatId,
      question: poll.question,
      questionFormat: this.normalizeQuestionFormat(poll.questionFormat),
      status: poll.status,
      visibility: poll.visibility,
      imageCount: poll.imageCount,
      totalVotes: result.totalVotes,
      options: result.options,
      ...(includeImages ? { images } : {}),
      publicationMessageId: poll.publicationMessageId,
      publicationUrl: poll.publicationUrl,
      publicationPending: Boolean(poll.lockedAt) && !publicationNeedsReview,
      publicationNeedsReview,
      renderRepairNeeded: this.pollNeedsRenderRepair(poll),
      publishedAt: poll.publishedAt?.toISOString() ?? null,
      closedAt: poll.closedAt?.toISOString() ?? null,
      createdAt: poll.createdAt.toISOString(),
      updatedAt: poll.updatedAt.toISOString(),
      lastError: poll.lastError,
      lastRenderError: poll.lastRenderError,
    };
  }

  private normalizeQuestionFormat(value: unknown): ManagedPollQuestionFormat {
    return value === 'markdown' ? 'markdown' : 'plain';
  }

  private resolveQuestionTextFormat(
    questionFormat: unknown,
  ): MaxSendMessageOptions['textFormat'] | undefined {
    return this.normalizeQuestionFormat(questionFormat) === 'markdown' ? 'html' : undefined;
  }

  private readPollImages(value: unknown): ManagedPollImage[] {
    const parsed = managedPollImagesSchema.safeParse(value);
    return parsed.success ? parsed.data : [];
  }

  private async resolvePollPublicationMedia(
    images: readonly ManagedPollImage[],
    botId: string | null | undefined,
  ): Promise<PollPublicationMedia> {
    const preparedImages = images.map((image) => ({
      image,
      mimeType: image.mimeType.trim().toLowerCase(),
      buffer: this.validatePollImage(image),
    }));
    const totalBytes = preparedImages.reduce((total, image) => total + image.buffer.length, 0);
    if (totalBytes > BROADCAST_IMAGES_TOTAL_MAX_BYTES) {
      throw new BadRequestException('Суммарный размер фото слишком большой.');
    }

    const payloads: Record<string, unknown>[] = [];
    for (const prepared of preparedImages) {
      payloads.push(
        await this.uploadPollImage(prepared.image, prepared.buffer, prepared.mimeType, botId),
      );
    }

    if (payloads.length === 1) {
      return { imagePayload: payloads[0] };
    }
    if (payloads.length > 1) {
      return {
        attachments: payloads.map((payload): MaxAttachmentPayload => ({ type: 'image', payload })),
      };
    }
    return {};
  }

  private validatePollImage(image: ManagedPollImage): Buffer {
    const mimeType = image.mimeType.trim().toLowerCase();
    if (!mimeType.startsWith('image/')) {
      throw new BadRequestException('Поддерживаются только изображения.');
    }

    let buffer: Buffer;
    try {
      buffer = decodeBroadcastImageBase64(image.base64);
    } catch {
      throw new BadRequestException('Не удалось прочитать фото.');
    }
    if (buffer.length > BROADCAST_IMAGE_MAX_BYTES) {
      throw new BadRequestException('Фото слишком большое. Попробуйте другое изображение.');
    }
    return buffer;
  }

  private async uploadPollImage(
    image: ManagedPollImage,
    buffer: Buffer,
    mimeType: string,
    botId: string | null | undefined,
  ): Promise<Record<string, unknown>> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.maxClient.uploadImage(
          buffer,
          resolveBroadcastImageFileName(image.fileName, mimeType),
          mimeType,
          this.buildMaxOptions(botId, MANAGED_POLL_UPLOAD_TIMEOUT_MS),
        );
      } catch (error: unknown) {
        const retryDelayMs = resolveManagedBroadcastUploadRetryDelayMs(error, attempt);
        if (retryDelayMs === null) {
          throw error;
        }
        await this.delay(retryDelayMs);
      }
    }
  }

  private async sendPollPublicationWithRetry(
    chatId: string,
    pollId: string,
    renderRevision: number,
    text: string,
    options: MaxSendMessageOptions,
    images: readonly ManagedPollImage[],
    botId: string | null | undefined,
    onAttemptBotId?: (botId: string) => void | Promise<void>,
  ): Promise<MaxRoutedPublicationResult> {
    if (!this.maxRoutedPublicationService && process.env.NODE_ENV === 'production') {
      throw new ServiceUnavailableException(
        'Routed MAX publication service is required for production managed polls',
      );
    }
    const fallbackMedia = this.maxRoutedPublicationService
      ? null
      : await this.resolvePollPublicationMedia(images, botId);
    for (let attempt = 1; ; attempt += 1) {
      try {
        if (this.maxRoutedPublicationService) {
          return await this.maxRoutedPublicationService.publish({
            entityId: chatId,
            logicalIdempotencyKey: `managed-poll:publish:${pollId}:revision:${renderRevision}:format:${MANAGED_POLL_AUTHORED_CONTENT_FORMAT_VERSION}`,
            routePurpose: 'channel_poll',
            text,
            options,
            trafficClass: 'interactive',
            sourceTag: MAX_API_SOURCE_TAGS.MANAGED_POLL,
            timeoutMs: MANAGED_POLL_SEND_TIMEOUT_MS,
            prepareAttempt: async ({ botId: routedBotId }) => ({
              options: {
                ...options,
                ...(await this.resolvePollPublicationMedia(images, routedBotId)),
              },
            }),
            onDispatchAttempt: async ({ botId: routedBotId }) => {
              await onAttemptBotId?.(routedBotId);
            },
          });
        }

        const resolvedBotId = botId?.trim() ?? '';
        if (!resolvedBotId) {
          throw new Error('No bot with send/edit access is available for managed poll publish');
        }
        await onAttemptBotId?.(resolvedBotId);
        const published = await this.maxClient.sendMessageImmediateWithResolvedLink(
          chatId,
          text,
          {
            ...options,
            ...(fallbackMedia ?? {}),
          },
          this.buildMaxOptions(resolvedBotId, MANAGED_POLL_SEND_TIMEOUT_MS),
        );
        return {
          ...published,
          botId: resolvedBotId,
          candidateBotIds: [resolvedBotId],
          routingVersion: null,
        };
      } catch (error: unknown) {
        if (isAmbiguousMaxSendError(error)) {
          throw error;
        }
        const retryDelayMs = resolveManagedBroadcastSendRetryDelayMs(error, attempt, options);
        if (retryDelayMs === null) {
          throw error;
        }
        await this.delay(retryDelayMs);
      }
    }
  }

  private startPublicationClaimHeartbeat(
    pollId: string,
    lockToken: string,
  ): {
    renew: () => Promise<boolean>;
    stop: () => Promise<boolean>;
  } {
    let stopped = false;
    let claimStillOwned = true;
    let refreshChain = Promise.resolve();
    const renew = (): Promise<boolean> => {
      if (stopped || !claimStillOwned) {
        return Promise.resolve(claimStillOwned);
      }
      refreshChain = refreshChain
        .then(async () => {
          if (!claimStillOwned) {
            return;
          }
          const refreshed = await this.prisma.managedPoll.updateMany({
            where: {
              id: pollId,
              lockToken,
              status: ManagedPollStatus.DRAFT,
            },
            data: { lockedAt: new Date() },
          });
          if (refreshed.count === 0) {
            claimStillOwned = false;
            this.logger.warn(
              { pollId },
              'Managed poll publication claim was lost while media was being prepared',
            );
          }
        })
        .catch((error: unknown) => {
          claimStillOwned = false;
          this.logger.warn(
            { pollId, err: this.formatError(error) },
            'Managed poll publication claim could not be renewed',
          );
        });
      return refreshChain.then(() => claimStillOwned);
    };
    const timer = setInterval(() => {
      void renew();
    }, MANAGED_POLL_PUBLICATION_CLAIM_HEARTBEAT_MS);
    timer.unref?.();

    return {
      renew,
      stop: async () => {
        if (!stopped) {
          stopped = true;
          clearInterval(timer);
        }
        await refreshChain;
        return claimStillOwned;
      },
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

  private buildMaxOptions(
    botId: string | null | undefined,
    timeoutMs: number,
    trafficClass: MaxApiTrafficClass = 'interactive',
  ) {
    return {
      ...(botId?.trim() ? { botId: botId.trim() } : {}),
      trafficClass,
      actionHealthLane:
        trafficClass === 'background' ? ('background' as const) : ('interactive' as const),
      sourceTag: MAX_API_SOURCE_TAGS.MANAGED_POLL,
      timeoutMs,
    };
  }

  private shouldSchedulePollRenderRepair(action: string): boolean {
    return action !== 'coalesced-repair' && action !== 'background-repair';
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
      data: {
        renderedRevision: renderRevision,
        renderFormatVersion: MANAGED_POLL_AUTHORED_CONTENT_FORMAT_VERSION,
        lastRenderError: null,
      },
    });
    return updated.count > 0;
  }

  private pollNeedsRenderRepair(
    poll: Pick<
      ManagedPoll,
      | 'lastRenderError'
      | 'publicationMessageId'
      | 'renderedRevision'
      | 'renderRevision'
      | 'renderFormatVersion'
    >,
  ): boolean {
    return (
      Boolean(poll.publicationMessageId) &&
      (Boolean(poll.lastRenderError) ||
        poll.renderedRevision < poll.renderRevision ||
        poll.renderFormatVersion < MANAGED_POLL_AUTHORED_CONTENT_FORMAT_VERSION)
    );
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

  private pollEntityAuditLabel(entityType: ManagedEntityType): 'CHAT' | 'CHANNEL' {
    return entityType === 'channel' ? 'CHANNEL' : 'CHAT';
  }

  private pollEntityName(entityType: ManagedEntityType): 'чат' | 'канал' {
    return entityType === 'channel' ? 'канал' : 'чат';
  }

  private managedEntityTypeFromPrisma(entityType: ChatEntityType): ManagedEntityType {
    return entityType === ChatEntityType.CHANNEL ? 'channel' : 'chat';
  }

  private async resolveFallbackPollBotId(
    chatId: string,
    entityType: ManagedEntityType,
  ): Promise<string | undefined> {
    return entityType === 'channel'
      ? this.adminService.resolveChannelPollBotId(chatId)
      : this.adminService.resolveChatPollBotId(chatId);
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
    entityType: ManagedEntityType,
  ): Promise<void> {
    try {
      await this.managedEntityAccessLossService?.recordIfManagedEntityAccessLost({
        chatId: poll.chatId,
        botId,
        entityType: entityType === 'channel' ? ChatEntityType.CHANNEL : ChatEntityType.CHAT,
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
