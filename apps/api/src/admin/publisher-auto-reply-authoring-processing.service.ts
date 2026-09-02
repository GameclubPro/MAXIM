import { HttpException, Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import {
  Prisma,
  PublisherAutoReplyAuthoringState,
  PublisherPrivateFlowType,
} from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  PublisherAutoReplyCaptureError,
  PublisherAutoReplyContentCaptureService,
} from '../publisher/publisher-auto-reply-content-capture.service';
import { PublisherPrivateFlowLeaseService } from '../publisher/publisher-private-flow-lease.service';
import {
  PublisherAutoReplyService,
  type PreparedPublisherAutoReplyContent,
} from './publisher-auto-reply.service';
import { PublisherPolicyService } from './publisher-policy.service';
import { BotCapabilityRequiredException } from './bot-capability-required.error';

const PROCESSING_LEASE_MS = 2 * 60_000;
const REVIEW_TTL_MS = 20 * 60_000;
const RESULT_TTL_MS = 24 * 60 * 60_000;

type AuthoringProcessResult = 'ready' | 'failed' | 'noop';
type AuthoringActivationResult = 'activated' | 'conflict' | 'failed' | 'noop' | 'ready';

@Injectable()
export class PublisherAutoReplyAuthoringProcessingService {
  private readonly logger = new Logger(PublisherAutoReplyAuthoringProcessingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly captureService: PublisherAutoReplyContentCaptureService,
    private readonly autoReplies: PublisherAutoReplyService,
    private readonly policy: PublisherPolicyService,
    private readonly privateFlows: PublisherPrivateFlowLeaseService,
  ) {}

  async processContent(sessionId: string): Promise<AuthoringProcessResult> {
    const now = new Date();
    const lockToken = randomUUID();
    const claimed = await this.prisma.publisherAutoReplyAuthoringSession.updateMany({
      where: {
        id: sessionId,
        state: PublisherAutoReplyAuthoringState.PROCESSING,
        OR: [
          { lockedAt: null },
          { lockedAt: { lte: new Date(now.getTime() - PROCESSING_LEASE_MS) } },
        ],
      },
      data: { lockedAt: now, lockToken },
    });
    if (claimed.count !== 1) return 'noop';
    const session = await this.prisma.publisherAutoReplyAuthoringSession.findFirst({
      where: {
        id: sessionId,
        state: PublisherAutoReplyAuthoringState.PROCESSING,
        lockToken,
      },
    });
    if (!session) return 'noop';

    try {
      if (
        session.expiresAt <= now ||
        !session.privateChatId ||
        !session.contentMessageId ||
        !session.phrase ||
        !session.normalizedPhrase
      ) {
        throw new PublisherAutoReplyCaptureError(
          'message_unavailable',
          'Auto-reply authoring session is incomplete',
        );
      }
      const captured = await this.captureService.capture({
        webhookEventId: session.sourceWebhookEventId,
        publisherBotId: session.publisherBotId,
        actorUserId: session.actorUserId,
        privateChatId: session.privateChatId,
        incomingMessageId: session.contentMessageId,
      });
      const prepared: PreparedPublisherAutoReplyContent = {
        text: captured.text,
        textFormat: captured.textFormat,
        buttons: captured.buttons,
        images: captured.images.map((image) => ({
          kind: 'prepared',
          sha256: createHash('sha256').update(image.bytes).digest('hex'),
          mimeType: image.mimeType,
          fileName: image.fileName,
          sizeBytes: image.bytes.length,
          bytes: image.bytes,
        })),
      };
      const draft = await this.autoReplies.createFromPreparedContent({
        chatId: session.targetChatId,
        actorUserId: session.actorUserId,
        requestId: this.draftRequestId(session.id, session.stageRevision),
        sessionId: session.id,
        phrase: session.phrase,
        normalizedPhrase: session.normalizedPhrase,
        phrases: this.readTriggerPhrases(session.triggerPhrases, session.phrase),
        matchInContext: session.matchInContext,
        fuzzyMatch: session.fuzzyMatch,
        content: prepared,
      });
      const reviewExpiresAt = new Date(Date.now() + REVIEW_TTL_MS);
      const completed = await this.prisma.$transaction(async (tx) => {
        const result = await tx.publisherAutoReplyAuthoringSession.updateMany({
          where: {
            id: session.id,
            state: PublisherAutoReplyAuthoringState.PROCESSING,
            lockToken,
          },
          data: {
            state: PublisherAutoReplyAuthoringState.REVIEW,
            stageRevision: { increment: 1 },
            ruleId: draft.ruleId,
            contentRevisionId: draft.contentRevisionId,
            omissions: captured.omissions,
            failureCode: null,
            notificationKind: 'ready',
            notificationPending: true,
            notificationRevision: { increment: 1 },
            lockedAt: null,
            lockToken: null,
            expiresAt: reviewExpiresAt,
          },
        });
        if (result.count === 1) {
          const renewed = await this.privateFlows.renew(
            this.leaseFor(session, reviewExpiresAt),
            tx,
          );
          if (!renewed) throw new Error('Publisher auto-reply authoring lease was lost');
        }
        return result;
      });
      if (completed.count !== 1) return 'noop';
      return 'ready';
    } catch (error: unknown) {
      if (error instanceof PublisherAutoReplyCaptureError && !error.retryable) {
        await this.failSession(session.id, lockToken, error.code);
        return 'failed';
      }
      if (error instanceof HttpException && error.getStatus() >= 400 && error.getStatus() < 500) {
        await this.failSession(session.id, lockToken, 'unsupported_content');
        return 'failed';
      }
      await this.prisma.publisherAutoReplyAuthoringSession.updateMany({
        where: {
          id: session.id,
          state: PublisherAutoReplyAuthoringState.PROCESSING,
          lockToken,
        },
        data: { lockedAt: null, lockToken: null },
      });
      throw error;
    }
  }

