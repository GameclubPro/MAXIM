import { PublisherAutoReplyAuthoringState } from '../prisma/prisma-client';
import { PublisherAutoReplyAuthoringDeliveryService } from './publisher-auto-reply-authoring-delivery.service';

function notificationSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-1',
    publisherBotId: 'publik_bot',
    actorUserId: '42',
    startToken: 'token-1',
    targetChatId: '-100500',
    state: PublisherAutoReplyAuthoringState.REVIEW,
    phrase: 'Каталог',
    triggerPhrases: ['Каталог'],
    matchInContext: false,
    fuzzyMatch: false,
    failureCode: null,
    privateChatId: '42',
    botStatusMessageId: null,
    notificationPending: true,
    notificationKind: 'ready',
    notificationRevision: 7,
    notificationLockedAt: null,
    notificationLockToken: null,
    notificationDispatchStartedAt: null,
    rule: {
      currentContentRevision: {
        text: '**Ответ**',
        textFormat: 'markdown',
        buttons: [],
        _count: { assets: 2 },
      },
    },
    ...overrides,
  };
}

const readyJob = {
  version: 1 as const,
  kind: 'notify' as const,
  sessionId: 'session-1',
  notification: 'ready' as const,
  requestedAt: '2026-08-29T12:00:00.000Z',
};

