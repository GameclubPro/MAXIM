import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';

import { Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  formatDateKeyInTimeZone,
  normalizeNightModeTimezone,
} from './night-mode-transition-time.util';

export const PARTICIPANT_MODERATION_IMMUNITY_RULE_CODE = 'COMMERCIAL_OCR_PARTICIPANT_IMMUNITY';
export const PARTICIPANT_MODERATION_IMMUNITY_UPDATE_TYPE = 'commercial_ocr_immunity';

export type ParticipantModerationImmunityResult = 'granted' | 'not_granted';

export async function consumeLegacyParticipantModerationImmunity(
  prisma: Pick<PrismaService, '$queryRaw'>,
  params: {
    chatId: string;
    userId: string;
    nightModeTimezone: string | null;
  },
): Promise<boolean> {
  if (typeof prisma.$queryRaw !== 'function') {
    return false;
  }

  const now = new Date();
  const timezone = normalizeNightModeTimezone(params.nightModeTimezone ?? '');
  const dateKey = formatDateKeyInTimeZone(now, timezone);
  const rows = await prisma.$queryRaw<Array<{ expires_at: Date | string | null }>>(Prisma.sql`
    WITH active_immunity AS (
      SELECT
        "id",
        "expires_at",
        "daily_violation_limit",
        "daily_violation_usage",
        "usage_date_key"
      FROM "chat_participant_moderation_immunities"
      WHERE "chat_id" = ${params.chatId}
        AND "user_id" = ${params.userId}
        AND ("expires_at" IS NULL OR "expires_at" > ${now})
    ),
    limited_update AS (
      UPDATE "chat_participant_moderation_immunities" immunity
      SET
        "usage_date_key" = ${dateKey},
        "daily_violation_usage" = CASE
          WHEN immunity."usage_date_key" = ${dateKey} THEN immunity."daily_violation_usage" + 1
          ELSE 1
        END,
        "updated_at" = CURRENT_TIMESTAMP
      FROM active_immunity active
      WHERE immunity."id" = active."id"
        AND active."daily_violation_limit" IS NOT NULL
        AND CASE
          WHEN active."usage_date_key" = ${dateKey} THEN active."daily_violation_usage" < active."daily_violation_limit"
          ELSE TRUE
        END
      RETURNING immunity."expires_at"
    )
    SELECT "expires_at" FROM limited_update
    UNION ALL
    SELECT "expires_at"
    FROM active_immunity
    WHERE "expires_at" IS NULL
      AND "daily_violation_limit" IS NULL
  `);

  return rows.length > 0;
}

type ParticipantModerationImmunityClaim = {
  dedupeKey: string;
  messageActionKey: null;
  chatId: string;
  userId: string;
  messageId: string;
  ruleCode: typeof PARTICIPANT_MODERATION_IMMUNITY_RULE_CODE;
  updateType: typeof PARTICIPANT_MODERATION_IMMUNITY_UPDATE_TYPE;
};

const CLAIM_SELECT = {
  dedupeKey: true,
  messageActionKey: true,
  chatId: true,
  userId: true,
  messageId: true,
  ruleCode: true,
  updateType: true,
} as const;

@Injectable()
export class ParticipantModerationImmunityService {
  constructor(private readonly prisma: PrismaService) {}

