import type { MaxUpdate } from '@maxim/contracts';
import { SanctionAction } from '@prisma/client';
import { ModerationService } from './moderation.service';

function createSettings(overrides: Record<string, unknown> = {}) {
  return {
    id: 'settings-1',
    chatId: 'chat-1',
    profanityLevel: 'MEDIUM',
    capsThreshold: 70,
    floodWindowSec: 10,
    floodMaxMessages: 5,
    duplicateWindowSec: 60,
    duplicateMaxCount: 3,
    duplicateWarnEnabled: true,
    duplicateKickEnabled: true,
    duplicateBanEnabled: true,
    duplicateWarnWindowSec: 12 * 60 * 60,
    duplicateWarnMaxCount: 2,
    duplicateKickWindowSec: 24 * 60 * 60,
    duplicateKickMaxCount: 3,
    duplicateBanWindowSec: 48 * 60 * 60,
    duplicateBanMaxCount: 4,
    linkPolicy: 'ALLOWLIST_ONLY',
    linkBotMessageEnabled: true,
    duplicateBotMessageEnabled: false,
    warnThreshold: 3,
    repeatBanWindowDays: 7,
    logRetentionDays: 90,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function createUpdate(): MaxUpdate {
  return {
    updateId: 'upd-1',
    type: 'message_created',
    message: {
      messageId: 'msg-1',
      chatId: 'chat-1',
      senderId: 'user-1',
      text: 'same text',
      createdAt: new Date().toISOString(),
    },
    raw: {},
  };
}

function createOldUpdate(): MaxUpdate {
  return {
    updateId: 'upd-old-1',
    type: 'message_created',
    message: {
      messageId: 'msg-old-1',
      chatId: 'chat-1',
      senderId: 'user-1',
      text: 'old text',
      createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    },
    raw: {},
  };
}

describe('ModerationService', () => {
  it('handles duplicate escalation separately and does not call SanctionService', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings(),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [],
        duplicateDecision: {
          action: 'KICK',
          count: 3,
          threshold: 3,
          windowSec: 24 * 60 * 60,
          hash: 'abc123',
          nextAction: 'BAN',
        },
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createUpdate());

    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-1');
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(maxClient.kickMember).toHaveBeenCalledWith('chat-1', 'user-1');
    expect(maxClient.banMember).not.toHaveBeenCalled();

    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(2);
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'msg-1',
        ruleCode: 'DUPLICATE_DELETE',
        action: SanctionAction.DELETE_MESSAGE,
      }),
    });
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'msg-1',
        ruleCode: 'DUPLICATE_KICK',
        action: SanctionAction.KICK,
        metadata: expect.objectContaining({
          windowSec: 24 * 60 * 60,
          count: 3,
          threshold: 3,
          nextStep: 'BAN',
        }),
      }),
    });
  });

  it('sends duplicate explanation when duplicate bot toggle is enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ duplicateBotMessageEnabled: true }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [],
        duplicateDecision: {
          action: 'WARN',
          count: 2,
          threshold: 2,
          windowSec: 12 * 60 * 60,
          hash: 'dup-hash-1',
          nextAction: 'KICK',
        },
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createUpdate());

    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-1');
    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      expect.stringContaining('Дубли сообщений: пользователь user-1.'),
    );
  });

  it('keeps legacy sanction flow for non-duplicate violations', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings(),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'LINK_BLOCKED', score: 0.9, reason: 'Link detected' }],
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn().mockResolvedValue(SanctionAction.WARN),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createUpdate());

    expect(prisma.violation.create).toHaveBeenCalledTimes(1);
    expect(sanctionService.resolveAction).toHaveBeenCalledTimes(1);
    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      'Сообщение пользователя user-1 удалено: ссылки в этом чате ограничены.',
    );
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(2);
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        ruleCode: 'LINK_BLOCKED_DELETE',
        action: SanctionAction.DELETE_MESSAGE,
      }),
    });
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'LINK_BLOCKED',
        action: SanctionAction.WARN,
      }),
    });
  });

  it('does not send link explanation when link bot toggle is disabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ linkBotMessageEnabled: false }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'LINK_BLOCKED', score: 0.9, reason: 'Link detected' }],
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn().mockResolvedValue(SanctionAction.WARN),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createUpdate());

    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-1');
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(2);
  });

  it('sends link explanation for old messages when link bot toggle is enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ linkBotMessageEnabled: true }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'LINK_BLOCKED', score: 0.9, reason: 'Link detected' }],
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn().mockResolvedValue(SanctionAction.WARN),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createOldUpdate());

    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.notifyModerators).toHaveBeenCalledTimes(1);
    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      'Сообщение пользователя user-1 нарушает правила: ссылки в этом чате ограничены.',
    );
  });

  it('still sends duplicate explanation when message deletion fails', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ duplicateBotMessageEnabled: true }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [],
        duplicateDecision: {
          action: 'WARN',
          count: 2,
          threshold: 2,
          windowSec: 12 * 60 * 60,
          hash: 'hash-1',
          nextAction: 'KICK',
        },
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn().mockRejectedValue(new Error('delete failed')),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createUpdate());

    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-1');
    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'msg-1',
        ruleCode: 'DUPLICATE_WARN',
        action: SanctionAction.WARN,
      }),
    });
  });
});
