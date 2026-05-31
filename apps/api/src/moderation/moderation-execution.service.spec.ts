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
    const legacyModerationService = {
      processWebhookEvent: jest.fn().mockResolvedValue(undefined),
      processNightModeTransitionJob: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ModerationExecutionService(legacyModerationService);
    const job = {
      chatId: 'chat-1',
      transition: 'open' as const,
      scheduledFor: '2026-05-31T05:00:00.000Z',
      sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-05-30',
    };

    await service.processNightModeTransitionJob(job);

    expect(legacyModerationService.processNightModeTransitionJob).toHaveBeenCalledWith(job);
  });
});
