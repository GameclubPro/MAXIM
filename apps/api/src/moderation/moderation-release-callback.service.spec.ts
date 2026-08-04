import type { MaxUpdate } from '@maxim/contracts';
import { SanctionAction } from '../prisma/prisma-client';
import { ModerationReleaseCallbackService } from './moderation-release-callback.service';
import { buildModerationReleaseCallbackPayload } from './moderation-release-callback.util';

const SANCTION_EVENT_ID = 'sanction-event-1';

function createCallbackUpdate(params: {
  action: 'UNBAN' | 'UNMUTE';
  sanctionEventId?: string;
  actorUserId?: string;
}): MaxUpdate {
  return {
    updateId: 'update-release-1',
    botId: 'bot-1',
    type: 'message_callback',
    message: {
      messageId: 'message-release-1',
      chatId: 'chat-1',
      chatTitle: 'Chat 1',
      senderId: 'bot-1',
      senderName: 'Major Maximov',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'message_callback',
      callback: {
        callback_id: 'callback-release-1',
        payload: buildModerationReleaseCallbackPayload(
          params.action,
          params.sanctionEventId ?? SANCTION_EVENT_ID,
        ),
        user: {
          user_id: params.actorUserId ?? 'admin-1',
        },
      },
      message: {
        recipient: {
          chat_id: 'chat-1',
        },
      },
    },
  };
}

function createSanctionEvent(
  overrides: Partial<{
    id: string;
    action: SanctionAction;
    metadata: Record<string, unknown>;
  }> = {},
) {
  return {
    id: overrides.id ?? SANCTION_EVENT_ID,
    chatId: 'chat-1',
    userId: 'target-user-1',
    action: overrides.action ?? SanctionAction.BAN,
    ruleCode: overrides.action === SanctionAction.MUTE ? 'AUTO_MUTE' : 'AUTO_BAN',
    metadata: overrides.metadata ?? {},
    createdAt: new Date('2026-08-04T08:00:00.000Z'),
  };
}

function createHarness(
  params: {
    sanctionEvent?: ReturnType<typeof createSanctionEvent>;
    latestEventId?: string;
    actorIsAdmin?: boolean;
  } = {},
) {
  const sanctionEvent = params.sanctionEvent ?? createSanctionEvent();
  const prisma = {
    moderationEvent: {
      findUnique: jest.fn().mockResolvedValue(sanctionEvent),
      findFirst: jest.fn().mockResolvedValue({
        id: params.latestEventId ?? sanctionEvent.id,
      }),
    },
  };
  const maxClient = {
    getChatMemberAccess: jest.fn().mockResolvedValue({
      userId: params.actorIsAdmin === false ? 'member-1' : 'admin-1',
      isAdmin: params.actorIsAdmin !== false,
      isOwner: false,
      permissions: [],
    }),
    answerCallback: jest.fn().mockResolvedValue(undefined),
  };
  const manualModeration = {
    applyManualModerationAction: jest.fn().mockResolvedValue({
      ok: true,
      action: sanctionEvent.action === SanctionAction.BAN ? 'UNBAN' : 'UNMUTE',
      userId: sanctionEvent.userId,
      muteDurationHours: null,
      muteExpiresAt: null,
      message: sanctionEvent.action === SanctionAction.BAN ? 'Блокировка снята' : 'Мут снят',
    }),
  };
  const service = new ModerationReleaseCallbackService(
    prisma as never,
    maxClient as never,
    manualModeration as never,
  );

  return { service, prisma, maxClient, manualModeration };
}

