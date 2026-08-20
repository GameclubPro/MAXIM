import { Injectable } from '@nestjs/common';

import {
  ChatBotAccessState,
  ChatBotMembershipStatus,
  ChatEntityType,
  Prisma,
} from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  isFreshMembershipAccessSnapshot,
  normalizeMembershipAccessSnapshot,
} from './max-bot-access-policy.util';
import {
  buildBotAccessSnapshotPersistence,
  type BotAccessSnapshotInput,
} from './bot-access-snapshot.util';
import { hasConfirmedDeleteMessageAccess } from './max-delete-message-access.util';

const ACCESS_WAKE_BATCH_SIZE = 100;
const DELETE_INTENT_PROBE_SOURCE_PREFIX = 'moderation_delete_intent_probe';

export type PreviousBotDeleteAccess = {
  status: ChatBotMembershipStatus;
  botAccessState: ChatBotAccessState;
  botAccessCheckedAt: Date | null;
  botAccessExpiresAt: Date | null;
  permissionsSnapshot: unknown;
} | null;

export type CommittedBotDeleteAccessProbe = {
  chatId: string;
  botId: string;
  entityType: ChatEntityType;
  source: string;
  checkedAt: Date;
  access: BotAccessSnapshotInput;
  previousAccess: PreviousBotDeleteAccess;
};

@Injectable()
export class ModerationDeleteIntentAccessWakeService {
  constructor(private readonly prisma: PrismaService) {}

  shouldWake(params: CommittedBotDeleteAccessProbe): boolean {
    if (
      !params.access ||
      params.source.startsWith(DELETE_INTENT_PROBE_SOURCE_PREFIX) ||
      params.checkedAt.getTime() > Date.now()
    ) {
      return false;
    }

    const incomingSnapshot = normalizeMembershipAccessSnapshot({
      checkedAt: params.checkedAt.toISOString(),
      isAdmin: params.access.isAdmin,
      isOwner: params.access.isOwner,
      permissions: params.access.permissions ?? [],
    });
    if (!hasConfirmedDeleteMessageAccess(incomingSnapshot, params.entityType)) {
      return false;
    }

    return !this.wasFreshDeleteCapable(params.previousAccess, params.entityType, params.checkedAt);
  }

  async wakeAfterCommittedProbe(params: CommittedBotDeleteAccessProbe): Promise<number> {
    if (!this.shouldWake(params) || !params.access) {
      return 0;
    }

    const committedSnapshot = buildBotAccessSnapshotPersistence(params.access, {
      source: params.source,
      now: params.checkedAt,
    });

    // FLAG: Capability recovery may only advance the retry clock. Dispatch/deadline evidence and
    // attempt ownership remain untouched, and an exact committed access epoch fences later losses.
    return this.prisma.$executeRaw(Prisma.sql`
      WITH candidates AS (
        SELECT intent."id"
        FROM "moderation_delete_intents" intent
        WHERE intent."chat_id" = ${params.chatId}
          AND intent."execute_at" <= CURRENT_TIMESTAMP
          AND intent."retry_until_at" > CURRENT_TIMESTAMP
          AND (
            (
              intent."status" = CAST(
                'WAITING_CAPABILITY' AS "ModerationDeleteIntentStatus"
              )
              AND intent."next_attempt_at" > CURRENT_TIMESTAMP
            )
            OR (
              intent."status" = CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
              AND intent."lease_token" IS NOT NULL
              AND intent."lease_expires_at" > CURRENT_TIMESTAMP
            )
          )
          AND (
            intent."entity_type" IS NULL
            OR intent."entity_type" = CAST(${params.entityType} AS "ChatEntityType")
          )
          AND intent."remote_delete_succeeded_at" IS NULL
          AND intent."remote_delete_succeeded_bot_id" IS NULL
          AND intent."delete_dispatch_started_at" IS NULL
          AND intent."delete_dispatch_started_bot_id" IS NULL
          AND (
            intent."last_attempt_at" IS NULL
            OR intent."last_attempt_at" < ${params.checkedAt}
          )
          AND (
            intent."routing_policy" <> 'origin_only'
            OR intent."origin_bot_id" = ${params.botId}
          )
          AND EXISTS (
            SELECT 1
            FROM "chat_bot_memberships" membership
            JOIN "chats" chat ON chat."id" = membership."chat_id"
            WHERE membership."chat_id" = intent."chat_id"
              AND membership."bot_id" = ${params.botId}
              AND membership."status" = CAST('ACTIVE' AS "ChatBotMembershipStatus")
              AND membership."bot_access_state" IN (
                CAST('CONFIRMED_ADMIN' AS "ChatBotAccessState"),
                CAST('CONFIRMED_OWNER' AS "ChatBotAccessState")
              )
              AND membership."bot_access_checked_at" = ${params.checkedAt}
              AND membership."bot_access_expires_at" > CURRENT_TIMESTAMP
              AND membership."bot_access_source" = ${params.source}
              AND membership."permissions_hash" = ${committedSnapshot.permissionsHash}
              AND chat."entity_type" = CAST(${params.entityType} AS "ChatEntityType")
        )
        ORDER BY intent."created_at" ASC, intent."id" ASC
        LIMIT ${ACCESS_WAKE_BATCH_SIZE}
        -- FLAG: A one-shot permission edge must wait for a concurrent SQL-only intent finish so
        -- PostgreSQL can re-evaluate its status; skipping the lock would lose the recovery wake.
        FOR UPDATE OF intent
      )
      UPDATE "moderation_delete_intents" intent
      SET
        "next_attempt_at" = CASE
          WHEN intent."status" = CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
          THEN GREATEST(intent."next_attempt_at", ${params.checkedAt})
          ELSE CURRENT_TIMESTAMP
        END,
        "updated_at" = CURRENT_TIMESTAMP
      FROM candidates
      WHERE intent."id" = candidates."id"
    `);
  }

  private wasFreshDeleteCapable(
    previous: PreviousBotDeleteAccess,
    entityType: ChatEntityType,
    at: Date,
  ): boolean {
    if (
      !previous ||
      previous.status !== ChatBotMembershipStatus.ACTIVE ||
      (previous.botAccessState !== ChatBotAccessState.CONFIRMED_ADMIN &&
        previous.botAccessState !== ChatBotAccessState.CONFIRMED_OWNER)
    ) {
      return false;
    }

    const snapshot = normalizeMembershipAccessSnapshot(previous.permissionsSnapshot);
    if (!hasConfirmedDeleteMessageAccess(snapshot, entityType)) {
      return false;
    }

    const atMs = at.getTime();
    const checkedAtMs = previous.botAccessCheckedAt?.getTime() ?? Number.NaN;
    const expiresAtMs = previous.botAccessExpiresAt?.getTime() ?? Number.NaN;
    return (
      Number.isFinite(checkedAtMs) &&
      checkedAtMs <= atMs &&
      (Number.isFinite(expiresAtMs)
        ? expiresAtMs > atMs
        : isFreshMembershipAccessSnapshot(snapshot, { nowMs: atMs }))
    );
  }
}
