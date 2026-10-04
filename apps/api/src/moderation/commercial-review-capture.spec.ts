import { ConfigService } from '@nestjs/config';
import {
  ModerationService,
  createDeferred,
  createSettings,
  createUpdate,
} from './moderation.service.spec-support';

describe('commercial quality capture ordering', () => {
  it('awaits the frozen sample before persisting or executing its delete intent when initial capture is slow', async () => {
    const pendingReached = createDeferred<void>();
    const captureCompleted = createDeferred<void>();
    const recordCandidate = jest.fn((input: { executionOutcome: string }) => {
      if (input.executionOutcome === 'PENDING') pendingReached.resolve();
      return captureCompleted.promise;
    });
    const prisma = {
      chat: {
        upsert: jest
          .fn()
          .mockResolvedValue({
            id: 'chat-1',
            title: 'Chat 1',
            domains: [],
            settings: createSettings({ commercialAdsFilterEnabled: true }),
          }),
      },
      violation: { create: jest.fn() },
      moderationEvent: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
      webhookEvent: { findUnique: jest.fn(), update: jest.fn() },
    };
    const service = new ModerationService(
      prisma as never,
      {
        detect: jest
          .fn()
          .mockResolvedValue({
            violations: [
              {
                ruleCode: 'COMMERCIAL_AD',
                score: 0.9,
                reason: 'test',
                metadata: { actionBand: 'DELETE', actionable: true, messageDisposition: 'DELETE' },
              },
            ],
          }),
      } as never,
      { resolveAction: jest.fn() } as never,
      {} as never,
      undefined,
      undefined,
      new ConfigService({ MAX_WEBHOOK_SECRET_PATH: 'private-test-observation-key-1234567890' }),
    );
    const ensure = jest.fn().mockResolvedValue(undefined);
    const execute = jest.fn().mockResolvedValue({ deleted: false, gone: false });
    Object.assign(service, {
      commercialReview: { recordCandidate, recordExecution: jest.fn() },
      ensureModerationDeleteIntent: ensure,
      executeModerationDelete: execute,
    });
    const update = createUpdate();
    update.raw = { message: { timestamp: update.message!.createdAt } };
    const processing = service.handleUpdate(update);
    await pendingReached.promise;
    expect(ensure).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    captureCompleted.resolve();
    await processing;
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(ensure.mock.calls[0]![0].event.metadata.commercialReviewBinding).toMatchObject({
      schemaVersion: 1,
      source: 'TEXT',
      evidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      sourceSnapshotSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