  async activate(sessionId: string): Promise<AuthoringActivationResult> {
    const session = await this.prisma.publisherAutoReplyAuthoringSession.findFirst({
      where: {
        id: sessionId,
        state: PublisherAutoReplyAuthoringState.SAVING,
        expiresAt: { gt: new Date() },
      },
    });
    if (!session?.ruleId || !session.contentRevisionId) return 'noop';

    try {
      await this.policy.getEntity('chat', session.targetChatId, this.authUser(session.actorUserId));
      await this.policy.assertBotCapabilityForFeatureEnablement('chat', session.targetChatId, [
        'enabled',
        'autoRepliesEnabled',
      ]);
      const mutationRequestId = this.activationRequestId(session.id);
      const requestHash = createHash('sha256')
        .update(
          JSON.stringify({
            kind: 'publisher_auto_reply_authoring_activation',
            sessionId: session.id,
            ruleId: session.ruleId,
            contentRevisionId: session.contentRevisionId,
          }),
        )
        .digest('hex');
      await this.prisma.$transaction(async (tx) => {
        const current = await tx.publisherAutoReplyRule.findFirst({
          where: {
            id: session.ruleId!,
            chatId: session.targetChatId,
            currentContentRevisionId: session.contentRevisionId,
          },
          select: {
            id: true,
            version: true,
            normalizedPhrase: true,
            fuzzyMatch: true,
            _count: { select: { triggers: true } },
          },
        });
        if (!current || current.normalizedPhrase !== session.normalizedPhrase) {
          throw new Error('Publisher auto-reply authoring draft changed before activation');
        }
        await this.autoReplies.assertTriggerActivationCapacity(tx, {
          chatId: session.targetChatId,
          ruleId: current.id,
          phraseCount: current._count.triggers,
          fuzzyMatch: current.fuzzyMatch,
        });
        const nextVersion = current.version + 1;
        const enabled = await tx.publisherAutoReplyRule.updateMany({
          where: {
            id: current.id,
            version: current.version,
            archivedAt: { not: null },
            enabled: false,
          },
          data: {
            enabled: true,
            archivedAt: null,
            authoringSessionId: null,
            updatedByUserId: session.actorUserId,
            version: { increment: 1 },
          },
        });
        if (enabled.count !== 1) {
          throw new Error('Publisher auto-reply authoring draft activation lost its revision');
        }
        const settings = await this.enableModule(tx, session.targetChatId, session.actorUserId);
        await tx.publisherAutoReplyMutationRecord.create({
          data: {
            actorUserId: session.actorUserId,
            requestId: mutationRequestId,
            requestHash,
            operation: 'UPDATE',
            ruleId: current.id,
            resultingVersion: nextVersion,
          },
        });
        await tx.auditLog.create({
          data: {
            chatId: session.targetChatId,
            actorUserId: session.actorUserId,
            action: 'ACTIVATE_PUBLISHER_AUTO_REPLY_DRAFT',
            payload: {
              sessionId: session.id,
              ruleId: current.id,
              version: nextVersion,
              contentRevisionId: session.contentRevisionId,
              moduleSettingsRevision: settings.revision,
            } satisfies Prisma.InputJsonValue,
          },
        });
        const completed = await tx.publisherAutoReplyAuthoringSession.updateMany({
          where: {
            id: session.id,
            state: PublisherAutoReplyAuthoringState.SAVING,
            stageRevision: session.stageRevision,
          },
          data: {
            state: PublisherAutoReplyAuthoringState.COMPLETED,
            stageRevision: { increment: 1 },
            notificationKind: 'activated',
            notificationPending: true,
            notificationRevision: { increment: 1 },
            failureCode: null,
            lockedAt: null,
            lockToken: null,
            captureGuardUntil: null,
            expiresAt: new Date(Date.now() + RESULT_TTL_MS),
          },
        });
        if (completed.count !== 1) {
          throw new Error('Publisher auto-reply authoring session changed during activation');
        }
      });
      await this.releaseLease(session);
      return 'activated';
    } catch (error: unknown) {
      if (error instanceof BotCapabilityRequiredException) {
        await this.failSavingSession(session.id, 'bot_capability_required');
        return 'failed';
      }
      if (this.isPhraseConflict(error)) {
        await this.returnToReviewAfterPhraseConflict(session);
        return 'conflict';
      }
      const capacityFailureCode = this.readCapacityFailureCode(error);
      if (capacityFailureCode) {
        await this.returnToReviewAfterCapacityFailure(session, capacityFailureCode);
        return 'ready';
      }
      if (error instanceof HttpException && error.getStatus() >= 400 && error.getStatus() < 500) {
        await this.failSavingSession(session.id, 'access_or_activation_failed');
        return 'failed';
      }
      this.logger.warn(
        { sessionId, err: error instanceof Error ? error.message : String(error) },
        'Publisher auto-reply authoring activation will be retried',
      );
      throw error;
    }
  }

