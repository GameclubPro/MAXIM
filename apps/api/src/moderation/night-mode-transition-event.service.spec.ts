import { EventType, Operator, SanctionAction } from '../prisma/prisma-client';
import { NightModeTransitionEventService } from './night-mode-transition-event.service';

function createService(
  params: {
    botId?: string | null;
    activeBotId?: string | null;
    create?: jest.Mock;
    findFirst?: jest.Mock;
  } = {},
) {
  const create = params.create ?? jest.fn().mockResolvedValue({});
  const findFirst = params.findFirst ?? jest.fn().mockResolvedValue(null);
  const executeRaw = jest.fn().mockResolvedValue(0);
  const moderationEvent = {
    create,
    findFirst,
  };
  const transaction = jest.fn(async (operation: (tx: unknown) => Promise<unknown>) =>
    operation({ moderationEvent, $executeRaw: executeRaw }),
  );
  const service = new NightModeTransitionEventService(
    {
      moderationEvent,
      $transaction: transaction,
    } as never,
    {
      get: jest.fn().mockReturnValue(params.botId),
    } as never,
    {
      getActiveBotId: jest.fn().mockReturnValue(params.activeBotId ?? null),
    } as never,
  );
  return { service, create, findFirst, executeRaw, transaction };
}

function extractSqlText(query: unknown): string {
  const strings = (query as { strings?: readonly string[] } | null)?.strings;
  return Array.isArray(strings) ? strings.join(' ') : String(query);
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

  it('returns an exact existing close event without creating a duplicate', async () => {
    const findFirst = jest.fn().mockResolvedValue({ id: 'event-existing-1' });
    const { service, create, executeRaw, transaction } = createService({ findFirst });

    await expect(
      service.ensureTransitionEvent({
        chatId: ' chat-1 ',
        messageId: ' message-close-1 ',
        botId: ' bot-1 ',
        ruleCode: 'NIGHT_MODE_CLOSE_NOTICE',
        sessionKey: ' session-1 ',
        timezone: 'Europe/Moscow',
        startMinutes: 23 * 60,
        endMinutes: 8 * 60,
      }),
    ).resolves.toEqual({ id: 'event-existing-1' });

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-1',
        messageId: 'message-close-1',
        botId: 'bot-1',
        ruleCode: 'NIGHT_MODE_CLOSE_NOTICE',
        metadata: {
          path: ['sessionKey'],
          equals: 'session-1',
        },
      },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(extractSqlText(executeRaw.mock.calls[0]?.[0])).toContain(
      'pg_advisory_xact_lock(hashtextextended(',
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('creates and returns a missing exact close event', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'event-created-1' });
    const { service } = createService({ create });

    await expect(
      service.ensureTransitionEvent({
        chatId: 'chat-1',
        messageId: 'message-close-1',
        botId: 'bot-1',
        ruleCode: 'NIGHT_MODE_CLOSE_NOTICE',
        sessionKey: 'session-1',
        timezone: 'Europe/Moscow',
        startMinutes: 23 * 60,
        endMinutes: 8 * 60,
      }),
    ).resolves.toEqual({ id: 'event-created-1' });

    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        messageId: 'message-close-1',
        botId: 'bot-1',
        ruleCode: 'NIGHT_MODE_CLOSE_NOTICE',
      }),
      select: { id: true },
    });
  });

  it('serializes overlapping exact ensures so a lost Redis lease cannot duplicate the event', async () => {
    let storedEvent: { id: string } | null = null;
    const findFirst = jest.fn(async () => storedEvent);
    const create = jest.fn(async () => {
      storedEvent = { id: 'event-serialized-1' };
      return storedEvent;
    });
    const executeRaw = jest.fn().mockResolvedValue(0);
    const tx = {
      moderationEvent: { findFirst, create },
      $executeRaw: executeRaw,
    };
    let transactionTail = Promise.resolve();
    const transaction = jest.fn(async (operation: (client: typeof tx) => Promise<unknown>) => {
      const predecessor = transactionTail;
      let release: () => void = () => undefined;
      transactionTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await predecessor;
      try {
        return await operation(tx);
      } finally {
        release();
      }
    });
    const service = new NightModeTransitionEventService({
      moderationEvent: tx.moderationEvent,
      $transaction: transaction,
    } as never);
    const params = {
      chatId: 'chat-1',
      messageId: 'message-close-1',
      botId: 'bot-1',
      ruleCode: 'NIGHT_MODE_CLOSE_NOTICE' as const,
      sessionKey: 'session-1',
      timezone: 'Europe/Moscow',
      startMinutes: 23 * 60,
      endMinutes: 8 * 60,
    };

    await expect(
      Promise.all([service.ensureTransitionEvent(params), service.ensureTransitionEvent(params)]),
    ).resolves.toEqual([{ id: 'event-serialized-1' }, { id: 'event-serialized-1' }]);

    expect(transaction).toHaveBeenCalledTimes(2);
    expect(executeRaw).toHaveBeenCalledTimes(2);
    expect(findFirst).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
