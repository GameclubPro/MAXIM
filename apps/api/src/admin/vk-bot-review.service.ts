import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { vkBotReviewSettingsRequestSchema, type VkBotReviewState } from '@maxim/contracts';
import type { Job } from 'bullmq';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { MaxBotLinkService } from '../max/max-bot-link.service';
import {
  MAX_API_SOURCE_TAGS,
  MaxClientService,
  type MaxMessageButton,
} from '../max/max-client.service';
import { Prisma, type VkBotReview } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { getAppRole, roleRunsPublisher } from '../runtime/app-role';
import {
  PublisherVkBotReviewQueueService,
  type VkBotReviewJob,
} from '../publisher/publisher-vk-bot-review.queue';
import { BackgroundRuntimeGovernorService } from '../system/background-runtime-governor.service';
import { VkParsingAccessService } from './vk-parsing-access.service';
import { VkParsingOwnershipService } from './vk-parsing-ownership.service';
import { VkPublishService } from './vk-publish.service';
import {
  isVkMaxSendAmbiguous,
  isVkMaxSendConfirmedPersistencePending,
} from './vk-publish-quarantine';
import {
  buildVkBotReviewFingerprint,
  isDefiniteVkReviewSendRejection,
  VK_BOT_REVIEW_CHANNEL_LIMIT,
  VK_BOT_REVIEW_MODE,
  VK_BOT_REVIEW_START,
  VK_BOT_REVIEW_USER_LIMIT,
  vkBotReviewCallback,
} from './vk-bot-review-protocol';

type ReviewRow = Prisma.VkBotReviewGetPayload<{
  include: { post: { include: { source: true; chat: true } } };
}>;
const includePost = { post: { include: { source: true, chat: true } } } as const;
const LATER = new Date('9999-01-01T00:00:00Z');
const LEASE_MS = 10 * 60_000;
const CONTINUATION_STATES = new Set([
  'CONTENT_SENT',
  'CONTENT_SENDING',
  'CONTROL_SENDING',
  'PREPARING',
]);
const DRAIN_STATES = [...CONTINUATION_STATES, 'DELIVERED', 'QUEUED', 'ERROR'] as const;

