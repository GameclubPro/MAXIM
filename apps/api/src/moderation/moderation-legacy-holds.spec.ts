import { ModerationService } from './moderation.service';
import { ModerationRuleSanctionRejectedError } from './moderation-rule-sanction-authority';
import { deliverSanctionNotice } from './moderation-sanction-notice-delivery';
import { createSettings, createUpdate } from './moderation.service.spec-support';

describe('permanent legacy moderation hold', () => {
  function fixture() {
    const service = Object.create(ModerationService.prototype) as ModerationService;
    const create = jest.fn();
    const legacyHolds = {
      isMessageHeld: jest.fn().mockResolvedValue(false),
      isMemberHeld: jest.fn().mockResolvedValue(true),
      isGlobalUserHeld: jest.fn().mockResolvedValue(false),
    };
    Object.assign(service, { legacyHolds, prisma: { moderationEvent: { create } } });
    return { service: service as any, create, legacyHolds };
  }

  function messageFixture() {
    const settings = createSettings({ deleteSpammersEnabled: false });
    const detect = jest.fn().mockResolvedValue({ violations: [] });
    const service = new ModerationService(
      {
        chat: {
          upsert: jest.fn().mockResolvedValue({ id: 'chat-1', settings, domains: [] }),
        },
        moderationEvent: { findFirst: jest.fn().mockResolvedValue(null) },
      } as never,
      { detect } as never,
      {} as never,
      {} as never,
    );
    const legacyHolds = {
      isMessageHeld: jest.fn().mockResolvedValue(false),
      isMemberHeld: jest.fn().mockResolvedValue(false),
      isGlobalUserHeld: jest.fn((userId: string) => Promise.resolve(userId === 'user-1')),
    };
    const admin = jest.fn().mockResolvedValue({ isAdmin: false, source: 'remote' });
    const adminCommand = jest.fn().mockResolvedValue(undefined);
    Object.assign(service, {
      legacyHolds,
      resolveSenderChatAdminCheck: admin,
      handleChatAdminModerationBypass: adminCommand,
    });
    return { service, detect, legacyHolds, admin, adminCommand };
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

  it('denies another-chat strikes, immunity and local sanctions for a globally held author', async () => {
    const { service, create, legacyHolds } = fixture();
    legacyHolds.isMemberHeld.mockResolvedValue(false);
    legacyHolds.isGlobalUserHeld.mockImplementation(async (userId: string) => userId === 'held');
    const consumeForMessage = jest.fn().mockResolvedValue('granted');
    const underLock = jest.fn();
    Object.assign(service, {
      participantImmunity: { consumeForMessage },
      applySanctionActionUnderLock: underLock,
    });
    const source = { chatId: 'other-chat', userId: 'held', messageId: 'fresh' };
    expect(
      await service.claimMessageViolationProcessing({ ...source, ruleCode: 'MESSAGE_TOO_LONG' }),
    ).toBe(false);
    expect(
      await service.consumeChatParticipantModerationImmunity({
        ...source,
        nightModeTimezone: 'UTC',
      }),
    ).toBe(true);
    await expect(service.applySanctionAction({ ...source, action: 'WARN' })).rejects.toBeInstanceOf(
      ModerationRuleSanctionRejectedError,
    );
    await expect(
      service.createBotModerationEvent({ data: { ...source, action: 'WARN' } }),
    ).rejects.toBeInstanceOf(ModerationRuleSanctionRejectedError);
    expect(create).not.toHaveBeenCalled();
    expect(consumeForMessage).not.toHaveBeenCalled();
    expect(underLock).not.toHaveBeenCalled();

    await service.createBotModerationEvent({
      data: { ...source, userId: 'independent', action: 'WARN' },
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(
      await service.consumeChatParticipantModerationImmunity({
        ...source,
        userId: 'independent',
        nightModeTimezone: 'UTC',
      }),
    ).toBe(true);
    expect(consumeForMessage).toHaveBeenCalledTimes(1);
  });

  it('fails closed on a global-user hold reader outage before any local event', async () => {
    const { service, create, legacyHolds } = fixture();
    legacyHolds.isMemberHeld.mockResolvedValue(false);
    legacyHolds.isGlobalUserHeld.mockRejectedValue(new Error('Global hold reader unavailable'));
    await expect(
      service.createBotModerationEvent({
        data: { chatId: 'other-chat', userId: 'held', messageId: 'fresh', action: 'WARN' },
      }),
    ).rejects.toThrow('Global hold reader unavailable');
    expect(create).not.toHaveBeenCalled();
  });

  it('stops automatic detection for a globally held author and admits an independent author', async () => {
    const { service, detect, legacyHolds } = messageFixture();
    await service.handleUpdate(createUpdate());
    expect(legacyHolds.isMemberHeld).toHaveBeenCalledWith('chat-1', 'user-1');
    expect(legacyHolds.isGlobalUserHeld).toHaveBeenCalledWith('user-1');
    expect(detect).not.toHaveBeenCalled();
    const independent = createUpdate();
    independent.message!.senderId = 'independent';
    await service.handleUpdate(independent);
    expect(detect).toHaveBeenCalledTimes(1);
  });

  it('preserves explicit admin command admission for an author held only in another chat', async () => {
    const { service, detect, legacyHolds, admin, adminCommand } = messageFixture();
    admin.mockResolvedValue({ isAdmin: true, source: 'remote' });
    const source = createUpdate();
    source.message!.text = 'тишина выкл';
    await service.handleUpdate(source);
    expect(adminCommand).toHaveBeenCalledWith(expect.objectContaining({ senderId: 'user-1' }));
    expect(legacyHolds.isGlobalUserHeld).not.toHaveBeenCalled();
    expect(detect).not.toHaveBeenCalled();
  });

  it('preserves an explicit callback before any global automatic admission check', async () => {
    const { service, detect, legacyHolds } = messageFixture();
    const tryHandleCallback = jest.fn().mockResolvedValue(true);
    Object.assign(service, { managedPollService: { tryHandleCallback } });
    const callback = createUpdate();
    callback.type = 'message_callback';
    await service.handleUpdate(callback);
    expect(tryHandleCallback).toHaveBeenCalledWith(callback);
    expect(legacyHolds.isGlobalUserHeld).not.toHaveBeenCalled();
    expect(detect).not.toHaveBeenCalled();
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