  async consumeForMessage(params: {
    chatId: string;
    userId: string;
    messageId: string;
    scope: string;
    nightModeTimezone: string | null;
  }): Promise<ParticipantModerationImmunityResult> {
    const expected = buildClaim(params);
    const now = new Date();
    const timezone = normalizeNightModeTimezone(params.nightModeTimezone ?? '');
    const dateKey = formatDateKeyInTimeZone(now, timezone);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await tx.moderationViolationMessageClaim.findUnique({
          where: { dedupeKey: expected.dedupeKey },
          select: CLAIM_SELECT,
        });
        if (existing) {
          assertOwnedClaim(existing, expected);
          return 'granted';
        }

        const rows = await tx.$queryRaw<Array<{ granted: number }>>(Prisma.sql`
          WITH limited_update AS (
            UPDATE "chat_participant_moderation_immunities" immunity
            SET
              "usage_date_key" = ${dateKey},
              "daily_violation_usage" = CASE
                WHEN immunity."usage_date_key" = ${dateKey}
                  THEN immunity."daily_violation_usage" + 1
                ELSE 1
              END,
              "updated_at" = CURRENT_TIMESTAMP
            WHERE immunity."chat_id" = ${params.chatId}
              AND immunity."user_id" = ${params.userId}
              AND (immunity."expires_at" IS NULL OR immunity."expires_at" > ${now})
              AND immunity."daily_violation_limit" IS NOT NULL
              AND CASE
                WHEN immunity."usage_date_key" = ${dateKey}
                  THEN immunity."daily_violation_usage" < immunity."daily_violation_limit"
                ELSE TRUE
              END
            RETURNING 1 AS "granted"
          )
          SELECT "granted" FROM limited_update
          UNION ALL
          SELECT 1 AS "granted"
          FROM "chat_participant_moderation_immunities" immunity
          WHERE "expires_at" IS NULL
            AND "daily_violation_limit" IS NULL
            AND immunity."chat_id" = ${params.chatId}
            AND immunity."user_id" = ${params.userId}
          LIMIT 1
        `);
        if (rows.length === 0) {
          const concurrent = await tx.moderationViolationMessageClaim.findUnique({
            where: { dedupeKey: expected.dedupeKey },
            select: CLAIM_SELECT,
          });
          if (concurrent) {
            assertOwnedClaim(concurrent, expected);
            return 'granted';
          }
          return 'not_granted';
        }

        await tx.moderationViolationMessageClaim.create({ data: expected });
        return 'granted';
      });
    } catch (error: unknown) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }

      // The conflicting transaction rolls back its immunity update before this reconciliation.
      const existing = await this.prisma.moderationViolationMessageClaim.findUnique({
        where: { dedupeKey: expected.dedupeKey },
        select: CLAIM_SELECT,
      });
      if (!existing) {
        throw error;
      }
      assertOwnedClaim(existing, expected);
      return 'granted';
    }
  }
}

export function buildParticipantModerationImmunityClaimKey(params: {
  chatId: string;
  userId: string;
  messageId: string;
  scope: string;
}): string {
  const semanticHash = createHash('sha256')
    .update(JSON.stringify([params.chatId, params.userId, params.messageId, params.scope]))
    .digest('hex');
  return `participant-moderation-immunity:v1:${semanticHash}`;
}

function buildClaim(params: {
  chatId: string;
  userId: string;
  messageId: string;
  scope: string;
}): ParticipantModerationImmunityClaim {
  return {
    dedupeKey: buildParticipantModerationImmunityClaimKey(params),
    messageActionKey: null,
    chatId: params.chatId,
    userId: params.userId,
    messageId: params.messageId,
    ruleCode: PARTICIPANT_MODERATION_IMMUNITY_RULE_CODE,
    updateType: PARTICIPANT_MODERATION_IMMUNITY_UPDATE_TYPE,
  };
}

function assertOwnedClaim(
  existing: {
    dedupeKey: string;
    messageActionKey: string | null;
    chatId: string;
    userId: string;
    messageId: string;
    ruleCode: string;
    updateType: string;
  },
  expected: ParticipantModerationImmunityClaim,
): void {
  if (
    existing.dedupeKey !== expected.dedupeKey ||
    existing.messageActionKey !== null ||
    existing.chatId !== expected.chatId ||
    existing.userId !== expected.userId ||
    existing.messageId !== expected.messageId ||
    existing.ruleCode !== expected.ruleCode ||
    existing.updateType !== expected.updateType
  ) {
    throw new Error('Participant moderation immunity claim ownership mismatch');
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}