  private async returnToReviewAfterPhraseConflict(session: {
    id: string;
    state: PublisherAutoReplyAuthoringState;
    stageRevision: number;
    publisherBotId: string;
    actorUserId: string;
  }): Promise<void> {
    const expiresAt = new Date(Date.now() + REVIEW_TTL_MS);
    await this.prisma.$transaction(async (tx) => {
      const restored = await tx.publisherAutoReplyAuthoringSession.updateMany({
        where: { id: session.id, state: session.state, stageRevision: session.stageRevision },
        data: {
          state: PublisherAutoReplyAuthoringState.REVIEW,
          stageRevision: { increment: 1 },
          failureCode: 'phrase_conflict',
          notificationKind: 'conflict',
          notificationPending: true,
          notificationRevision: { increment: 1 },
          expiresAt,
        },
      });
      if (restored.count === 1) {
        const renewed = await this.privateFlows.renew(this.leaseFor(session, expiresAt), tx);
        if (!renewed) throw new Error('Publisher auto-reply authoring lease was lost');
      }
    });
  }

  private async returnToReviewAfterCapacityFailure(
    session: {
      id: string;
      state: PublisherAutoReplyAuthoringState;
      stageRevision: number;
      publisherBotId: string;
      actorUserId: string;
    },
    failureCode: 'trigger_capacity' | 'fuzzy_trigger_capacity',
  ): Promise<void> {
    const expiresAt = new Date(Date.now() + REVIEW_TTL_MS);
    await this.prisma.$transaction(async (tx) => {
      const restored = await tx.publisherAutoReplyAuthoringSession.updateMany({
        where: { id: session.id, state: session.state, stageRevision: session.stageRevision },
        data: {
          state: PublisherAutoReplyAuthoringState.REVIEW,
          stageRevision: { increment: 1 },
          failureCode,
          notificationKind: 'ready',
          notificationPending: true,
          notificationRevision: { increment: 1 },
          expiresAt,
        },
      });
      if (restored.count === 1) {
        const renewed = await this.privateFlows.renew(this.leaseFor(session, expiresAt), tx);
        if (!renewed) throw new Error('Publisher auto-reply authoring lease was lost');
      }
    });
  }