describe('PublisherAutoReplyAuthoringDeliveryService', () => {
  it('sends a new bot message instead of editing the previous authoring status', async () => {
    const updateMany = jest
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    const prisma = {
      publisherAutoReplyAuthoringSession: {
        findUnique: jest.fn().mockResolvedValue(
          notificationSession({
            state: PublisherAutoReplyAuthoringState.AWAITING_CONTENT,
            notificationKind: 'prompt_content',
            botStatusMessageId: 'previous-status-mid',
          }),
        ),
        updateMany,
      },
    };
    const maxClient = {
      answerCallback: jest.fn().mockResolvedValue(undefined),
      editMessageInlineKeyboard: jest.fn(),
      sendMessageImmediateWithId: jest
        .fn()
        .mockImplementation(
          async (_chatId: string, _text: string, options: { beforeSend?: () => Promise<void> }) => {
            await options.beforeSend?.();
            return { messageId: 'new-status-mid' };
          },
        ),
    };
    const service = new PublisherAutoReplyAuthoringDeliveryService(
      prisma as never,
      maxClient as never,
    );

    await expect(
      service.deliver({
        ...readyJob,
        notification: 'prompt_content',
        callbackId: 'callback-1',
      }),
    ).resolves.toBeUndefined();

    expect(maxClient.answerCallback).toHaveBeenCalledWith(
      'callback-1',
      'Готово',
      undefined,
      expect.objectContaining({ rateLimitEntityId: '42' }),
    );
    expect(maxClient.editMessageInlineKeyboard).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(1);
    const [chatId, text] = maxClient.sendMessageImmediateWithId.mock.calls[0] ?? [];
    expect(chatId).toBe('42');
    expect(text).toBe(
      'Фраза «Каталог» сохранена. Пришлите одним сообщением ответ, который Публик будет отправлять участникам. Можно использовать форматирование и добавить до 10 фото. Кнопки-ссылки можно добавить после сохранения в мини-приложении.',
    );
    expect(updateMany.mock.calls[2]?.[0]).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({ botStatusMessageId: 'new-status-mid' }),
      }),
    );
  });

  it('explains the fuzzy minimum while keeping the phrase step active', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      publisherAutoReplyAuthoringSession: {
        findUnique: jest.fn().mockResolvedValue(
          notificationSession({
            state: PublisherAutoReplyAuthoringState.AWAITING_PHRASE,
            phrase: null,
            triggerPhrases: [],
            fuzzyMatch: true,
            failureCode: 'fuzzy_phrase_too_short',
            notificationKind: 'prompt_phrase',
          }),
        ),
        updateMany,
      },
    };
    const maxClient = {
      sendMessageImmediateWithId: jest
        .fn()
        .mockImplementation(
          async (_chatId: string, _text: string, options: { beforeSend?: () => Promise<void> }) => {
            await options.beforeSend?.();
            return { messageId: 'fuzzy-minimum-status-mid' };
          },
        ),
    };
    const service = new PublisherAutoReplyAuthoringDeliveryService(
      prisma as never,
      maxClient as never,
    );

    await expect(
      service.deliver({ ...readyJob, notification: 'prompt_phrase' }),
    ).resolves.toBeUndefined();

    expect(maxClient.sendMessageImmediateWithId.mock.calls[0]?.[1]).toBe(
      'Для учёта опечаток каждая фраза должна содержать не меньше 5 букв или цифр. Отправьте другой набор.',
    );
  });

  it('does not clear a newer notification revision after an older send completes', async () => {
    const updateMany = jest
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    const prisma = {
      publisherAutoReplyAuthoringSession: {
        findUnique: jest.fn().mockResolvedValue(notificationSession()),
        updateMany,
      },
    };
    const maxClient = {
      sendMessageImmediateWithId: jest
        .fn()
        .mockImplementation(
          async (_chatId: string, _text: string, options: { beforeSend?: () => Promise<void> }) => {
            await options.beforeSend?.();
            return { messageId: 'status-mid-1' };
          },
        ),
    };
    const service = new PublisherAutoReplyAuthoringDeliveryService(
      prisma as never,
      maxClient as never,
    );

    await expect(service.deliver(readyJob)).resolves.toBeUndefined();

    expect(updateMany.mock.calls[2]?.[0]).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'session-1',
          notificationKind: 'ready',
          notificationRevision: 7,
        }),
        data: expect.objectContaining({ notificationPending: false, notificationKind: null }),
      }),
    );
    const supersededRelease = updateMany.mock.calls[3]?.[0];
    expect(supersededRelease.where).toEqual({
      id: 'session-1',
      notificationLockToken: expect.any(String),
      notificationClaimRevision: 7,
    });
    expect(supersededRelease.data).toEqual({
      notificationLockedAt: null,
      notificationLockToken: null,
      notificationClaimRevision: null,
      notificationDispatchStartedAt: null,
      botStatusMessageId: 'status-mid-1',
    });
    expect(supersededRelease.data).not.toHaveProperty('notificationPending');
    expect(supersededRelease.data).not.toHaveProperty('notificationKind');
  });

  it('renders multiline phrases and independent mode toggles in the review notification', async () => {
    const updateMany = jest
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    const prisma = {
      publisherAutoReplyAuthoringSession: {
        findUnique: jest.fn().mockResolvedValue(
          notificationSession({
            triggerPhrases: ['Каталог', 'Стоимость'],
            matchInContext: true,
            fuzzyMatch: true,
          }),
        ),
        updateMany,
      },
    };
    const maxClient = {
      sendMessageImmediateWithId: jest
        .fn()
        .mockImplementation(
          async (_chatId: string, _text: string, options: { beforeSend?: () => Promise<void> }) => {
            await options.beforeSend?.();
            return { messageId: 'review-status-mid' };
          },
        ),
    };
    const service = new PublisherAutoReplyAuthoringDeliveryService(
      prisma as never,
      maxClient as never,
    );

    await expect(service.deliver(readyJob)).resolves.toBeUndefined();

    const [, text, options] = maxClient.sendMessageImmediateWithId.mock.calls[0] ?? [];
    expect(text).toBe(
      'Автоответ готов. 2 фразы: «Каталог», «Стоимость». Фото: 2. Режим: поиск внутри сообщения, учёт опечаток.',
    );
    expect(options.buttons).toEqual([
      [expect.objectContaining({ text: 'Включить', payload: 'ar:activate:token-1' })],
      [
        expect.objectContaining({ text: 'В тексте: да', payload: 'ar:toggle_context:token-1' }),
        expect.objectContaining({ text: 'Опечатки: да', payload: 'ar:toggle_fuzzy:token-1' }),
      ],
      [
        expect.objectContaining({ text: 'Изменить фразы' }),
        expect.objectContaining({ text: 'Заменить ответ' }),
      ],
      [expect.objectContaining({ text: 'Отмена' })],
    ]);
  });

  it.each([
    [
      'trigger_capacity',
      'В чате достигнут лимит фраз автоответов. Уменьшите набор или удалите другой автоответ в Публике.',
    ],
    [
      'fuzzy_trigger_capacity',
      'Достигнут лимит фраз с учётом опечаток. Отключите «Опечатки» или уменьшите набор фраз.',
    ],
  ])('renders an actionable %s review warning', async (failureCode, warning) => {
    const updateMany = jest
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    const prisma = {
      publisherAutoReplyAuthoringSession: {
        findUnique: jest.fn().mockResolvedValue(notificationSession({ failureCode })),
        updateMany,
      },
    };
    const maxClient = {
      sendMessageImmediateWithId: jest
        .fn()
        .mockImplementation(
          async (_chatId: string, _text: string, options: { beforeSend?: () => Promise<void> }) => {
            await options.beforeSend?.();
            return { messageId: 'capacity-status-mid' };
          },
        ),
    };
    const service = new PublisherAutoReplyAuthoringDeliveryService(
      prisma as never,
      maxClient as never,
    );

    await expect(service.deliver(readyJob)).resolves.toBeUndefined();

    expect(maxClient.sendMessageImmediateWithId.mock.calls[0]?.[1]).toContain(warning);
  });

  it('quarantines an attempted send as ambiguous instead of retrying it', async () => {
    const updateMany = jest
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    const prisma = {
      publisherAutoReplyAuthoringSession: {
        findUnique: jest.fn().mockResolvedValue(notificationSession()),
        updateMany,
      },
    };
    const maxClient = {
      sendMessageImmediateWithId: jest
        .fn()
        .mockImplementation(
          async (_chatId: string, _text: string, options: { beforeSend?: () => Promise<void> }) => {
            await options.beforeSend?.();
            throw new Error('transport timed out after dispatch');
          },
        ),
    };
    const service = new PublisherAutoReplyAuthoringDeliveryService(
      prisma as never,
      maxClient as never,
    );

    await expect(service.deliver(readyJob)).resolves.toBeUndefined();

    expect(updateMany).toHaveBeenCalledTimes(3);
    expect(updateMany.mock.calls[2]?.[0]).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'session-1',
          state: PublisherAutoReplyAuthoringState.REVIEW,
          notificationKind: 'ready',
          notificationRevision: 7,
          notificationClaimRevision: 7,
        }),
        data: {
          notificationPending: false,
          notificationKind: null,
          notificationLockedAt: null,
          notificationLockToken: null,
          notificationClaimRevision: null,
          notificationLastAmbiguousRevision: 7,
          notificationDispatchStartedAt: null,
        },
      }),
    );
  });
});
