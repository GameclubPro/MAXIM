import { Inject, Injectable, Optional } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import {
  EventType,
  Operator,
  Prisma,
  type ChatSettings,
  type ModerationEvent,
} from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookLegacyHoldService } from '../webhook/webhook-legacy-hold.service';
import {
  buildMessageScopedModerationActionClaimKey,
  buildModerationMessageViolationProcessingClaimKey,
} from './moderation-message-action-claim';
import { fingerprintModerationSettings } from './moderation-settings-fingerprint';
import { persistAutomaticMuteCleanup } from './automatic-mute-cleanup';
import { ModerationRuleSanctionRejectedError } from './moderation-rule-sanction-authority';
import type {
  RuleFollowupSanctionJournal,
  RuleFollowupSanctionState,
} from './moderation-rule-followup-sanction';
import {
  readFrozenRequiredSubscriptionCandidatePlan,
  readRequiredSubscriptionCandidateSource,
  type FrozenRequiredSubscriptionCandidatePlan,
  type RequiredSubscriptionCandidateDeleteReceipt,
  type RequiredSubscriptionCandidateNoticeReceipt,
  type RequiredSubscriptionCandidateSource,
} from './required-subscription-candidate-workflow';

const PAGE_SIZE = 4;
const LEASE_MS = 30_000;
const RULE_CODE = 'REQUIRED_SUBSCRIPTION';
const TERMINAL = ['DONE', 'NO_ACTION', 'EXPIRED'];
type CandidateStoreDatabase = Pick<PrismaService, '$queryRaw' | '$executeRaw' | '$transaction'>;
export type RequiredSubscriptionCandidateStatus =
  | 'WAITING_CHECK'
  | 'RUNNING'
  | 'UNKNOWN'
  | 'DONE'
  | 'NO_ACTION'
  | 'EXPIRED';
export type RequiredSubscriptionCandidateRow = {
  id: string;
  chatId: string;
  userId: string;
  messageId: string;
  sourceAt: Date;
  deadlineAt: Date;
  policySha256: string;
  source: RequiredSubscriptionCandidateSource;
  status: RequiredSubscriptionCandidateStatus;
  frozenPlan: FrozenRequiredSubscriptionCandidatePlan | null;
  claimId: string | null;
  effects: Record<string, unknown>;
  nextAttemptAt: Date;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
  attemptCount: number;
  lastError: string | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};
type StoredRow = Omit<RequiredSubscriptionCandidateRow, 'source' | 'frozenPlan' | 'effects'> & {
  source: unknown;
  frozenPlan: unknown;
  effects: unknown;
};
export type RequiredSubscriptionCandidateFreezeContext = {
  candidateId: string;
  source: RequiredSubscriptionCandidateSource;
  qualification: FrozenRequiredSubscriptionCandidatePlan['qualification'];
  violationCount24h: number;
  issuedAtMs: number;
  eventId: string;
  settings: ChatSettings;
};
export type RequiredSubscriptionCandidateFreezeResult =
  | { kind: 'owned'; plan: FrozenRequiredSubscriptionCandidatePlan }
  | { kind: 'foreign_claim_blocked' }
  | { kind: 'authority_revoked'; reason: string };

export function buildRequiredSubscriptionCandidateId(
  source: RequiredSubscriptionCandidateSource,
): string {
  return `required-subscription-candidate:v1:${createHash('sha256')
    .update(
      JSON.stringify([
        source.chatId,
        source.userId,
        source.messageId,
        source.sourceAtMs,
        source.policySha256,
      ]),
    )
    .digest('hex')}`;
}

@Injectable()
export class RequiredSubscriptionCandidateStore {
  private dueStatusOffset = 0;
  constructor(
    @Inject(PrismaService) private readonly prisma: CandidateStoreDatabase,
    @Optional() private readonly legacyHolds?: WebhookLegacyHoldService,
  ) {}

