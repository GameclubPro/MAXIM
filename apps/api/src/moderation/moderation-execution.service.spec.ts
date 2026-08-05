import { ModerationExecutionService } from './moderation-execution.service';

describe('ModerationExecutionService', () => {
  it('executes webhook events through the legacy moderation boundary', async () => {
    const legacyModerationService = {
      processWebhookEvent: jest.fn().mockResolvedValue(undefined),
      processNightModeTransitionJob: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ModerationExecutionService(legacyModerationService);

    await service.processWebhookEvent('webhook-event-1');

    expect(legacyModerationService.processWebhookEvent).toHaveBeenCalledWith('webhook-event-1');
  });

  it('executes night mode transition jobs through the legacy moderation boundary', async () => {
    const processResult = { shouldEnqueueNext: false };
    const legacyModerationService = {
      processWebhookEvent: jest.fn().mockResolvedValue(undefined),
      processNightModeTransitionJob: jest.fn().mockResolvedValue(processResult),
    };
    const service = new ModerationExecutionService(legacyModerationService);
    const job = {
      chatId: 'chat-1',
      transition: 'open' as const,
      scheduledFor: '2026-05-31T05:00:00.000Z',
      sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-05-30',
    };

    await expect(service.processNightModeTransitionJob(job)).resolves.toBe(processResult);

    expect(legacyModerationService.processNightModeTransitionJob).toHaveBeenCalledWith(job);
  });

  it('executes photo duplicate jobs through the focused moderation boundary', async () => {
    const legacyModerationService = {
      processWebhookEvent: jest.fn().mockResolvedValue(undefined),
      processNightModeTransitionJob: jest.fn().mockResolvedValue(undefined),
    };
    const photoDuplicateModerationService = {
      processPhotoDuplicateJob: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ModerationExecutionService(
      legacyModerationService,
      photoDuplicateModerationService as never,
    );
    const job = {
      webhookEventId: 'webhook-event-1',
      chatId: 'chat-1',
      messageId: 'message-1',
      sourceCreatedAt: '2026-08-05T12:00:00.000Z',
      algorithmVersion: 1 as const,
    };

    const lease = { assertOwned: jest.fn() };
    await service.processPhotoDuplicateJob(job, lease);

    expect(photoDuplicateModerationService.processPhotoDuplicateJob).toHaveBeenCalledWith(
      job,
      lease,
    );
  });
});
