import { MaxActionNoExecutableRouteError } from '../max/max-action-dispatch-error';
import { NightModeTransitionDeliveryService } from './night-mode-transition-delivery.service';
import type { NightModeTransitionDeliveryAdapters } from './night-mode-transition-delivery.service';
import { NightModeTransitionNoticeEventPersistenceError } from './night-mode-transition-notice-persistence-error';
import type { NightModeTransitionRuntimeSettings } from './night-mode-transition-runtime.service';

function createMaxApiError(status: number, message: string, code?: string): Error {
  return Object.assign(new Error(message), {
    response: {
      status,
      data: code ? { code, message } : { message },
    },
  });
}

function createSettings(
  overrides: Partial<NightModeTransitionRuntimeSettings> = {},
): NightModeTransitionRuntimeSettings {
  return {
    chatId: 'chat-1',
    nightModeEnabled: true,
    nightModeStartTimeMinutes: 23 * 60,
    nightModeEndTimeMinutes: 8 * 60,
    nightModeTimezone: 'Europe/Moscow',
    nightModeBotMessageEnabled: true,
    nightModeBotMessageText: '',
    nightModeCommentsEnabled: false,
    nightModeOpenMessageEnabled: true,
    nightModeOpenMessageText: '',
    nightModeBotButtons: null,
    nightModeBotButtonEnabled: false,
    nightModeBotButtonUrl: '',
    nightModeBotButtonText: '',
    nightModeRulesButtonEnabled: false,
    commentsEnabled: false,
    botSpeechStyle: 'ROBOT',
    botSpeechMedia: null,
    chat: {
      rules: null,
    },
    ...overrides,
  };
}

function createAdapters(
  overrides: Partial<NightModeTransitionDeliveryAdapters> = {},
): NightModeTransitionDeliveryAdapters {
  return {
    getBotSpeechProfile: jest.fn((botId?: string | null) =>
      botId === 'bot-survivor'
        ? {
            persona: 'female',
            characterName: 'Майор Максимова',
          }
        : {
            persona: 'male',
            characterName: 'Майор Максимов',
          },
    ),
    buildClosedNoticeOptions: jest.fn().mockReturnValue({
      buttons: [[{ type: 'link', text: 'Комментарии', url: 'https://example.test' }]],
    }),
    resolveBotId: jest.fn().mockResolvedValue('bot-1'),
    ...overrides,
  };
}

function createEventService() {
  return {
    createTransitionEvent: jest.fn().mockResolvedValue(undefined),
  };
}

