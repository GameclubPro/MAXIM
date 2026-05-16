import { ModerationExecutionService } from './moderation-execution.service';

describe('ModerationExecutionService', () => {
  it('executes webhook events through the legacy moderation boundary', async () => {
    const legacyModerationService = {
      processWebhookEvent: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ModerationExecutionService(legacyModerationService);

    await service.processWebhookEvent('webhook-event-1');

    expect(legacyModerationService.processWebhookEvent).toHaveBeenCalledWith('webhook-event-1');
  });
});