  async register(input: RequiredSubscriptionCandidateSource): Promise<{
    id: string;
    created: boolean;
    row: RequiredSubscriptionCandidateRow;
  }> {
    const source = readRequiredSubscriptionCandidateSource(input);
    if (!source) throw new Error('Invalid required-subscription candidate source');
    const id = buildRequiredSubscriptionCandidateId(source);
    // FLAG: Registration is no-effect authority only. Conflict never changes the first
    // source, deadline, status, schedule, plan or effect receipts, including expired rows.
    const inserted = await this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO "required_subscription_candidates"
        ("id", "chat_id", "user_id", "message_id", "source_at", "deadline_at", "policy_sha256", "source", "updated_at")
      VALUES (${id}, ${source.chatId}, ${source.userId}, ${source.messageId}, ${new Date(source.sourceAtMs)},
        ${new Date(source.deadlineAtMs)}, ${source.policySha256}, ${JSON.stringify(source)}::jsonb,
        (clock_timestamp() AT TIME ZONE 'UTC')) ON CONFLICT ("id") DO NOTHING
    `);
    const row = await this.read(id);
    if (!row || !sameJson(row.source, source))
      throw new Error('Required-subscription candidate immutable source conflict');
    return { id, created: inserted > 0, row };
  }

  async read(id: string): Promise<RequiredSubscriptionCandidateRow | null> {
    return this.readWith(this.prisma, id);
  }

  async listDueIds(): Promise<string[]> {
    const clocks = await this.prisma.$queryRaw<Array<{ now: Date }>>(
      Prisma.sql`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`,
    );
    const now = clocks[0]!.now;
    const ids: string[] = [];
    // FLAG: Literal-status index ranges and a shared four-row budget precede all
    // authority/hold/JSON probes. Expired and started rows remain visible for settlement.
    const statuses = ['WAITING_CHECK', 'RUNNING', 'UNKNOWN'] as const;
    const offset = this.dueStatusOffset++ % statuses.length;
    for (let index = 0; index < statuses.length; index += 1) {
      if (ids.length === PAGE_SIZE) break;
      const status = statuses[(offset + index) % statuses.length]!;
      const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(
        status === 'RUNNING'
          ? Prisma.sql`SELECT "id" FROM "required_subscription_candidates"
              WHERE "status" = 'RUNNING' AND "lease_expires_at" <= ${now}
              ORDER BY "lease_expires_at", "id" LIMIT ${PAGE_SIZE - ids.length}`
          : Prisma.sql`SELECT "id" FROM "required_subscription_candidates"
              WHERE "status" = ${status} AND "next_attempt_at" <= ${now}
              ORDER BY "next_attempt_at", "id" LIMIT ${PAGE_SIZE - ids.length}`,
      );
      ids.push(...rows.map((row) => row.id));
    }
    return ids;
  }

  async claim(id: string): Promise<RequiredSubscriptionCandidateRow | null> {
    const token = randomUUID();
    const count = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "required_subscription_candidates" SET "status" = 'RUNNING', "lease_token" = ${token},
        "lease_expires_at" = (clock_timestamp() AT TIME ZONE 'UTC') + ${LEASE_MS} * INTERVAL '1 millisecond',
        "attempt_count" = "attempt_count" + 1, "updated_at" = (clock_timestamp() AT TIME ZONE 'UTC')
      WHERE "id" = ${id} AND (("status" IN ('WAITING_CHECK', 'UNKNOWN')
        AND "next_attempt_at" <= (clock_timestamp() AT TIME ZONE 'UTC'))
        OR ("status" = 'RUNNING' AND "lease_expires_at" <= (clock_timestamp() AT TIME ZONE 'UTC')))
    `);
    if (!count) return null;
    const row = await this.read(id);
    if (!row || row.leaseToken !== token)
      throw new Error('Required-subscription candidate claim lost');
    return row;
  }

  async renewLease(id: string, token: string): Promise<void> {
    const count = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "required_subscription_candidates" SET
        "lease_expires_at" = (clock_timestamp() AT TIME ZONE 'UTC') + ${LEASE_MS} * INTERVAL '1 millisecond'
      WHERE "id" = ${id} AND "status" = 'RUNNING' AND "lease_token" = ${token}
        AND "lease_expires_at" > (clock_timestamp() AT TIME ZONE 'UTC')
    `);
    if (!count) throw new Error('Required-subscription candidate lease lost');
  }

  async assertLease(id: string, token: string): Promise<void> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "required_subscription_candidates" WHERE "id" = ${id}
        AND "status" = 'RUNNING' AND "lease_token" = ${token}
        AND "lease_expires_at" > (clock_timestamp() AT TIME ZONE 'UTC')
    `);
    if (!rows.length) throw new Error('Required-subscription candidate lease lost');
  }

  async freezeOwnClaimAndDecision(input: {
    id: string;
    leaseToken: string;
    qualification: FrozenRequiredSubscriptionCandidatePlan['qualification'];
    buildPlan: (
      context: RequiredSubscriptionCandidateFreezeContext,
    ) => FrozenRequiredSubscriptionCandidatePlan;
  }): Promise<RequiredSubscriptionCandidateFreezeResult> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "required_subscription_candidates" WHERE "id" = ${input.id} FOR UPDATE`,
      );
      const row = await this.readWith(tx, input.id);
      if (!row) throw new Error('Required-subscription candidate missing');
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([row.chatId, row.userId])}, 8317))`,
      );
      const now = await databaseNow(tx);
      assertOwnedLease(row, input.leaseToken, now);
      if (row.frozenPlan) return { kind: 'owned', plan: row.frozenPlan };
      if (now >= row.deadlineAt) return { kind: 'authority_revoked', reason: 'deadline' };
      if (await this.isHeld(row, tx)) return { kind: 'authority_revoked', reason: 'held_source' };
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "chats" WHERE "id" = ${row.chatId} FOR SHARE`);
      await tx.$queryRaw(
        Prisma.sql`SELECT "chat_id" FROM "chat_settings" WHERE "chat_id" = ${row.chatId} FOR SHARE`,
      );
      const settings = await tx.chatSettings.findUnique({
        where: { chatId: row.chatId },
        include: {
          chat: {
            select: {
              entityType: true,
              admins: { where: { userId: row.userId }, select: { userId: true } },
            },
          },
        },
      });
      if (
        !settings ||
        settings.chat.entityType !== 'CHAT' ||
        settings.chat.admins.length ||
        !settings.requiredSubscriptionEnabled ||
        !Array.isArray(settings.requiredSubscriptionChannelIds) ||
        fingerprintModerationSettings(settings, RULE_CODE) !== row.policySha256
      )
        return { kind: 'authority_revoked', reason: 'policy_or_author' };
      const required = [...new Set(input.qualification.requiredChannelIds)];
      const missing = [...new Set(input.qualification.missingChannelIds)];
      if (
        !required.length ||
        !missing.length ||
        required.length !== input.qualification.requiredChannelIds.length ||
        missing.length !== input.qualification.missingChannelIds.length ||
        missing.some((id) => !required.includes(id)) ||
        !sameJson(
          [...required].sort(),
          [...new Set(settings.requiredSubscriptionChannelIds)].sort(),
        )
      )
        return { kind: 'authority_revoked', reason: 'qualification' };
      const issuedAt = await databaseNow(tx);
      if (issuedAt >= row.deadlineAt || !row.leaseExpiresAt || issuedAt >= row.leaseExpiresAt)
        throw new Error('Required-subscription candidate decision authority expired');
      const claim = buildModerationMessageViolationProcessingClaimKey({
        chatId: row.chatId,
        userId: row.userId,
        messageId: row.messageId,
        ruleCode: RULE_CODE,
        updateType: 'message_action',
      });
      const claimId = `${row.id}:claim`;
      // FLAG: The standard global message-action uniqueness is shared with every rule.
      // An existing or legacy owner is never adopted, even if its rule matches.
      const inserted = await tx.moderationViolationMessageClaim.createMany({
        data: [
          {
            id: claimId,
            dedupeKey: claim.dedupeKey,
            messageActionKey: buildMessageScopedModerationActionClaimKey(row.chatId, row.messageId),
            chatId: row.chatId,
            userId: row.userId,
            messageId: row.messageId,
            ruleCode: RULE_CODE,
            updateType: 'message_action',
            createdAt: issuedAt,
          },
        ],
        skipDuplicates: true,
      });
      if (!inserted.count) return { kind: 'foreign_claim_blocked' };
      await tx.violation.create({
        data: {
          id: `${row.id}:violation`,
          chatId: row.chatId,
          userId: row.userId,
          ruleCode: RULE_CODE,
          score: 1,
          createdAt: issuedAt,
        },
      });
      const manual = await tx.moderationEvent.findFirst({
        where: {
          chatId: row.chatId,
          userId: row.userId,
          createdAt: { lte: issuedAt },
          ruleCode: { in: ['MANUAL_UNMUTE', 'MANUAL_UNBAN'] },
        },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      const violationCount24h = await tx.violation.count({
        where: {
          chatId: row.chatId,
          userId: row.userId,
          ruleCode: RULE_CODE,
          createdAt: {
            gte: new Date(
              Math.max(issuedAt.getTime() - 86_400_000, manual?.createdAt.getTime() ?? 0),
            ),
            lte: issuedAt,
          },
        },
      });
      const proposed = input.buildPlan({
        candidateId: row.id,
        source: row.source,
        qualification: input.qualification,
        violationCount24h,
        issuedAtMs: issuedAt.getTime(),
        eventId: `${row.id}:decision`,
        settings,
      });
      const plan = readFrozenRequiredSubscriptionCandidatePlan(proposed, row.source, row.id);
      if (
        !plan ||
        plan.violationCount24h !== violationCount24h ||
        plan.sanction.issuedAtMs !== issuedAt.getTime() ||
        plan.sanction.eventId !== `${row.id}:decision` ||
        !sameJson(plan.qualification, input.qualification)
      )
        throw new Error('Invalid required-subscription frozen decision');
      // FLAG: No MAX/Redis/copy rendering is awaited in this transaction. Claim, strike,
      // exact count/action/expiry and this candidate's ownership receipt commit together.
      const saved = await tx.$executeRaw(Prisma.sql`
        UPDATE "required_subscription_candidates" SET "frozen_plan" = ${JSON.stringify(plan)}::jsonb,
          "claim_id" = ${claimId}, "updated_at" = (clock_timestamp() AT TIME ZONE 'UTC')
        WHERE "id" = ${row.id} AND "status" = 'RUNNING' AND "lease_token" = ${input.leaseToken}
          AND "lease_expires_at" > (clock_timestamp() AT TIME ZONE 'UTC')
          AND "deadline_at" > (clock_timestamp() AT TIME ZONE 'UTC') AND "frozen_plan" IS NULL AND "claim_id" IS NULL
      `);
      if (!saved) throw new Error('Required-subscription candidate freeze lease lost');
      return { kind: 'owned', plan };
    });
  }

  async readEffects(id: string, token: string): Promise<Record<string, unknown>> {
    const rows = await this.prisma.$queryRaw<Array<{ effects: unknown }>>(Prisma.sql`
      SELECT "effects" FROM "required_subscription_candidates" WHERE "id" = ${id}
        AND "status" = 'RUNNING' AND "lease_token" = ${token}
        AND "lease_expires_at" > (clock_timestamp() AT TIME ZONE 'UTC')
    `);
    if (!rows[0]) throw new Error('Required-subscription candidate lease lost');
    return record(rows[0].effects);
  }

  async persistDeterministicEvent(input: {
    id: string;
    leaseToken: string;
    metadata?: Prisma.InputJsonObject;
  }): Promise<ModerationEvent> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "required_subscription_candidates" WHERE "id" = ${input.id} FOR UPDATE`,
      );
      const row = await this.readWith(tx, input.id);
      if (!row?.frozenPlan)
        throw new Error('Required-subscription candidate has no owned decision');
      assertOwnedLease(row, input.leaseToken, await databaseNow(tx));
      const plan = row.frozenPlan;
      const sanction = plan.sanction;
      const existing = await tx.moderationEvent.findUnique({ where: { id: sanction.eventId } });
      if (
        existing &&
        (existing.chatId !== row.chatId ||
          existing.userId !== row.userId ||
          existing.messageId !== row.messageId ||
          existing.ruleCode !== RULE_CODE ||
          existing.action !== sanction.action ||
          existing.eventType !== EventType.MESSAGE ||
          existing.operator !== Operator.BOT ||
          existing.createdAt.getTime() !== sanction.issuedAtMs ||
          existing.maskedExcerpt !== row.source.maskedExcerpt ||
          record(existing.metadata).requiredSubscriptionCandidateId !== row.id ||
          record(existing.metadata).requiredSubscriptionViolationCount24h !==
            plan.violationCount24h ||
          (sanction.action === 'MUTE' &&
            (record(existing.metadata).muteDurationHours !== sanction.muteDurationHours ||
              record(existing.metadata).muteExpiresAt !==
                new Date(sanction.muteExpiresAtMs!).toISOString())))
      )
        throw new Error('Required-subscription candidate event identity changed');
      if (!existing) {
        const confirmedBan = sanction.action === 'BAN' && row.effects.phase === 'BAN_CONFIRMED';
        // FLAG: Exact confirmed BAN may settle its SQL receipt after expiry. A new
        // warning/mute keeps current policy, source holds, release and original deadline.
        if (!confirmedBan) {
          if (sanction.action === 'BAN' || (await this.isHeld(row, tx)))
            throw new ModerationRuleSanctionRejectedError();
          await tx.$queryRaw(
            Prisma.sql`SELECT "id" FROM "chats" WHERE "id" = ${row.chatId} FOR SHARE`,
          );
          await tx.$queryRaw(
            Prisma.sql`SELECT "chat_id" FROM "chat_settings" WHERE "chat_id" = ${row.chatId} FOR SHARE`,
          );
          const settings = await tx.chatSettings.findUnique({
            where: { chatId: row.chatId },
            include: {
              chat: {
                select: {
                  entityType: true,
                  admins: { where: { userId: row.userId }, select: { userId: true } },
                },
              },
            },
          });
          const released = await tx.moderationEvent.findFirst({
            where: {
              chatId: row.chatId,
              userId: row.userId,
              ruleCode: { in: ['MANUAL_UNMUTE', 'MANUAL_UNBAN'] },
              createdAt: { gte: new Date(sanction.issuedAtMs) },
            },
            select: { id: true },
          });
          const finalNow = await databaseNow(tx);
          if (
            !settings ||
            settings.chat.entityType !== 'CHAT' ||
            settings.chat.admins.length ||
            !settings.requiredSubscriptionEnabled ||
            fingerprintModerationSettings(settings, RULE_CODE) !== row.policySha256 ||
            released ||
            finalNow >= row.deadlineAt ||
            !row.leaseExpiresAt ||
            finalNow >= row.leaseExpiresAt
          )
            throw new ModerationRuleSanctionRejectedError();
        }
      }
      const event =
        existing ??
        (await tx.moderationEvent.create({
          data: {
            id: sanction.eventId,
            chatId: row.chatId,
            userId: row.userId,
            messageId: row.messageId,
            botId:
              typeof row.effects.banBotId === 'string'
                ? row.effects.banBotId
                : row.source.originBotId,
            eventType: EventType.MESSAGE,
            ruleCode: RULE_CODE,
            action: sanction.action,
            maskedExcerpt: row.source.maskedExcerpt,
            score: 1,
            operator: Operator.BOT,
            createdAt: new Date(sanction.issuedAtMs),
            metadata: {
              ...input.metadata,
              requiredSubscriptionCandidateId: row.id,
              action: sanction.action,
              requiredSubscriptionViolationCount24h: plan.violationCount24h,
              requiredSubscriptionEscalationWindowHours: 24,
              requiredChannelIds: [...plan.qualification.requiredChannelIds],
              missingChannelIds: [...plan.qualification.missingChannelIds],
              sanctionApplied: ['MUTE', 'BAN'].includes(sanction.action),
              ...(sanction.action === 'MUTE'
                ? {
                    muteDurationHours: sanction.muteDurationHours,
                    muteExpiresAt: new Date(sanction.muteExpiresAtMs!).toISOString(),
                  }
                : {}),
            },
          },
        }));
      if (!existing) await persistAutomaticMuteCleanup(tx, event);
      const saved = await tx.$executeRaw(Prisma.sql`
        UPDATE "required_subscription_candidates" SET "effects" = "effects" ||
          ${JSON.stringify({ phase: 'SQL_COMMITTED', eventId: sanction.eventId })}::jsonb,
          "updated_at" = (clock_timestamp() AT TIME ZONE 'UTC')
        WHERE "id" = ${row.id} AND "status" = 'RUNNING' AND "lease_token" = ${input.leaseToken}
          AND "lease_expires_at" > (clock_timestamp() AT TIME ZONE 'UTC')
      `);
      if (!saved) throw new Error('Required-subscription candidate event checkpoint lease lost');
      return event;
    });
  }

  async recordReceipt(
    id: string,
    token: string,
    key: 'notice',
    receipt: RequiredSubscriptionCandidateNoticeReceipt,
  ): Promise<void>;
  async recordReceipt(
    id: string,
    token: string,
    key: 'delete',
    receipt: RequiredSubscriptionCandidateDeleteReceipt,
  ): Promise<void>;
  async recordReceipt(
    id: string,
    token: string,
    key: 'notice' | 'delete',
    receipt:
      | RequiredSubscriptionCandidateNoticeReceipt
      | RequiredSubscriptionCandidateDeleteReceipt,
  ): Promise<void> {
    const row = await this.read(id);
    if (
      !row ||
      receipt.candidateId !== id ||
      receipt.chatId !== row.chatId ||
      receipt.userId !== row.userId ||
      receipt.messageId !== row.messageId ||
      receipt.sourceAtMs !== row.source.sourceAtMs ||
      receipt.deadlineAtMs !== row.source.deadlineAtMs ||
      receipt.policySha256 !== row.policySha256
    )
      throw new Error('Required-subscription candidate receipt binding mismatch');
    if (key === 'notice') {
      const notice = receipt as RequiredSubscriptionCandidateNoticeReceipt;
      if (
        !['notice_handoff', 'media_coverage'].includes(notice.kind) ||
        !notice.receiptId?.trim() ||
        notice.receiptId.length > 1024 ||
        !notice.noticeKey?.trim() ||
        notice.noticeKey.length > 2048 ||
        (notice.kind === 'notice_handoff' &&
          notice.noticeKey !== `required-subscription:notice:v1:${row.chatId}:${row.messageId}`) ||
        (!row.frozenPlan && notice.kind !== 'media_coverage')
      )
        throw new Error('Invalid required-subscription notice receipt');
    } else {
      const deletion = receipt as RequiredSubscriptionCandidateDeleteReceipt;
      if (
        deletion.reasonKey !== 'REQUIRED_SUBSCRIPTION:message-delete' ||
        deletion.rollout !== 'execute' ||
        !deletion.intentId?.trim() ||
        deletion.intentId.length > 1024 ||
        ![
          'PENDING',
          'IN_PROGRESS',
          'RETRYABLE',
          'WAITING_CAPABILITY',
          'SUCCEEDED',
          'ALREADY_ABSENT',
        ].includes(deletion.status)
      )
        throw new Error('Invalid required-subscription DELETE receipt');
    }
    const serialized = JSON.stringify(receipt);
    if (
      !serialized ||
      Buffer.byteLength(serialized) > 8192 ||
      !receipt ||
      typeof receipt !== 'object' ||
      Array.isArray(receipt)
    )
      throw new Error('Invalid required-subscription candidate receipt');
    // FLAG: DELETE status is a downstream snapshot, not transfer identity. Preserve
    // the first receipt; only an otherwise exact, allowed snapshot can acknowledge it.
    const sameReceipt =
      key === 'delete'
        ? Prisma.sql`(("effects"->'delete') - 'status') = (${serialized}::jsonb - 'status')
            AND "effects"->'delete'->>'status' IN
              ('PENDING', 'IN_PROGRESS', 'RETRYABLE', 'WAITING_CAPABILITY', 'SUCCEEDED', 'ALREADY_ABSENT')`
        : Prisma.sql`"effects"->${key}::text = ${serialized}::jsonb`;
    const count = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "required_subscription_candidates" SET "effects" = "effects" ||
          jsonb_build_object(${key}::text, COALESCE("effects"->${key}::text, ${serialized}::jsonb)),
        "updated_at" = (clock_timestamp() AT TIME ZONE 'UTC')
      WHERE "id" = ${id} AND "status" = 'RUNNING' AND "lease_token" = ${token}
        AND "lease_expires_at" > (clock_timestamp() AT TIME ZONE 'UTC')
        AND ("effects"->${key}::text IS NULL OR (${sameReceipt}))
    `);
    if (!count) throw new Error('Required-subscription candidate receipt conflict or lease lost');
  }

  journal(id: string, token: string, receiptOnly = false): RuleFollowupSanctionJournal {
    const patch = async (values: Record<string, unknown>, expected?: string): Promise<boolean> => {
      const count = await this.prisma.$executeRaw(Prisma.sql`
        UPDATE "required_subscription_candidates" SET "effects" = "effects" || ${JSON.stringify(values)}::jsonb,
          "updated_at" = (clock_timestamp() AT TIME ZONE 'UTC')
        WHERE "id" = ${id} AND "status" = 'RUNNING' AND "lease_token" = ${token}
          AND "lease_expires_at" > (clock_timestamp() AT TIME ZONE 'UTC')
          ${expected ? Prisma.sql`AND COALESCE("effects"->>'phase', 'UNSTARTED') = ${expected}` : Prisma.empty}
      `);
      if (!count) await this.assertLease(id, token);
      return count > 0;
    };
    return {
      id,
      receiptOnly,
      assertLease: () => this.assertLease(id, token),
      readState: async () => {
        const effects = await this.readEffects(id, token);
        return {
          ...effects,
          phase: (effects.phase as RuleFollowupSanctionState['phase']) ?? 'UNSTARTED',
        };
      },
      beginBan: async (actionKey) => {
        if (actionKey !== `${id}:sanction-ban`)
          throw new Error('Required-subscription BAN action binding mismatch');
        if (receiptOnly) return false;
        const count = await this.prisma.$executeRaw(Prisma.sql`
          UPDATE "required_subscription_candidates" SET "effects" = "effects" ||
            ${JSON.stringify({ phase: 'BAN_STARTED', actionKey })}::jsonb,
            "updated_at" = (clock_timestamp() AT TIME ZONE 'UTC')
          WHERE "id" = ${id} AND "status" = 'RUNNING' AND "lease_token" = ${token}
            AND "lease_expires_at" > (clock_timestamp() AT TIME ZONE 'UTC')
            AND "deadline_at" > (clock_timestamp() AT TIME ZONE 'UTC')
            AND "frozen_plan"->'sanction'->>'action' = 'BAN' AND "claim_id" = ${`${id}:claim`}
            AND COALESCE("effects"->>'phase', 'UNSTARTED') = 'UNSTARTED'
        `);
        if (!count) await this.assertLease(id, token);
        return count > 0;
      },
      confirmBan: async (banBotId) => {
        await patch({ phase: 'BAN_CONFIRMED', banBotId });
      },
      resetAfterProvenNoEffect: async () => {
        await patch({ phase: 'UNSTARTED' });
      },
      markUnknown: async () => {
        await patch({ phase: 'UNKNOWN' });
      },
      commitSqlEvent: async (eventId) => {
        await patch({ phase: 'SQL_COMMITTED', eventId });
      },
      claimReputation: async () => {
        const count = await this.prisma.$executeRaw(Prisma.sql`
          UPDATE "required_subscription_candidates" SET "effects" = "effects" || '{"reputation":"STARTED"}'::jsonb,
            "updated_at" = (clock_timestamp() AT TIME ZONE 'UTC')
          WHERE "id" = ${id} AND "status" = 'RUNNING' AND "lease_token" = ${token}
            AND "lease_expires_at" > (clock_timestamp() AT TIME ZONE 'UTC') AND "effects"->>'reputation' IS NULL
        `);
        if (count) return 'run';
        const effects = await this.readEffects(id, token);
        return effects.reputation === 'DONE' ? 'done' : 'unknown';
      },
      completeReputation: async () => {
        await patch({ reputation: 'DONE' });
      },
      settle: async () => {
        await patch({ phase: 'SETTLED' });
      },
    };
  }

  async finish(
    id: string,
    token: string,
    status: Exclude<RequiredSubscriptionCandidateStatus, 'RUNNING'>,
    errorCode: string | null = null,
    delayMs = 1000,
  ): Promise<void> {
    if (
      !Number.isSafeInteger(delayMs) ||
      delayMs < 0 ||
      delayMs > 3_600_000 ||
      (errorCode && !/^[A-Z0-9_]{1,100}$/.test(errorCode))
    )
      throw new Error('Invalid required-subscription candidate completion');
    const count = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "required_subscription_candidates" SET "status" = ${status}, "lease_token" = NULL, "lease_expires_at" = NULL,
        "next_attempt_at" = (clock_timestamp() AT TIME ZONE 'UTC') + ${delayMs} * INTERVAL '1 millisecond',
        "last_error" = ${errorCode}, "completed_at" = ${TERMINAL.includes(status) ? Prisma.sql`(clock_timestamp() AT TIME ZONE 'UTC')` : Prisma.sql`NULL`},
        "updated_at" = (clock_timestamp() AT TIME ZONE 'UTC')
      WHERE "id" = ${id} AND "status" = 'RUNNING' AND "lease_token" = ${token}
        AND "lease_expires_at" > (clock_timestamp() AT TIME ZONE 'UTC')
    `);
    if (!count) throw new Error('Required-subscription candidate completion lease lost');
  }

  private async readWith(
    prisma: Pick<Prisma.TransactionClient, '$queryRaw'>,
    id: string,
  ): Promise<RequiredSubscriptionCandidateRow | null> {
    const rows = await prisma.$queryRaw<StoredRow[]>(Prisma.sql`
      SELECT "id", "chat_id" AS "chatId", "user_id" AS "userId", "message_id" AS "messageId",
        "source_at" AS "sourceAt", "deadline_at" AS "deadlineAt", "policy_sha256" AS "policySha256", "source", "status",
        "frozen_plan" AS "frozenPlan", "claim_id" AS "claimId", "effects", "next_attempt_at" AS "nextAttemptAt",
        "lease_token" AS "leaseToken", "lease_expires_at" AS "leaseExpiresAt", "attempt_count" AS "attemptCount",
        "last_error" AS "lastError", "completed_at" AS "completedAt", "created_at" AS "createdAt", "updated_at" AS "updatedAt"
      FROM "required_subscription_candidates" WHERE "id" = ${id}
    `);
    const row = rows[0];
    if (!row) return null;
    const source = readRequiredSubscriptionCandidateSource(row.source);
    const plan =
      row.frozenPlan === null || !source
        ? null
        : readFrozenRequiredSubscriptionCandidatePlan(row.frozenPlan, source, row.id);
    if (
      !source ||
      row.id !== buildRequiredSubscriptionCandidateId(source) ||
      row.chatId !== source.chatId ||
      row.userId !== source.userId ||
      row.messageId !== source.messageId ||
      row.sourceAt.getTime() !== source.sourceAtMs ||
      row.deadlineAt.getTime() !== source.deadlineAtMs ||
      row.policySha256 !== source.policySha256 ||
      (row.frozenPlan !== null && !plan) ||
      (plan ? row.claimId !== `${row.id}:claim` : row.claimId !== null)
    )
      throw new Error('Invalid stored required-subscription candidate authority');
    return { ...row, source, frozenPlan: plan, effects: record(row.effects) };
  }

  private async isHeld(
    row: RequiredSubscriptionCandidateRow,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    return Boolean(
      (await this.legacyHolds?.isMessageHeld(row.chatId, row.messageId, tx)) ||
      (await this.legacyHolds?.isMemberHeld(row.chatId, row.userId, tx)) ||
      (await this.legacyHolds?.isGlobalUserHeld(row.userId, tx)),
    );
  }
}

async function databaseNow(tx: Pick<Prisma.TransactionClient, '$queryRaw'>): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>(
    Prisma.sql`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`,
  );
  return rows[0]!.now;
}
function assertOwnedLease(row: RequiredSubscriptionCandidateRow, token: string, now: Date): void {
  if (
    row.status !== 'RUNNING' ||
    row.leaseToken !== token ||
    !row.leaseExpiresAt ||
    row.leaseExpiresAt <= now
  )
    throw new Error('Required-subscription candidate lease lost');
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid candidate effect journal');
  return value as Record<string, unknown>;
}
function sameJson(a: unknown, b: unknown): boolean {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, value]) => [key, canonical(value)]),
          )
        : value;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