  async failInternalAfterFinalAttempt(sessionId: string): Promise<boolean> {
    const session = await this.prisma.publisherAutoReplyAuthoringSession.findFirst({
      where: {
        id: sessionId,
        state: {
          in: [
            PublisherAutoReplyAuthoringState.PROCESSING,
            PublisherAutoReplyAuthoringState.SAVING,
          ],
        },
      },
    });
    if (!session) return false;
    const failed = await this.prisma.publisherAutoReplyAuthoringSession.updateMany({
      where: { id: session.id, state: session.state },
      data: {
        state: PublisherAutoReplyAuthoringState.FAILED,
        stageRevision: { increment: 1 },
        failureCode: 'internal_error',
        notificationKind: 'failed',
        notificationPending: true,
        notificationRevision: { increment: 1 },
        lockedAt: null,
        lockToken: null,
        expiresAt: new Date(Date.now() + RESULT_TTL_MS),
      },
    });
    if (failed.count === 1) await this.releaseLease(session);
    return failed.count === 1;
  }

  private async failSession(
    sessionId: string,
    lockToken: string,
    failureCode: string,
  ): Promise<void> {
    const session = await this.prisma.publisherAutoReplyAuthoringSession.findFirst({
      where: { id: sessionId, state: PublisherAutoReplyAuthoringState.PROCESSING, lockToken },
    });
    if (!session) return;
    const failed = await this.prisma.publisherAutoReplyAuthoringSession.updateMany({
      where: { id: sessionId, state: session.state, lockToken },
      data: {
        state: PublisherAutoReplyAuthoringState.FAILED,
        stageRevision: { increment: 1 },
        failureCode,
        notificationKind: 'failed',
        notificationPending: true,
        notificationRevision: { increment: 1 },
        lockedAt: null,
        lockToken: null,
        captureGuardUntil: null,
        expiresAt: new Date(Date.now() + RESULT_TTL_MS),
      },
    });
    if (failed.count === 1) await this.releaseLease(session);
  }

  private async failSavingSession(sessionId: string, failureCode: string): Promise<void> {
    const session = await this.prisma.publisherAutoReplyAuthoringSession.findFirst({
      where: { id: sessionId, state: PublisherAutoReplyAuthoringState.SAVING },
    });
    if (!session) return;
    const failed = await this.prisma.publisherAutoReplyAuthoringSession.updateMany({
      where: { id: session.id, state: session.state, stageRevision: session.stageRevision },
      data: {
        state: PublisherAutoReplyAuthoringState.FAILED,
        stageRevision: { increment: 1 },
        failureCode,
        notificationKind: 'failed',
        notificationPending: true,
        notificationRevision: { increment: 1 },
        expiresAt: new Date(Date.now() + RESULT_TTL_MS),
      },
    });
    if (failed.count === 1) await this.releaseLease(session);
  }

