import { ModerationService } from './moderation.service';
import { ModerationRuleSanctionRejectedError } from './moderation-rule-sanction-authority';
import { deliverSanctionNotice } from './moderation-sanction-notice-delivery';

describe('permanent legacy moderation hold', () => {
  function fixture() {
    const service = Object.create(ModerationService.prototype) as ModerationService;
    const create = jest.fn();
    const legacyHolds = {
      isMessageHeld: jest.fn().mockResolvedValue(false),
      isMemberHeld: jest.fn().mockResolvedValue(true),
    };
    Object.assign(service, { legacyHolds, prisma: { moderationEvent: { create } } });
    return { service: service as any, create, legacyHolds };
  }

  it('denies a late edited message before any whole-engine or duplicate state mutation', async () => {
    const { service, legacyHolds } = fixture();
    legacyHolds.isMessageHeld.mockResolvedValue(true);
    const observeLifecycle = jest.fn();
    Object.assign(service, { messageDuplicateService: { observeLifecycle } });
    await service.handleUpdate({
      type: 'message_edited',
      message: { chatId: 'chat', messageId: 'old', senderId: 'actor' },
    });
    expect(observeLifecycle).not.toHaveBeenCalled();
  });

  it('denies new strikes and local WARN/MUTE persistence for the held participant', async () => {
    const { service, create } = fixture();
    await expect(
      service.claimMessageViolationProcessing({
        chatId: 'chat',
        userId: 'actor',
        messageId: 'new',
        ruleCode: 'MESSAGE_TOO_LONG',
      }),
    ).resolves.toBe(false);
    await expect(
      service.createBotModerationEvent({
        data: {
          chatId: 'chat',
          userId: 'actor',
          messageId: 'new',
          action: 'MUTE',
          ruleCode: 'MESSAGE_TOO_LONG',
        },
      }),
    ).rejects.toBeInstanceOf(ModerationRuleSanctionRejectedError);
    expect(create).not.toHaveBeenCalled();
  });

  it('fails closed when the participant lookup fails', async () => {
    const { service, create, legacyHolds } = fixture();
    legacyHolds.isMemberHeld.mockRejectedValue(new Error('Hold store unavailable'));
    await expect(
      service.createBotModerationEvent({
        data: {
          chatId: 'chat',
          userId: 'actor',
          messageId: 'new',
          action: 'WARN',
          ruleCode: 'MESSAGE_TOO_LONG',
        },
      }),
    ).rejects.toThrow('Hold store unavailable');
    expect(create).not.toHaveBeenCalled();
  });

  it('preserves exact source attribution when a generic sanction notice reaches durable SEND', async () => {
    const send = jest.fn().mockResolvedValue(true);
    await deliverSanctionNotice({
      notice: {
        chatId: 'chat',
        userId: 'actor',
        messageId: 'original',
        userLabel: 'User',
        deleteBotMessagesEnabled: false,
        deleteBotMessagesDelayMinutes: 0,
        botSpeechStyle: null,
        ledgerContext: { moderationNoticeEnvelope: { version: 1 } },
      },
      action: 'UNMUTE',
      text: 'Existing product notice',
      send,
      logger: { warn: jest.fn() },
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        ledgerContext: {
          moderationNoticeEnvelope: { version: 1 },
          moderationSource: { version: 1, chatId: 'chat', userId: 'actor', messageId: 'original' },
        },
      }),
    );
  });
});
