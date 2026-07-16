import { EventType, Operator, SanctionAction } from '../prisma/prisma-client';
import { NightModeTransitionEventService } from './night-mode-transition-event.service';

function createService(
  params: {
    botId?: string | null;
    activeBotId?: string | null;
    create?: jest.Mock;
  } = {},
) {
  const create = params.create ?? jest.fn().mockResolvedValue({});
  const service = new NightModeTransitionEventService(
    {
      moderationEvent: {
        create,
      },
    } as never,
    {
      get: jest.fn().mockReturnValue(params.botId),
    } as never,
    {
      getActiveBotId: jest.fn().mockReturnValue(params.activeBotId ?? null),
    } as never,
  );
  return { service, create };
}

describe('NightModeTransitionEventService', () => {
  it('creates a close transition moderation event with legacy metadata shape', async () => {
    const { service, create } = createService({
      botId: ' bot-main ',
      activeBotId: 'runtime-bot-1',
    });

    await service.createTransitionEvent({
      chatId: 'chat-1',
      messageId: 'message-close-1',
      botId: ' origin-bot-2 ',
      ruleCode: 'NIGHT_MODE_CLOSE_NOTICE',
      sessionKey: 'session-1',
      timezone: 'Europe/Moscow',
      startMinutes: 23 * 60,
      endMinutes: 8 * 60,
    });

    expect(create).toHaveBeenCalledWith({
      data: {
        chatId: 'chat-1',
        userId: 'bot-main',
        messageId: 'message-close-1',
        eventType: EventType.SYSTEM,
        ruleCode: 'NIGHT_MODE_CLOSE_NOTICE',
        action: SanctionAction.NONE,
        maskedExcerpt: null,
        score: 0.1,
        operator: Operator.BOT,
        botId: 'origin-bot-2',
        metadata: {
          reason: 'Night mode close notice sent by schedule',
          sessionKey: 'session-1',
          nightModeTimezone: 'Europe/Moscow',
          nightModeStartTime: '23:00',
          nightModeEndTime: '08:00',
        },
      },
    });
  });

  it('creates an open transition event, falls back to bot user id, and formats invalid minutes safely', async () => {
    const { service, create } = createService({
      botId: '',
      activeBotId: null,
    });

    await service.createTransitionEvent({
      chatId: 'chat-1',
      messageId: null,
      ruleCode: 'NIGHT_MODE_OPEN_NOTICE',
      sessionKey: 'session-2',
      timezone: 'Asia/Yekaterinburg',
      startMinutes: -1,
      endMinutes: 1_440,
    });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'bot',
        messageId: null,
        eventType: EventType.SYSTEM,
        ruleCode: 'NIGHT_MODE_OPEN_NOTICE',
        action: SanctionAction.NONE,
        maskedExcerpt: null,
        score: 0.1,
        operator: Operator.BOT,
        metadata: {
          reason: 'Night mode open notice sent by schedule',
          sessionKey: 'session-2',
          nightModeTimezone: 'Asia/Yekaterinburg',
          nightModeStartTime: '00:00',
          nightModeEndTime: '00:00',
        },
      }),
    });
    expect(create.mock.calls[0]?.[0].data).not.toHaveProperty('botId');
  });
});
