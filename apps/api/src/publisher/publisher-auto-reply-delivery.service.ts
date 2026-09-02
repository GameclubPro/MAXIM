import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { UnrecoverableError } from 'bullmq';
import { buildManagedBroadcastLinkButtonRows } from '../admin/admin-managed-broadcast-buttons';
import { readStoredPublicationButtons } from '../admin/publication-buttons';
import { extractHttpStatusCode } from '../common/http-error.util';
import { renderSupportedMarkdownAsHtml } from '../common/max-markdown.util';
import {
  MAX_API_SOURCE_TAGS,
  MaxClientService,
  type MaxAttachmentPayload,
} from '../max/max-client.service';
import {
  Prisma,
  PublicationContentFormat,
  PublisherAutoReplyAssetUploadStatus,
  PublisherAutoReplyDeliveryStatus,
  PublisherAutoReplyMatchKind,
} from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { PublisherActionCredentialService } from './publisher-action-credential.service';
import { PublisherDispatchHealthService } from './publisher-dispatch-health.service';
import { PublisherReadinessService } from './publisher-readiness.service';
import type { PublisherAutoReplyJob } from './publisher-auto-reply.queue';
import { PublisherAutoReplySourceFenceService } from './publisher-auto-reply-source-fence.service';

const DELIVERY_LEASE_MS = 2 * 60_000;
const UPLOAD_LEASE_MS = 2 * 60_000;
const UPLOAD_BOT_MARKER = '__maximUploadBotId';
const FAILURE_MESSAGE_MAX_LENGTH = 500;

type DeliveryAttempt = {
  final: boolean;
  attemptsMade: number;
  maxAttempts: number;
};

type DeliveryContent = {
  id: string;
  ruleId: string;
  text: string;
  textFormat: PublicationContentFormat;
  buttons: Prisma.JsonValue;
  assets: Array<{
    position: number;
    asset: {
      id: string;
      chatId: string;
      bytes: Uint8Array;
      mimeType: string;
      fileName: string;
      sizeBytes: number;
    };
  }>;
};

type LeasedDelivery = {
  id: string;
  chatId: string;
  ruleId: string;
  contentRevisionId: string;
  publisherBotId: string;
  sourceMessageId: string;
  sourceUserId: string | null;
  matchedRuleVersion: number;
  matchedNormalizedPhrase: string;
  matchedTriggerId: string | null;
  matchKind: PublisherAutoReplyMatchKind;
  matcherVersion: number;
  autoReplyConfigRevision: number;
  publisherSettingsRevision: number;
  publicationPolicyRevision: number;
  status: PublisherAutoReplyDeliveryStatus;
  dueAt: Date;
  lockToken: string | null;
  dispatchStartedAt: Date | null;
  rule: {
    version: number;
    normalizedPhrase: string;
    enabled: boolean;
    archivedAt: Date | null;
    cooldownSeconds: number;
    currentContentRevisionId: string | null;
  };
  matchedTrigger: {
    id: string;
    ruleId: string;
    normalizedPhrase: string;
    archivedAt: Date | null;
  } | null;
  chat: {
    publisherSettings: {
      autoRepliesEnabled: boolean;
      autoReplyConfigRevision: number;
      revision: number;
    } | null;
    publicationPolicy: { publikEnabled: boolean; revision: number } | null;
  };
  contentRevision: DeliveryContent;
};

export class PublisherAutoReplyDueError extends Error {
  constructor(readonly delayMs: number) {
    super('Publisher auto-reply is not due yet');
    this.name = 'PublisherAutoReplyDueError';
  }
}

class PublisherAutoReplyEpochChangedError extends Error {}
class PublisherAutoReplyClaimLostError extends Error {}
class PublisherAutoReplyCooldownError extends Error {}
class PublisherAutoReplyUploadBusyError extends Error {}

