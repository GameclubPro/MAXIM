import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma, WebhookExecutionClaimStatus } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';

const PUBLISHER_AUTO_REPLY_SOURCE_FENCE_KIND = 'PUBLISHER_AUTO_REPLY_SOURCE';

export type PublisherAutoReplySourceFenceState = 'admitted' | 'canceled' | 'missing';

type PublisherAutoReplySourceIdentity = {
  publisherBotId: string;
  chatId: string;
  sourceMessageId: string;
};

type PublisherAutoReplySourceMutation = PublisherAutoReplySourceIdentity & {
  sourceWebhookEventId?: string | null;
};

@Injectable()
export class PublisherAutoReplySourceFenceService {
  constructor(private readonly prisma: PrismaService) {}

  async admit(params: PublisherAutoReplySourceMutation): Promise<PublisherAutoReplySourceFenceState> {
    const semanticKey = this.buildSemanticKey(params);
    const existing = await this.readBySemanticKey(semanticKey);
    if (existing !== 'missing') {
      return existing;
    }
    const sourceWebhookEventId = this.requireWebhookEventId(params.sourceWebhookEventId);
    const now = new Date();

    // FLAG: COMPLETED is an absorbing cancellation state. Admission may create READY only when
    // no source fence exists and must never overwrite a concurrent edit/removal tombstone.
    await this.prisma.webhookExecutionClaim.createMany({
      data: [
        {
          kind: PUBLISHER_AUTO_REPLY_SOURCE_FENCE_KIND,
          semanticKey,
          webhookEventId: sourceWebhookEventId,
          enforced: true,
          status: WebhookExecutionClaimStatus.READY,
          preparedAt: now,
        },
      ],
      skipDuplicates: true,
    });
    return this.readBySemanticKey(semanticKey);
  }

  async cancel(params: PublisherAutoReplySourceMutation): Promise<void> {
    const semanticKey = this.buildSemanticKey(params);
    if ((await this.readBySemanticKey(semanticKey)) === 'canceled') {
      return;
    }
    const sourceWebhookEventId = this.requireWebhookEventId(params.sourceWebhookEventId);
    const now = new Date();

    // FLAG: Cancellation wins regardless of whether READY was committed before or during this
    // transaction. The unique kind/semantic key serializes concurrent source lifecycle updates.
    await this.prisma.$transaction(async (tx) => {
      await tx.webhookExecutionClaim.createMany({
        data: [
          {
            kind: PUBLISHER_AUTO_REPLY_SOURCE_FENCE_KIND,
            semanticKey,
            webhookEventId: sourceWebhookEventId,
            enforced: true,
            status: WebhookExecutionClaimStatus.COMPLETED,
            completedAt: now,
          },
        ],
        skipDuplicates: true,
      });
      await tx.webhookExecutionClaim.updateMany({
        where: {
          kind: PUBLISHER_AUTO_REPLY_SOURCE_FENCE_KIND,
          semanticKey,
          status: { not: WebhookExecutionClaimStatus.COMPLETED },
        },
        data: {
          webhookEventId: sourceWebhookEventId,
          enforced: true,
          status: WebhookExecutionClaimStatus.COMPLETED,
          completedAt: now,
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
    });
  }

  read(params: PublisherAutoReplySourceIdentity): Promise<PublisherAutoReplySourceFenceState> {
    return this.readBySemanticKey(this.buildSemanticKey(params));
  }

  async lockAdmitted(
    tx: Prisma.TransactionClient,
    params: PublisherAutoReplySourceIdentity,
  ): Promise<boolean> {
    const semanticKey = this.buildSemanticKey(params);
    const rows = await tx.$queryRaw<Array<{ status: string }>>(Prisma.sql`
      /* publisher_auto_reply_source_fence_lock */
      SELECT "status"::text AS "status"
      FROM "webhook_execution_claims"
      WHERE "kind" = ${PUBLISHER_AUTO_REPLY_SOURCE_FENCE_KIND}
        AND "semantic_key" = ${semanticKey}
      FOR UPDATE
    `);
    return rows[0]?.status === WebhookExecutionClaimStatus.READY;
  }

  private async readBySemanticKey(
    semanticKey: string,
  ): Promise<PublisherAutoReplySourceFenceState> {
    const claim = await this.prisma.webhookExecutionClaim.findUnique({
      where: {
        kind_semanticKey: {
          kind: PUBLISHER_AUTO_REPLY_SOURCE_FENCE_KIND,
          semanticKey,
        },
      },
      select: { status: true },
    });
    if (!claim) {
      return 'missing';
    }
    if (claim.status === WebhookExecutionClaimStatus.READY) {
      return 'admitted';
    }
    if (claim.status === WebhookExecutionClaimStatus.COMPLETED) {
      return 'canceled';
    }
    throw new Error('Publisher auto-reply source fence has an invalid pending state');
  }

  private buildSemanticKey(params: PublisherAutoReplySourceIdentity): string {
    const publisherBotId = this.requireIdentity(params.publisherBotId, 'publisherBotId');
    const chatId = this.requireIdentity(params.chatId, 'chatId');
    const sourceMessageId = this.requireIdentity(params.sourceMessageId, 'sourceMessageId');
    const digest = createHash('sha256')
      .update(JSON.stringify([publisherBotId, chatId, sourceMessageId]))
      .digest('hex');
    return `publisher-auto-reply-source:${digest}`;
  }

  private requireIdentity(value: string, label: string): string {
    const normalized = value.trim();
    if (!normalized) {
      throw new Error(`Publisher auto-reply source fence ${label} is required`);
    }
    return normalized;
  }

  private requireWebhookEventId(value: string | null | undefined): string {
    const normalized = value?.trim() ?? '';
    if (!normalized) {
      throw new Error('Publisher auto-reply source fence webhookEventId is required');
    }
    return normalized;
  }
}

export const PUBLISHER_AUTO_REPLY_SOURCE_FENCE_TESTING = Object.freeze({
  kind: PUBLISHER_AUTO_REPLY_SOURCE_FENCE_KIND,
});
