import { Injectable } from '@nestjs/common';
import { Prisma, PublisherPrivateFlowType } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';

type PrivateFlowLeaseRow = {
  publisher_bot_id: string;
  actor_user_id: string;
  flow_type: PublisherPrivateFlowType;
  flow_id: string;
  lease_token: string;
  expires_at: Date;
};

export type PublisherPrivateFlowLease = {
  publisherBotId: string;
  actorUserId: string;
  flowType: PublisherPrivateFlowType;
  flowId: string;
  leaseToken: string;
  expiresAt: Date;
};

type PrivateFlowTx = Pick<
  Prisma.TransactionClient,
  '$executeRaw' | '$queryRaw' | 'publisherPrivateFlowLease'
>;

@Injectable()
export class PublisherPrivateFlowLeaseService {
  constructor(private readonly prisma: PrismaService) {}

  acquire(
    params: PublisherPrivateFlowLease,
    tx: PrivateFlowTx = this.prisma,
  ): Promise<PublisherPrivateFlowLease | null> {
    return this.acquireWithClient(tx, params);
  }

  async read(
    publisherBotId: string,
    actorUserId: string,
    tx: PrivateFlowTx = this.prisma,
  ): Promise<PublisherPrivateFlowLease | null> {
    const row = await tx.publisherPrivateFlowLease.findUnique({
      where: {
        publisherBotId_actorUserId: {
          publisherBotId: publisherBotId.trim(),
          actorUserId: actorUserId.trim(),
        },
      },
    });
    return row && row.expiresAt > new Date() ? row : null;
  }

  async renew(
    params: PublisherPrivateFlowLease,
    tx: PrivateFlowTx = this.prisma,
  ): Promise<boolean> {
    const updated = await tx.$executeRaw(Prisma.sql`
      UPDATE "publisher_private_flow_leases"
      SET
        "expires_at" = GREATEST("expires_at", ${params.expiresAt}),
        "updated_at" = CURRENT_TIMESTAMP
      WHERE
        "publisher_bot_id" = ${params.publisherBotId.trim()}
        AND "actor_user_id" = ${params.actorUserId.trim()}
        AND "flow_type" = ${params.flowType}::"PublisherPrivateFlowType"
        AND "flow_id" = ${params.flowId.trim()}
        AND "lease_token" = ${params.leaseToken.trim()}
    `);
    return updated === 1;
  }

  async release(
    params: Omit<PublisherPrivateFlowLease, 'expiresAt'>,
    tx: PrivateFlowTx = this.prisma,
  ): Promise<boolean> {
    const deleted = await tx.publisherPrivateFlowLease.deleteMany({
      where: {
        publisherBotId: params.publisherBotId.trim(),
        actorUserId: params.actorUserId.trim(),
        flowType: params.flowType,
        flowId: params.flowId.trim(),
        leaseToken: params.leaseToken.trim(),
      },
    });
    return deleted.count === 1;
  }

  async releaseExpired(now = new Date()): Promise<number> {
    const deleted = await this.prisma.publisherPrivateFlowLease.deleteMany({
      where: { expiresAt: { lte: now } },
    });
    return deleted.count;
  }

  private async acquireWithClient(
    tx: PrivateFlowTx,
    params: PublisherPrivateFlowLease,
  ): Promise<PublisherPrivateFlowLease | null> {
    const publisherBotId = params.publisherBotId.trim();
    const actorUserId = params.actorUserId.trim();
    const flowId = params.flowId.trim();
    const leaseToken = params.leaseToken.trim();
    if (!publisherBotId || !actorUserId || !flowId || !leaseToken) {
      throw new Error('Publisher private flow lease identity is incomplete');
    }

    const rows = await tx.$queryRaw<PrivateFlowLeaseRow[]>(Prisma.sql`
      INSERT INTO "publisher_private_flow_leases" (
        "publisher_bot_id",
        "actor_user_id",
        "flow_type",
        "flow_id",
        "lease_token",
        "expires_at",
        "created_at",
        "updated_at"
      )
      VALUES (
        ${publisherBotId},
        ${actorUserId},
        ${params.flowType}::"PublisherPrivateFlowType",
        ${flowId},
        ${leaseToken},
        ${params.expiresAt},
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      )
      ON CONFLICT ("publisher_bot_id", "actor_user_id") DO UPDATE
      SET
        "flow_type" = EXCLUDED."flow_type",
        "flow_id" = EXCLUDED."flow_id",
        "lease_token" = EXCLUDED."lease_token",
        "expires_at" = CASE
          WHEN
            "publisher_private_flow_leases"."flow_type" = EXCLUDED."flow_type"
            AND "publisher_private_flow_leases"."flow_id" = EXCLUDED."flow_id"
          THEN GREATEST(
            "publisher_private_flow_leases"."expires_at",
            EXCLUDED."expires_at"
          )
          ELSE EXCLUDED."expires_at"
        END,
        "updated_at" = CURRENT_TIMESTAMP
      WHERE
        "publisher_private_flow_leases"."expires_at" <= CURRENT_TIMESTAMP
        OR (
          "publisher_private_flow_leases"."flow_type" = EXCLUDED."flow_type"
          AND "publisher_private_flow_leases"."flow_id" = EXCLUDED."flow_id"
        )
      RETURNING
        "publisher_bot_id",
        "actor_user_id",
        "flow_type",
        "flow_id",
        "lease_token",
        "expires_at"
    `);
    const row = rows[0];
    return row
      ? {
          publisherBotId: row.publisher_bot_id,
          actorUserId: row.actor_user_id,
          flowType: row.flow_type,
          flowId: row.flow_id,
          leaseToken: row.lease_token,
          expiresAt: row.expires_at,
        }
      : null;
  }
}