describe('ModerationReleaseCallbackService', () => {
  it('releases the sanction referenced by the exact moderation event ID', async () => {
    const { service, prisma, maxClient, manualModeration } = createHarness();

    await expect(
      service.tryHandle(
        createCallbackUpdate({ action: 'UNBAN', sanctionEventId: SANCTION_EVENT_ID }),
      ),
    ).resolves.toBe(true);

    expect(prisma.moderationEvent.findUnique).toHaveBeenCalledWith({
      where: { id: SANCTION_EVENT_ID },
      select: {
        id: true,
        chatId: true,
        userId: true,
        action: true,
        ruleCode: true,
        metadata: true,
        createdAt: true,
      },
    });
    expect(prisma.moderationEvent.findFirst).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-1',
        userId: 'target-user-1',
        OR: [
          { action: { in: [SanctionAction.BAN, SanctionAction.MUTE] } },
          { ruleCode: { in: ['MANUAL_UNBAN', 'MANUAL_UNMUTE'] } },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
    expect(manualModeration.applyManualModerationAction).toHaveBeenCalledWith(
      'chat-1',
      'target-user-1',
      expect.objectContaining({
        userId: 'admin-1',
        launchBotId: 'bot-1',
        chatId: 'chat-1',
      }),
      { action: 'UNBAN' },
      'group_command',
      {
        actorAlreadyVerified: true,
        allowTargetDisplayNameRemoteLookup: false,
        expectedSanctionEventId: SANCTION_EVENT_ID,
      },
    );
    expect(maxClient.answerCallback).toHaveBeenCalledWith(
      'callback-release-1',
      'Блокировка снята',
      undefined,
      {
        ignoreFailureMetricStatuses: [400, 404],
        botId: 'bot-1',
      },
    );
  });

  it('rejects an old ban button after a newer ban was recorded', async () => {
    const { service, maxClient, manualModeration } = createHarness({
      latestEventId: 'sanction-event-2',
    });

    await service.tryHandle(createCallbackUpdate({ action: 'UNBAN' }));

    expect(manualModeration.applyManualModerationAction).not.toHaveBeenCalled();
    expect(maxClient.answerCallback).toHaveBeenCalledWith(
      'callback-release-1',
      'Санкция уже снята или изменилась',
      undefined,
      {
        ignoreFailureMetricStatuses: [400, 404],
        botId: 'bot-1',
      },
    );
  });

  it('rejects an expired mute button', async () => {
    const { service, prisma, maxClient, manualModeration } = createHarness({
      sanctionEvent: createSanctionEvent({
        action: SanctionAction.MUTE,
        metadata: { muteExpiresAt: '2020-01-01T00:00:00.000Z', mutePermanent: false },
      }),
    });

    await service.tryHandle(createCallbackUpdate({ action: 'UNMUTE' }));

    expect(prisma.moderationEvent.findFirst).not.toHaveBeenCalled();
    expect(manualModeration.applyManualModerationAction).not.toHaveBeenCalled();
    expect(maxClient.answerCallback).toHaveBeenCalledWith(
      'callback-release-1',
      'Санкция уже снята или изменилась',
      undefined,
      {
        ignoreFailureMetricStatuses: [400, 404],
        botId: 'bot-1',
      },
    );
  });

  it.each([
    ['permanent', { mutePermanent: true, muteExpiresAt: null }],
    ['future', { mutePermanent: false, muteExpiresAt: '2999-01-01T00:00:00.000Z' }],
  ] as const)('accepts a %s active mute', async (_caseName, metadata) => {
    const { service, manualModeration } = createHarness({
      sanctionEvent: createSanctionEvent({
        action: SanctionAction.MUTE,
        metadata,
      }),
    });

    await service.tryHandle(createCallbackUpdate({ action: 'UNMUTE' }));

    expect(manualModeration.applyManualModerationAction).toHaveBeenCalledWith(
      'chat-1',
      'target-user-1',
      expect.objectContaining({ userId: 'admin-1' }),
      { action: 'UNMUTE' },
      'group_command',
      expect.objectContaining({ expectedSanctionEventId: SANCTION_EVENT_ID }),
    );
  });

  it('answers a regular member with an empty ACK and performs no release work', async () => {
    const { service, prisma, maxClient, manualModeration } = createHarness({
      actorIsAdmin: false,
    });

    await service.tryHandle(createCallbackUpdate({ action: 'UNBAN', actorUserId: 'member-1' }));

    expect(prisma.moderationEvent.findUnique).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.findFirst).not.toHaveBeenCalled();
    expect(manualModeration.applyManualModerationAction).not.toHaveBeenCalled();
    expect(maxClient.answerCallback).toHaveBeenCalledTimes(1);
    expect(maxClient.answerCallback).toHaveBeenCalledWith(
      'callback-release-1',
      undefined,
      undefined,
      {
        ignoreFailureMetricStatuses: [400, 404],
        botId: 'bot-1',
      },
    );
  });
});