describe('NightModeTransitionDeliveryService', () => {
  it('routes a scheduled close notice with a stable session key and bot-scoped media preparation', async () => {
    const maxClient = {
      sendMessageImmediateWithId: jest.fn(),
      deleteMessage: jest.fn(),
    };
    const botSpeechMediaService = {
      resolveMedia: jest.fn().mockReturnValue({
        base64: 'aW1hZ2U=',
        mimeType: 'image/png',
        fileName: 'night.png',
        fieldKey: 'nightModeBotMessageText',
      }),
      withMediaOptions: jest.fn(async (options) => ({
        ...(options ?? {}),
        imagePayload: { token: 'survivor-upload' },
      })),
    };
    const maxRoutedPublicationService = {
      publish: jest.fn().mockImplementation(async (request: any) => {
        const job = { idempotencyKey: request.logicalIdempotencyKey };
        const prepared = await request.prepareAttempt({ botId: 'bot-survivor', job });
        expect(prepared).toEqual(
          expect.objectContaining({
            text: 'Майор Максимова: Новые сообщения временно не принимаются.',
          }),
        );
        expect(prepared).toEqual({
          text: 'Майор Максимова: Новые сообщения временно не принимаются.',
          options: expect.objectContaining({
            textFormat: 'markdown',
            imagePayload: { token: 'survivor-upload' },
          }),
        });
        request.onDispatchAttempt({ botId: 'bot-survivor', job: { ...job, ...prepared } });
        return {
          messageId: 'msg-routed-close-1',
          url: null,
          botId: 'bot-survivor',
          candidateBotIds: ['bot-primary', 'bot-survivor'],
          routingVersion: 11,
        };
      }),
    };
    const eventService = createEventService();
    const service = new NightModeTransitionDeliveryService(
      maxClient as never,
      botSpeechMediaService as never,
      eventService as never,
      undefined,
      maxRoutedPublicationService as never,
    );
    const adapters = createAdapters();

    await expect(
      service.sendClosedNotice(
        createSettings({
          nightModeBotMessageText: '{bot_character_name}: {night_status}',
        }),
        {
          startMinutes: 23 * 60,
          endMinutes: 8 * 60,
          timezone: 'Europe/Moscow',
          sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-07-11',
        },
        adapters,
      ),
    ).resolves.toEqual({
      shouldEnqueueNext: true,
      messageId: 'msg-routed-close-1',
      botId: 'bot-survivor',
    });

    expect(maxRoutedPublicationService.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: 'chat-1',
        logicalIdempotencyKey:
          'night-mode:close:chat-1:session:v1:Europe/Moscow:23:00:08:00:2026-07-11',
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: 'night_mode_transition',
        ignoreFailureMetricStatuses: [403, 404],
      }),
    );
    expect(botSpeechMediaService.withMediaOptions).toHaveBeenCalledWith(
      expect.objectContaining({ textFormat: 'markdown' }),
      expect.objectContaining({ fieldKey: 'nightModeBotMessageText' }),
      { botId: 'bot-survivor', sourceTag: 'night_mode_transition' },
    );
    expect(adapters.resolveBotId).not.toHaveBeenCalled();
    expect(adapters.getBotSpeechProfile).toHaveBeenCalledWith('bot-survivor');
    expect(maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
    expect(eventService.createTransitionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-1',
        messageId: 'msg-routed-close-1',
        sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-07-11',
      }),
    );
  });

  it('fails closed in production when routed publication wiring is missing', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const maxClient = {
      sendMessageImmediateWithId: jest.fn(),
      deleteMessage: jest.fn(),
    };
    const service = new NightModeTransitionDeliveryService(
      maxClient as never,
      {
        resolveMedia: jest.fn().mockReturnValue(null),
        withMediaOptions: jest.fn(),
      } as never,
      createEventService() as never,
    );

    try {
      await expect(
        service.sendClosedNotice(
          createSettings(),
          {
            startMinutes: 23 * 60,
            endMinutes: 8 * 60,
            timezone: 'Europe/Moscow',
            sessionKey: 'session-1',
          },
          createAdapters(),
        ),
      ).rejects.toThrow(
        'Routed MAX publication service is required for production night mode notices',
      );
      expect(maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it('does not create a transition event when routed delivery has no executable bot', async () => {
    const noRouteError = new MaxActionNoExecutableRouteError('SEND_MESSAGE', 'chat-1');
    const eventService = createEventService();
    const maxRoutedPublicationService = {
      publish: jest.fn().mockRejectedValue(noRouteError),
    };
    const service = new NightModeTransitionDeliveryService(
      {
        sendMessageImmediateWithId: jest.fn(),
        deleteMessage: jest.fn(),
      } as never,
      {
        resolveMedia: jest.fn().mockReturnValue(null),
        withMediaOptions: jest.fn(),
      } as never,
      eventService as never,
      undefined,
      maxRoutedPublicationService as never,
    );

    await expect(
      service.sendOpenedNotice(
        createSettings(),
        {
          startMinutes: 23 * 60,
          endMinutes: 8 * 60,
          timezone: 'Europe/Moscow',
          sessionKey: 'session-no-route',
        },
        createAdapters(),
      ),
    ).rejects.toBe(noRouteError);

    expect(eventService.createTransitionEvent).not.toHaveBeenCalled();
  });

  it('records a routed terminal send against the dispatch attempt epoch', async () => {
    const dispatchAttemptStartedAt = new Date('2026-08-20T12:00:00.123Z');
    const errorHandledAt = new Date('2026-08-20T12:00:05.456Z');
    jest.useFakeTimers().setSystemTime(dispatchAttemptStartedAt);
    const accessLoss = {
      recordManagedEntityAccessLost: jest.fn().mockResolvedValue(undefined),
    };
    const maxRoutedPublicationService = {
      publish: jest.fn().mockImplementation(async (request: any) => {
        request.onDispatchAttempt({ botId: 'bot-routed', job: {} });
        jest.setSystemTime(errorHandledAt);
        throw createMaxApiError(403, 'Request failed with status code 403');
      }),
    };
    const service = new NightModeTransitionDeliveryService(
      {
        sendMessageImmediateWithId: jest.fn(),
        deleteMessage: jest.fn(),
      } as never,
      {
        resolveMedia: jest.fn().mockReturnValue(null),
        withMediaOptions: jest.fn(async (options) => options),
      } as never,
      createEventService() as never,
      accessLoss as never,
      maxRoutedPublicationService as never,
    );

    try {
      await expect(
        service.sendOpenedNotice(
          createSettings(),
          {
            startMinutes: 23 * 60,
            endMinutes: 8 * 60,
            timezone: 'Europe/Moscow',
            sessionKey: 'session-routed-terminal',
          },
          createAdapters(),
        ),
      ).resolves.toEqual({ shouldEnqueueNext: false });

      expect(accessLoss.recordManagedEntityAccessLost).toHaveBeenCalledWith({
        chatId: 'chat-1',
        botId: 'bot-routed',
        reason: 'bot_denied',
        source: 'night_mode_transition:send-open-notice',
        lastMaxErrorCode: null,
        lastMaxErrorMessage: 'request failed with status code 403',
        lastMaxStatusCode: 403,
        lifecycleEventAt: dispatchAttemptStartedAt,
        lifecycleEventType: 'live_probe',
        lifecycleSource: 'live_probe',
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not record access loss for a terminal-shaped pre-dispatch failure', async () => {
    const preDispatchError = createMaxApiError(403, 'Request failed with status code 403');
    const accessLoss = {
      recordManagedEntityAccessLost: jest.fn(),
    };
    const maxRoutedPublicationService = {
      publish: jest.fn().mockRejectedValue(preDispatchError),
    };
    const service = new NightModeTransitionDeliveryService(
      {
        sendMessageImmediateWithId: jest.fn(),
        deleteMessage: jest.fn(),
      } as never,
      {
        resolveMedia: jest.fn().mockReturnValue(null),
        withMediaOptions: jest.fn(async (options) => options),
      } as never,
      createEventService() as never,
      accessLoss as never,
      maxRoutedPublicationService as never,
    );

    await expect(
      service.sendOpenedNotice(
        createSettings(),
        {
          startMinutes: 23 * 60,
          endMinutes: 8 * 60,
          timezone: 'Europe/Moscow',
          sessionKey: 'session-routed-pre-dispatch',
        },
        createAdapters(),
      ),
    ).rejects.toBe(preDispatchError);

    expect(accessLoss.recordManagedEntityAccessLost).not.toHaveBeenCalled();
  });

  it('does not duplicate routed access loss already recorded by action dispatch', async () => {
    const terminalError = Object.assign(
      createMaxApiError(403, 'Request failed with status code 403'),
      { maxManagedEntityAccessLossRecorded: true },
    );
    const accessLoss = {
      recordManagedEntityAccessLost: jest.fn(),
    };
    const maxRoutedPublicationService = {
      publish: jest.fn().mockImplementation(async (request: any) => {
        request.onDispatchAttempt({ botId: 'bot-routed', job: {} });
        throw terminalError;
      }),
    };
    const service = new NightModeTransitionDeliveryService(
      {
        sendMessageImmediateWithId: jest.fn(),
        deleteMessage: jest.fn(),
      } as never,
      {
        resolveMedia: jest.fn().mockReturnValue(null),
        withMediaOptions: jest.fn(async (options) => options),
      } as never,
      createEventService() as never,
      accessLoss as never,
      maxRoutedPublicationService as never,
    );

    await expect(
      service.sendOpenedNotice(
        createSettings(),
        {
          startMinutes: 23 * 60,
          endMinutes: 8 * 60,
          timezone: 'Europe/Moscow',
          sessionKey: 'session-routed-recorded',
        },
        createAdapters(),
      ),
    ).resolves.toEqual({ shouldEnqueueNext: false });

    expect(accessLoss.recordManagedEntityAccessLost).not.toHaveBeenCalled();
  });

  it('sends a closed notice with markdown, background request options, media adapter, and event', async () => {
    const maxClient = {
      sendMessageImmediateWithId: jest.fn().mockResolvedValue({ messageId: 'msg-close-1' }),
      deleteMessage: jest.fn(),
    };
    const botSpeechMediaService = {
      resolveMedia: jest.fn().mockReturnValue({
        base64: 'aW1hZ2U=',
        mimeType: 'image/png',
        fileName: 'night.png',
        fieldKey: 'nightModeBotMessageText',
      }),
      withMediaOptions: jest.fn(async (options) => ({
        ...(options ?? {}),
        imagePayload: { token: 'image-token' },
      })),
    };
    const eventService = createEventService();
    const service = new NightModeTransitionDeliveryService(
      maxClient as never,
      botSpeechMediaService as never,
      eventService as never,
    );
    const adapters = createAdapters();

    await expect(
      service.sendClosedNotice(
        createSettings(),
        {
          startMinutes: 23 * 60,
          endMinutes: 8 * 60,
          timezone: 'Europe/Moscow',
          sessionKey: 'session-1',
        },
        adapters,
      ),
    ).resolves.toEqual({
      shouldEnqueueNext: true,
      messageId: 'msg-close-1',
      botId: 'bot-1',
    });

    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      'chat-1',
      '🌙 Чат закрыт по расписанию: 23:00-08:00 (Москва). До открытия новые сообщения будут удаляться.',
      expect.objectContaining({
        textFormat: 'markdown',
        imagePayload: { token: 'image-token' },
      }),
      {
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: 'night_mode_transition',
        ignoreFailureMetricStatuses: [403, 404],
        botId: 'bot-1',
      },
    );
    expect(botSpeechMediaService.resolveMedia).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'chat-1' }),
      'nightModeBotMessageText',
    );
    expect(botSpeechMediaService.withMediaOptions).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ fieldKey: 'nightModeBotMessageText' }),
      { botId: 'bot-1', sourceTag: 'night_mode_transition' },
    );
    expect(eventService.createTransitionEvent).toHaveBeenCalledWith({
      chatId: 'chat-1',
      messageId: 'msg-close-1',
      botId: 'bot-1',
      ruleCode: 'NIGHT_MODE_CLOSE_NOTICE',
      sessionKey: 'session-1',
      timezone: 'Europe/Moscow',
      startMinutes: 23 * 60,
      endMinutes: 8 * 60,
    });
  });

  it('keeps the accepted close notice id when event persistence fails after send', async () => {
    const maxClient = {
      sendMessageImmediateWithId: jest.fn().mockResolvedValue({ messageId: 'msg-close-1' }),
      deleteMessage: jest.fn(),
    };
    const botSpeechMediaService = {
      resolveMedia: jest.fn().mockReturnValue(null),
      withMediaOptions: jest.fn(async (options) => options),
    };
    const eventError = new Error('database is temporarily unavailable');
    const eventService = {
      createTransitionEvent: jest.fn().mockRejectedValue(eventError),
    };
    const service = new NightModeTransitionDeliveryService(
      maxClient as never,
      botSpeechMediaService as never,
      eventService as never,
    );

    const result = service.sendClosedNotice(
      createSettings(),
      {
        startMinutes: 23 * 60,
        endMinutes: 8 * 60,
        timezone: 'Europe/Moscow',
        sessionKey: 'session-1',
      },
      createAdapters(),
    );

    await expect(result).rejects.toBeInstanceOf(NightModeTransitionNoticeEventPersistenceError);
    await expect(result).rejects.toMatchObject({
      name: 'NightModeTransitionNoticeEventPersistenceError',
      details: {
        chatId: 'chat-1',
        messageId: 'msg-close-1',
        botId: 'bot-1',
        ruleCode: 'NIGHT_MODE_CLOSE_NOTICE',
        sessionKey: 'session-1',
        timezone: 'Europe/Moscow',
        startMinutes: 23 * 60,
        endMinutes: 8 * 60,
      },
    });
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(1);
  });

  it('sends an opened notice and creates an open event', async () => {
    const maxClient = {
      sendMessageImmediateWithId: jest.fn().mockResolvedValue({ messageId: 'msg-open-1' }),
      deleteMessage: jest.fn(),
    };
    const botSpeechMediaService = {
      resolveMedia: jest.fn().mockReturnValue(null),
      withMediaOptions: jest.fn(async (options) => options),
    };
    const eventService = createEventService();
    const service = new NightModeTransitionDeliveryService(
      maxClient as never,
      botSpeechMediaService as never,
      eventService as never,
    );
    const adapters = createAdapters();

    await expect(
      service.sendOpenedNotice(
        createSettings(),
        {
          startMinutes: 23 * 60,
          endMinutes: 8 * 60,
          timezone: 'Europe/Moscow',
          sessionKey: 'session-1',
        },
        adapters,
      ),
    ).resolves.toEqual({ shouldEnqueueNext: true });

    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      'chat-1',
      'Чат снова открыт. Можно отправлять сообщения.',
      expect.objectContaining({ textFormat: 'markdown' }),
      expect.objectContaining({
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: 'night_mode_transition',
        botId: 'bot-1',
      }),
    );
    expect(botSpeechMediaService.resolveMedia).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'chat-1' }),
      'nightModeOpenMessageText',
    );
    expect(eventService.createTransitionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-1',
        messageId: 'msg-open-1',
        ruleCode: 'NIGHT_MODE_OPEN_NOTICE',
      }),
    );
  });

  it('records access loss and stops scheduling on terminal send errors', async () => {
    const dispatchAttemptStartedAt = new Date('2026-08-20T13:00:00.123Z');
    jest.useFakeTimers().setSystemTime(dispatchAttemptStartedAt);
    const maxClient = {
      sendMessageImmediateWithId: jest
        .fn()
        .mockRejectedValue(createMaxApiError(404, 'Request failed with status code 404')),
      deleteMessage: jest.fn(),
    };
    const accessLoss = {
      recordManagedEntityAccessLost: jest.fn().mockResolvedValue(undefined),
    };
    const service = new NightModeTransitionDeliveryService(
      maxClient as never,
      {
        resolveMedia: jest.fn().mockReturnValue(null),
        withMediaOptions: jest.fn(async (options) => options),
      } as never,
      createEventService() as never,
      accessLoss as never,
    );

    try {
      await expect(
        service.sendClosedNotice(
          createSettings(),
          {
            startMinutes: 23 * 60,
            endMinutes: 8 * 60,
            timezone: 'Europe/Moscow',
            sessionKey: 'session-1',
          },
          createAdapters(),
        ),
      ).resolves.toEqual({ shouldEnqueueNext: false, messageId: null, botId: null });

      expect(accessLoss.recordManagedEntityAccessLost).toHaveBeenCalledWith({
        chatId: 'chat-1',
        botId: 'bot-1',
        reason: 'chat_not_found',
        source: 'night_mode_transition:send-close-notice',
        lastMaxErrorCode: null,
        lastMaxErrorMessage: 'request failed with status code 404',
        lastMaxStatusCode: 404,
        lifecycleEventAt: dispatchAttemptStartedAt,
        lifecycleEventType: 'live_probe',
        lifecycleSource: 'live_probe',
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('hands close notice cleanup to a durable origin-only intent in execute rollout', async () => {
    const maxClient = {
      sendMessageImmediateWithId: jest.fn(),
      deleteMessage: jest.fn(),
    };
    const eventService = createEventService();
    const deleteIntents = {
      getRolloutForChat: jest.fn().mockReturnValue('execute'),
      ensureIntent: jest.fn().mockResolvedValue({
        intentId: 'intent-close-notice-1',
        rollout: 'execute',
        status: 'PENDING',
      }),
    };
    const service = new NightModeTransitionDeliveryService(
      maxClient as never,
      {
        resolveMedia: jest.fn().mockReturnValue(null),
        withMediaOptions: jest.fn(async (options) => options),
      } as never,
      eventService as never,
      undefined,
      undefined,
      deleteIntents as never,
    );

    await expect(
      service.deleteClosedNotice('chat-1', 'close-message-1', 'origin-bot-1', createAdapters()),
    ).resolves.toEqual({ shouldEnqueueNext: true });

    expect(deleteIntents.ensureIntent).toHaveBeenCalledWith({
      chatId: 'chat-1',
      messageId: 'close-message-1',
      reasonKey: 'NIGHT_MODE_CLOSE_NOTICE_CLEANUP',
      ruleCode: 'NIGHT_MODE_CLOSE_NOTICE_CLEANUP',
      entityType: 'CHAT',
      messageAuthorKind: 'bot',
      originBotId: 'origin-bot-1',
      routingPolicy: 'origin_only',
    });
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(eventService.createTransitionEvent).not.toHaveBeenCalled();
  });

  it('does not create an origin-only intent when a historical close notice has no author bot', async () => {
    const maxClient = {
      sendMessageImmediateWithId: jest.fn(),
      deleteMessage: jest.fn().mockResolvedValue(undefined),
    };
    const deleteIntents = {
      getRolloutForChat: jest.fn().mockReturnValue('execute'),
      ensureIntent: jest.fn(),
    };
    const service = new NightModeTransitionDeliveryService(
      maxClient as never,
      {
        resolveMedia: jest.fn().mockReturnValue(null),
        withMediaOptions: jest.fn(async (options) => options),
      } as never,
      createEventService() as never,
      undefined,
      undefined,
      deleteIntents as never,
    );

    await expect(
      service.deleteClosedNotice('chat-1', 'historical-close-1', null, createAdapters()),
    ).resolves.toEqual({ shouldEnqueueNext: true });

    expect(deleteIntents.ensureIntent).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).toHaveBeenCalledWith(
      'chat-1',
      'historical-close-1',
      expect.objectContaining({ botId: 'bot-1', immediate: true }),
    );
  });

  it('does not treat an arbitrary 404 as successful historical notice deletion', async () => {
    const error = createMaxApiError(404, 'Request failed with status code 404');
    const maxClient = {
      sendMessageImmediateWithId: jest.fn(),
      deleteMessage: jest.fn().mockRejectedValue(error),
    };
    const service = new NightModeTransitionDeliveryService(
      maxClient as never,
      {
        resolveMedia: jest.fn().mockReturnValue(null),
        withMediaOptions: jest.fn(async (options) => options),
      } as never,
      createEventService() as never,
    );

    await expect(
      service.deleteClosedNotice('chat-1', 'historical-close-1', null, createAdapters()),
    ).rejects.toBe(error);
  });

  it('records terminal direct deletion against the MAX attempt epoch', async () => {
    const dispatchAttemptStartedAt = new Date('2026-08-20T14:00:00.123Z');
    jest.useFakeTimers().setSystemTime(dispatchAttemptStartedAt);
    const maxClient = {
      sendMessageImmediateWithId: jest.fn(),
      deleteMessage: jest
        .fn()
        .mockRejectedValue(createMaxApiError(404, 'Chat not found', 'chat.not.found')),
    };
    const accessLoss = {
      recordManagedEntityAccessLost: jest.fn().mockResolvedValue(undefined),
    };
    const service = new NightModeTransitionDeliveryService(
      maxClient as never,
      {
        resolveMedia: jest.fn().mockReturnValue(null),
        withMediaOptions: jest.fn(async (options) => options),
      } as never,
      createEventService() as never,
      accessLoss as never,
    );

    try {
      await expect(
        service.deleteClosedNotice('chat-1', 'historical-close-1', null, createAdapters()),
      ).resolves.toEqual({ shouldEnqueueNext: false });

      expect(accessLoss.recordManagedEntityAccessLost).toHaveBeenCalledWith({
        chatId: 'chat-1',
        botId: 'bot-1',
        reason: 'chat_not_found',
        source: 'night_mode_transition:delete-close-notice',
        lastMaxErrorCode: 'chat.not.found',
        lastMaxErrorMessage: 'chat not found',
        lastMaxStatusCode: 404,
        lifecycleEventAt: dispatchAttemptStartedAt,
        lifecycleEventType: 'live_probe',
        lifecycleSource: 'live_probe',
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps direct close-notice deletion as the shadow fallback', async () => {
    const maxClient = {
      sendMessageImmediateWithId: jest.fn(),
      deleteMessage: jest
        .fn()
        .mockRejectedValue(
          createMaxApiError(404, 'Request failed with status code 404', 'message.not.found'),
        ),
    };
    const accessLoss = {
      recordManagedEntityAccessLost: jest.fn(),
    };
    const deleteIntents = {
      getRolloutForChat: jest.fn().mockReturnValue('observed'),
      ensureIntent: jest.fn().mockResolvedValue({
        intentId: 'intent-close-notice-shadow-1',
        rollout: 'observed',
        status: 'OBSERVED',
      }),
    };
    const service = new NightModeTransitionDeliveryService(
      maxClient as never,
      {
        resolveMedia: jest.fn().mockReturnValue(null),
        withMediaOptions: jest.fn(async (options) => options),
      } as never,
      createEventService() as never,
      accessLoss as never,
      undefined,
      deleteIntents as never,
    );

    await expect(
      service.deleteClosedNotice('chat-1', 'close-message-1', 'origin-bot-1', createAdapters()),
    ).resolves.toEqual({ shouldEnqueueNext: true });

    expect(deleteIntents.ensureIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-1',
        messageId: 'close-message-1',
        originBotId: 'origin-bot-1',
        routingPolicy: 'origin_only',
      }),
    );
    expect(maxClient.deleteMessage).toHaveBeenCalledWith(
      'chat-1',
      'close-message-1',
      expect.objectContaining({
        immediate: true,
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: 'night_mode_transition',
        ignoreFailureMetricStatuses: [403, 404],
        botId: 'origin-bot-1',
      }),
    );
    expect(accessLoss.recordManagedEntityAccessLost).not.toHaveBeenCalled();
  });
});
