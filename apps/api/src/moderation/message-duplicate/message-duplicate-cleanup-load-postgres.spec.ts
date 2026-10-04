import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createPrismaClient, Prisma } from '../../prisma/prisma-client';
import { ModerationDeleteIntentService } from '../moderation-delete-intent.service';
import { buildMessageScopedModerationActionClaimKey } from '../moderation-message-action-claim';
import { duplicateRevocationKey } from './message-duplicate-authorization.service';
import { digestDuplicateContent } from './message-duplicate-content';
import { MESSAGE_DUPLICATE_CLAIM_PREFIX } from './message-duplicate-state';
import type { DuplicateCleanupSample } from './message-duplicate-claim-cleanup';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL ?? '';
const dueCount = 250;
const protectedCount = 3;

(databaseUrl ? describe : describe.skip)('duplicate cleanup finite local PostgreSQL load', () => {
  it('settles 250 due obligations in bounded batches while measuring retained storage', async () => {
    const parsed = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) ||
      !parsed.pathname.includes('race_test')
    )
      throw new Error('Cleanup load acceptance requires a disposable local race_test database');
    const prisma = createPrismaClient(databaseUrl, { max: 2 });
    const chatId = `cleanup-load-${randomUUID()}`;
    const service = new ModerationDeleteIntentService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      new ConfigService({ MODERATION_DELETE_INTENT_MODE: 'on' }),
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const eventTimestampMs = Date.now();
    const dueDeadlineMs = eventTimestampMs + 120_000;
    const dueAtMs = dueDeadlineMs + 30_000;
    const entries = Array.from({ length: dueCount + 1 }, (_, index) => {
      const messageId = `message-${index}`;
      const claim = {
        chatId,
        userId: 'fixture-user',
        messageId,
        ruleCode: 'DUPLICATE_MESSAGE_ACTION',
        updateType: 'message_action' as const,
        dedupeKey: `${MESSAGE_DUPLICATE_CLAIM_PREFIX}${digestDuplicateContent([chatId, 'fixture-user', messageId])}`,
        messageActionKey: buildMessageScopedModerationActionClaimKey(chatId, messageId),
      };
      const binding = {
        messageId,
        senderId: claim.userId,
        eventTimestampMs,
        authorization: {
          eventTimestampMs,
          deadlineAtMs: index < dueCount ? dueDeadlineMs : eventTimestampMs + 600_000,
        },
      };
      return { claim, binding };
    });
    const cardinality = async () => {
      const owners = await prisma.moderationViolationMessageClaim.count({
        where: { chatId, ruleCode: 'DUPLICATE_MESSAGE_ACTION' },
      });
      const activeOwners = await prisma.moderationViolationMessageClaim.count({
        where: { chatId, messageActionKey: { not: null } },
      });
      const revocations = await prisma.moderationViolationMessageClaim.count({
        where: { chatId, ruleCode: 'MESSAGE_DUPLICATE_AUTHORIZATION_REVOKED' },
      });
      const obligations = await prisma.messageDuplicateClaimCleanup.count({
        where: { claim: { chatId } },
      });
      const due = await prisma.messageDuplicateClaimCleanup.count({
        where: { claim: { chatId }, deadlineAt: { lte: new Date(dueAtMs) } },
      });
      const oldest = await prisma.messageDuplicateClaimCleanup.findFirst({
        where: { claim: { chatId }, deadlineAt: { lte: new Date(dueAtMs) } },
        orderBy: [{ deadlineAt: 'asc' }, { claimId: 'asc' }],
        select: { deadlineAt: true },
      });
      return {
        owners,
        activeOwners,
        revocations,
        obligations,
        due,
        oldestDueAgeMs: oldest ? dueAtMs - oldest.deadlineAt.getTime() : 0,
      };
    };
    const relationBytes = async () => {
      const [sizes] = await prisma.$queryRaw<
        Array<{
          claimsHeap: bigint;
          claimsTotal: bigint;
          cleanupHeap: bigint;
          cleanupTotal: bigint;
        }>
      >(Prisma.sql`
        SELECT pg_relation_size('moderation_violation_message_claims') AS "claimsHeap",
          pg_total_relation_size('moderation_violation_message_claims') AS "claimsTotal",
          pg_relation_size('message_duplicate_claim_cleanup') AS "cleanupHeap",
          pg_total_relation_size('message_duplicate_claim_cleanup') AS "cleanupTotal"
      `);
      return Object.fromEntries(Object.entries(sizes!).map(([key, value]) => [key, Number(value)]));
    };
    try {
      await prisma.chat.create({ data: { id: chatId, title: 'Finite cleanup fixture' } });
      const before = { rows: await cardinality(), bytes: await relationBytes() };
      const prepareStarted = performance.now();
      for (const entry of entries)
        expect(
          await service.claimMessageActionBeforeQualification(entry.claim, entry.binding),
        ).toBe('claimed');
      const prepareMs = performance.now() - prepareStarted;
      const ownersBefore = await prisma.moderationViolationMessageClaim.findMany({
        where: { chatId, ruleCode: 'DUPLICATE_MESSAGE_ACTION' },
        orderBy: { messageId: 'asc' },
      });
      const ownerIds = ownersBefore.map((owner) => owner.id);
      const liveOwner = ownersBefore.find(
        (owner) => owner.messageId === entries[dueCount]!.claim.messageId,
      )!;
      const liveObligation = await prisma.messageDuplicateClaimCleanup.findUniqueOrThrow({
        where: { claimId: liveOwner.id },
      });
      // FLAG: Existing materialization is seeded as in the claim race fixtures. The
      // real reconciler must settle these duties without clearing any action owner.
      await prisma.moderationDeleteIntent.create({
        data: {
          id: randomUUID(),
          chatId,
          messageId: entries[0]!.claim.messageId,
          retryUntilAt: new Date(eventTimestampMs + 600_000),
        },
      });
      await prisma.moderationEvent.create({
        data: {
          chatId,
          messageId: entries[1]!.claim.messageId,
          userId: 'fixture-user',
          eventType: 'MESSAGE',
          ruleCode: 'DUPLICATE_WARN',
          action: 'WARN',
        },
      });
      await prisma.maxActionLedgerEntry.create({
        data: {
          chatId,
          jobId: `${chatId}:receipt`,
          messageId: entries[2]!.claim.messageId,
          actionType: 'DELETE_MESSAGE',
          status: 'SUCCEEDED',
          terminal: true,
        },
      });
      const loaded = { rows: await cardinality(), bytes: await relationBytes() };
      expect(loaded.rows).toEqual({
        owners: 251,
        activeOwners: 251,
        revocations: 0,
        obligations: 251,
        due: 250,
        oldestDueAgeMs: 30_000,
      });
      const batches: Array<DuplicateCleanupSample & { durationMs: number }> = [];
      // FLAG: Advance only application wall time. PostgreSQL stays real, all I/O
      // timers and performance.now stay real, and persisted generations/deadlines
      // are never rewritten to make a duty eligible. No sleep enters the benchmark.
      jest.useFakeTimers({
        now: dueAtMs,
        doNotFake: [
          'nextTick',
          'queueMicrotask',
          'setImmediate',
          'clearImmediate',
          'setTimeout',
          'clearTimeout',
          'setInterval',
          'clearInterval',
          'hrtime',
          'performance',
        ],
      });
      let released = 0;
      let sweepDurationMs = 0;
      try {
        for (let index = 0; index < dueCount / 25; index++) {
          let sample: DuplicateCleanupSample | undefined;
          const started = performance.now();
          const count = await service.reconcileExpiredMessageDuplicateActions((value) => {
            sample = value;
          });
          const durationMs = performance.now() - started;
          sweepDurationMs += durationMs;
          expect(sample).toEqual({
            sampledDue: 25,
            sampleLimit: 25,
            sampleLimitReached: true,
            oldestDueAgeMs: 30_000,
            released: count,
          });
          expect(count).toBeGreaterThanOrEqual(0);
          expect(count).toBeLessThanOrEqual(25);
          expect(durationMs).toBeGreaterThan(0);
          batches.push({ ...sample!, durationMs: Number(durationMs.toFixed(3)) });
          released += count;
          const remaining = await cardinality();
          expect(remaining.obligations).toBe(dueCount - (index + 1) * 25 + 1);
          expect(remaining.due).toBe(dueCount - (index + 1) * 25);
          expect(remaining.revocations).toBe(released);
        }
        const emptyReport = jest.fn();
        expect(await service.reconcileExpiredMessageDuplicateActions(emptyReport)).toBe(0);
        expect(emptyReport).toHaveBeenCalledWith({
          sampledDue: 0,
          sampleLimit: 25,
          sampleLimitReached: false,
          oldestDueAgeMs: null,
          released: 0,
        });
      } finally {
        jest.useRealTimers();
      }
      expect(released).toBe(dueCount - protectedCount);
      const settled = { rows: await cardinality(), bytes: await relationBytes() };
      expect(settled.rows).toEqual({
        owners: 251,
        activeOwners: 4,
        revocations: 247,
        obligations: 1,
        due: 0,
        oldestDueAgeMs: 0,
      });
      const ownersAfter = await prisma.moderationViolationMessageClaim.findMany({
        where: { id: { in: ownerIds } },
        orderBy: { messageId: 'asc' },
      });
      expect(ownersAfter).toHaveLength(ownersBefore.length);
      const protectedIds = new Set(entries.slice(0, 3).map((entry) => entry.claim.messageId));
      protectedIds.add(entries[dueCount]!.claim.messageId);
      ownersAfter.forEach((owner, index) => {
        expect(owner).toEqual({
          ...ownersBefore[index],
          messageActionKey: protectedIds.has(owner.messageId)
            ? ownersBefore[index]!.messageActionKey
            : null,
        });
      });
      expect(
        await prisma.messageDuplicateClaimCleanup.findUniqueOrThrow({
          where: { claimId: liveOwner.id },
        }),
      ).toEqual(liveObligation);
      expect(await prisma.moderationDeleteIntent.count({ where: { chatId } })).toBe(1);
      expect(await prisma.moderationEvent.count({ where: { chatId } })).toBe(1);
      expect(await prisma.maxActionLedgerEntry.count({ where: { chatId } })).toBe(1);
      const oldWorker = entries[protectedCount]!;
      expect(
        await service.claimMessageActionBeforeQualification(oldWorker.claim, oldWorker.binding),
      ).toBe('blocked');
      expect(
        await prisma.moderationViolationMessageClaim.findUnique({
          where: {
            dedupeKey: duplicateRevocationKey(chatId, oldWorker.claim.messageId, eventTimestampMs),
          },
        }),
      ).not.toBeNull();
      const delta = (left: Record<string, number>, right: Record<string, number>) =>
        Object.fromEntries(Object.keys(left).map((key) => [key, right[key]! - left[key]!]));
      console.info(
        '[duplicate-cleanup-local-load]',
        JSON.stringify({
          scope: 'disposable_local_postgresql_not_production_capacity',
          scheduling: 'back_to_back_calls_excluding_production_poll_interval',
          fixture: {
            due: dueCount,
            protected: protectedCount,
            notDue: 1,
            applicationClockAdvanceMs: dueAtMs - eventTimestampMs,
          },
          timing: {
            prepareMs: Number(prepareMs.toFixed(3)),
            sweepDurationMs: Number(sweepDurationMs.toFixed(3)),
            settledPerSecond: Number(((dueCount * 1000) / sweepDurationMs).toFixed(2)),
          },
          batches,
          before,
          loaded,
          settled,
          relationDeltaBytes: {
            admission: delta(before.bytes, loaded.bytes),
            cleanup: delta(loaded.bytes, settled.bytes),
          },
          storageMeaning:
            'relation-wide allocated bytes including retained tombstones; no vacuum or size-reduction claim',
        }),
      );
    } finally {
      jest.useRealTimers();
      await prisma.maxActionLedgerEntry.deleteMany({ where: { chatId } });
      await prisma.chat.deleteMany({ where: { id: chatId } });
      await prisma.$disconnect();
    }
  }, 60_000);
});
