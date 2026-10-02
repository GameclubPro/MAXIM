import { Injectable, Logger } from '@nestjs/common';
import { ChatBotAccessState, ChatBotMembershipStatus, Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { PublisherAccessRefreshPolicy } from './publisher-access-refresh-policy';

export const PUBLISHER_ACCESS_REFRESH_AHEAD_MS = 5 * 60_000;
const RETENTION_MS = 7 * 24 * 60 * 60_000;
const OBSERVATION_BATCH_SIZE = 225;

export type PublisherRefreshProof = {
  publisherBotId: string;
  status: ChatBotMembershipStatus;
  botAccessState: ChatBotAccessState;
  botAccessCheckedAt: Date | null;
  botAccessExpiresAt: Date | null;
};

@Injectable()
export class PublisherAccessRefreshEvidenceService {
  private readonly logger = new Logger(PublisherAccessRefreshEvidenceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: PublisherAccessRefreshPolicy,
  ) {}

  async observeDue(
    botId: string,
    rows: Array<{
      chatId: string;
      botAccessCheckedAt?: Date | null;
      botAccessExpiresAt?: Date | null;
    }>,
    now: Date,
  ): Promise<void> {
    if (!this.policy.deadlinePrioritiesEnabled) return;
    try {
      const data = rows.slice(0, OBSERVATION_BATCH_SIZE).flatMap((row) => {
        const key = this.key(botId, row.chatId, row.botAccessCheckedAt, row.botAccessExpiresAt);
        return key &&
          key.requiredBefore.getTime() <= now.getTime() + PUBLISHER_ACCESS_REFRESH_AHEAD_MS
          ? [{ ...key, observedAt: now, cohort: this.cohort(botId, row.chatId) }]
          : [];
      });
      if (data.length) {
        await this.prisma.publisherAccessRefreshObligation.createMany({
          data,
          skipDuplicates: true,
        });
      }
      if (rows.length > OBSERVATION_BATCH_SIZE) this.unavailable('observation_truncated');
      const missing = rows.filter(
        (row) => !this.key(botId, row.chatId, row.botAccessCheckedAt, row.botAccessExpiresAt),
      ).length;
      if (missing) this.unavailable('missing_proof_identity', missing);
    } catch {
      this.unavailable('observation_write_failed');
    }
  }

  async recordCommittedProof(params: {
    chatId: string;
    previous: PublisherRefreshProof;
    probeStartedAt: Date;
    committedAt: Date;
    outcome: 'confirmed' | 'denied';
  }): Promise<void> {
    if (!this.policy.deadlinePrioritiesEnabled) return;
    const previous = params.previous;
    if (
      previous.status !== ChatBotMembershipStatus.ACTIVE ||
      (previous.botAccessState !== ChatBotAccessState.CONFIRMED_ADMIN &&
        previous.botAccessState !== ChatBotAccessState.CONFIRMED_OWNER)
    )
      return;
    const key = this.key(
      previous.publisherBotId,
      params.chatId,
      previous.botAccessCheckedAt,
      previous.botAccessExpiresAt,
    );
    if (!key) {
      this.unavailable('missing_proof_identity');
      return;
    }
    // FLAG: An obligation begins when the old proof enters the renewal horizon, not
    // on each retry or each early actor refresh. Exact proof identity deduplicates both.
    if (
      key.requiredBefore.getTime() >
      params.probeStartedAt.getTime() + PUBLISHER_ACCESS_REFRESH_AHEAD_MS
    )
      return;
    try {
      const identity = { publisherBotId_chatId_proofCheckedAt_requiredBefore: key };
      await this.prisma.publisherAccessRefreshObligation.upsert({
        where: identity,
        create: {
          ...key,
          observedAt: params.probeStartedAt,
          cohort: this.cohort(previous.publisherBotId, params.chatId),
          resolution: params.outcome,
          committedAt: params.committedAt,
        },
        update: {},
      });
      // FLAG: Once settled, a later retry cannot improve or rewrite the original verdict.
      await this.prisma.publisherAccessRefreshObligation.updateMany({
        where: { ...key, resolution: 'pending' },
        data: { resolution: params.outcome, committedAt: params.committedAt },
      });
    } catch {
      // FLAG: A telemetry outage invalidates coverage, never the committed grant.
      this.unavailable('resolution_write_failed');
    }
  }

  async maintain(now: Date): Promise<void> {
    if (!this.policy.deadlinePrioritiesEnabled) return;
    try {
      // FLAG: Only this new diagnostic table is retained. No access, receipt or send ledger
      // is deleted; old unresolved obligations remain visible for the same seven days.
      await this.prisma.$executeRaw(Prisma.sql`
        DELETE FROM "publisher_access_refresh_obligations" AS evidence
        USING (
          SELECT "publisher_bot_id", "chat_id", "proof_checked_at", "required_before"
          FROM "publisher_access_refresh_obligations"
          WHERE "required_before" < ${new Date(now.getTime() - RETENTION_MS)}
          ORDER BY "required_before" ASC
          LIMIT 500
        ) AS expired
        WHERE evidence."publisher_bot_id" = expired."publisher_bot_id"
          AND evidence."chat_id" = expired."chat_id"
          AND evidence."proof_checked_at" = expired."proof_checked_at"
          AND evidence."required_before" = expired."required_before"
      `);
    } catch {
      this.unavailable('retention_failed');
    }
  }

  async reportCompletedHour(botId: string, now: Date): Promise<void> {
    if (!this.policy.deadlinePrioritiesEnabled) return;
    const to = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
    const from = new Date(to.getTime() - 3_600_000);
    try {
      const cohorts = await this.prisma.$queryRaw<
        Array<{
          cohort: string;
          obligations: number;
          confirmedInTime: number;
          confirmedLate: number;
          denied: number;
          unresolved: number;
          registeredAfterDeadline: number;
          sourceTruncated: boolean;
        }>
      >(Prisma.sql`
        WITH source AS MATERIALIZED (
          SELECT "cohort", "resolution", "committed_at", "required_before", "observed_at"
          FROM "publisher_access_refresh_obligations"
          WHERE "publisher_bot_id" = ${botId}
            AND "required_before" >= ${from} AND "required_before" < ${to}
          ORDER BY "required_before" ASC
          LIMIT 50001
        ), sampled AS (SELECT * FROM source LIMIT 50000)
        SELECT "cohort", COUNT(*)::int AS "obligations",
          COUNT(*) FILTER (WHERE "resolution" = 'confirmed' AND "committed_at" <= "required_before")::int AS "confirmedInTime",
          COUNT(*) FILTER (WHERE "resolution" = 'confirmed' AND "committed_at" > "required_before")::int AS "confirmedLate",
          COUNT(*) FILTER (WHERE "resolution" = 'denied')::int AS "denied",
          COUNT(*) FILTER (WHERE "resolution" = 'pending')::int AS "unresolved",
          COUNT(*) FILTER (WHERE "observed_at" > "required_before")::int AS "registeredAfterDeadline",
          (SELECT COUNT(*) > 50000 FROM source) AS "sourceTruncated"
        FROM sampled GROUP BY "cohort" ORDER BY "cohort"
      `);
      // FLAG: Repeated reports replace the same absolute hour, never add to it. Coverage
      // still requires complete scan cycles/population and no evidence gaps for this release.
      this.logger.log(
        {
          metric: 'publisher_access_obligations_v1',
          from: from.toISOString(),
          to: to.toISOString(),
          basis: 'registered_obligations',
          sourceCap: 50000,
          cohorts,
        },
        'Publisher access obligation hour',
      );
    } catch {
      this.unavailable('report_failed');
    }
  }

  private key(botId: string, chatId: string, checkedAt?: Date | null, expiresAt?: Date | null) {
    if (
      !checkedAt ||
      !expiresAt ||
      !Number.isFinite(checkedAt.getTime()) ||
      !Number.isFinite(expiresAt.getTime()) ||
      expiresAt <= checkedAt
    )
      return null;
    return { publisherBotId: botId, chatId, proofCheckedAt: checkedAt, requiredBefore: expiresAt };
  }

  private cohort(botId: string, chatId: string) {
    return this.policy.separatesMaintenance(botId, chatId) ? 'separated' : 'legacy';
  }

  private unavailable(reason: string, count = 1) {
    try {
      this.logger.warn(
        { metric: 'publisher_access_evidence_gap_v1', reason, count },
        'Publisher access evidence unavailable',
      );
    } catch {
      // FLAG: Observational logging never invalidates a permission transition.
    }
  }
}
