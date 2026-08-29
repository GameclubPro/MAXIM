import type { MaxUpdate } from '@maxim/contracts';
import {
  MAX_PUBLISHER_AUTO_REPLY_PHRASE_LENGTH,
  normalizePublisherAutoReplyPhrase,
  normalizePublisherAutoReplyPhraseDisplay,
  publisherAutoReplyRequestIdSchema,
} from '@maxim/contracts/publisher-auto-replies';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import {
  Prisma,
  PublisherAutoReplyAuthoringState,
  PublisherPrivateFlowType,
} from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { buildPublisherBotDescriptor } from './publisher-bot-descriptor';
import {
  PublisherAutoReplyAuthoringQueueService,
  type PublisherAutoReplyAuthoringNotification,
} from './publisher-auto-reply-authoring.queue';
import { PublisherPrivateFlowLeaseService } from './publisher-private-flow-lease.service';

const AUTHORING_WAITING_TTL_MS = 15 * 60_000;
const AUTHORING_PROCESSING_TTL_MS = 20 * 60_000;
const AUTHORING_RESULT_TTL_MS = 24 * 60 * 60_000;
const AUTHORING_CAPTURE_GUARD_MS = 60_000;
const AUTHORING_START_PREFIX = 'ar_';
const AUTHORING_CALLBACK_PREFIX = 'ar:';

type AuthoringCallbackAction = 'activate' | 'cancel' | 'replace_content' | 'replace_phrase';
type AuthoringSessionRow = Prisma.PublisherAutoReplyAuthoringSessionGetPayload<
  Record<string, never>
>;

export type PublisherAutoReplyAuthoringPresentation = {
  id: string;
  state:
    | 'awaiting_start'
    | 'awaiting_phrase'
    | 'awaiting_content'
    | 'processing'
    | 'review'
    | 'saving'
    | 'completed'
    | 'canceled'
    | 'failed'
    | 'expired';
  targetChatId: string;
  phrase: string | null;
  ruleId: string | null;
  contentRevisionId: string | null;
  botUrl: string | null;
  expiresAt: string;
};

export type PublisherAutoReplyAuthoringResponse = {
  session: Omit<PublisherAutoReplyAuthoringPresentation, 'botUrl'> | null;
  botUrl: string | null;
};

