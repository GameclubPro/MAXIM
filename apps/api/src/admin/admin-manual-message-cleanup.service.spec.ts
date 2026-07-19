import { AdminManualMessageCleanupService } from './admin-manual-message-cleanup.service';

describe('AdminManualMessageCleanupService', () => {
  it('routes exact replacement cleanup through the durable executor outside the global rollout', async () => {
    const maxClient = { deleteMessage: jest.fn() };
    const deleteIntents = {
      getRolloutForChat: jest.fn().mockReturnValue('observed'),
      getRolloutForRule: jest.fn().mockReturnValue('execute'),
      ensureIntent: jest.fn().mockResolvedValue({
        intentId: 'intent-1',
        rollout: 'execute',
        status: 'PENDING',
      }),
      ensureAndAttempt: jest.fn().mockResolvedValue({
        kind: 'pending',
        confirmed: false,
        intentId: 'intent-1',
        status: 'PENDING',
      }),
    };
    const service = new AdminManualMessageCleanupService(
      {} as never,
      maxClient as never,
      deleteIntents as never,
    );

    await expect(
      service.deleteBotAuthoredMessage({
        chatId: 'chat-outside-canary',
        messageId: 'message-1',
        originBotId: 'bot-1',
        reasonKey: 'chat_rules_republish_previous_message_cleanup',
        ruleCode: 'CHAT_RULES_REPUBLISH_PREVIOUS_MESSAGE_CLEANUP',
        metadata: { source: 'chat_rules' },
        directOptions: { immediate: true, botId: 'bot-1' },
      }),
    ).resolves.toBe('accepted');

    expect(deleteIntents.getRolloutForRule).toHaveBeenCalledWith(
      'chat-outside-canary',
      'CHAT_RULES_REPUBLISH_PREVIOUS_MESSAGE_CLEANUP',
    );
    expect(deleteIntents.ensureIntent).toHaveBeenCalledTimes(1);
    expect(deleteIntents.ensureAndAttempt).toHaveBeenCalledTimes(1);
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
  });

  it('fails closed when exact replacement cleanup intent persistence fails', async () => {
    const persistenceError = new Error('intent persistence unavailable');
    const maxClient = { deleteMessage: jest.fn() };
    const deleteIntents = {
      getRolloutForChat: jest.fn().mockReturnValue('observed'),
      getRolloutForRule: jest.fn().mockReturnValue('execute'),
      ensureIntent: jest.fn().mockRejectedValue(persistenceError),
      ensureAndAttempt: jest.fn(),
    };
    const service = new AdminManualMessageCleanupService(
      {} as never,
      maxClient as never,
      deleteIntents as never,
    );

    await expect(
      service.deleteBotAuthoredMessage({
        chatId: 'chat-outside-canary',
        messageId: 'message-1',
        originBotId: 'bot-1',
        reasonKey: 'chat_rules_republish_previous_message_cleanup',
        ruleCode: 'CHAT_RULES_REPUBLISH_PREVIOUS_MESSAGE_CLEANUP',
        metadata: { source: 'chat_rules' },
        directOptions: { immediate: true, botId: 'bot-1' },
      }),
    ).rejects.toBe(persistenceError);

    expect(deleteIntents.ensureAndAttempt).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
  });
});
