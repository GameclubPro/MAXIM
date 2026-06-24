import { NightModeTransitionDeliveryService } from './night-mode-transition-delivery.service';
import type { NightModeTransitionDeliveryAdapters } from './night-mode-transition-delivery.service';
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
    getActiveBotSpeechProfile: jest.fn().mockReturnValue({
      persona: 'male',
      characterName: 'Майор Максимов',
    }),
    buildClosedNoticeOptions: jest.fn().mockReturnValue({
      buttons: [[{ type: 'link', text: 'Комментарии', url: 'https://example.test' }]],
    }),
    resolveBotSpeechMedia: jest.fn().mockReturnValue(null),
    withBotSpeechMediaOptions: jest.fn(async (options) => options),
    resolveBotId: jest.fn().mockResolvedValue('bot-1'),
    createEvent: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('NightModeTransitionDeliveryService', () => {
  it('sends a closed notice with markdown, background request options, media adapter, and event', async () => {
    const maxClient = {
      sendMessageImmediateWithId: jest.fn().mockResolvedValue({ messageId: 'msg-close-1' }),
      deleteMessage: jest.fn(),
    };
    const service = new NightModeTransitionDeliveryService(maxClient as never);
    const adapters = createAdapters({
      resolveBotSpeechMedia: jest.fn().mockReturnValue({
        base64: 'aW1hZ2U=',
        mimeType: 'image/png',
        fileName: 'night.png',
        fieldKey: 'nightModeBotMessageText',
      }),
      withBotSpeechMediaOptions: jest.fn(async (options) => ({
        ...(options ?? {}),
        imagePayload: { token: 'image-token' },
      })),
    });

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
    ).resolves.toEqual({ shouldEnqueueNext: true, messageId: 'msg-close-1' });

    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      'chat-1',
      '🌙 Ночной режим активен: 23:00-08:00 (Москва). Новые сообщения временно не принимаются.',
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
    expect(adapters.withBotSpeechMediaOptions).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ fieldKey: 'nightModeBotMessageText' }),
      { botId: 'bot-1', sourceTag: 'night_mode_transition' },
    );
    expect(adapters.createEvent).toHaveBeenCalledWith({
      chatId: 'chat-1',
      messageId: 'msg-close-1',
      ruleCode: 'NIGHT_MODE_CLOSE_NOTICE',
      sessionKey: 'session-1',
      timezone: 'Europe/Moscow',
      startMinutes: 23 * 60,
      endMinutes: 8 * 60,
    });
  });

  it('sends an opened notice and creates an open event', async () => {
    const maxClient = {
      sendMessageImmediateWithId: jest.fn().mockResolvedValue({ messageId: 'msg-open-1' }),
      deleteMessage: jest.fn(),
    };
    const service = new NightModeTransitionDeliveryService(maxClient as never);
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
      '☀️ Ночной режим завершен. Группа снова открыта.',
      expect.objectContaining({ textFormat: 'markdown' }),
      expect.objectContaining({
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: 'night_mode_transition',
        botId: 'bot-1',
      }),
    );
    expect(adapters.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-1',
        messageId: 'msg-open-1',
        ruleCode: 'NIGHT_MODE_OPEN_NOTICE',
      }),
    );
  });

  it('records access loss and stops scheduling on terminal send errors', async () => {
    const maxClient = {
      sendMessageImmediateWithId: jest
        .fn()
        .mockRejectedValue(createMaxApiError(404, 'Request failed with status code 404')),
      deleteMessage: jest.fn(),
    };
    const accessLoss = {
      recordManagedEntityAccessLost: jest.fn().mockResolvedValue(undefined),
    };
    const service = new NightModeTransitionDeliveryService(maxClient as never, accessLoss as never);

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
    ).resolves.toEqual({ shouldEnqueueNext: false, messageId: null });

    expect(accessLoss.recordManagedEntityAccessLost).toHaveBeenCalledWith({
      chatId: 'chat-1',
      botId: 'bot-1',
      reason: 'chat_not_found',
      source: 'night_mode_transition:send-close-notice',
      lastMaxErrorCode: null,
      lastMaxErrorMessage: 'request failed with status code 404',
      lastMaxStatusCode: 404,
    });
  });

  it('continues when deleting an old close notice returns message.not.found', async () => {
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
    const service = new NightModeTransitionDeliveryService(maxClient as never, accessLoss as never);

    await expect(
      service.deleteClosedNotice('chat-1', 'close-message-1', createAdapters()),
    ).resolves.toEqual({ shouldEnqueueNext: true });

    expect(maxClient.deleteMessage).toHaveBeenCalledWith(
      'chat-1',
      'close-message-1',
      expect.objectContaining({
        immediate: true,
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: 'night_mode_transition',
        ignoreFailureMetricStatuses: [403, 404],
        botId: 'bot-1',
      }),
    );
    expect(accessLoss.recordManagedEntityAccessLost).not.toHaveBeenCalled();
  });
});