@Injectable()
export class PublisherAutoReplyDeliveryService {
  private readonly logger = new Logger(PublisherAutoReplyDeliveryService.name);
  private readonly publisherBotId: string;
  private readonly extendedMatchingMode: 'off' | 'shadow' | 'on';

  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    private readonly readiness: PublisherReadinessService,
    private readonly dispatchHealth: PublisherDispatchHealthService,
    private readonly sourceFence: PublisherAutoReplySourceFenceService,
    configService: ConfigService,
    credentials: PublisherActionCredentialService,
  ) {
    this.publisherBotId = credentials.getBotId();
    this.extendedMatchingMode = configService.get<'off' | 'shadow' | 'on'>(
      'PUBLISHER_AUTO_REPLY_EXTENDED_MATCHING_MODE',
      'on',
    );
    credentials.getRequiredActionToken(this.publisherBotId);
  }

  async process(job: PublisherAutoReplyJob, attempt: DeliveryAttempt): Promise<void> {
    this.assertJob(job);
    const initial = await this.prisma.publisherAutoReplyDelivery.findUnique({
      where: { id: job.deliveryId },
      select: {
        status: true,
        dueAt: true,
        lockedAt: true,
        dispatchStartedAt: true,
      },
    });
    if (!initial || this.isTerminal(initial.status)) {
      return;
    }
    if (initial.status === PublisherAutoReplyDeliveryStatus.SENDING && initial.dispatchStartedAt) {
      await this.quarantineAmbiguous(
        job.deliveryId,
        'A prior worker crossed the durable send fence without a confirmed message id',
      );
      return;
    }
    const now = new Date();
    if (initial.status === PublisherAutoReplyDeliveryStatus.PENDING && initial.dueAt > now) {
      throw new PublisherAutoReplyDueError(
        Math.max(100, Math.min(60_000, initial.dueAt.getTime() - now.getTime())),
      );
    }

    const lockToken = randomUUID();
    const staleBefore = new Date(now.getTime() - DELIVERY_LEASE_MS);
    const claimed = await this.prisma.publisherAutoReplyDelivery.updateMany({
      where: {
        id: job.deliveryId,
        dispatchStartedAt: null,
        OR: [
          { status: PublisherAutoReplyDeliveryStatus.PENDING },
          {
            status: PublisherAutoReplyDeliveryStatus.SENDING,
            OR: [{ lockedAt: null }, { lockedAt: { lte: staleBefore } }],
          },
        ],
      },
      data: {
        status: PublisherAutoReplyDeliveryStatus.SENDING,
        lockedAt: now,
        lockToken,
        attemptCount: { increment: 1 },
        failureCode: null,
        failureMessage: null,
      },
    });
    if (claimed.count !== 1) {
      return;
    }

    let delivery: LeasedDelivery;
    try {
      delivery = await this.loadLeasedDelivery(job.deliveryId, lockToken);
      this.assertCurrentEpoch(delivery);
      await this.assertCurrentSource(delivery);
      const route = await this.readiness.assertEntityReady(delivery.chatId, 'auto_replies');
      if (
        route.entityType !== 'chat' ||
        route.requiredBotId !== this.publisherBotId ||
        route.requiredBotId !== delivery.publisherBotId
      ) {
        throw new PublisherAutoReplyEpochChangedError('Publisher route changed');
      }
    } catch (error: unknown) {
      if (error instanceof PublisherAutoReplyEpochChangedError || this.isSetupRequired(error)) {
        await this.cancelClaim(job.deliveryId, lockToken, 'EPOCH_CHANGED');
        return;
      }
      await this.retryOrFailClaim(job.deliveryId, lockToken, error, attempt, 'PREPARATION_FAILED');
      if (!attempt.final) throw error;
      return;
    }

    let payloads: Record<string, unknown>[];
    try {
      payloads = await this.prepareAssetPayloads(delivery);
    } catch (error: unknown) {
      const terminal = error instanceof UnrecoverableError;
      await this.retryOrFailClaim(
        job.deliveryId,
        lockToken,
        error,
        { ...attempt, final: attempt.final || terminal },
        terminal ? 'INVALID_ASSET' : 'UPLOAD_FAILED',
      );
      if (!attempt.final && !terminal) throw error;
      return;
    }

    const rendered = this.renderContent(delivery.contentRevision);
    const buttonRows = buildManagedBroadcastLinkButtonRows(
      readStoredPublicationButtons(delivery.contentRevision.buttons),
      { buttonsPerRow: 1 },
    );
    let fenceActive = false;
    let refreshedInvalidAttachments = false;
    for (;;) {
      try {
        const sent = await this.maxClient.sendMessageImmediateWithId(
          delivery.chatId,
          rendered.text,
          {
            ...(rendered.textFormat ? { textFormat: rendered.textFormat } : {}),
            ...this.buildMediaOptions(payloads),
            ...(buttonRows.length > 0 ? { buttons: buttonRows } : {}),
            messageLink: { type: 'reply', mid: delivery.sourceMessageId },
            beforeSend: async () => {
              await this.dispatchHealth.assertDispatchAllowed();
              const immediateRoute = await this.readiness.assertEntityReady(
                delivery.chatId,
                'auto_replies',
              );
              if (
                immediateRoute.entityType !== 'chat' ||
                immediateRoute.requiredBotId !== this.publisherBotId ||
                immediateRoute.requiredBotId !== delivery.publisherBotId
              ) {
                throw new PublisherAutoReplyEpochChangedError('Publisher route changed');
              }
              await this.assertCurrentSource(delivery);
              await this.recordSendFence(delivery, lockToken);
              fenceActive = true;
            },
            debugContext: {
              screen: 'publisher-auto-replies',
              action: 'deliver-auto-reply',
            },
          },
          {
            trafficClass: 'interactive',
            actionHealthLane: 'interactive',
            sourceTag: MAX_API_SOURCE_TAGS.PUBLISHER_AUTO_REPLY,
            botId: delivery.publisherBotId,
          },
        );
        await this.completeSent(delivery, lockToken, sent.messageId);
        await this.dispatchHealth.recordSendSuccess(delivery.chatId);
        return;
      } catch (error: unknown) {
        if (error instanceof PublisherAutoReplyCooldownError) {
          await this.cancelClaim(delivery.id, lockToken, 'COOLDOWN_ACTIVE');
          return;
        }
        if (
          error instanceof PublisherAutoReplyEpochChangedError ||
          error instanceof PublisherAutoReplyClaimLostError
        ) {
          await this.cancelClaim(delivery.id, lockToken, 'SOURCE_OR_RULE_CHANGED');
          return;
        }

        const statusCode = extractHttpStatusCode(error);
        if (
          fenceActive &&
          !refreshedInvalidAttachments &&
          payloads.length > 0 &&
          this.isDefinitiveInvalidAttachment(error)
        ) {
          if (!(await this.clearDefinitiveSendFence(delivery.id, lockToken))) {
            return;
          }
          fenceActive = false;
          refreshedInvalidAttachments = true;
          try {
            await this.invalidateAssetUploads(
              delivery.contentRevision.assets.map(({ asset }) => asset.id),
            );
            payloads = await this.prepareAssetPayloads(delivery);
            continue;
          } catch (refreshError: unknown) {
            await this.retryOrFailClaim(
              delivery.id,
              lockToken,
              refreshError,
              attempt,
              'ATTACHMENT_REFRESH_FAILED',
            );
            if (!attempt.final) throw refreshError;
            return;
          }
        }

        if (fenceActive && this.isDefinitiveNonDeliveryStatus(statusCode)) {
          await this.clearDefinitiveSendFence(delivery.id, lockToken);
          fenceActive = false;
          await this.recordSendFailureSafely(delivery.chatId, error);
          if (statusCode === 429) {
            await this.retryOrFailClaim(delivery.id, lockToken, error, attempt, 'RATE_LIMITED');
            if (!attempt.final) throw error;
            return;
          }
          await this.failClaim(delivery.id, lockToken, 'MAX_REJECTED', error);
          return;
        }

        if (fenceActive) {
          await this.recordSendFailureSafely(delivery.chatId, error);
          await this.quarantineAmbiguous(delivery.id, this.errorSummary(error), lockToken);
          return;
        }

        await this.retryOrFailClaim(delivery.id, lockToken, error, attempt, 'SEND_PREP_FAILED');
        if (!attempt.final) throw error;
        return;
      }
    }
  }

  private loadLeasedDelivery(id: string, lockToken: string): Promise<LeasedDelivery> {
    return this.prisma.publisherAutoReplyDelivery
      .findFirstOrThrow({
        where: {
          id,
          status: PublisherAutoReplyDeliveryStatus.SENDING,
          lockToken,
          dispatchStartedAt: null,
        },
        include: {
          rule: {
            select: {
              version: true,
              normalizedPhrase: true,
              enabled: true,
              archivedAt: true,
              cooldownSeconds: true,
              currentContentRevisionId: true,
            },
          },
          matchedTrigger: {
            select: {
              id: true,
              ruleId: true,
              normalizedPhrase: true,
              archivedAt: true,
            },
          },
          chat: {
            select: {
              publisherSettings: {
                select: {
                  autoRepliesEnabled: true,
                  autoReplyConfigRevision: true,
                  revision: true,
                },
              },
              publicationPolicy: { select: { publikEnabled: true, revision: true } },
            },
          },
          contentRevision: {
            select: {
              id: true,
              ruleId: true,
              text: true,
              textFormat: true,
              buttons: true,
              assets: {
                orderBy: { position: 'asc' },
                select: {
                  position: true,
                  asset: {
                    select: {
                      id: true,
                      chatId: true,
                      bytes: true,
                      mimeType: true,
                      fileName: true,
                      sizeBytes: true,
                    },
                  },
                },
              },
            },
          },
        },
      })
      .then((row) => row as LeasedDelivery);
  }

  private assertCurrentEpoch(delivery: LeasedDelivery): void {
    const policyRevision = delivery.chat.publicationPolicy?.revision ?? 0;
    if (
      delivery.publisherBotId !== this.publisherBotId ||
      delivery.status !== PublisherAutoReplyDeliveryStatus.SENDING ||
      !delivery.sourceUserId ||
      delivery.rule.archivedAt !== null ||
      !delivery.rule.enabled ||
      delivery.rule.version !== delivery.matchedRuleVersion ||
      (this.extendedMatchingMode !== 'on' &&
        delivery.matchKind !== PublisherAutoReplyMatchKind.EXACT_FULL) ||
      delivery.matcherVersion !== 1 ||
      (delivery.matchedTriggerId
        ? !delivery.matchedTrigger ||
          delivery.matchedTrigger.id !== delivery.matchedTriggerId ||
          delivery.matchedTrigger.ruleId !== delivery.ruleId ||
          delivery.matchedTrigger.archivedAt !== null ||
          delivery.matchedTrigger.normalizedPhrase !== delivery.matchedNormalizedPhrase
        : delivery.rule.normalizedPhrase !== delivery.matchedNormalizedPhrase) ||
      delivery.rule.currentContentRevisionId !== delivery.contentRevisionId ||
      delivery.contentRevision.id !== delivery.contentRevisionId ||
      delivery.contentRevision.ruleId !== delivery.ruleId ||
      delivery.chat.publisherSettings?.autoRepliesEnabled !== true ||
      delivery.chat.publisherSettings.revision !== delivery.publisherSettingsRevision ||
      delivery.chat.publisherSettings.autoReplyConfigRevision !==
        delivery.autoReplyConfigRevision ||
      delivery.chat.publicationPolicy?.publikEnabled === false ||
      policyRevision !== delivery.publicationPolicyRevision ||
      delivery.contentRevision.assets.some(({ asset }) => asset.chatId !== delivery.chatId)
    ) {
      throw new PublisherAutoReplyEpochChangedError('Publisher auto-reply epoch changed');
    }
  }

  private async recordSendFence(delivery: LeasedDelivery, lockToken: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const sourceAdmitted = await this.sourceFence.lockAdmitted(tx, {
        publisherBotId: delivery.publisherBotId,
        chatId: delivery.chatId,
        sourceMessageId: delivery.sourceMessageId,
      });
      if (!sourceAdmitted) {
        throw new PublisherAutoReplyEpochChangedError('Publisher auto-reply source changed');
      }
      const current = (await tx.publisherAutoReplyDelivery.findFirst({
        where: {
          id: delivery.id,
          status: PublisherAutoReplyDeliveryStatus.SENDING,
          lockToken,
          dispatchStartedAt: null,
        },
        include: {
          rule: {
            select: {
              version: true,
              normalizedPhrase: true,
              enabled: true,
              archivedAt: true,
              cooldownSeconds: true,
              currentContentRevisionId: true,
            },
          },
          matchedTrigger: {
            select: {
              id: true,
              ruleId: true,
              normalizedPhrase: true,
              archivedAt: true,
            },
          },
          chat: {
            select: {
              publisherSettings: {
                select: {
                  autoRepliesEnabled: true,
                  autoReplyConfigRevision: true,
                  revision: true,
                },
              },
              publicationPolicy: { select: { publikEnabled: true, revision: true } },
            },
          },
          contentRevision: {
            select: {
              id: true,
              ruleId: true,
              text: true,
              textFormat: true,
              buttons: true,
              assets: false,
            },
          },
        },
      })) as LeasedDelivery | null;
      if (!current) {
        throw new PublisherAutoReplyClaimLostError();
      }
      this.assertCurrentEpoch({
        ...current,
        contentRevision: { ...current.contentRevision, assets: delivery.contentRevision.assets },
      });
      await this.claimCooldown(tx, current);
      const started = await tx.publisherAutoReplyDelivery.updateMany({
        where: {
          id: delivery.id,
          status: PublisherAutoReplyDeliveryStatus.SENDING,
          lockToken,
          dispatchStartedAt: null,
        },
        data: { dispatchStartedAt: new Date() },
      });
      if (started.count !== 1) {
        throw new PublisherAutoReplyClaimLostError();
      }
    });
  }

  private async claimCooldown(
    tx: Prisma.TransactionClient,
    delivery: LeasedDelivery,
  ): Promise<void> {
    const sourceUserId = delivery.sourceUserId?.trim() ?? '';
    const cooldownSeconds = Math.max(0, delivery.rule.cooldownSeconds);
    if (!sourceUserId || cooldownSeconds === 0) {
      return;
    }
    const now = new Date();
    const nextAllowedAt = new Date(now.getTime() + cooldownSeconds * 1_000);
    const rows = await tx.$queryRaw<Array<{ rule_id: string }>>(Prisma.sql`
      INSERT INTO "publisher_auto_reply_cooldowns" (
        "rule_id", "source_user_id", "next_allowed_at", "last_source_message_id", "version", "updated_at"
      )
      VALUES (
        ${delivery.ruleId}, ${sourceUserId}, ${nextAllowedAt}, ${delivery.sourceMessageId}, 1, ${now}
      )
      ON CONFLICT ("rule_id", "source_user_id") DO UPDATE
      SET
        "next_allowed_at" = CASE
          WHEN "publisher_auto_reply_cooldowns"."last_source_message_id" = EXCLUDED."last_source_message_id"
            THEN "publisher_auto_reply_cooldowns"."next_allowed_at"
          ELSE EXCLUDED."next_allowed_at"
        END,
        "last_source_message_id" = EXCLUDED."last_source_message_id",
        "version" = CASE
          WHEN "publisher_auto_reply_cooldowns"."last_source_message_id" = EXCLUDED."last_source_message_id"
            THEN "publisher_auto_reply_cooldowns"."version"
          ELSE "publisher_auto_reply_cooldowns"."version" + 1
        END,
        "updated_at" = EXCLUDED."updated_at"
      WHERE
        "publisher_auto_reply_cooldowns"."last_source_message_id" = EXCLUDED."last_source_message_id"
        OR "publisher_auto_reply_cooldowns"."next_allowed_at" <= ${now}
      RETURNING "rule_id"
    `);
    if (rows.length !== 1) {
      throw new PublisherAutoReplyCooldownError();
    }
  }

  private async prepareAssetPayloads(delivery: LeasedDelivery): Promise<Record<string, unknown>[]> {
    const payloads: Record<string, unknown>[] = [];
    for (const { asset } of delivery.contentRevision.assets) {
      payloads.push(await this.resolveAssetPayload(asset, delivery.publisherBotId));
    }
    return payloads;
  }

  private async resolveAssetPayload(
    asset: DeliveryContent['assets'][number]['asset'],
    publisherBotId: string,
  ): Promise<Record<string, unknown>> {
    if (
      !asset.mimeType.toLowerCase().startsWith('image/') ||
      asset.bytes.byteLength <= 0 ||
      asset.bytes.byteLength !== asset.sizeBytes
    ) {
      throw new UnrecoverableError('Publisher auto-reply image asset is invalid');
    }
    const now = new Date();
    await this.prisma.publisherAutoReplyAssetUpload.createMany({
      data: [{ assetId: asset.id, publisherBotId }],
      skipDuplicates: true,
    });
    const existing = await this.prisma.publisherAutoReplyAssetUpload.findUnique({
      where: { assetId_publisherBotId: { assetId: asset.id, publisherBotId } },
    });
    const cached = this.readCachedPayload(existing?.payload, publisherBotId);
    if (
      existing?.status === PublisherAutoReplyAssetUploadStatus.READY &&
      cached &&
      (!existing.expiresAt || existing.expiresAt > now)
    ) {
      return cached;
    }

    const lockToken = randomUUID();
    const staleBefore = new Date(now.getTime() - UPLOAD_LEASE_MS);
    const claimed = await this.prisma.publisherAutoReplyAssetUpload.updateMany({
      where: {
        assetId: asset.id,
        publisherBotId,
        OR: [
          { status: { not: PublisherAutoReplyAssetUploadStatus.UPLOADING } },
          { lockedAt: null },
          { lockedAt: { lte: staleBefore } },
        ],
      },
      data: {
        status: PublisherAutoReplyAssetUploadStatus.UPLOADING,
        lockedAt: now,
        lockToken,
        attemptCount: { increment: 1 },
        failureCode: null,
      },
    });
    if (claimed.count !== 1) {
      throw new PublisherAutoReplyUploadBusyError();
    }

    try {
      const payload = await this.maxClient.uploadImage(
        Buffer.from(asset.bytes),
        asset.fileName || 'auto-reply-image.jpg',
        asset.mimeType,
        {
          trafficClass: 'interactive',
          actionHealthLane: 'interactive',
          sourceTag: MAX_API_SOURCE_TAGS.PUBLISHER_AUTO_REPLY,
          botId: publisherBotId,
        },
      );
      const persistedPayload = {
        ...payload,
        [UPLOAD_BOT_MARKER]: publisherBotId,
      };
      const completed = await this.prisma.publisherAutoReplyAssetUpload.updateMany({
        where: { assetId: asset.id, publisherBotId, lockToken },
        data: {
          status: PublisherAutoReplyAssetUploadStatus.READY,
          payload: persistedPayload as Prisma.InputJsonValue,
          expiresAt: null,
          lockedAt: null,
          lockToken: null,
          failureCode: null,
        },
      });
      if (completed.count !== 1) {
        throw new PublisherAutoReplyUploadBusyError();
      }
      return payload;
    } catch (error: unknown) {
      await this.prisma.publisherAutoReplyAssetUpload.updateMany({
        where: { assetId: asset.id, publisherBotId, lockToken },
        data: {
          status: PublisherAutoReplyAssetUploadStatus.FAILED,
          lockedAt: null,
          lockToken: null,
          failureCode: this.errorCode(error),
        },
      });
      throw error;
    }
  }

  private readCachedPayload(
    value: unknown,
    publisherBotId: string,
  ): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    const payload = value as Record<string, unknown>;
    if (payload[UPLOAD_BOT_MARKER] !== publisherBotId) {
      return null;
    }
    const outbound = { ...payload };
    delete outbound[UPLOAD_BOT_MARKER];
    return Object.keys(outbound).length > 0 ? outbound : null;
  }

  private invalidateAssetUploads(assetIds: string[]): Promise<{ count: number }> {
    if (assetIds.length === 0) {
      return Promise.resolve({ count: 0 });
    }
    return this.prisma.publisherAutoReplyAssetUpload.updateMany({
      where: { assetId: { in: assetIds }, publisherBotId: this.publisherBotId },
      data: {
        status: PublisherAutoReplyAssetUploadStatus.PENDING,
        payload: Prisma.DbNull,
        expiresAt: null,
        lockedAt: null,
        lockToken: null,
        failureCode: 'ATTACHMENT_REJECTED',
      },
    });
  }

  private renderContent(content: DeliveryContent): {
    text: string;
    textFormat?: 'html';
  } {
    if (content.textFormat === PublicationContentFormat.MARKDOWN) {
      return {
        text: renderSupportedMarkdownAsHtml(content.text, { blockMode: 'raw' }),
        textFormat: 'html',
      };
    }
    return { text: content.text };
  }

  private async assertCurrentSource(delivery: LeasedDelivery): Promise<void> {
    const state = await this.sourceFence.read({
      publisherBotId: delivery.publisherBotId,
      chatId: delivery.chatId,
      sourceMessageId: delivery.sourceMessageId,
    });
    if (state !== 'admitted') {
      throw new PublisherAutoReplyEpochChangedError('Publisher auto-reply source changed');
    }
  }

  private buildMediaOptions(payloads: Record<string, unknown>[]): {
    imagePayload?: Record<string, unknown>;
    attachments?: MaxAttachmentPayload[];
  } {
    if (payloads.length === 1) {
      return { imagePayload: payloads[0]! };
    }
    if (payloads.length > 1) {
      return { attachments: payloads.map((payload) => ({ type: 'image', payload })) };
    }
    return {};
  }

  private async completeSent(
    delivery: LeasedDelivery,
    lockToken: string,
    remoteMessageId: string,
  ): Promise<void> {
    const completed = await this.prisma.publisherAutoReplyDelivery.updateMany({
      where: {
        id: delivery.id,
        status: PublisherAutoReplyDeliveryStatus.SENDING,
        lockToken,
        dispatchStartedAt: { not: null },
      },
      data: {
        status: PublisherAutoReplyDeliveryStatus.SENT,
        remoteMessageId,
        lockedAt: null,
        lockToken: null,
        failureCode: null,
        failureMessage: null,
      },
    });
    if (completed.count === 1) {
      return;
    }
    const recovered = await this.prisma.publisherAutoReplyDelivery.updateMany({
      where: {
        id: delivery.id,
        publisherBotId: delivery.publisherBotId,
        status: PublisherAutoReplyDeliveryStatus.SENDING,
        dispatchStartedAt: { not: null },
        remoteMessageId: null,
      },
      data: {
        status: PublisherAutoReplyDeliveryStatus.SENT,
        remoteMessageId,
        lockedAt: null,
        lockToken: null,
        failureCode: null,
        failureMessage: null,
      },
    });
    if (recovered.count !== 1) {
      throw new Error('Confirmed Publisher auto-reply message id could not be persisted');
    }
  }

  private clearDefinitiveSendFence(id: string, lockToken: string): Promise<boolean> {
    return this.prisma.publisherAutoReplyDelivery
      .updateMany({
        where: {
          id,
          status: PublisherAutoReplyDeliveryStatus.SENDING,
          lockToken,
          dispatchStartedAt: { not: null },
          remoteMessageId: null,
        },
        data: { dispatchStartedAt: null },
      })
      .then((result) => result.count === 1);
  }

  private cancelClaim(id: string, lockToken: string, code: string): Promise<{ count: number }> {
    return this.prisma.publisherAutoReplyDelivery.updateMany({
      where: {
        id,
        status: PublisherAutoReplyDeliveryStatus.SENDING,
        lockToken,
        dispatchStartedAt: null,
      },
      data: {
        status: PublisherAutoReplyDeliveryStatus.CANCELED,
        canceledAt: new Date(),
        lockedAt: null,
        lockToken: null,
        failureCode: code,
        failureMessage: null,
      },
    });
  }

  private failClaim(
    id: string,
    lockToken: string,
    code: string,
    error: unknown,
  ): Promise<{ count: number }> {
    return this.prisma.publisherAutoReplyDelivery.updateMany({
      where: {
        id,
        status: PublisherAutoReplyDeliveryStatus.SENDING,
        lockToken,
        dispatchStartedAt: null,
      },
      data: {
        status: PublisherAutoReplyDeliveryStatus.FAILED,
        lockedAt: null,
        lockToken: null,
        failureCode: code,
        failureMessage: this.errorSummary(error),
      },
    });
  }

  private async retryOrFailClaim(
    id: string,
    lockToken: string,
    error: unknown,
    attempt: DeliveryAttempt,
    failureCode: string,
  ): Promise<void> {
    if (attempt.final) {
      await this.failClaim(id, lockToken, failureCode, error);
      return;
    }
    await this.prisma.publisherAutoReplyDelivery.updateMany({
      where: {
        id,
        status: PublisherAutoReplyDeliveryStatus.SENDING,
        lockToken,
        dispatchStartedAt: null,
      },
      data: {
        status: PublisherAutoReplyDeliveryStatus.PENDING,
        lockedAt: null,
        lockToken: null,
        failureCode,
        failureMessage: this.errorSummary(error),
      },
    });
  }

  private quarantineAmbiguous(
    id: string,
    message: string,
    lockToken?: string | null,
  ): Promise<{ count: number }> {
    return this.prisma.publisherAutoReplyDelivery.updateMany({
      where: {
        id,
        status: PublisherAutoReplyDeliveryStatus.SENDING,
        dispatchStartedAt: { not: null },
        ...(lockToken ? { lockToken } : {}),
      },
      data: {
        status: PublisherAutoReplyDeliveryStatus.AMBIGUOUS,
        lockedAt: null,
        lockToken: null,
        failureCode: 'AMBIGUOUS_SEND',
        failureMessage: message.slice(0, FAILURE_MESSAGE_MAX_LENGTH),
      },
    });
  }

  private isTerminal(status: PublisherAutoReplyDeliveryStatus): boolean {
    return (
      status === PublisherAutoReplyDeliveryStatus.SENT ||
      status === PublisherAutoReplyDeliveryStatus.FAILED ||
      status === PublisherAutoReplyDeliveryStatus.AMBIGUOUS ||
      status === PublisherAutoReplyDeliveryStatus.CANCELED
    );
  }

  private isDefinitiveInvalidAttachment(error: unknown): boolean {
    const status = extractHttpStatusCode(error);
    if (status !== 400 && status !== 422) {
      return false;
    }
    const responseData = (error as { response?: { data?: unknown } } | null)?.response?.data;
    let responseDiagnostic = '';
    if (typeof responseData === 'string') {
      responseDiagnostic = responseData.slice(0, 2_000);
    } else if (responseData && typeof responseData === 'object') {
      try {
        responseDiagnostic = JSON.stringify(responseData).slice(0, 2_000);
      } catch {
        responseDiagnostic = '';
      }
    }
    const message = `${this.errorSummary(error)} ${responseDiagnostic}`.toLowerCase();
    return /(attachment|upload|image|photo|token|влож|изображ|фото)/u.test(message);
  }

  private isDefinitiveNonDeliveryStatus(status: number | null): boolean {
    return status !== null && status >= 400 && status < 500 && status !== 408;
  }

  private isSetupRequired(error: unknown): boolean {
    return (
      (error as { response?: { code?: unknown } } | null)?.response?.code ===
      'PUBLISHER_SETUP_REQUIRED'
    );
  }

  private async recordSendFailureSafely(chatId: string, error: unknown): Promise<void> {
    try {
      await this.dispatchHealth.recordSendFailure(chatId, error);
    } catch (healthError: unknown) {
      this.logger.warn(
        { chatId, code: this.errorCode(healthError) },
        'Publisher auto-reply health bookkeeping failed',
      );
    }
  }

  private errorCode(error: unknown): string {
    const status = extractHttpStatusCode(error);
    if (status) return `HTTP_${status}`;
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === 'string' && code.trim() ? code.trim().slice(0, 80) : 'UNKNOWN';
  }

  private errorSummary(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    return raw
      .replace(/[A-Za-z0-9+/=_-]{160,}/gu, '[redacted]')
      .slice(0, FAILURE_MESSAGE_MAX_LENGTH);
  }

  private assertJob(job: PublisherAutoReplyJob): void {
    if (
      job.version !== 1 ||
      job.kind !== 'deliver' ||
      job.retryPolicyName !== 'publisher-auto-reply' ||
      !job.deliveryId?.trim()
    ) {
      throw new UnrecoverableError('Publisher auto-reply job envelope is invalid');
    }
  }
}
