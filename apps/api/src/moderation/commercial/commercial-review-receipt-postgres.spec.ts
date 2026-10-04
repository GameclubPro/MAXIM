import { createHash, randomUUID } from 'node:crypto';
import { createPrismaClient, type PrismaClient } from '../../prisma/prisma-client';
import { ModerationDeleteIntentService } from '../moderation-delete-intent.service';
import { buildCommercialTextDeleteBinding } from './commercial-delete-binding';
import {
  CommercialReviewService,
  buildCommercialReviewExecutionBinding,
  type Candidate,
} from './commercial-review.service';
import {
  COMMERCIAL_INTENT_QUALITY_COHORT,
  COMMERCIAL_INTENT_QUALITY_DECISION_VERSION,
} from './commercial-policy-cohorts';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
(databaseUrl ? describe : describe.skip)(
  'commercial review durable receipt PostgreSQL recovery',
  () => {
    let prisma: PrismaClient;
    let review: CommercialReviewService;
    let service: {
      recordRemoteDeleteSucceeded(
        id: string,
        lease: string,
        bot: string,
        keys: string[],
      ): Promise<boolean>;
      completeSucceeded(
        id: string,
        lease: string,
        bot: string,
        absence?: null,
        profanity?: boolean,
        keys?: string[],
      ): Promise<unknown>;
    };
    const chatId = `review-receipt-${randomUUID()}`;
    const detectorSourceSha256 = createHash('sha256').update(chatId).digest('hex');
    const intentId = `intent-${randomUUID()}`;
    const candidate: Candidate = {
      chatId,
      userId: 'test-user',
      messageId: 'review-message',
      text: 'Продам свой холодильник',
      source: 'TEXT',
      score: 80,
      actionBand: 'DELETE',
      messageDisposition: 'DELETE',
      decisionFingerprint: 'test',
      detectorVersion: COMMERCIAL_INTENT_QUALITY_DECISION_VERSION,
      detectorSourceSha256,
      requiredPolicyCohorts: [COMMERCIAL_INTENT_QUALITY_COHORT],
      logicalMessageKey: 'a'.repeat(64),
      authorGroupId: 'b'.repeat(64),
      sourceSnapshotSha256: 'c'.repeat(64),
      sourceExcerptComplete: true,
      executionOutcome: 'PENDING',
      analysisOutcome: 'COMPLETE',
    };
    const binding = buildCommercialReviewExecutionBinding(candidate)!;
    const commercialTextBinding = {
      ...buildCommercialTextDeleteBinding({
        text: candidate.text,
        settings: {
          commercialAdsFilterEnabled: true,
          commercialAdsSensitivity: 'BALANCED',
          commercialAdsWarnThreshold: 45,
          commercialAdsDeleteThreshold: 65,
          nightModeTimezone: 'UTC',
          textFiltersWarnEnabled: false,
          textFiltersMuteEnabled: false,
          textFiltersBanEnabled: false,
          textFiltersMuteDurationHours: 1,
          textFiltersBotMessageEnabled: false,
        },
        eventTimestampMs: Date.now(),
        campaignContext: null,
        requiredPolicyCohorts: [COMMERCIAL_INTENT_QUALITY_COHORT],
      }),
      detectorSourceSha256,
    };
    const metadata = { commercialReviewBinding: binding, commercialTextBinding };
    const maxDelete = jest.fn();
    beforeAll(async () => {
      const url = new URL(databaseUrl);
      if (
        !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        !url.pathname.includes('race_test')
      )
        throw new Error('Receipt races require a disposable local race_test database');
      prisma = createPrismaClient(databaseUrl, { max: 8 });
      await prisma.$connect();
      await prisma.chat.create({ data: { id: chatId, title: 'Private receipt recovery tests' } });
      review = new CommercialReviewService(prisma as never);
      service = Object.assign(Object.create(ModerationDeleteIntentService.prototype), {
        prisma,
        commercialReview: review,
        logger: { warn: jest.fn() },
        maxClient: { deleteMessage: maxDelete },
        loadRequiredIntent: () =>
          prisma.moderationDeleteIntent.findUniqueOrThrow({ where: { id: intentId } }),
        markReplacementCleanupConfirmed: jest.fn().mockResolvedValue(undefined),
      });
    });
    beforeEach(async () => {
      await prisma.moderationDeleteIntent.deleteMany({ where: { chatId } });
      await prisma.moderationEvent.deleteMany({ where: { chatId } });
      await prisma.commercialReviewSample.deleteMany({ where: { chatId } });
      await prisma.auditLog.deleteMany({ where: { chatId } });
      await prisma.commercialQualityPolicyStop.deleteMany({ where: { detectorSourceSha256 } });
      await review.recordCandidate(candidate);
      await prisma.moderationDeleteIntent.create({
        data: {
          id: intentId,
          chatId,
          messageId: candidate.messageId,
          subjectUserId: candidate.userId,
          status: 'IN_PROGRESS',
          retryUntilAt: new Date(Date.now() + 60_000),
          leaseToken: 'lease',
          leaseExpiresAt: new Date(Date.now() + 60_000),
          reasons: {
            create: [
              {
                id: `${intentId}-verified`,
                reasonKey: 'verified',
                ruleCode: 'COMMERCIAL_AD_DELETE',
                userId: candidate.userId,
                eventType: 'MESSAGE',
                maskedExcerpt: 'test',
                score: 0.8,
                metadata,
              },
              {
                id: `${intentId}-unverified`,
                reasonKey: 'unverified',
                ruleCode: 'COMMERCIAL_AD_DELETE',
                userId: candidate.userId,
                eventType: 'MESSAGE',
                maskedExcerpt: 'test',
                score: 0.8,
                metadata,
              },
            ],
          },
        },
      });
      maxDelete.mockClear();
    });
    afterAll(async () => {
      if (!prisma) return;
      await prisma.chat.deleteMany({ where: { id: chatId } });
      await prisma.commercialQualityPolicyStop.deleteMany({ where: { detectorSourceSha256 } });
      await prisma.$disconnect();
    });
    async function sample() {
      return prisma.commercialReviewSample.findUniqueOrThrow({
        where: { evidenceHash: binding.evidenceHash },
        include: { ratings: true },
      });
    }
    async function vote(actor: string) {
      const row = await sample();
      return review.labelItem(row.id, actor, {
        expectedUpdatedAt: row.updatedAt.toISOString(),
        label: 'NOT_COMMERCIAL',
        expectedDisposition: 'KEEP',
      });
    }
    it('stores only freshly verified reason attribution and consumes it on receipt-first recovery without new commercial events', async () => {
      await vote('one');
      await vote('two');
      expect(
        await service.recordRemoteDeleteSucceeded(intentId, 'lease', 'bot', ['verified']),
      ).toBe(true);
      const reasons = await prisma.moderationDeleteIntentReason.findMany({
        where: { intentId },
        orderBy: { reasonKey: 'asc' },
      });
      expect(reasons[1]?.metadata).toMatchObject({
        commercialReviewReceipt: {
          outcome: 'CONFIRMED_DELETE',
          evidenceHash: binding.evidenceHash,
          botId: 'bot',
        },
      });
      expect(reasons[0]?.metadata).not.toHaveProperty('commercialReviewReceipt');
      await service.completeSucceeded(intentId, 'lease', 'bot');
      expect((await sample()).qualityMetadata).toMatchObject({
        executionOutcome: 'CONFIRMED_DELETE',
      });
      expect(
        await prisma.commercialQualityPolicyStop.count({ where: { detectorSourceSha256 } }),
      ).toBe(1);
      expect(await prisma.moderationEvent.count({ where: { chatId } })).toBe(0);
      expect(maxDelete).not.toHaveBeenCalled();
    });
    it('keeps durable remote success after a quality write failure and recovers atomically without another MAX call', async () => {
      await vote('one');
      await vote('two');
      await service.recordRemoteDeleteSucceeded(intentId, 'lease', 'bot', ['verified']);
      const record = jest
        .spyOn(review, 'recordExecution')
        .mockRejectedValueOnce(new Error('temporary observation database failure'));
      await expect(service.completeSucceeded(intentId, 'lease', 'bot')).rejects.toThrow(
        'temporary observation',
      );
      const pending = await prisma.moderationDeleteIntent.findUniqueOrThrow({
        where: { id: intentId },
      });
      expect(pending.status).toBe('IN_PROGRESS');
      expect(pending.remoteDeleteSucceededAt).not.toBeNull();
      expect(pending.remoteDeleteSucceededBotId).toBe('bot');
      expect((await sample()).qualityMetadata).toMatchObject({ executionOutcome: 'PENDING' });
      expect(
        await prisma.commercialQualityPolicyStop.count({ where: { detectorSourceSha256 } }),
      ).toBe(0);
      await service.completeSucceeded(intentId, 'lease', 'bot');
      expect((await sample()).qualityMetadata).toMatchObject({
        executionOutcome: 'CONFIRMED_DELETE',
      });
      expect(
        await prisma.commercialQualityPolicyStop.count({ where: { detectorSourceSha256 } }),
      ).toBe(1);
      expect(maxDelete).not.toHaveBeenCalled();
      record.mockRestore();
    });
    it('serializes final independent KEEP with receipt finalization and never applies the receipt to an edited sample', async () => {
      await vote('one');
      await service.recordRemoteDeleteSucceeded(intentId, 'lease', 'bot', ['verified']);
      await review.recordCandidate({
        ...candidate,
        text: 'Изменённое предложение',
        sourceSnapshotSha256: 'd'.repeat(64),
      });
      const results = await Promise.allSettled([
        vote('two'),
        service.completeSucceeded(intentId, 'lease', 'bot'),
      ]);
      expect(results[1]?.status).toBe('fulfilled');
      if (results[0]?.status === 'rejected') {
        expect(results[0].reason).toMatchObject({ status: 409 });
        await vote('two');
      }
      expect(
        await prisma.commercialQualityPolicyStop.count({ where: { detectorSourceSha256 } }),
      ).toBe(1);
      const edit = await prisma.commercialReviewSample.findFirstOrThrow({
        where: { chatId, evidenceHash: { not: binding.evidenceHash } },
      });
      expect(edit.qualityMetadata).toMatchObject({ executionOutcome: 'PENDING' });
    });
    it('treats missing sources and unverified successful deletion as omissions rather than proof for a shadow candidate', async () => {
      await service.recordRemoteDeleteSucceeded(intentId, 'lease', 'bot', []);
      await service.completeSucceeded(intentId, 'lease', 'bot');
      expect((await sample()).qualityMetadata).toMatchObject({ executionOutcome: 'PENDING' });
      expect(
        await prisma.commercialQualityPolicyStop.count({ where: { detectorSourceSha256 } }),
      ).toBe(0);
      await prisma.moderationDeleteIntent.update({
        where: { id: intentId },
        data: {
          status: 'IN_PROGRESS',
          leaseToken: 'new-lease',
          leaseExpiresAt: new Date(Date.now() + 60_000),
        },
      });
      await service.recordRemoteDeleteSucceeded(intentId, 'new-lease', 'bot', ['verified']);
      await prisma.commercialReviewSample.deleteMany({ where: { chatId } });
      await expect(service.completeSucceeded(intentId, 'new-lease', 'bot')).resolves.toMatchObject({
        status: 'SUCCEEDED',
      });
      expect(await prisma.commercialReviewSample.count({ where: { chatId } })).toBe(0);
      expect(maxDelete).not.toHaveBeenCalled();
    });
  },
);