@Injectable()
export class VkBotReviewService {
  private readonly logger = new Logger(VkBotReviewService.name);
  private readonly startedAt = new Date();
  private legacyCalendarDeferralsChecked = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: VkParsingAccessService,
    private readonly ownership: VkParsingOwnershipService,
    private readonly publish: VkPublishService,
    private readonly max: MaxClientService,
    private readonly links: MaxBotLinkService,
    private readonly queue: PublisherVkBotReviewQueueService,
    private readonly config: ConfigService,
    private readonly governor: BackgroundRuntimeGovernorService,
  ) {}

  get enabled(): boolean {
    return this.config.get<boolean>('VK_BOT_REVIEW_ENABLED') ?? true;
  }

  async getState(chatId: string, user: AuthUser): Promise<VkBotReviewState> {
    const entity = await this.access.assertAccess(chatId, user);
    const scope = this.ownership.getPublisherScope();
    const settings = await this.settings(chatId);
    const inbox = await this.prisma.vkBotReviewInbox.findUnique({
      where: { botId_userId: { botId: scope.ownerBotId, userId: user.userId } },
    });
    return {
      available: this.enabled && entity === 'CHANNEL',
      inboxConnected: Boolean(inbox),
      isRecipient: settings?.botReviewRecipientUserId === user.userId,
      recipientConfigured: Boolean(settings?.botReviewRecipientUserId),
      paused: settings?.botReviewPaused ?? false,
      pendingCount: await this.prisma.vkBotReview.count({
        where: { post: { chatId, ...scope }, status: 'PENDING' },
      }),
      botUrl:
        this.links.buildPublisherBotStartUrlSync(VK_BOT_REVIEW_START) ??
        this.links.buildPublisherBotUrlSync(),
    };
  }

  async configure(chatId: string, user: AuthUser, body: unknown): Promise<VkBotReviewState> {
    const entity = await this.access.assertAccess(chatId, user);
    if (!this.enabled)
      throw new ServiceUnavailableException('Согласование в боте временно отключено.');
    if (entity !== 'CHANNEL')
      throw new BadRequestException('Согласование доступно только для каналов.');
    const parsed = vkBotReviewSettingsRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.format());
    const scope = this.ownership.getPublisherScope();
    const inbox = await this.prisma.vkBotReviewInbox.findUnique({
      where: { botId_userId: { botId: scope.ownerBotId, userId: user.userId } },
    });
    if (!inbox)
      throw new BadRequestException('Сначала откройте личку бота и подключите VK-предложку.');
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM chats WHERE id = ${chatId} FOR UPDATE`;
      const where = { chatId_ownerProfile_ownerBotId: { chatId, ...scope } };
      const current = await tx.vkParsingSettings.findUnique({ where });
      if (current?.botReviewRecipientUserId && current.botReviewRecipientUserId !== user.userId) {
        throw new ConflictException('Для этого канала уже назначен другой согласующий.');
      }
      const data = {
        botReviewRecipientUserId: user.userId,
        botReviewPaused: parsed.data.action === 'PAUSE',
      };
      await tx.vkParsingSettings.upsert({
        where,
        create: { chatId, ...scope, ...data },
        update: data,
      });
      await tx.auditLog.create({
        data: {
          chatId,
          actorUserId: user.userId,
          action: 'VK_PARSING_BOT_REVIEW_SETTINGS',
          payload: { ...scope, action: parsed.data.action },
        },
      });
    });
    await this.queue.enqueueTick();
    return this.getState(chatId, user);
  }

  async submitPost(chatId: string, postId: string, user: AuthUser): Promise<VkBotReviewState> {
    await this.access.assertAccess(chatId, user);
    if (!this.enabled) throw new ServiceUnavailableException('Согласование временно отключено.');
    const scope = this.ownership.getPublisherScope();
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM chats WHERE id = ${chatId} FOR UPDATE`;
      const settings = await tx.vkParsingSettings.findUnique({
        where: { chatId_ownerProfile_ownerBotId: { chatId, ...scope } },
      });
      if (settings?.botReviewRecipientUserId !== user.userId)
        throw new ForbiddenException('Вы не назначены согласующим этого канала.');
      const post = await tx.vkParsingPost.findFirst({
        where: {
          id: postId,
          chatId,
          ...scope,
          source: { ...scope, status: 'ACTIVE', publishMode: VK_BOT_REVIEW_MODE },
        },
        include: { botReview: true },
      });
      if (
        !post ||
        post.status !== 'NEW' ||
        post.publishIdempotencyKey ||
        post.publishAttemptCount > 0
      )
        throw new ConflictException('Пост недоступен для согласования.');
      if (
        post.botReview &&
        (post.botReview.status !== 'PENDING' || post.botReview.deliveryState === 'AMBIGUOUS')
      ) {
        throw new ConflictException('Решение или неопределённую отправку нельзя сбросить.');
      }
      await tx.vkBotReview.upsert({
        where: { postId },
        create: { postId, recipientUserId: user.userId },
        update: { nextAttemptAt: new Date() },
      });
      await tx.auditLog.create({
        data: {
          chatId,
          actorUserId: user.userId,
          action: 'VK_PARSING_BOT_REVIEW_SUBMIT',
          payload: { ...scope, postId },
        },
      });
    });
    await this.queue.enqueueTick();
    return this.getState(chatId, user);
  }

  async process(job: Job<VkBotReviewJob>): Promise<void> {
    if (!roleRunsPublisher(getAppRole()) || process.env.APP_SERVICE_NAME !== 'api-publisher')
      throw new Error('VK review requires api-publisher');
    if (job.data.requiredBotId !== this.ownership.getPublisherScope().ownerBotId || !this.enabled)
      return;
    if (job.data.action === 'tick') {
      await this.drain();
      return;
    }
    const { userId, privateChatId } = job.data;
    if (
      !userId ||
      !privateChatId ||
      Date.now() - Date.parse(job.data.requestedAt) > 24 * 60 * 60_000
    )
      return;
    try {
      if (job.data.action === 'connect') {
        await this.prisma.$executeRaw`
          INSERT INTO vk_bot_review_inboxes (bot_id, user_id, private_chat_id, confirmed_at)
          VALUES (${job.data.requiredBotId}, ${userId}, ${privateChatId}, ${new Date(job.data.requestedAt)})
          ON CONFLICT (bot_id, user_id) DO UPDATE
          SET private_chat_id = EXCLUDED.private_chat_id, confirmed_at = EXCLUDED.confirmed_at
          WHERE vk_bot_review_inboxes.confirmed_at <= EXCLUDED.confirmed_at
        `;
        await this.sendMenu(job);
      } else {
        const inbox = await this.prisma.vkBotReviewInbox.findUnique({
          where: { botId_userId: { botId: job.data.requiredBotId, userId } },
        });
        if (inbox?.privateChatId !== privateChatId)
          throw new ForbiddenException('Личный диалог не подтверждён.');
        if (job.data.action === 'menu') await this.sendMenu(job);
        else if (job.data.action === 'pause' || job.data.action === 'resume') {
          const row = await this.prisma.vkParsingSettings.findFirst({
            where: {
              id: job.data.id,
              ...this.ownership.getPublisherScope(),
              botReviewRecipientUserId: userId,
            },
          });
          if (!row) throw new ForbiddenException('Канал недоступен.');
          await this.configure(row.chatId, this.actor(job.data), {
            action: job.data.action === 'pause' ? 'PAUSE' : 'RESUME',
          });
          await this.sendMenu(job);
        } else await this.decide(job.data);
      }
      await this.answer(job.data, 'Готово.');
    } catch (error) {
      await this.answer(
        job.data,
        error instanceof BadRequestException ||
          error instanceof ConflictException ||
          error instanceof ForbiddenException
          ? error.message
          : 'Не удалось выполнить действие. Попробуйте позже.',
      );
      if (
        !(
          error instanceof BadRequestException ||
          error instanceof ConflictException ||
          error instanceof ForbiddenException
        )
      )
        throw error;
    }
    await this.queue.enqueueTick(5000);
  }

  private async decide(data: VkBotReviewJob): Promise<void> {
    let row = await this.prisma.vkBotReview.findFirst({
      where: {
        id: data.id,
        recipientUserId: data.userId,
        post: this.ownership.getPublisherScope(),
      },
      include: includePost,
    });
    if (
      !row ||
      row.revision !== data.revision ||
      row.privateChatId !== data.privateChatId ||
      row.controlMessageId !== data.messageId ||
      row.deliveryState !== 'DELIVERED'
    ) {
      throw new ConflictException('Эта кнопка устарела.');
    }
    await this.assertEditor(row);
    if (
      (data.action === 'publish' && row.status === 'APPROVED') ||
      (data.action === 'reject' && row.status === 'REJECTED')
    )
      return;
    if (row.status !== 'PENDING') throw new ConflictException('Пост уже обработан.');
    if (data.action === 'refresh') {
      await this.refresh(row);
      return;
    }
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM chats WHERE id = ${row!.post.chatId} FOR UPDATE`;
      const current = await tx.vkParsingPost.findUnique({
        where: { id: row!.postId },
        include: { source: true },
      });
      const settings = await tx.vkParsingSettings.findUnique({
        where: {
          chatId_ownerProfile_ownerBotId: {
            chatId: row!.post.chatId,
            ...this.ownership.getPublisherScope(),
          },
        },
      });
      if (
        !current ||
        current.source.publishMode !== VK_BOT_REVIEW_MODE ||
        current.source.status !== 'ACTIVE' ||
        !settings ||
        settings.botReviewRecipientUserId !== data.userId ||
        !['NEW', 'FAILED'].includes(current.status) ||
        current.publishIdempotencyKey ||
        current.publishedMessageId
      )
        throw new ConflictException('Состояние поста изменилось.');
      if (
        data.action === 'publish' &&
        (row!.fingerprint !== buildVkBotReviewFingerprint(current, settings) ||
          current.status !== 'NEW')
      ) {
        throw new ConflictException('Пост изменился. Обновите превью перед публикацией.');
      }
      const status = data.action === 'publish' ? 'APPROVED' : 'REJECTED';
      const changed = await tx.vkBotReview.updateMany({
        where: {
          id: row!.id,
          revision: data.revision,
          status: 'PENDING',
          fingerprint: row!.fingerprint,
        },
        data: {
          status,
          decidedAt: now,
          decidedByUserId: data.userId,
          lastError: null,
          nextAttemptAt: now,
        },
      });
      if (!changed.count) throw new ConflictException('Пост уже обработан.');
      await tx.auditLog.create({
        data: {
          chatId: row!.post.chatId,
          actorUserId: data.userId!,
          action: 'VK_PARSING_BOT_REVIEW_DECISION',
          payload: {
            ...this.ownership.getPublisherScope(),
            postId: row!.postId,
            revision: row!.revision,
            status,
          },
        },
      });
    });
    if (data.action === 'publish') {
      try {
        await this.publish.publishBotReviewedPost(row.id);
      } catch (error) {
        this.logger.warn(
          { err: error, reviewId: row.id },
          'VK review publication admission deferred',
        );
      }
    }
    row = await this.prisma.vkBotReview.findUnique({ where: { id: row.id }, include: includePost });
    if (row) await this.syncCard(row);
  }

  private async refresh(row: ReviewRow): Promise<void> {
    const post = await this.prisma.vkParsingPost.findUnique({ where: { id: row.postId } });
    if (!post || post.publishIdempotencyKey || post.publishAttemptCount > 0)
      throw new ConflictException('Публикация уже началась.');
    // FLAG: Old buttons are disabled before rotating their version; ambiguous delivery is never reset.
    await this.max.editMessageInlineKeyboard(
      row.privateChatId!,
      row.controlMessageId!,
      'Превью обновляется.',
      { buttons: [] },
      this.requestOptions(),
    );
    await this.prisma.vkBotReview.updateMany({
      where: { id: row.id, status: 'PENDING', revision: row.revision, deliveryState: 'DELIVERED' },
      data: {
        revision: { increment: 1 },
        deliveryState: 'QUEUED',
        snapshot: Prisma.DbNull,
        fingerprint: null,
        contentMessageId: null,
        controlMessageId: null,
        presentationKey: null,
        lastError: null,
        nextAttemptAt: new Date(),
      },
    });
  }

  private async drain(): Promise<void> {
    const now = new Date();
    await this.releaseLegacyCalendarDeferrals(now);
    const rows: ReviewRow[] = [];
    // FLAG: Finish existing message pairs before admitting new previews. Each literal state
    // gets its own bounded index walk so a large unsent backlog cannot hide its controls.
    for (const deliveryState of DRAIN_STATES) {
      rows.push(
        ...(await this.prisma.vkBotReview.findMany({
          where: {
            post: this.ownership.getPublisherScope(),
            deliveryState,
            nextAttemptAt: { lte: now },
          },
          include: includePost,
          orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
          take: 10,
        })),
      );
    }
    // FLAG: Recurring card refreshes must not monopolize the recipient's single step.
    // Finish in-flight pairs first, then serve deadlines with new deliveries winning ties.
    rows.sort((left, right) => {
      const leftPriority = CONTINUATION_STATES.has(left.deliveryState) ? 0 : 1;
      const rightPriority = CONTINUATION_STATES.has(right.deliveryState) ? 0 : 1;
      return (
        leftPriority - rightPriority ||
        left.nextAttemptAt.getTime() - right.nextAttemptAt.getTime() ||
        Number(left.deliveryState === 'DELIVERED') - Number(right.deliveryState === 'DELIVERED') ||
        left.id.localeCompare(right.id)
      );
    });
    const recipients = new Set<string>();
    for (const row of rows) {
      const fresh = row.status === 'PENDING' && ['QUEUED', 'ERROR'].includes(row.deliveryState);
      if (recipients.has(row.recipientUserId)) {
        if (fresh) await this.defer(row, new Date(now.getTime() + 30_000));
        continue;
      }
      if (fresh && !(await this.hasRoom(row))) {
        await this.defer(row, new Date(now.getTime() + 30_000));
        continue;
      }
      recipients.add(row.recipientUserId);
      try {
        await this.advance(row);
      } catch (error) {
        this.logger.warn({ err: error, reviewId: row.id }, 'VK review step deferred');
        await this.prisma.vkBotReview.updateMany({
          where: { id: row.id, revision: row.revision },
          data: { lastError: publicError(error), nextAttemptAt: new Date(Date.now() + 60_000) },
        });
      }
      if (recipients.size >= 5) break;
    }
    if (rows.length) {
      await this.queue.enqueueTick(5000);
    } else {
      await this.scheduleDeferredTick();
    }
  }

  private async scheduleDeferredTick(): Promise<void> {
    let nextAttemptMs = Number.POSITIVE_INFINITY;
    // FLAG: An empty due batch does not mean an empty inbox. Keep a wake-up for deferred
    // rows so delivered-card maintenance cannot repeatedly postpone unsent reviews.
    for (const deliveryState of DRAIN_STATES) {
      const next = await this.prisma.vkBotReview.findFirst({
        where: {
          post: this.ownership.getPublisherScope(),
          deliveryState,
          nextAttemptAt: { lt: LATER },
        },
        select: { nextAttemptAt: true },
        orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
      });
      if (next) nextAttemptMs = Math.min(nextAttemptMs, next.nextAttemptAt.getTime());
    }
    if (Number.isFinite(nextAttemptMs)) {
      await this.queue.enqueueTick(Math.max(5000, nextAttemptMs - Date.now()));
    }
  }

  private async releaseLegacyCalendarDeferrals(now: Date): Promise<void> {
    if (this.legacyCalendarDeferralsChecked) return;
    const retryBoundMs = Math.max(
      5 * 60_000,
      this.config.get<number>('BACKGROUND_GOVERNOR_PAUSE_RETRY_AFTER_MS') ?? 120_000,
    );
    let exhausted = true;
    // FLAG: Release only pre-start calendar-sized delays, never send leases, ambiguous
    // outcomes, terminal sentinels or ordinary retries. Every send still rechecks admission.
    for (const deliveryState of ['QUEUED', 'ERROR', 'CONTENT_SENT']) {
      const rows = await this.prisma.vkBotReview.findMany({
        where: {
          post: this.ownership.getPublisherScope(),
          status: 'PENDING',
          deliveryState,
          nextAttemptAt: { gt: new Date(now.getTime() + retryBoundMs), lt: LATER },
          updatedAt: { lt: this.startedAt },
        },
        select: { id: true, revision: true, nextAttemptAt: true },
        orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
        take: 10,
      });
      if (rows.length === 10) exhausted = false;
      for (const row of rows) {
        await this.prisma.vkBotReview.updateMany({
          where: {
            id: row.id,
            revision: row.revision,
            post: this.ownership.getPublisherScope(),
            status: 'PENDING',
            deliveryState,
            nextAttemptAt: row.nextAttemptAt,
            updatedAt: { lt: this.startedAt },
          },
          data: { nextAttemptAt: now },
        });
      }
    }
    this.legacyCalendarDeferralsChecked = exhausted;
  }

  private async advance(row: ReviewRow): Promise<void> {
    const now = new Date();
    if (['CONTENT_SENDING', 'CONTROL_SENDING'].includes(row.deliveryState)) {
      await this.prisma.vkBotReview.updateMany({
        where: { id: row.id, revision: row.revision, deliveryState: row.deliveryState },
        data: {
          deliveryState: 'AMBIGUOUS',
          lastError: 'Результат отправки в личку неизвестен. Автоповтор остановлен.',
          nextAttemptAt: LATER,
        },
      });
      return;
    }
    if (row.deliveryState === 'AMBIGUOUS') return;
    if (row.deliveryState === 'PREPARING') {
      await this.prisma.vkBotReview.updateMany({
        where: { id: row.id, revision: row.revision, deliveryState: 'PREPARING' },
        data: { deliveryState: 'QUEUED', nextAttemptAt: now },
      });
      return;
    }
    const settings = await this.settings(row.post.chatId);
    if (row.status === 'APPROVED') {
      if (
        ['NEW', 'FAILED'].includes(row.post.status) &&
        !row.post.publishIdempotencyKey &&
        !row.post.publishLockedAt &&
        row.post.publishAttemptCount === 0 &&
        !isVkMaxSendAmbiguous(row.post.lastError) &&
        !isVkMaxSendConfirmedPersistencePending(row.post.lastError) &&
        (row.lastError ||
          row.post.lastError ||
          !settings ||
          row.fingerprint !== buildVkBotReviewFingerprint(row.post, settings))
      ) {
        await this.prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM chats WHERE id = ${row.post.chatId} FOR UPDATE`;
          const reset = await tx.vkParsingPost.updateMany({
            where: {
              id: row.postId,
              status: row.post.status,
              lastError: row.post.lastError,
              publishIdempotencyKey: null,
              publishLockedAt: null,
              publishAttemptCount: 0,
              publishedMessageId: null,
            },
            data: { status: 'NEW', lastError: null },
          });
          if (!reset.count) return;
          await tx.vkBotReview.updateMany({
            where: {
              id: row.id,
              status: 'APPROVED',
              revision: row.revision,
              post: {
                publishIdempotencyKey: null,
                publishLockedAt: null,
                publishAttemptCount: 0,
                publishedMessageId: null,
                status: 'NEW',
              },
            },
            data: {
              status: 'PENDING',
              decidedAt: null,
              decidedByUserId: null,
              lastError: null,
              nextAttemptAt: now,
            },
          });
        });
        return;
      }
      if (row.post.status === 'NEW' && !row.post.publishIdempotencyKey && !row.lastError) {
        try {
          await this.assertEditor(row);
          await this.publish.publishBotReviewedPost(row.id);
        } catch (error) {
          await this.prisma.vkBotReview.updateMany({
            where: { id: row.id, status: 'APPROVED' },
            data: { lastError: publicError(error) },
          });
        }
      }
      const latest = await this.prisma.vkBotReview.findUnique({
        where: { id: row.id },
        include: includePost,
      });
      if (latest) await this.syncCard(latest);
      return;
    }
    if (row.status !== 'PENDING') {
      await this.syncCard(row);
      return;
    }
    if (
      !settings ||
      settings.botReviewRecipientUserId !== row.recipientUserId ||
      row.post.source.publishMode !== VK_BOT_REVIEW_MODE ||
      row.post.source.status !== 'ACTIVE' ||
      !['NEW', 'FAILED'].includes(row.post.status)
    ) {
      await this.prisma.vkBotReview.updateMany({
        where: { id: row.id, status: 'PENDING' },
        data: {
          status: 'CANCELLED',
          lastError: 'Источник или пост больше недоступен.',
          nextAttemptAt: now,
        },
      });
      return;
    }
    if (row.deliveryState === 'DELIVERED') {
      await this.syncCard(row);
      return;
    }
    if (settings.botReviewPaused || !row.post.source.importEnabled) {
      await this.defer(row, new Date(now.getTime() + 60_000));
      return;
    }
    const decision = await this.governor.decide({
      component: 'vk_bot_review',
      sourceTag: MAX_API_SOURCE_TAGS.VK_PARSING,
    });
    if (decision.action === 'pause') {
      await this.defer(row, new Date(Date.now() + decision.retryAfterMs));
      return;
    }
    await this.assertEditor(row);
    const inbox = await this.prisma.vkBotReviewInbox.findUnique({
      where: {
        botId_userId: {
          botId: row.post.ownerBotId,
          userId: row.recipientUserId,
        },
      },
    });
    if (!inbox) {
      await this.defer(row, new Date(now.getTime() + 60_000));
      return;
    }
    if (row.contentMessageId && row.privateChatId !== inbox.privateChatId)
      throw new ConflictException('Личный диалог изменился.');
    if (row.deliveryState === 'CONTENT_SENT') {
      await this.deliverControl(row);
      return;
    }
    if (!(await this.hasRoom(row))) {
      await this.defer(row, new Date(now.getTime() + 30_000));
      return;
    }
    await this.deliverContent(row, inbox.privateChatId);
  }

  private async hasRoom(row: ReviewRow): Promise<boolean> {
    const occupied = {
      status: 'PENDING',
      deliveryState: {
        in: [
          'PREPARING',
          'CONTENT_SENDING',
          'CONTENT_SENT',
          'CONTROL_SENDING',
          'DELIVERED',
          'AMBIGUOUS',
        ],
      },
      recipientUserId: row.recipientUserId,
      post: this.ownership.getPublisherScope(),
    };
    const userCount = await this.prisma.vkBotReview.count({ where: occupied });
    const channelCount = await this.prisma.vkBotReview.count({
      where: { ...occupied, post: { ...occupied.post, chatId: row.post.chatId } },
    });
    return userCount < VK_BOT_REVIEW_USER_LIMIT && channelCount < VK_BOT_REVIEW_CHANNEL_LIMIT;
  }

  private async deliverContent(row: ReviewRow, privateChatId: string): Promise<void> {
    const now = new Date();
    const claim = await this.prisma.vkBotReview.updateMany({
      where: {
        id: row.id,
        revision: row.revision,
        status: 'PENDING',
        deliveryState: row.deliveryState,
      },
      data: {
        deliveryState: 'PREPARING',
        privateChatId,
        nextAttemptAt: new Date(now.getTime() + LEASE_MS),
      },
    });
    if (!claim.count) return;
    let attempted = false;
    let confirmed = false;
    try {
      const snapshot = await this.publish.prepareBotReviewSnapshot(row.postId);
      const options = await this.publish.prepareBotReviewMedia(row.postId, snapshot);
      const stored = await this.prisma.vkBotReview.updateMany({
        where: {
          id: row.id,
          revision: row.revision,
          status: 'PENDING',
          deliveryState: 'PREPARING',
        },
        data: {
          snapshot: snapshot as Prisma.InputJsonValue,
          fingerprint: snapshot.fingerprint,
          lastError: null,
        },
      });
      if (!stored.count) return;
      const sent = await this.max.sendMessageImmediateWithId(
        privateChatId,
        snapshot.maxMessage.text,
        {
          ...options,
          beforeSend: async () => {
            await this.assertDeliverable(row);
            const claimSend = await this.prisma.vkBotReview.updateMany({
              where: {
                id: row.id,
                revision: row.revision,
                status: 'PENDING',
                deliveryState: 'PREPARING',
              },
              data: {
                deliveryState: 'CONTENT_SENDING',
                attemptStartedAt: new Date(),
                nextAttemptAt: new Date(Date.now() + LEASE_MS),
              },
            });
            if (!claimSend.count) throw new ConflictException('Согласование изменилось.');
            attempted = true;
          },
        },
        this.requestOptions(),
      );
      confirmed = true;
      await this.persistReceipt(row, 'CONTENT_SENDING', {
        contentMessageId: sent.messageId,
        privateChatId,
        deliveryState: 'CONTENT_SENT',
      });
    } catch (error) {
      const ambiguous = confirmed || (attempted && !isDefiniteVkReviewSendRejection(error));
      await this.prisma.vkBotReview.updateMany({
        where: {
          id: row.id,
          revision: row.revision,
          deliveryState: { in: ['PREPARING', 'CONTENT_SENDING'] },
        },
        data: {
          deliveryState: ambiguous ? 'AMBIGUOUS' : 'ERROR',
          lastError: ambiguous
            ? 'Результат отправки в личку неизвестен. Автоповтор остановлен.'
            : publicError(error),
          nextAttemptAt: ambiguous ? LATER : new Date(Date.now() + 5 * 60_000),
        },
      });
    }
  }

  private async deliverControl(row: ReviewRow): Promise<void> {
    const presentation = await this.presentation(row);
    let attempted = false;
    let confirmed = false;
    try {
      const sent = await this.max.sendMessageImmediateWithId(
        row.privateChatId!,
        presentation.text,
        {
          buttons: presentation.buttons,
          messageLink: { type: 'reply', mid: row.contentMessageId! },
          beforeSend: async () => {
            await this.assertDeliverable(row);
            const changed = await this.prisma.vkBotReview.updateMany({
              where: {
                id: row.id,
                revision: row.revision,
                status: 'PENDING',
                deliveryState: 'CONTENT_SENT',
              },
              data: {
                deliveryState: 'CONTROL_SENDING',
                attemptStartedAt: new Date(),
                nextAttemptAt: new Date(Date.now() + LEASE_MS),
              },
            });
            if (!changed.count) throw new ConflictException('Согласование изменилось.');
            attempted = true;
          },
        },
        this.requestOptions(),
      );
      confirmed = true;
      await this.persistReceipt(row, 'CONTROL_SENDING', {
        controlMessageId: sent.messageId,
        deliveryState: 'DELIVERED',
        presentationKey: presentation.key,
      });
    } catch (error) {
      const ambiguous = confirmed || (attempted && !isDefiniteVkReviewSendRejection(error));
      await this.prisma.vkBotReview.updateMany({
        where: {
          id: row.id,
          revision: row.revision,
          deliveryState: { in: ['CONTENT_SENT', 'CONTROL_SENDING'] },
        },
        data: {
          deliveryState: ambiguous ? 'AMBIGUOUS' : 'CONTENT_SENT',
          lastError: ambiguous
            ? 'Результат отправки кнопок неизвестен. Автоповтор остановлен.'
            : publicError(error),
          nextAttemptAt: ambiguous ? LATER : new Date(Date.now() + 60_000),
        },
      });
    }
  }

  private async persistReceipt(
    row: ReviewRow,
    state: string,
    data: Prisma.VkBotReviewUpdateManyMutationInput,
  ): Promise<void> {
    // FLAG: Retry only the known receipt write, never the remote send that produced it.
    for (let attempt = 0; ; attempt++) {
      try {
        await this.prisma.vkBotReview.updateMany({
          where: { id: row.id, revision: row.revision, deliveryState: state },
          data: {
            ...data,
            nextAttemptAt: new Date(Date.now() + 5000),
            attemptStartedAt: null,
            lastError: null,
          },
        });
        return;
      } catch (error) {
        if (attempt >= 2) throw error;
      }
    }
  }

  private async assertDeliverable(row: ReviewRow): Promise<void> {
    if (!this.enabled) throw new ServiceUnavailableException('Согласование отключено.');
    const settings = await this.settings(row.post.chatId);
    const post = await this.prisma.vkParsingPost.findUnique({
      where: { id: row.postId },
      include: { source: true },
    });
    if (
      !settings ||
      settings.botReviewPaused ||
      settings.botReviewRecipientUserId !== row.recipientUserId ||
      !post ||
      post.source.publishMode !== VK_BOT_REVIEW_MODE ||
      post.source.status !== 'ACTIVE' ||
      !post.source.importEnabled ||
      post.status !== 'NEW'
    ) {
      throw new ConflictException('Доставка приостановлена или пост изменился.');
    }
  }

  private async assertEditor(row: ReviewRow): Promise<void> {
    await this.access.assertAccess(row.post.chatId, {
      userId: row.recipientUserId,
      launchBotId: row.post.ownerBotId,
      username: null,
      displayName: null,
    });
    const member = (
      await this.max.getChatMembersAccess(row.post.chatId, [row.recipientUserId], {
        ...this.requestOptions(),
        bypassCache: true,
      })
    ).get(row.recipientUserId);
    if (!member || (!member.isAdmin && !member.isOwner))
      throw new ForbiddenException('Права администратора больше не подтверждены.');
  }

  private async presentation(
    row: ReviewRow,
  ): Promise<{ text: string; buttons: MaxMessageButton[][]; key: string; terminal: boolean }> {
    const settings = await this.settings(row.post.chatId);
    const stale = !settings || row.fingerprint !== buildVkBotReviewFingerprint(row.post, settings);
    const published = row.post.status === 'PUBLISHED';
    const error = row.lastError || row.post.lastError;
    const state = published
      ? 'Опубликован'
      : row.status === 'REJECTED'
        ? 'Отклонён'
        : row.status === 'CANCELLED'
          ? 'Согласование отменено'
          : row.status === 'APPROVED'
            ? error
              ? 'Публикация требует проверки'
              : 'Принят в публикацию'
            : stale
              ? 'Пост изменён. Требуется обновить превью.'
              : 'На согласовании';
    const date =
      row.post.vkPublishedAt?.toLocaleString('ru-RU', {
        timeZone: settings?.schedulerTimezone ?? 'Europe/Moscow',
      }) ?? '';
    const text = [
      `Канал: ${row.post.chat.title}`,
      `Источник VK: ${row.post.source.title}`,
      date,
      state,
      row.post.hasUnsupportedAttachments
        ? 'Часть вложений VK не поддерживается; в канал попадёт показанное превью.'
        : '',
      error ? publicErrorText(error) : '',
    ]
      .filter(Boolean)
      .join('\n');
    const buttons: MaxMessageButton[][] = [];
    if (row.status === 'PENDING')
      buttons.push([
        {
          type: 'callback',
          text: stale ? 'Обновить превью' : 'Опубликовать',
          payload: vkBotReviewCallback(stale ? 'refresh' : 'publish', row.id, row.revision),
        },
        {
          type: 'callback',
          text: 'Отклонить',
          payload: vkBotReviewCallback('reject', row.id, row.revision),
        },
      ]);
    buttons.push([{ type: 'link', text: 'Оригинал VK', url: row.post.url }]);
    const editorUrl = this.links.buildPublisherMiniappStartUrlSync(
      `mr-${Buffer.from(JSON.stringify({ v: 1, k: 'route', r: `/publisher/channel/${encodeURIComponent(row.post.chatId)}?focus=vk` })).toString('base64url')}`,
    );
    if (editorUrl) buttons.push([{ type: 'link', text: 'Открыть в приложении', url: editorUrl }]);
    if (published && row.post.publishedUrl)
      buttons.push([{ type: 'link', text: 'Пост в канале', url: row.post.publishedUrl }]);
    buttons.push([
      { type: 'callback', text: 'Мои каналы', payload: vkBotReviewCallback('menu', 'all') },
    ]);
    return {
      text,
      buttons,
      key: JSON.stringify([row.revision, text, buttons]),
      terminal: published || row.status === 'REJECTED' || row.status === 'CANCELLED',
    };
  }

  private async syncCard(row: ReviewRow): Promise<void> {
    if (!row.controlMessageId || !row.privateChatId) {
      await this.defer(row, LATER);
      return;
    }
    const presentation = await this.presentation(row);
    if (presentation.key !== row.presentationKey) {
      await this.max.editMessageInlineKeyboard(
        row.privateChatId,
        row.controlMessageId,
        presentation.text,
        { buttons: presentation.buttons },
        this.requestOptions(),
      );
      await this.prisma.vkBotReview.updateMany({
        where: { id: row.id, revision: row.revision },
        data: { presentationKey: presentation.key },
      });
    }
    await this.defer(row, presentation.terminal ? LATER : new Date(Date.now() + 60_000));
  }

  private async sendMenu(job: Job<VkBotReviewJob>): Promise<void> {
    const settings = await this.prisma.vkParsingSettings.findMany({
      where: {
        ...this.ownership.getPublisherScope(),
        botReviewRecipientUserId: job.data.userId,
        ...(job.data.action === 'menu' && job.data.id && job.data.id !== 'all'
          ? { id: { gt: job.data.id } }
          : {}),
      },
      include: { chat: { select: { title: true } } },
      orderBy: { id: 'asc' },
      take: 21,
    });
    const buttons: MaxMessageButton[][] = [];
    const lines = ['VK-предложка', 'Личка подключена.'];
    for (const setting of settings.slice(0, 20)) {
      try {
        await this.access.assertAccess(setting.chatId, this.actor(job.data));
      } catch {
        continue;
      }
      const count = await this.prisma.vkBotReview.count({
        where: {
          post: { chatId: setting.chatId, ...this.ownership.getPublisherScope() },
          status: 'PENDING',
          recipientUserId: job.data.userId,
        },
      });
      lines.push(
        `${setting.chat.title.slice(0, 90)}: ${count} на согласовании${setting.botReviewPaused ? ' (пауза)' : ''}`,
      );
      buttons.push([
        {
          type: 'callback',
          text: `${setting.botReviewPaused ? 'Возобновить' : 'Пауза'}: ${setting.chat.title}`.slice(
            0,
            100,
          ),
          payload: vkBotReviewCallback(setting.botReviewPaused ? 'resume' : 'pause', setting.id),
        },
      ]);
    }
    if (!settings.length) lines.push('Подключённых каналов пока нет.');
    if (settings.length > 20)
      buttons.push([
        {
          type: 'callback',
          text: 'Следующие каналы',
          payload: vkBotReviewCallback('menu', settings[19]!.id),
        },
      ]);
    const cabinetUrl = this.links.buildPublisherMiniappStartUrlSync(
      `mr-${Buffer.from(JSON.stringify({ v: 1, k: 'route', r: '/' })).toString('base64url')}`,
    );
    if (cabinetUrl) buttons.push([{ type: 'link', text: 'Настройки каналов', url: cabinetUrl }]);
    buttons.push([
      { type: 'callback', text: 'Обновить', payload: vkBotReviewCallback('menu', 'all') },
    ]);
    if (job.data.menuDispatchStarted) return;
    await this.max.sendMessageImmediateWithId(
      job.data.privateChatId!,
      lines.join('\n'),
      {
        buttons,
        beforeSend: async () => {
          await job.updateData({ ...job.data, menuDispatchStarted: true });
        },
      },
      this.requestOptions(),
    );
  }

  private settings(chatId: string) {
    return this.prisma.vkParsingSettings.findUnique({
      where: { chatId_ownerProfile_ownerBotId: { chatId, ...this.ownership.getPublisherScope() } },
    });
  }

  private async defer(row: VkBotReview, nextAttemptAt: Date): Promise<void> {
    await this.prisma.vkBotReview.updateMany({
      where: { id: row.id, revision: row.revision },
      data: { nextAttemptAt },
    });
  }

  private requestOptions() {
    return {
      botId: this.ownership.getPublisherScope().ownerBotId,
      trafficClass: 'background' as const,
      sourceTag: MAX_API_SOURCE_TAGS.VK_PARSING,
    };
  }

  private actor(data: VkBotReviewJob): AuthUser {
    return {
      userId: data.userId!,
      launchBotId: data.requiredBotId,
      username: null,
      displayName: null,
      chatId: data.privateChatId,
      chatType: 'dialog',
    };
  }

  private async answer(data: VkBotReviewJob, text: string): Promise<void> {
    if (!data.callbackId) return;
    try {
      await this.max.answerCallback(data.callbackId, text, undefined, {
        botId: data.requiredBotId,
        sourceTag: MAX_API_SOURCE_TAGS.CALLBACK_ANSWER,
      });
    } catch {
      /* Persisted decisions remain authoritative. */
    }
  }
}

function publicError(error: unknown): string {
  return error instanceof BadRequestException ||
    error instanceof ConflictException ||
    error instanceof ForbiddenException
    ? publicErrorText(error.message)
    : 'Не удалось подготовить пост. Повторная попытка позже.';
}

function publicErrorText(value: string): string {
  return value.startsWith('MAX_SEND_') || value.includes('max_send_')
    ? 'Результат публикации требует проверки. Автоповтор остановлен.'
    : value.slice(0, 300);
}