@Injectable()
export class PublisherAutoReplyAuthoringService {
  private readonly logger = new Logger(PublisherAutoReplyAuthoringService.name);
  private readonly publisherBotId: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: PublisherAutoReplyAuthoringQueueService,
    private readonly privateFlows: PublisherPrivateFlowLeaseService,
    configService: ConfigService,
  ) {
    this.publisherBotId = buildPublisherBotDescriptor({
      id: configService.get<string>('MAX_PUBLISHER_BOT_ID'),
    }).id;
  }

  async create(
    user: AuthUser,
    targetChatIdValue: string,
    body: unknown,
  ): Promise<PublisherAutoReplyAuthoringResponse> {
    const targetChatId = targetChatIdValue.trim();
    const requestIdResult = publisherAutoReplyRequestIdSchema.safeParse(asRecord(body)?.requestId);
    if (!targetChatId || !requestIdResult.success) {
      throw new BadRequestException(
        requestIdResult.success ? 'Target chat is required' : requestIdResult.error.format(),
      );
    }
    const actorUserId = user.userId.trim();
    const now = new Date();
    await this.expireActorSessions(actorUserId, now);

    const replay = await this.prisma.publisherAutoReplyAuthoringSession.findUnique({
      where: {
        publisherBotId_actorUserId_requestId: {
          publisherBotId: this.publisherBotId,
          actorUserId,
          requestId: requestIdResult.data,
        },
      },
    });
    if (replay) {
      this.assertRequestTarget(replay, targetChatId);
      await this.ensureLease(replay);
      return this.presentResponse(replay);
    }

    const sessionId = randomUUID();
    const startToken = randomBytes(18).toString('base64url');
    const expiresAt = new Date(now.getTime() + AUTHORING_WAITING_TTL_MS);
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const lease = await this.privateFlows.acquire(
          {
            publisherBotId: this.publisherBotId,
            actorUserId,
            flowType: PublisherPrivateFlowType.AUTO_REPLY_AUTHORING,
            flowId: sessionId,
            leaseToken: sessionId,
            expiresAt,
          },
          tx,
        );
        if (!lease) {
          throw this.flowConflict();
        }
        return tx.publisherAutoReplyAuthoringSession.create({
          data: {
            id: sessionId,
            publisherBotId: this.publisherBotId,
            actorUserId,
            requestId: requestIdResult.data,
            startToken,
            targetChatId,
            expiresAt,
          },
        });
      });
      return this.presentResponse(created);
    } catch (error: unknown) {
      const concurrent = await this.prisma.publisherAutoReplyAuthoringSession.findUnique({
        where: {
          publisherBotId_actorUserId_requestId: {
            publisherBotId: this.publisherBotId,
            actorUserId,
            requestId: requestIdResult.data,
          },
        },
      });
      if (!concurrent) throw error;
      this.assertRequestTarget(concurrent, targetChatId);
      await this.ensureLease(concurrent);
      return this.presentResponse(concurrent);
    }
  }

  async getCurrent(
    user: AuthUser,
    targetChatIdValue: string,
  ): Promise<PublisherAutoReplyAuthoringResponse> {
    const targetChatId = targetChatIdValue.trim();
    const actorUserId = user.userId.trim();
    await this.expireActorSessions(actorUserId, new Date());
    const session = await this.prisma.publisherAutoReplyAuthoringSession.findFirst({
      where: {
        publisherBotId: this.publisherBotId,
        actorUserId,
        targetChatId,
        expiresAt: { gt: new Date() },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return session ? this.presentResponse(session) : { session: null, botUrl: null };
  }

  async cancelCurrent(
    user: AuthUser,
    targetChatIdValue: string,
  ): Promise<PublisherAutoReplyAuthoringResponse> {
    const targetChatId = targetChatIdValue.trim();
    await this.expireActorSessions(user.userId.trim(), new Date());
    const session = await this.prisma.publisherAutoReplyAuthoringSession.findFirst({
      where: {
        publisherBotId: this.publisherBotId,
        actorUserId: user.userId.trim(),
        targetChatId,
        state: {
          in: [
            PublisherAutoReplyAuthoringState.AWAITING_START,
            PublisherAutoReplyAuthoringState.AWAITING_PHRASE,
            PublisherAutoReplyAuthoringState.AWAITING_CONTENT,
            PublisherAutoReplyAuthoringState.PROCESSING,
            PublisherAutoReplyAuthoringState.REVIEW,
            PublisherAutoReplyAuthoringState.SAVING,
          ],
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    if (!session) throw new NotFoundException('Сессия автоответа не найдена.');
    await this.cancelSession(session, null);
    const current = await this.prisma.publisherAutoReplyAuthoringSession.findUniqueOrThrow({
      where: { id: session.id },
    });
    return this.presentResponse(current);
  }

  async observeWebhook(
    update: MaxUpdate,
    webhookEventId: string | null,
    options: { duplicate?: boolean } = {},
  ): Promise<boolean> {
    if (update.botId?.trim() !== this.publisherBotId) return false;

    const callback = extractCallback(update);
    if (callback) {
      const parsed = parseCallbackPayload(callback.payload);
      if (!parsed) return false;
      const session = await this.findSessionForActorToken(parsed.token, callback.actorUserId);
      if (!session) return true;
      if (parsed.action === 'cancel') {
        await this.cancelSession(session, callback.callbackId);
      } else if (parsed.action === 'activate') {
        await this.requestActivation(session, callback.callbackId);
      } else {
        await this.resetStep(session, parsed.action, callback.callbackId);
      }
      if (options.duplicate) {
        await this.recoverSessionWork(session, update.updateId);
      }
      return true;
    }

    const startToken = extractStartToken(update);
    if (startToken !== null) {
      await this.startSession(update, startToken);
      return true;
    }
    if (update.type.trim().toLowerCase() !== 'message_created') return false;

    const identity = extractPrivateIdentity(update);
    if (!identity) return false;
    const consumed = await this.prisma.publisherAutoReplyAuthoringMessage.findUnique({
      where: {
        publisherBotId_messageId: {
          publisherBotId: this.publisherBotId,
          messageId: identity.messageId,
        },
      },
      select: { sessionId: true },
    });
    if (consumed) {
      const consumedSession = await this.prisma.publisherAutoReplyAuthoringSession.findUnique({
        where: { id: consumed.sessionId },
      });
      if (consumedSession) {
        await this.recoverSessionWork(consumedSession, identity.messageId);
      }
      return true;
    }
    const lease = await this.privateFlows.read(this.publisherBotId, identity.actorUserId);
    if (!lease || lease.flowType !== PublisherPrivateFlowType.AUTO_REPLY_AUTHORING) return false;
    const session = await this.prisma.publisherAutoReplyAuthoringSession.findFirst({
      where: {
        id: lease.flowId,
        publisherBotId: this.publisherBotId,
        actorUserId: identity.actorUserId,
        expiresAt: { gt: new Date() },
      },
    });
    if (!session) return false;
    if (options.duplicate) {
      if (
        session.phraseMessageId === identity.messageId ||
        session.contentMessageId === identity.messageId
      ) {
        await this.recoverSessionWork(session, identity.messageId);
        return true;
      }
      if (session.state === PublisherAutoReplyAuthoringState.AWAITING_PHRASE) {
        await this.capturePhrase(session, update, identity);
        return true;
      }
      if (session.state === PublisherAutoReplyAuthoringState.AWAITING_CONTENT) {
        await this.captureContent(
          session,
          identity,
          await this.resolveWebhookEventId(update, webhookEventId),
        );
        return true;
      }
      await this.recoverSessionWork(session, identity.messageId);
      return true;
    }
    if (session.state === PublisherAutoReplyAuthoringState.AWAITING_PHRASE) {
      await this.capturePhrase(session, update, identity);
      return true;
    }
    if (session.state === PublisherAutoReplyAuthoringState.AWAITING_CONTENT) {
      await this.captureContent(session, identity, webhookEventId);
      return true;
    }
    return true;
  }

  private async startSession(update: MaxUpdate, startToken: string): Promise<void> {
    const identity = extractPrivateIdentity(update);
    if (!identity) return;
    const session = await this.prisma.publisherAutoReplyAuthoringSession.findFirst({
      where: {
        startToken,
        publisherBotId: this.publisherBotId,
        actorUserId: identity.actorUserId,
        expiresAt: { gt: new Date() },
      },
    });
    if (!session) return;
    if (session.state !== PublisherAutoReplyAuthoringState.AWAITING_START) {
      await this.recoverSessionWork(session, update.updateId);
      return;
    }
    const expiresAt = new Date(Date.now() + AUTHORING_WAITING_TTL_MS);
    const changed = await this.prisma.$transaction(async (tx) => {
      const result = await tx.publisherAutoReplyAuthoringSession.updateMany({
        where: { id: session.id, state: session.state, stageRevision: session.stageRevision },
        data: {
          state: PublisherAutoReplyAuthoringState.AWAITING_PHRASE,
          stageRevision: { increment: 1 },
          privateChatId: identity.privateChatId,
          notificationKind: 'prompt_phrase',
          notificationPending: true,
          notificationRevision: { increment: 1 },
          expiresAt,
        },
      });
      if (result.count === 1) {
        const renewed = await this.privateFlows.renew(this.leaseFor(session, expiresAt), tx);
        if (!renewed) throw this.flowConflict();
      }
      return result;
    });
    if (changed.count !== 1) return;
    await this.enqueueNotificationSafe(session.id, 'prompt_phrase', update.updateId);
  }

  private async capturePhrase(
    session: AuthoringSessionRow,
    update: MaxUpdate,
    identity: { actorUserId: string; privateChatId: string; messageId: string },
  ): Promise<void> {
    const phrase = extractDirectPhrase(update);
    const display = phrase ? normalizePublisherAutoReplyPhraseDisplay(phrase) : '';
    const normalized = display ? normalizePublisherAutoReplyPhrase(display) : '';
    const invalid =
      !display ||
      display.length > MAX_PUBLISHER_AUTO_REPLY_PHRASE_LENGTH ||
      normalized === '/start' ||
      normalized === 'старт';
    const duplicate = invalid
      ? null
      : await this.prisma.publisherAutoReplyRule.findFirst({
          where: {
            chatId: session.targetChatId,
            normalizedPhrase: normalized,
            archivedAt: null,
          },
          select: { id: true },
        });
    if (invalid || duplicate) {
      try {
        await this.prisma.$transaction(async (tx) => {
          const changed = await tx.publisherAutoReplyAuthoringSession.updateMany({
            where: { id: session.id, state: session.state, stageRevision: session.stageRevision },
            data: {
              failureCode: duplicate ? 'phrase_conflict' : 'invalid_phrase',
              notificationKind: 'prompt_phrase',
              notificationPending: true,
              notificationRevision: { increment: 1 },
              privateChatId: identity.privateChatId,
            },
          });
          if (changed.count === 1) {
            await tx.publisherAutoReplyAuthoringMessage.create({
              data: {
                sessionId: session.id,
                publisherBotId: session.publisherBotId,
                messageId: identity.messageId,
                kind: 'PHRASE',
                stageRevision: session.stageRevision,
              },
            });
          }
        });
      } catch (error: unknown) {
        if ((error as { code?: unknown })?.code !== 'P2002') throw error;
      }
      await this.enqueueNotificationSafe(session.id, 'prompt_phrase', identity.messageId);
      return;
    }

    const expiresAt = new Date(Date.now() + AUTHORING_WAITING_TTL_MS);
    const reuseDraft = Boolean(session.ruleId && session.contentRevisionId);
    try {
      const changed = await this.prisma.$transaction(async (tx) => {
        const result = await tx.publisherAutoReplyAuthoringSession.updateMany({
          where: { id: session.id, state: session.state, stageRevision: session.stageRevision },
          data: {
            state: reuseDraft
              ? PublisherAutoReplyAuthoringState.REVIEW
              : PublisherAutoReplyAuthoringState.AWAITING_CONTENT,
            stageRevision: { increment: 1 },
            phrase: display,
            normalizedPhrase: normalized,
            phraseMessageId: identity.messageId,
            privateChatId: identity.privateChatId,
            failureCode: null,
            notificationKind: reuseDraft ? 'ready' : 'prompt_content',
            notificationPending: true,
            notificationRevision: { increment: 1 },
            expiresAt,
          },
        });
        if (result.count === 1) {
          if (reuseDraft) {
            const rule = await tx.publisherAutoReplyRule.updateMany({
              where: {
                id: session.ruleId!,
                chatId: session.targetChatId,
                currentContentRevisionId: session.contentRevisionId,
                archivedAt: { not: null },
              },
              data: {
                phrase: display,
                normalizedPhrase: normalized,
                updatedByUserId: session.actorUserId,
                version: { increment: 1 },
              },
            });
            if (rule.count !== 1) {
              throw new Error('Publisher auto-reply authoring draft changed before phrase update');
            }
            await tx.auditLog.create({
              data: {
                chatId: session.targetChatId,
                actorUserId: session.actorUserId,
                action: 'UPDATE_PUBLISHER_AUTO_REPLY_DRAFT_PHRASE',
                payload: {
                  sessionId: session.id,
                  ruleId: session.ruleId!,
                  contentRevisionId: session.contentRevisionId!,
                } satisfies Prisma.InputJsonValue,
              },
            });
          }
          await tx.publisherAutoReplyAuthoringMessage.create({
            data: {
              sessionId: session.id,
              publisherBotId: session.publisherBotId,
              messageId: identity.messageId,
              kind: 'PHRASE',
              stageRevision: session.stageRevision,
            },
          });
          const renewed = await this.privateFlows.renew(this.leaseFor(session, expiresAt), tx);
          if (!renewed) throw this.flowConflict();
        }
        return result;
      });
      if (changed.count !== 1) return;
    } catch (error: unknown) {
      if ((error as { code?: unknown })?.code !== 'P2002') throw error;
      return;
    }
    await this.enqueueNotificationSafe(
      session.id,
      reuseDraft ? 'ready' : 'prompt_content',
      identity.messageId,
    );
  }

  private async captureContent(
    session: AuthoringSessionRow,
    identity: { actorUserId: string; privateChatId: string; messageId: string },
    webhookEventId: string | null,
  ): Promise<void> {
    const expiresAt = new Date(Date.now() + AUTHORING_PROCESSING_TTL_MS);
    try {
      const changed = await this.prisma.$transaction(async (tx) => {
        const result = await tx.publisherAutoReplyAuthoringSession.updateMany({
          where: { id: session.id, state: session.state, stageRevision: session.stageRevision },
          data: {
            state: PublisherAutoReplyAuthoringState.PROCESSING,
            stageRevision: { increment: 1 },
            contentMessageId: identity.messageId,
            sourceWebhookEventId: webhookEventId?.trim() || null,
            privateChatId: identity.privateChatId,
            failureCode: null,
            notificationKind: 'processing',
            notificationPending: true,
            notificationRevision: { increment: 1 },
            captureGuardUntil: new Date(Date.now() + AUTHORING_CAPTURE_GUARD_MS),
            expiresAt,
          },
        });
        if (result.count === 1) {
          await tx.publisherAutoReplyAuthoringMessage.create({
            data: {
              sessionId: session.id,
              publisherBotId: session.publisherBotId,
              messageId: identity.messageId,
              kind: 'CONTENT',
              stageRevision: session.stageRevision,
            },
          });
          const renewed = await this.privateFlows.renew(this.leaseFor(session, expiresAt), tx);
          if (!renewed) throw this.flowConflict();
        }
        return result;
      });
      if (changed.count !== 1) return;
    } catch (error: unknown) {
      if ((error as { code?: unknown })?.code !== 'P2002') throw error;
      return;
    }
    await Promise.all([
      this.enqueueNotificationSafe(session.id, 'processing', identity.messageId),
      this.enqueueProcessSafe(session.id),
    ]);
  }

  private async requestActivation(
    session: AuthoringSessionRow,
    callbackId: string | null,
  ): Promise<void> {
    if (session.state !== PublisherAutoReplyAuthoringState.REVIEW || !session.ruleId) return;
    const expiresAt = new Date(Date.now() + AUTHORING_PROCESSING_TTL_MS);
    const changed = await this.prisma.$transaction(async (tx) => {
      const result = await tx.publisherAutoReplyAuthoringSession.updateMany({
        where: { id: session.id, state: session.state, stageRevision: session.stageRevision },
        data: {
          state: PublisherAutoReplyAuthoringState.SAVING,
          stageRevision: { increment: 1 },
          callbackId,
          notificationKind: null,
          notificationPending: false,
          notificationRevision: { increment: 1 },
          expiresAt,
        },
      });
      if (result.count === 1) {
        const renewed = await this.privateFlows.renew(this.leaseFor(session, expiresAt), tx);
        if (!renewed) throw this.flowConflict();
      }
      return result;
    });
    if (changed.count === 1) {
      await this.queue.enqueueActivation({ sessionId: session.id, callbackId });
    }
  }

  private async resetStep(
    session: AuthoringSessionRow,
    action: Extract<AuthoringCallbackAction, 'replace_content' | 'replace_phrase'>,
    callbackId: string | null,
  ): Promise<void> {
    if (session.state !== PublisherAutoReplyAuthoringState.REVIEW) return;
    const phraseStep = action === 'replace_phrase';
    const expiresAt = new Date(Date.now() + AUTHORING_WAITING_TTL_MS);
    const changed = await this.prisma.$transaction(async (tx) => {
      const result = await tx.publisherAutoReplyAuthoringSession.updateMany({
        where: { id: session.id, state: session.state, stageRevision: session.stageRevision },
        data: {
          state: phraseStep
            ? PublisherAutoReplyAuthoringState.AWAITING_PHRASE
            : PublisherAutoReplyAuthoringState.AWAITING_CONTENT,
          stageRevision: { increment: 1 },
          ...(phraseStep
            ? { phrase: null, normalizedPhrase: null, phraseMessageId: null }
            : { contentMessageId: null, sourceWebhookEventId: null }),
          callbackId,
          failureCode: null,
          notificationKind: phraseStep ? 'prompt_phrase' : 'prompt_content',
          notificationPending: true,
          notificationRevision: { increment: 1 },
          captureGuardUntil: null,
          expiresAt,
        },
      });
      if (result.count === 1) {
        const renewed = await this.privateFlows.renew(this.leaseFor(session, expiresAt), tx);
        if (!renewed) throw this.flowConflict();
      }
      return result;
    });
    if (changed.count !== 1) return;
    await this.enqueueNotificationSafe(
      session.id,
      phraseStep ? 'prompt_phrase' : 'prompt_content',
      callbackId ?? String(session.stageRevision),
      callbackId,
    );
  }

  private async cancelSession(
    session: AuthoringSessionRow,
    callbackId: string | null,
  ): Promise<void> {
    if (isTerminalState(session.state)) return;
    const changed = await this.prisma.publisherAutoReplyAuthoringSession.updateMany({
      where: { id: session.id, state: session.state, stageRevision: session.stageRevision },
      data: {
        state: PublisherAutoReplyAuthoringState.CANCELED,
        stageRevision: { increment: 1 },
        callbackId,
        notificationKind: 'canceled',
        notificationPending: true,
        notificationRevision: { increment: 1 },
        captureGuardUntil: null,
        expiresAt: new Date(Date.now() + AUTHORING_RESULT_TTL_MS),
      },
    });
    if (changed.count !== 1) return;
    await this.privateFlows.release({
      publisherBotId: session.publisherBotId,
      actorUserId: session.actorUserId,
      flowType: PublisherPrivateFlowType.AUTO_REPLY_AUTHORING,
      flowId: session.id,
      leaseToken: session.id,
    });
    await this.enqueueNotificationSafe(
      session.id,
      'canceled',
      callbackId ?? session.id,
      callbackId,
    );
  }

  private async findSessionForActorToken(token: string, actorUserId: string | null) {
    if (!actorUserId) return null;
    return this.prisma.publisherAutoReplyAuthoringSession.findFirst({
      where: {
        startToken: token,
        publisherBotId: this.publisherBotId,
        actorUserId,
        expiresAt: { gt: new Date() },
      },
    });
  }

  private async ensureLease(session: AuthoringSessionRow): Promise<void> {
    if (isTerminalState(session.state)) return;
    const acquired = await this.privateFlows.acquire({
      publisherBotId: session.publisherBotId,
      actorUserId: session.actorUserId,
      flowType: PublisherPrivateFlowType.AUTO_REPLY_AUTHORING,
      flowId: session.id,
      leaseToken: session.id,
      expiresAt: session.expiresAt,
    });
    if (!acquired) throw this.flowConflict();
  }

  private leaseFor(session: AuthoringSessionRow, expiresAt: Date) {
    return {
      publisherBotId: session.publisherBotId,
      actorUserId: session.actorUserId,
      flowType: PublisherPrivateFlowType.AUTO_REPLY_AUTHORING,
      flowId: session.id,
      leaseToken: session.id,
      expiresAt,
    } as const;
  }

  private async expireActorSessions(actorUserId: string, now: Date): Promise<void> {
    const expired = await this.prisma.publisherAutoReplyAuthoringSession.findMany({
      where: {
        publisherBotId: this.publisherBotId,
        actorUserId,
        expiresAt: { lte: now },
        state: {
          in: [
            PublisherAutoReplyAuthoringState.AWAITING_START,
            PublisherAutoReplyAuthoringState.AWAITING_PHRASE,
            PublisherAutoReplyAuthoringState.AWAITING_CONTENT,
            PublisherAutoReplyAuthoringState.PROCESSING,
            PublisherAutoReplyAuthoringState.REVIEW,
            PublisherAutoReplyAuthoringState.SAVING,
          ],
        },
      },
      select: { id: true, state: true, publisherBotId: true, actorUserId: true },
    });
    if (expired.length === 0) return;
    for (const session of expired) {
      const changed = await this.prisma.publisherAutoReplyAuthoringSession.updateMany({
        where: { id: session.id, state: session.state, expiresAt: { lte: now } },
        data: {
          state: PublisherAutoReplyAuthoringState.EXPIRED,
          stageRevision: { increment: 1 },
          notificationPending: false,
          notificationKind: null,
          notificationRevision: { increment: 1 },
          lockedAt: null,
          lockToken: null,
          captureGuardUntil: null,
          expiresAt: new Date(now.getTime() + AUTHORING_RESULT_TTL_MS),
        },
      });
      if (changed.count === 1) {
        await this.privateFlows.release({
          publisherBotId: session.publisherBotId,
          actorUserId: session.actorUserId,
          flowType: PublisherPrivateFlowType.AUTO_REPLY_AUTHORING,
          flowId: session.id,
          leaseToken: session.id,
        });
      }
    }
  }

  private async recoverSessionWork(session: AuthoringSessionRow, dedupeKey: string): Promise<void> {
    if (session.state === PublisherAutoReplyAuthoringState.PROCESSING) {
      await this.enqueueProcessSafe(session.id);
    }
    if (session.state === PublisherAutoReplyAuthoringState.SAVING) {
      await this.queue.enqueueActivation({
        sessionId: session.id,
        callbackId: session.callbackId,
      });
    }
    const notification = toAuthoringNotification(session.notificationKind);
    if (session.notificationPending && notification) {
      await this.enqueueNotificationSafe(
        session.id,
        notification,
        `duplicate-${dedupeKey}`,
        session.callbackId,
      );
    }
  }

  private async resolveWebhookEventId(
    update: MaxUpdate,
    webhookEventId: string | null,
  ): Promise<string | null> {
    if (webhookEventId?.trim()) return webhookEventId.trim();
    const botId = update.botId?.trim() ?? '';
    const updateId = update.updateId.trim();
    if (!updateId) return null;
    const receipt = await this.prisma.webhookEvent.findUnique({
      where: { dedupKey: botId ? `${botId}:${updateId}` : updateId },
      select: { id: true },
    });
    return receipt?.id ?? null;
  }

  private async enqueueProcessSafe(sessionId: string): Promise<void> {
    try {
      await this.queue.enqueueProcessContent(sessionId);
    } catch (error: unknown) {
      this.logger.warn(
        { sessionId, err: error instanceof Error ? error.message : String(error) },
        'Publisher auto-reply content enqueue failed; recovery will retry',
      );
    }
  }

  private async enqueueNotificationSafe(
    sessionId: string,
    notification: PublisherAutoReplyAuthoringNotification,
    dedupeKey: string,
    callbackId?: string | null,
  ): Promise<void> {
    try {
      await this.queue.enqueueNotification({
        sessionId,
        notification,
        dedupeKey,
        callbackId,
      });
    } catch (error: unknown) {
      this.logger.warn(
        { sessionId, notification, err: error instanceof Error ? error.message : String(error) },
        'Publisher auto-reply authoring notification enqueue failed',
      );
    }
  }

  private present(session: AuthoringSessionRow): PublisherAutoReplyAuthoringPresentation {
    return {
      id: session.id,
      state: session.state.toLowerCase() as PublisherAutoReplyAuthoringPresentation['state'],
      targetChatId: session.targetChatId,
      phrase: session.phrase,
      ruleId: session.ruleId,
      contentRevisionId: session.contentRevisionId,
      botUrl:
        session.state === PublisherAutoReplyAuthoringState.AWAITING_START
          ? `https://max.ru/${encodeURIComponent(this.publisherBotId)}?start=${encodeURIComponent(
              `${AUTHORING_START_PREFIX}${session.startToken}`,
            )}`
          : isTerminalState(session.state)
            ? null
            : `https://max.ru/${encodeURIComponent(this.publisherBotId)}`,
      expiresAt: session.expiresAt.toISOString(),
    };
  }

  private presentResponse(session: AuthoringSessionRow): PublisherAutoReplyAuthoringResponse {
    const presented = this.present(session);
    const { botUrl, ...publicSession } = presented;
    return { session: publicSession, botUrl };
  }

  private flowConflict(): ConflictException {
    return new ConflictException({
      code: 'PUBLISHER_PRIVATE_FLOW_CONFLICT',
      message: 'Сначала завершите текущую операцию в диалоге Публика.',
    });
  }

  private assertRequestTarget(session: AuthoringSessionRow, targetChatId: string): void {
    if (session.targetChatId !== targetChatId) {
      throw new ConflictException({
        code: 'PUBLISHER_AUTO_REPLY_REQUEST_SCOPE_CONFLICT',
        message: 'Этот идентификатор запроса уже использован для другого чата.',
      });
    }
  }
}

function isTerminalState(state: PublisherAutoReplyAuthoringState): boolean {
  return (
    state === PublisherAutoReplyAuthoringState.COMPLETED ||
    state === PublisherAutoReplyAuthoringState.CANCELED ||
    state === PublisherAutoReplyAuthoringState.FAILED ||
    state === PublisherAutoReplyAuthoringState.EXPIRED
  );
}

function toAuthoringNotification(
  value: string | null,
): PublisherAutoReplyAuthoringNotification | null {
  switch (value) {
    case 'prompt_phrase':
    case 'prompt_content':
    case 'processing':
    case 'ready':
    case 'conflict':
    case 'activated':
    case 'failed':
    case 'canceled':
      return value;
    default:
      return null;
  }
}

function extractStartToken(update: MaxUpdate): string | null {
  if (update.type.trim().toLowerCase() !== 'bot_started') return null;
  const raw = asRecord(update.raw);
  const data = asRecord(raw?.data);
  const payload = readString(
    raw?.payload ?? raw?.start_payload ?? raw?.startPayload ?? data?.payload,
  );
  return payload?.startsWith(AUTHORING_START_PREFIX)
    ? payload.slice(AUTHORING_START_PREFIX.length).trim()
    : null;
}

function parseCallbackPayload(
  payload: string,
): { action: AuthoringCallbackAction; token: string } | null {
  if (!payload.startsWith(AUTHORING_CALLBACK_PREFIX)) return null;
  const [, action, token] = payload.split(':');
  if (
    !token ||
    (action !== 'activate' &&
      action !== 'cancel' &&
      action !== 'replace_content' &&
      action !== 'replace_phrase')
  ) {
    return null;
  }
  return { action, token };
}

function extractCallback(update: MaxUpdate): {
  payload: string;
  callbackId: string | null;
  actorUserId: string | null;
} | null {
  if (update.type.trim().toLowerCase() !== 'message_callback') return null;
  const raw = asRecord(update.raw);
  const callback = asRecord(raw?.callback);
  const user = asRecord(callback?.user);
  const payload = readString(callback?.payload ?? callback?.data);
  return payload
    ? {
        payload,
        callbackId: readString(callback?.callback_id ?? callback?.callbackId ?? callback?.id),
        actorUserId: readString(user?.user_id ?? user?.userId ?? user?.id),
      }
    : null;
}

function extractPrivateIdentity(update: MaxUpdate): {
  actorUserId: string;
  privateChatId: string;
  messageId: string;
} | null {
  const actorUserId = update.message?.senderId?.trim() ?? '';
  const privateChatId = update.message?.chatId?.trim() ?? '';
  const messageId = update.message?.messageId?.trim() ?? '';
  if (!/^\d+$/u.test(actorUserId) || !/^\d+$/u.test(privateChatId) || !messageId) return null;
  const rawMessage = extractRawMessage(update.raw);
  const recipient = asRecord(rawMessage?.recipient);
  const chatType = readString(recipient?.chat_type ?? recipient?.chatType)?.toLowerCase();
  return chatType && chatType !== 'dialog' ? null : { actorUserId, privateChatId, messageId };
}

function extractDirectPhrase(update: MaxUpdate): string | null {
  const message = extractRawMessage(update.raw);
  if (!message) return null;
  const link = asRecord(message.link);
  if (readString(link?.type)?.toLowerCase() === 'forward') return null;
  const body = asRecord(message.body) ?? asRecord(message.content);
  if (!body) return null;
  const attachments = Array.isArray(message.attachments)
    ? message.attachments
    : Array.isArray(body.attachments)
      ? body.attachments
      : [];
  if (attachments.length > 0) return null;
  return readText(body.text ?? body.plain ?? body.caption);
}

function extractRawMessage(rawValue: unknown): Record<string, unknown> | null {
  const raw = asRecord(rawValue);
  if (!raw) return null;
  const direct = asRecord(raw.message);
  if (direct) return direct;
  for (const key of ['message_created', 'data', 'event']) {
    const envelope = asRecord(raw[key]);
    const nested = asRecord(envelope?.message);
    if (nested) return nested;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function readText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}