  private async enableModule(
    tx: Prisma.TransactionClient,
    chatId: string,
    actorUserId: string,
  ): Promise<{ revision: number }> {
    const rows = await tx.$queryRaw<Array<{ revision: number }>>(Prisma.sql`
      INSERT INTO "publisher_entity_settings" (
        "chat_id",
        "auto_replies_enabled",
        "revision",
        "auto_reply_config_revision",
        "updated_by_user_id",
        "created_at",
        "updated_at"
      )
      VALUES (${chatId}, true, 0, 1, ${actorUserId}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT ("chat_id") DO UPDATE
      SET
        "auto_replies_enabled" = true,
        "auto_reply_config_revision" =
          "publisher_entity_settings"."auto_reply_config_revision" + 1,
        "revision" = CASE
          WHEN "publisher_entity_settings"."auto_replies_enabled"
            THEN "publisher_entity_settings"."revision"
          ELSE "publisher_entity_settings"."revision" + 1
        END,
        "updated_by_user_id" = EXCLUDED."updated_by_user_id",
        "updated_at" = CURRENT_TIMESTAMP
      RETURNING "revision"
    `);
    const row = rows[0];
    if (!row) throw new Error('Publisher auto-reply module settings upsert returned no row');
    return row;
  }

  private readTriggerPhrases(value: unknown, fallback: string): string[] {
    if (Array.isArray(value)) {
      const phrases = value.filter(
        (item): item is string => typeof item === 'string' && item.trim().length > 0,
      );
      if (phrases.length > 0) return phrases;
    }
    return [fallback];
  }

  private isPhraseConflict(error: unknown): boolean {
    if ((error as { code?: unknown } | null)?.code !== 'P2002') return false;
    const metadata = (error as { meta?: unknown }).meta;
    const serialized = JSON.stringify(metadata ?? '').toLowerCase();
    return (
      serialized.includes('publisher_auto_reply_rules_active_phrase_key') ||
      serialized.includes('publisher_auto_reply_triggers_active_phrase_key') ||
      serialized.includes('publisher_auto_reply_triggers_rule_normalized_phrase_key') ||
      (serialized.includes('chatid') && serialized.includes('normalizedphrase')) ||
      (serialized.includes('chat_id') && serialized.includes('normalized_phrase'))
    );
  }

  private readCapacityFailureCode(
    error: unknown,
  ): 'trigger_capacity' | 'fuzzy_trigger_capacity' | null {
    if (!(error instanceof HttpException)) return null;
    const response = error.getResponse();
    const code =
      typeof response === 'object' && response !== null && 'code' in response
        ? (response as { code?: unknown }).code
        : null;
    if (code === 'PUBLISHER_AUTO_REPLY_TRIGGER_LIMIT') return 'trigger_capacity';
    if (code === 'PUBLISHER_AUTO_REPLY_FUZZY_TRIGGER_LIMIT') return 'fuzzy_trigger_capacity';
    return null;
  }

  private leaseFor(
    session: {
      publisherBotId: string;
      actorUserId: string;
      id: string;
    },
    expiresAt: Date,
  ) {
    return {
      publisherBotId: session.publisherBotId,
      actorUserId: session.actorUserId,
      flowType: PublisherPrivateFlowType.AUTO_REPLY_AUTHORING,
      flowId: session.id,
      leaseToken: session.id,
      expiresAt,
    } as const;
  }

  private releaseLease(session: {
    publisherBotId: string;
    actorUserId: string;
    id: string;
  }): Promise<boolean> {
    return this.privateFlows.release({
      publisherBotId: session.publisherBotId,
      actorUserId: session.actorUserId,
      flowType: PublisherPrivateFlowType.AUTO_REPLY_AUTHORING,
      flowId: session.id,
      leaseToken: session.id,
    });
  }

  private authUser(userId: string): AuthUser {
    return { userId, username: null, displayName: null };
  }

  private draftRequestId(sessionId: string, stageRevision: number): string {
    return `ar-draft-${sessionId}-${stageRevision}`.slice(0, 128);
  }

  private activationRequestId(sessionId: string): string {
    return `ar-activate-${sessionId}`.slice(0, 128);
  }
}
