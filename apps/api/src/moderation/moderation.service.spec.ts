import type { MaxUpdate } from '@maxim/contracts';
import { SanctionAction } from '@prisma/client';
import { ModerationService } from './moderation.service';

expect.extend({
  toHaveBeenCalledWithPrefix(this: jest.MatcherContext, received: unknown, ...expected: unknown[]) {
    if (typeof received !== 'function' || !('mock' in received)) {
      return {
        pass: false,
        message: () => 'Expected a Jest mock function',
      };
    }

    const mockFn = received as jest.Mock;
    const calls = mockFn.mock.calls ?? [];
    const pass = calls.some((call) =>
      expected.every((expectedArg, index) => this.equals(call[index], expectedArg)),
    );

    return {
      pass,
      message: () =>
        pass
          ? `Expected mock not to be called with prefix ${this.utils.printExpected(expected)}`
          : `Expected mock to be called with prefix ${this.utils.printExpected(expected)}, but got ${this.utils.printReceived(calls)}`,
    };
  },
});

function escapeMaxMarkdown(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/([*_`\[\]()~+])/g, '\\$1');
}

function boldUser(name: string): string {
  return `**${escapeMaxMarkdown(name)}**`;
}

function majorExplanation(
  name: string,
  messageStatus: 'снято с линии' | 'не по форме',
  reason: string,
  subject = 'Сообщение',
): string {
  void messageStatus;

  if (reason === 'в этом чате ссылки не проходят, без ссылок') {
    return `Товарищ ${boldUser(name)}, ссылочку изъял 👮‍♂️ В этом чате с ними строго. Поправьте и работаем дальше.`;
  }

  if (subject === 'Объявление') {
    return `Товарищ ${boldUser(name)}, объявление завернул 👮‍♂️ Причина: ${reason}. Поправьте по форме и возвращайтесь.`;
  }

  if (
    reason.includes('стоп-слово') ||
    reason.includes('слово из стоп-листа') ||
    reason.includes('слишком длинное сообщение') ||
    reason.includes('видео в этом чате отключены') ||
    reason.includes('файлы в этом чате отключены') ||
    reason.includes('голосовые сообщения в этом чате отключены') ||
    reason.includes('слишком частая отправка')
  ) {
    return `Товарищ ${boldUser(name)}, сообщение завернул 👮‍♂️ Причина: ${reason}. Подправьте и подавайте заново.`;
  }

  return `Товарищ ${boldUser(name)}, сообщение изъял 👮‍♂️ Причина: ${reason}. Поправьте по форме и разъедемся красиво.`;
}

function duplicateExplanation(name: string, sanction: string): string {
  return `Товарищ ${boldUser(name)}, у нас тут не ксерокс 👮‍♂️ Повтор зафиксирован. ${sanction}`;
}

function muteNotice(name: string, duration: string): string {
  return `Товарищ ${boldUser(name)}, оформляю мут на ${duration}. До конца срока новые сообщения будут скрываться.`;
}

function permanentBanNotice(name: string): string {
  return `Товарищ ${boldUser(name)}, оформляю бан до ручного разбана.`;
}

function textFilterWarnNotice(name: string, reason: string): string {
  return `Товарищ ${boldUser(name)}, предупреждение на карандаш занёс 👮‍♂️ Причина: ${reason}. Дальше держим порядок.`;
}

function linkWarnNotice(name: string): string {
  return `Товарищ ${boldUser(name)}, предупреждение за ссылки оформил 👮‍♂️ Ещё один такой заход, и разговор будет короче.`;
}

function messageLimitsWarnNotice(name: string, reason: string): string {
  return `Товарищ ${boldUser(name)}, предупреждение оформил 👮‍♂️ Причина: ${reason}.`;
}

function messageLimitsMuteNotice(name: string, reason: string): string {
  return `Товарищ ${boldUser(name)}, ограничения снова решили проверить на прочность. Оформляю мут. Причина: ${reason}.`;
}

function messageLimitsBanNotice(name: string, reason: string): string {
  return `Товарищ ${boldUser(name)}, оформляю бан до ручного разбана 👮‍♂️ Причина: ${reason}.`;
}

function topicFilterWarnNotice(name: string, reason: string): string {
  return `Товарищ ${boldUser(name)}, предупреждение оформил 👮‍♂️ Причина: ${reason}.`;
}

function nightModeNotice(window: string, timezone: string): string {
  return `Ночной режим, граждане 🌙 Участок прикрыт на ${window} (${timezone}). Новые сообщения временно не принимаются.`;
}

function nightModeOpenNotice(): string {
  return 'Доброе утро, граждане ☀️ Группа снова открыта. Возвращаемся в эфир без нарушений.';
}

function createMaxApiError(status: number, message: string, code?: string): Error {
  return Object.assign(new Error(message), {
    response: {
      status,
      data: {
        ...(code ? { code } : {}),
        message,
      },
    },
  });
}

function createSettings(overrides: Record<string, unknown> = {}) {
  return {
    id: 'settings-1',
    chatId: 'chat-1',
    duplicateWarnEnabled: true,
    duplicateMuteEnabled: true,
    duplicateBanEnabled: true,
    antiDuplicateEnabled: true,
    duplicateWarnWindowSec: 12 * 60 * 60,
    duplicateWarnMaxCount: 2,
    duplicateMuteWindowSec: 24 * 60 * 60,
    duplicateMuteMaxCount: 3,
    duplicateBanWindowSec: 48 * 60 * 60,
    duplicateBanMaxCount: 4,
    linkPolicy: 'ALLOWLIST_ONLY',
    botSpeechStyle: null,
    greetingEnabled: false,
    greetingBotMessageEnabled: true,
    greetingDeleteBotMessageEnabled: false,
    greetingBotMessageText: '',
    greetingBotButtonEnabled: false,
    greetingBotButtonUrl: '',
    greetingBotButtonText: 'Открыть',
    greetingRulesButtonEnabled: false,
    deleteBotMessagesEnabled: false,
    deleteBotMessagesDelayMinutes: 2,
    removeBotsFromGroupEnabled: false,
    deleteSpammersEnabled: false,

    antiSpamEnabled: true,
    messageCountLimitEnabled: false,
    messageCountLimitMessages: 5,
    messageCountLimitWindowHours: 1,
    maxMessageLengthEnabled: false,
    maxMessageLength: 1500,
    photoMessageCooldownEnabled: false,
    photoMessageCooldownHours: 1,
    stickerMessageCooldownEnabled: false,
    stickerMessageCooldownMinutes: 5,
    videoMessagesEnabled: true,
    fileMessagesEnabled: true,
    voiceMessagesEnabled: true,
    messageLimitsBlockedWords: [],
    messageLimitsBotMessageEnabled: false,
    messageLimitsBotMessageText: '',
    messageLimitsWarnEnabled: false,
    messageLimitsBanEnabled: false,
    messageLimitsMuteEnabled: false,
    messageLimitsBotButtonEnabled: false,
    messageLimitsBotButtonUrl: '',
    messageLimitsBotButtonText: 'Открыть',
    russianProfanityFilterEnabled: true,
    commercialAdsFilterEnabled: false,
    commercialAdsSensitivity: 'BALANCED',
    commercialAdsWarnThreshold: 45,
    commercialAdsDeleteThreshold: 65,
    profanityBotMessageEnabled: false,
    profanityWarnEnabled: false,
    profanityBanEnabled: false,
    profanityMuteEnabled: false,
    textFiltersBotMessageEnabled: false,
    textFiltersBotMessageText: '',
    textFiltersWarnEnabled: false,
    textFiltersWarnMessageText: '',
    textFiltersBanEnabled: false,
    textFiltersMuteEnabled: false,
    textFiltersBotButtonEnabled: false,
    textFiltersBotButtonUrl: '',
    textFiltersBotButtonText: 'Открыть',
    textFiltersRulesButtonEnabled: false,
    thematicCodewordEnabled: false,
    thematicCodeword: '',
    thematicFiltersBotMessageEnabled: false,
    thematicFiltersWarnEnabled: false,
    thematicFiltersBanEnabled: false,
    thematicFiltersMuteEnabled: false,
    thematicFiltersBotButtonEnabled: false,
    thematicFiltersBotButtonUrl: '',
    thematicFiltersBotButtonText: 'Открыть',
    thematicFiltersRulesButtonEnabled: false,
    commentsEnabled: false,
    commentsAdminsEnabled: true,
    commentsAllEnabled: false,
    commentsChatBroadcastsEnabled: false,
    nightModeEnabled: false,
    nightModeStartTimeMinutes: 23 * 60,
    nightModeEndTimeMinutes: 8 * 60,
    nightModeTimezone: 'Europe/Moscow',
    nightModeBotMessageEnabled: false,
    nightModeBotMessageText: '',
    nightModeCommentsEnabled: false,
    nightModeOpenMessageEnabled: true,
    nightModeOpenMessageText: '',
    nightModeBotButtonEnabled: false,
    nightModeBotButtonUrl: '',
    nightModeBotButtonText: 'Открыть',
    nightModeRulesButtonEnabled: false,
    nightModeForceCloseEnabled: false,
    nightModeForceCloseForever: false,
    nightModeForceCloseHours: 8,
    nightModeForceCloseDays: 0,
    nightModeForceCloseUntil: '',
    requiredSubscriptionEnabled: false,
    requiredSubscriptionChannelIds: [],
    requiredSubscriptionBotMessageEnabled: true,
    requiredSubscriptionBotMessageText: '',
    requiredSubscriptionWarnEnabled: false,
    requiredSubscriptionWarnMessageText: '',
    requiredSubscriptionBanEnabled: false,
    requiredSubscriptionMuteEnabled: false,
    linkBotMessageEnabled: true,
    linkBotMessageText: '',
    linkWarnEnabled: false,
    linkWarnMessageText: '',
    linkBanEnabled: false,
    linkMuteEnabled: false,
    linkBotButtonEnabled: false,
    linkBotButtonUrl: '',
    linkBotButtonText: 'Открыть',
    linkRulesButtonEnabled: false,
    duplicateBotMessageEnabled: false,
    duplicateBotMessageText: '',
    duplicateBotButtonEnabled: false,
    duplicateBotButtonUrl: '',
    duplicateBotButtonText: 'Открыть',
    duplicateRulesButtonEnabled: false,
    messageLimitsRulesButtonEnabled: false,
    rulesAttachViolationsEnabled: false,
    muteDurationHours: 6,
    warnThreshold: 3,
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
      senderName: 'Алексей',
      text: 'same text',
      createdAt: new Date().toISOString(),
    },
    raw: {},
  };
}

function createAdminForwardedBanUpdate(
  text = 'бан',
  forwardedChatId: string | number = 'chat-1',
): MaxUpdate {
  return {
    updateId: 'upd-admin-forward-ban-1',
    type: 'message_created',
    message: {
      messageId: 'msg-admin-forward-ban-1',
      chatId: 'chat-1',
      senderId: 'admin-1',
      senderName: 'Админ',
      text,
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'message_created',
      message: {
        sender: {
          user_id: 'admin-1',
          display_name: 'Админ',
        },
        recipient: {
          chat_id: 'chat-1',
        },
        body: {
          text,
          forwarded_message: {
            sender: {
              user_id: 'user-2',
              display_name: 'Нарушитель',
            },
            recipient: {
              chat_id: forwardedChatId,
              title: forwardedChatId === 'chat-1' ? 'Chat 1' : 'Другой чат',
            },
            body: {
              text: 'spam message',
            },
          },
        },
      },
    },
  };
}

function createAdminLinkedModerationUpdate(
  text = 'мут',
  linkedChatId: string | number = 'chat-1',
): MaxUpdate {
  return {
    updateId: 'upd-admin-link-moderation-1',
    type: 'message_created',
    message: {
      messageId: 'msg-admin-link-moderation-1',
      chatId: 'chat-1',
      senderId: 'admin-1',
      senderName: 'Админ',
      text,
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'message_created',
      message: {
        sender: {
          user_id: 'admin-1',
          display_name: 'Админ',
        },
        recipient: {
          chat_id: 'chat-1',
        },
        link: {
          sender: {
            user_id: 'user-2',
            display_name: 'Нарушитель',
          },
          recipient: {
            chat_id: linkedChatId,
            title: linkedChatId === 'chat-1' ? 'Chat 1' : 'Другой чат',
          },
          body: {
            text: 'spam message',
          },
        },
        body: {
          text,
        },
      },
    },
  };
}

function createBotAuthoredUpdate(): MaxUpdate {
  return {
    updateId: 'upd-bot-1',
    type: 'message_created',
    message: {
      messageId: 'msg-bot-1',
      chatId: 'chat-1',
      senderId: 'bot-1',
      text: 'service notice',
      createdAt: new Date().toISOString(),
    },
    raw: {
      message: {
        sender: {
          id: 'bot-1',
          type: 'bot',
          is_bot: true,
        },
      },
    },
  };
}

function createOwnBotUpdateWithoutBotFlags(
  text = 'service notice',
  messageId = 'msg-own-bot-no-flags-1',
): MaxUpdate {
  return {
    updateId: 'upd-own-bot-no-flags-1',
    type: 'message_created',
    message: {
      messageId,
      chatId: 'chat-1',
      senderId: '613002203036',
      text,
      createdAt: new Date().toISOString(),
    },
    raw: {
      message: {
        sender: {
          user_id: 613002203036,
        },
      },
    },
  };
}

function createServiceBotJoinedUpdate(): MaxUpdate {
  return {
    updateId: 'upd-service-bot-join-1',
    type: 'message_created',
    message: {
      messageId: 'msg-service-bot-join-1',
      chatId: 'chat-1',
      senderId: 'service-1',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      message: {
        sender: {
          id: 'service-1',
          type: 'service',
          is_service: true,
        },
        body: {
          new_members: [
            {
              user_id: 'bot-joined-1',
              type: 'bot',
              is_bot: true,
            },
          ],
        },
      },
    },
  };
}

function createBotAddedUpdate(chatId = 'chat-1'): MaxUpdate {
  return {
    updateId: 'upd-bot-added-1',
    type: 'bot_added',
    message: {
      messageId: 'bot_added:upd-bot-added-1',
      chatId,
      senderId: 'admin-1',
      senderName: 'Админ',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'bot_added',
      chat_id: chatId,
      timestamp: Date.now(),
    },
  };
}

function createServiceUserJoinedUpdate(): MaxUpdate {
  return {
    updateId: 'upd-service-user-join-1',
    type: 'message_created',
    message: {
      messageId: 'msg-service-user-join-1',
      chatId: 'chat-1',
      senderId: 'service-1',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      message: {
        sender: {
          id: 'service-1',
          type: 'service',
          is_service: true,
        },
        body: {
          new_members: [
            {
              user_id: 'user-black-2',
              type: 'user',
              display_name: 'Новый участник',
            },
          ],
        },
      },
    },
  };
}

function createServiceUserJoinedUpdateInDataEnvelope(): MaxUpdate {
  return {
    updateId: 'upd-service-user-join-envelope-1',
    type: 'message_created',
    message: {
      messageId: 'msg-service-user-join-envelope-1',
      chatId: 'chat-1',
      senderId: 'service-1',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'message_created',
      data: {
        message: {
          sender: {
            id: 'service-1',
            type: 'service',
            is_service: true,
          },
          body: {
            new_members: [
              {
                user_id: 'user-envelope-2',
                type: 'user',
                display_name: 'Новый участник из data',
              },
            ],
          },
        },
      },
    },
  };
}

function createServiceUserJoinedUpdateWithoutServiceSender(): MaxUpdate {
  return {
    updateId: 'upd-service-user-join-no-sender-1',
    type: 'message_created',
    message: {
      messageId: 'msg-service-user-join-no-sender-1',
      chatId: 'chat-1',
      senderId: '',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'message_created',
      message: {
        body: {
          new_members: [
            {
              user_id: 'user-no-sender-2',
              type: 'user',
              display_name: 'Новый участник без sender',
            },
          ],
        },
      },
    },
  };
}

function createUserAddedUpdate(): MaxUpdate {
  return {
    updateId: 'upd-user-added-1',
    type: 'user_added',
    message: {
      messageId: 'user_added:upd-user-added-1',
      chatId: 'chat-1',
      senderId: 'user-added-1',
      senderName: 'Новый участник user_added',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'user_added',
      chat_id: 'chat-1',
      user: {
        user_id: 'user-added-1',
        type: 'user',
        display_name: 'Новый участник user_added',
      },
      timestamp: Date.now(),
    },
  };
}

function createUserAddedUpdateWithSuffix(suffix: number | string): MaxUpdate {
  const normalizedSuffix = String(suffix);
  return {
    updateId: `upd-user-added-${normalizedSuffix}`,
    type: 'user_added',
    message: {
      messageId: `user_added:upd-user-added-${normalizedSuffix}`,
      chatId: 'chat-1',
      senderId: `user-added-${normalizedSuffix}`,
      senderName: `Новый участник user_added ${normalizedSuffix}`,
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'user_added',
      chat_id: 'chat-1',
      user: {
        user_id: `user-added-${normalizedSuffix}`,
        type: 'user',
        display_name: `Новый участник user_added ${normalizedSuffix}`,
      },
      timestamp: Date.now(),
    },
  };
}

function createUserRemovedUpdate(): MaxUpdate {
  return {
    updateId: 'upd-user-removed-1',
    type: 'user_removed',
    message: {
      messageId: 'user_removed:upd-user-removed-1',
      chatId: 'chat-1',
      senderId: 'user-removed-1',
      senderName: 'Пользователь вышел',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'user_removed',
      chat_id: 'chat-1',
      user: {
        user_id: 'user-removed-1',
        type: 'user',
        display_name: 'Пользователь вышел',
      },
      timestamp: Date.now(),
    },
  };
}

function createBotRemovedUpdate(): MaxUpdate {
  return {
    updateId: 'upd-bot-removed-1',
    type: 'bot_removed',
    message: {
      messageId: 'bot_removed:upd-bot-removed-1',
      chatId: 'chat-1',
      senderId: 'bot-removed-1',
      senderName: 'Бот вышел',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'bot_removed',
      chat_id: 'chat-1',
      user: {
        user_id: 'bot-removed-1',
        type: 'bot',
        display_name: 'Бот вышел',
      },
      timestamp: Date.now(),
    },
  };
}

function createBotStartedPrivateUpdate(): MaxUpdate {
  return {
    updateId: 'upd-bot-started-private-1',
    type: 'bot_started',
    message: {
      messageId: 'bot_started:upd-bot-started-private-1',
      chatId: '152517912',
      senderId: 'user-started-1',
      senderName: 'Пользователь bot_started',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'bot_started',
      chat_id: 152517912,
      chat: {
        id: 152517912,
        type: 'dialog',
      },
      user: {
        user_id: 'user-started-1',
        type: 'user',
        display_name: 'Пользователь bot_started',
      },
      timestamp: Date.now(),
    },
  };
}

function createBotStartedPrivateHandoffUpdate(startPayload = 'broadcast_handoff'): MaxUpdate {
  return {
    updateId: 'upd-bot-started-private-handoff-1',
    type: 'bot_started',
    message: {
      messageId: 'bot_started:upd-bot-started-private-handoff-1',
      chatId: '152517912',
      senderId: 'user-started-1',
      senderName: 'Пользователь bot_started',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'bot_started',
      chat_id: 152517912,
      start_payload: startPayload,
      chat: {
        id: 152517912,
        type: 'dialog',
      },
      user: {
        user_id: 'user-started-1',
        type: 'user',
        display_name: 'Пользователь bot_started',
      },
      timestamp: Date.now(),
    },
  };
}

function createBotStartedGroupUpdate(): MaxUpdate {
  return {
    updateId: 'upd-bot-started-group-1',
    type: 'bot_started',
    message: {
      messageId: 'bot_started:upd-bot-started-group-1',
      chatId: '-71527833503751',
      senderId: 'user-started-group-1',
      senderName: 'Пользователь bot_started group',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'bot_started',
      chat_id: -71527833503751,
      chat: {
        id: -71527833503751,
        type: 'chat',
      },
      user: {
        user_id: 'user-started-group-1',
        type: 'user',
        display_name: 'Пользователь bot_started group',
      },
      timestamp: Date.now(),
    },
  };
}

function createPrivateCommandUpdate(text: string): MaxUpdate {
  return {
    updateId: 'upd-private-command-1',
    type: 'message_created',
    message: {
      messageId: 'msg-private-command-1',
      chatId: '152517912',
      senderId: 'user-private-1',
      senderName: 'Пользователь private',
      text,
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'message_created',
      message: {
        body: {
          mid: 'msg-private-command-1',
          text,
        },
        sender: {
          user_id: 'user-private-1',
          type: 'user',
        },
        recipient: {
          chat_id: 152517912,
          chat_type: 'dialog',
        },
      },
    },
  };
}

function createPrivateCallbackUpdate(payload: string): MaxUpdate {
  return {
    updateId: 'upd-private-callback-1',
    type: 'message_callback',
    message: {
      messageId: 'msg-private-callback-1',
      chatId: '152517912',
      senderId: '613002203036',
      senderName: 'Майор Максимов',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'message_callback',
      callback: {
        callback_id: 'callback-1',
        payload,
        user: {
          user_id: 'user-private-1',
        },
      },
      message: {
        recipient: {
          chat_id: 152517912,
        },
      },
    },
  };
}

function createGroupRulesCallbackUpdate(): MaxUpdate {
  return {
    updateId: 'upd-group-rules-callback-1',
    type: 'message_callback',
    message: {
      messageId: 'msg-group-rules-callback-1',
      chatId: 'chat-1',
      senderId: 'user-1',
      senderName: 'Алексей',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'message_callback',
      callback: {
        callback_id: 'callback-rules-1',
        payload: 'rules:open',
        user: {
          user_id: 'user-1',
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

function createChannelSuggestionCallbackUpdate(payload: string): MaxUpdate {
  return {
    updateId: 'upd-channel-suggest-callback-1',
    type: 'message_callback',
    message: {
      messageId: 'msg-channel-suggest-callback-1',
      chatId: 'channel-1',
      senderId: '613002203036',
      senderName: 'Майор Максимов',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'message_callback',
      callback: {
        callback_id: 'callback-suggest-1',
        payload,
        user: {
          user_id: 'user-1',
        },
      },
      message: {
        recipient: {
          chat_id: 'channel-1',
        },
      },
    },
  };
}

function createManagedPollCallbackUpdate(
  payload: string,
  overrides: Partial<MaxUpdate['message']> = {},
): MaxUpdate {
  return {
    updateId: 'upd-managed-poll-callback-1',
    type: 'message_callback',
    message: {
      messageId: 'mid-poll-1',
      chatId: 'channel-1',
      senderId: 'user-1',
      senderName: 'Алексей',
      text: '',
      createdAt: new Date().toISOString(),
      ...overrides,
    },
    raw: {
      update_type: 'message_callback',
      callback: {
        callback_id: 'callback-poll-1',
        payload,
        user: {
          user_id: 'user-1',
        },
      },
      message: {
        recipient: {
          chat_id: 'channel-1',
          chat_type: 'channel',
        },
      },
    },
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
      senderName: 'Алексей',
      text: 'old text',
      createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    },
    raw: {},
  };
}

function createRequiredSubscriptionRedisCounter() {
  const stringCache = new Map<string, string>();

  return {
    stringCache,
    addToSetWithTtl: jest.fn().mockResolvedValue({ added: false, size: 1 }),
    incrementWithTtl: jest.fn().mockResolvedValue(1),
    getString: jest.fn(async (key: string) => stringCache.get(key) ?? null),
    setStringWithTtl: jest.fn(async (key: string, value: string) => {
      stringCache.set(key, value);
    }),
  };
}

function createForwardedUpdate(forwardedText: string): MaxUpdate {
  return {
    updateId: 'upd-forwarded-1',
    type: 'message_created',
    message: {
      messageId: 'msg-forwarded-1',
      chatId: 'chat-1',
      senderId: 'user-1',
      senderName: 'Алексей',
      text: 'коротко',
      createdAt: new Date().toISOString(),
    },
    raw: {
      message: {
        body: {
          text: 'коротко',
          forwarded_message: {
            body: {
              text: forwardedText,
            },
          },
        },
      },
    },
  };
}

function createVideoAttachmentUpdate(): MaxUpdate {
  return {
    updateId: 'upd-video-1',
    type: 'message_created',
    message: {
      messageId: 'msg-video-1',
      chatId: 'chat-1',
      senderId: 'user-1',
      senderName: 'Алексей',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      message: {
        attachments: [
          {
            type: 'video',
            payload: {
              url: 'https://cdn.example/video.mp4',
            },
          },
        ],
      },
    },
  };
}

function createStickerAttachmentUpdate(): MaxUpdate {
  return {
    updateId: 'upd-sticker-1',
    type: 'message_created',
    message: {
      messageId: 'msg-sticker-1',
      chatId: 'chat-1',
      senderId: 'user-1',
      senderName: 'Алексей',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      message: {
        attachments: [
          {
            type: 'sticker',
            payload: {
              mime_type: 'image/webp',
              url: 'https://cdn.example/sticker.webp',
            },
          },
        ],
      },
    },
  };
}

function createVoiceAttachmentUpdate(): MaxUpdate {
  return {
    updateId: 'upd-voice-1',
    type: 'message_created',
    message: {
      messageId: 'msg-voice-1',
      chatId: 'chat-1',
      senderId: 'user-1',
      senderName: 'Алексей',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      message: {
        attachments: [
          {
            type: 'voice',
            payload: {
              url: 'https://cdn.example/voice.ogg',
            },
          },
        ],
      },
    },
  };
}

function createForwardedVideoAttachmentUpdate(): MaxUpdate {
  return {
    updateId: 'upd-forwarded-video-1',
    type: 'message_created',
    message: {
      messageId: 'msg-forwarded-video-1',
      chatId: 'chat-1',
      senderId: 'user-1',
      senderName: 'Алексей',
      text: 'переслано',
      createdAt: new Date().toISOString(),
    },
    raw: {
      message: {
        body: {
          text: 'переслано',
          forwarded_message: {
            attachments: [
              {
                type: 'video',
                payload: {
                  url: 'https://cdn.example/forwarded-video.mp4',
                },
              },
            ],
          },
        },
      },
    },
  };
}

function createForwardedVoiceAttachmentUpdate(): MaxUpdate {
  return {
    updateId: 'upd-forwarded-voice-1',
    type: 'message_created',
    message: {
      messageId: 'msg-forwarded-voice-1',
      chatId: 'chat-1',
      senderId: 'user-1',
      senderName: 'Алексей',
      text: 'переслано',
      createdAt: new Date().toISOString(),
    },
    raw: {
      message: {
        body: {
          text: 'переслано',
          forwarded_message: {
            attachments: [
              {
                type: 'voice',
                payload: {
                  url: 'https://cdn.example/forwarded-voice.ogg',
                },
              },
            ],
          },
        },
      },
    },
  };
}

function createForwardedFileAttachmentUpdate(): MaxUpdate {
  return {
    updateId: 'upd-forwarded-file-1',
    type: 'message_created',
    message: {
      messageId: 'msg-forwarded-file-1',
      chatId: 'chat-1',
      senderId: 'user-1',
      senderName: 'Алексей',
      text: 'переслано',
      createdAt: new Date().toISOString(),
    },
    raw: {
      message: {
        body: {
          text: 'переслано',
          forwarded_message: {
            attachments: [
              {
                type: 'file',
                payload: {
                  file_name: 'forwarded.pdf',
                  url: 'https://cdn.example/forwarded.pdf',
                },
              },
            ],
          },
        },
      },
    },
  };
}

function createImageFileAttachmentUpdate(): MaxUpdate {
  return {
    updateId: 'upd-image-file-1',
    type: 'message_created',
    message: {
      messageId: 'msg-image-file-1',
      chatId: 'chat-1',
      senderId: 'user-1',
      senderName: 'Алексей',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      message: {
        attachments: [
          {
            type: 'file',
            payload: {
              mime_type: 'image/jpeg',
              file_name: 'photo-as-file.jpg',
              url: 'https://cdn.example/photo-as-file.jpg',
            },
          },
        ],
      },
    },
  };
}

describe('ModerationService', () => {
  it('ignores bot-authored messages when delete-bot toggle is disabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            removeBotsFromGroupEnabled: false,
            deleteBotMessagesEnabled: false,
          }),
          domains: [],
          admins: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      globalSpammer: {
        upsert: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
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

    await service.handleUpdate(createBotAuthoredUpdate());

    expect(prisma.chat.upsert).toHaveBeenCalledTimes(1);
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
  });

  it('schedules auto-delete for bot-authored messages when toggle is enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            removeBotsFromGroupEnabled: false,
            deleteBotMessagesEnabled: true,
            deleteBotMessagesDelayMinutes: 2,
          }),
          domains: [],
          admins: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      globalSpammer: {
        upsert: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
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
      undefined,
      undefined,
      {
        get: jest.fn().mockReturnValue('bot-1'),
      } as never,
    );

    await service.handleUpdate(createBotAuthoredUpdate());

    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-bot-1', {
      delayMs: 2 * 60 * 1000,
    });
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'bot-1',
        messageId: 'msg-bot-1',
        ruleCode: 'BOT_MESSAGE_AUTO_DELETE',
        action: SanctionAction.DELETE_MESSAGE,
      }),
    });
  });

  it('schedules auto-delete when MAX_BOT_ID is in id..._bot format', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            removeBotsFromGroupEnabled: false,
            deleteBotMessagesEnabled: true,
            deleteBotMessagesDelayMinutes: 2,
          }),
          domains: [],
          admins: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      globalSpammer: {
        upsert: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
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
      undefined,
      undefined,
      {
        get: jest.fn().mockReturnValue('idbot-1_bot'),
      } as never,
    );

    await service.handleUpdate(createBotAuthoredUpdate());

    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-bot-1', {
      delayMs: 2 * 60 * 1000,
    });
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
  });

  it('schedules auto-delete for own bot message without explicit bot flags in payload', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            removeBotsFromGroupEnabled: false,
            deleteBotMessagesEnabled: true,
            deleteBotMessagesDelayMinutes: 2,
          }),
          domains: [],
          admins: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      globalSpammer: {
        upsert: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
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
      undefined,
      undefined,
      {
        get: jest.fn().mockReturnValue('id613002203036_4_bot'),
      } as never,
    );

    await service.handleUpdate(createOwnBotUpdateWithoutBotFlags());

    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-own-bot-no-flags-1', {
      delayMs: 2 * 60 * 1000,
    });
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
  });

  it('supports 30-second auto-delete for own bot messages', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            removeBotsFromGroupEnabled: false,
            deleteBotMessagesEnabled: true,
            deleteBotMessagesDelayMinutes: 0.5,
          }),
          domains: [],
          admins: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      globalSpammer: {
        upsert: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
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
      undefined,
      undefined,
      {
        get: jest.fn().mockReturnValue('id613002203036_4_bot'),
      } as never,
    );

    await service.handleUpdate(createOwnBotUpdateWithoutBotFlags());

    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-own-bot-no-flags-1', {
      delayMs: 30_000,
    });
  });

  it('does not auto-delete tracked greeting message from own bot', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            deleteBotMessagesEnabled: true,
            deleteBotMessagesDelayMinutes: 2,
          }),
          domains: [],
          admins: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue({ id: 'greeting-event-1' }),
        create: jest.fn(),
      },
      managedBroadcastDelivery: {
        findFirst: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      globalSpammer: {
        upsert: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
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
      undefined,
      undefined,
      {
        get: jest.fn().mockReturnValue('id613002203036_4_bot'),
      } as never,
    );

    await service.handleUpdate(createOwnBotUpdateWithoutBotFlags('welcome', 'msg-greeting-own-1'));

    expect(prisma.moderationEvent.findFirst).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-1',
        ruleCode: 'GREETING_MESSAGE',
        metadata: {
          path: ['sentMessageId'],
          equals: 'msg-greeting-own-1',
        },
      },
      select: {
        id: true,
      },
    });
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(prisma.managedBroadcastDelivery.findFirst).not.toHaveBeenCalled();
  });

  it('does not auto-delete managed broadcast message from own bot', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            deleteBotMessagesEnabled: true,
            deleteBotMessagesDelayMinutes: 2,
          }),
          domains: [],
          admins: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      managedBroadcastDelivery: {
        findFirst: jest.fn().mockResolvedValue({ id: 'delivery-1' }),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      globalSpammer: {
        upsert: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
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
      undefined,
      undefined,
      {
        get: jest.fn().mockReturnValue('id613002203036_4_bot'),
      } as never,
    );

    await service.handleUpdate(createOwnBotUpdateWithoutBotFlags('broadcast', 'mid-broadcast-1'));

    expect(prisma.managedBroadcastDelivery.findFirst).toHaveBeenCalledWith({
      where: {
        targetChatId: 'chat-1',
        remoteMessageId: 'mid-broadcast-1',
      },
      select: {
        id: true,
      },
    });
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
  });

  it('does not auto-delete scheduled night mode notice from own bot', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            nightModeEnabled: true,
            nightModeStartTimeMinutes: 23 * 60,
            nightModeEndTimeMinutes: 8 * 60,
            nightModeTimezone: 'Europe/Moscow',
            nightModeBotMessageEnabled: true,
            nightModeBotMessageText: '',
            deleteBotMessagesEnabled: true,
            deleteBotMessagesDelayMinutes: 2,
          }),
          domains: [],
          admins: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      globalSpammer: {
        upsert: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
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
      undefined,
      undefined,
      {
        get: jest.fn().mockReturnValue('bot-1'),
      } as never,
    );

    await service.handleUpdate({
      updateId: 'upd-night-own-bot-1',
      type: 'message_created',
      message: {
        messageId: 'msg-night-own-bot-1',
        chatId: 'chat-1',
        senderId: 'bot-1',
        text: nightModeNotice('23:00-08:00', 'Москва'),
        createdAt: new Date().toISOString(),
      },
      raw: {
        message: {
          sender: {
            id: 'bot-1',
            type: 'bot',
            is_bot: true,
          },
        },
      },
    });

    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('does not auto-delete scheduled night mode open notice from own bot', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            nightModeEnabled: true,
            nightModeStartTimeMinutes: 23 * 60,
            nightModeEndTimeMinutes: 8 * 60,
            nightModeTimezone: 'Europe/Moscow',
            nightModeOpenMessageEnabled: true,
            nightModeOpenMessageText: '',
            deleteBotMessagesEnabled: true,
            deleteBotMessagesDelayMinutes: 2,
          }),
          domains: [],
          admins: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      globalSpammer: {
        upsert: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
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
      undefined,
      undefined,
      {
        get: jest.fn().mockReturnValue('bot-1'),
      } as never,
    );

    await service.handleUpdate({
      updateId: 'upd-night-open-own-bot-1',
      type: 'message_created',
      message: {
        messageId: 'msg-night-open-own-bot-1',
        chatId: 'chat-1',
        senderId: 'bot-1',
        text: nightModeOpenNotice(),
        createdAt: new Date().toISOString(),
      },
      raw: {
        message: {
          sender: {
            id: 'bot-1',
            type: 'bot',
            is_bot: true,
          },
        },
      },
    });

    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('adds user to global spammer registry and kicks on fifth unique chat in 2 minutes when toggle is enabled', async () => {
    const nowIso = new Date().toISOString();
    const createSpamUpdate = (chatId: string, messageId: string, text: string): MaxUpdate => ({
      updateId: `upd-${chatId}-${messageId}`,
      type: 'message_created',
      message: {
        messageId,
        chatId,
        senderId: 'user-spam-1',
        senderName: 'Спамер',
        text,
        createdAt: nowIso,
      },
      raw: {
        message: {
          sender: {
            id: 'user-spam-1',
            type: 'user',
          },
          body: {
            text,
          },
        },
      },
    });

    const prisma = {
      chat: {
        upsert: jest.fn().mockImplementation(({ where }: { where: { id: string } }) =>
          Promise.resolve({
            id: where.id,
            title: `Chat ${where.id}`,
            settings: createSettings({ deleteSpammersEnabled: true }),
            domains: [],
            admins: [{ userId: 'owner-1' }],
          }),
        ),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      globalSpammer: {
        upsert: jest.fn(),
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({ violations: [] }),
      hasCommercialSpamMarkers: jest.fn().mockReturnValue(false),
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
    const redisCounter = {
      addToSetWithTtl: jest
        .fn()
        .mockResolvedValueOnce({ added: true, size: 1 })
        .mockResolvedValueOnce({ added: true, size: 2 })
        .mockResolvedValueOnce({ added: true, size: 3 })
        .mockResolvedValueOnce({ added: true, size: 4 })
        .mockResolvedValueOnce({ added: true, size: 5 }),
      incrementWithTtl: jest.fn().mockResolvedValue(1),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      {
        get: jest.fn().mockReturnValue('bot-1'),
      } as never,
      redisCounter as never,
    );

    await service.handleUpdate(createSpamUpdate('chat-1', 'msg-1', 'Текст 1'));
    await service.handleUpdate(createSpamUpdate('chat-2', 'msg-2', 'Текст 2'));
    await service.handleUpdate(createSpamUpdate('chat-3', 'msg-3', 'Текст 3'));
    await service.handleUpdate(createSpamUpdate('chat-4', 'msg-4', 'Текст 4'));
    await service.handleUpdate(createSpamUpdate('chat-5', 'msg-5', 'Текст 5'));

    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(maxClient.sendMessage).toHaveBeenCalledWith('chat-4', expect.stringContaining('(1/2)'));
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-5', 'msg-5');
    expect(maxClient.kickMember).toHaveBeenCalledWith('chat-5', 'user-spam-1');
    expect(prisma.globalSpammer.upsert).toHaveBeenCalledWith({
      where: { userId: 'user-spam-1' },
      create: expect.objectContaining({
        userId: 'user-spam-1',
        lastReason: 'HIGH_FANOUT_5_CHATS_2M',
        lastChatId: 'chat-5',
      }),
      update: expect.objectContaining({
        lastReason: 'HIGH_FANOUT_5_CHATS_2M',
        lastChatId: 'chat-5',
      }),
    });
  });

  it('does not auto-kick on fifth unique chat when the sender is exempted by a chat admin', async () => {
    const nowIso = new Date().toISOString();
    const createSpamUpdate = (chatId: string, messageId: string, text: string): MaxUpdate => ({
      updateId: `upd-${chatId}-${messageId}`,
      type: 'message_created',
      message: {
        messageId,
        chatId,
        senderId: 'user-spam-1',
        senderName: 'Спамер',
        text,
        createdAt: nowIso,
      },
      raw: {
        message: {
          sender: {
            id: 'user-spam-1',
            type: 'user',
          },
          body: {
            text,
          },
        },
      },
    });

    const prisma = {
      chat: {
        upsert: jest.fn().mockImplementation(({ where }: { where: { id: string } }) =>
          Promise.resolve({
            id: where.id,
            title: `Chat ${where.id}`,
            settings: createSettings({ deleteSpammersEnabled: true }),
            domains: [],
            admins: [{ userId: 'owner-1' }],
          }),
        ),
      },
      adminGlobalSpammerExemption: {
        findMany: jest.fn().mockResolvedValue([{ userId: 'user-spam-1' }]),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      globalSpammer: {
        upsert: jest.fn(),
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({ violations: [] }),
      hasCommercialSpamMarkers: jest.fn().mockReturnValue(false),
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
    const redisCounter = {
      addToSetWithTtl: jest
        .fn()
        .mockResolvedValueOnce({ added: true, size: 1 })
        .mockResolvedValueOnce({ added: true, size: 2 })
        .mockResolvedValueOnce({ added: true, size: 3 })
        .mockResolvedValueOnce({ added: true, size: 4 })
        .mockResolvedValueOnce({ added: true, size: 5 }),
      incrementWithTtl: jest.fn().mockResolvedValue(1),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      {
        get: jest.fn().mockReturnValue('bot-1'),
      } as never,
      redisCounter as never,
    );

    await service.handleUpdate(createSpamUpdate('chat-1', 'msg-1', 'Текст 1'));
    await service.handleUpdate(createSpamUpdate('chat-2', 'msg-2', 'Текст 2'));
    await service.handleUpdate(createSpamUpdate('chat-3', 'msg-3', 'Текст 3'));
    await service.handleUpdate(createSpamUpdate('chat-4', 'msg-4', 'Текст 4'));
    await service.handleUpdate(createSpamUpdate('chat-5', 'msg-5', 'Текст 5'));

    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(prisma.globalSpammer.upsert).toHaveBeenCalledWith({
      where: { userId: 'user-spam-1' },
      create: expect.objectContaining({
        userId: 'user-spam-1',
        lastReason: 'HIGH_FANOUT_5_CHATS_2M',
        lastChatId: 'chat-5',
      }),
      update: expect.objectContaining({
        lastReason: 'HIGH_FANOUT_5_CHATS_2M',
        lastChatId: 'chat-5',
      }),
    });
  });

  it('adds user to global spammer registry on fifth unique chat without warning or kick when toggle is disabled', async () => {
    const nowIso = new Date().toISOString();
    const createSpamUpdate = (chatId: string, messageId: string, text: string): MaxUpdate => ({
      updateId: `upd-${chatId}-${messageId}`,
      type: 'message_created',
      message: {
        messageId,
        chatId,
        senderId: 'user-spam-1',
        senderName: 'Спамер',
        text,
        createdAt: nowIso,
      },
      raw: {
        message: {
          sender: {
            id: 'user-spam-1',
            type: 'user',
          },
          body: {
            text,
          },
        },
      },
    });

    const prisma = {
      chat: {
        upsert: jest.fn().mockImplementation(({ where }: { where: { id: string } }) =>
          Promise.resolve({
            id: where.id,
            title: `Chat ${where.id}`,
            settings: createSettings({ deleteSpammersEnabled: false }),
            domains: [],
            admins: [{ userId: 'owner-1' }],
          }),
        ),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      globalSpammer: {
        upsert: jest.fn(),
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({ violations: [] }),
      hasCommercialSpamMarkers: jest.fn().mockReturnValue(false),
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
    const redisCounter = {
      addToSetWithTtl: jest
        .fn()
        .mockResolvedValueOnce({ added: true, size: 1 })
        .mockResolvedValueOnce({ added: true, size: 2 })
        .mockResolvedValueOnce({ added: true, size: 3 })
        .mockResolvedValueOnce({ added: true, size: 4 })
        .mockResolvedValueOnce({ added: true, size: 5 }),
      incrementWithTtl: jest.fn().mockResolvedValue(1),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      {
        get: jest.fn().mockReturnValue('bot-1'),
      } as never,
      redisCounter as never,
    );

    await service.handleUpdate(createSpamUpdate('chat-1', 'msg-1', 'Текст 1'));
    await service.handleUpdate(createSpamUpdate('chat-2', 'msg-2', 'Текст 2'));
    await service.handleUpdate(createSpamUpdate('chat-3', 'msg-3', 'Текст 3'));
    await service.handleUpdate(createSpamUpdate('chat-4', 'msg-4', 'Текст 4'));
    await service.handleUpdate(createSpamUpdate('chat-5', 'msg-5', 'Текст 5'));

    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(prisma.globalSpammer.upsert).toHaveBeenCalledWith({
      where: { userId: 'user-spam-1' },
      create: expect.objectContaining({
        userId: 'user-spam-1',
        lastReason: 'HIGH_FANOUT_5_CHATS_2M',
        lastChatId: 'chat-5',
      }),
      update: expect.objectContaining({
        lastReason: 'HIGH_FANOUT_5_CHATS_2M',
        lastChatId: 'chat-5',
      }),
    });
  });

  it('does not send warning on fourth unique chat in 2 minutes when toggle is disabled', async () => {
    const nowIso = new Date().toISOString();
    const createSpamUpdate = (chatId: string, messageId: string, text: string): MaxUpdate => ({
      updateId: `upd-${chatId}-${messageId}`,
      type: 'message_created',
      message: {
        messageId,
        chatId,
        senderId: 'user-spam-1',
        senderName: 'Спамер',
        text,
        createdAt: nowIso,
      },
      raw: {
        message: {
          sender: {
            id: 'user-spam-1',
            type: 'user',
          },
          body: {
            text,
          },
        },
      },
    });

    const prisma = {
      chat: {
        upsert: jest.fn().mockImplementation(({ where }: { where: { id: string } }) =>
          Promise.resolve({
            id: where.id,
            title: `Chat ${where.id}`,
            settings: createSettings({ deleteSpammersEnabled: false }),
            domains: [],
            admins: [{ userId: 'owner-1' }],
          }),
        ),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      globalSpammer: {
        upsert: jest.fn(),
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({ violations: [] }),
      hasCommercialSpamMarkers: jest.fn().mockReturnValue(false),
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
    const redisCounter = {
      addToSetWithTtl: jest
        .fn()
        .mockResolvedValueOnce({ added: true, size: 1 })
        .mockResolvedValueOnce({ added: true, size: 2 })
        .mockResolvedValueOnce({ added: true, size: 3 })
        .mockResolvedValueOnce({ added: true, size: 4 }),
      incrementWithTtl: jest.fn().mockResolvedValue(1),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      {
        get: jest.fn().mockReturnValue('bot-1'),
      } as never,
      redisCounter as never,
    );

    await service.handleUpdate(createSpamUpdate('chat-1', 'msg-1', 'Добрый день, 1'));
    await service.handleUpdate(createSpamUpdate('chat-2', 'msg-2', 'Добрый день, 2'));
    await service.handleUpdate(createSpamUpdate('chat-3', 'msg-3', 'Добрый день, 3'));
    await service.handleUpdate(createSpamUpdate('chat-4', 'msg-4', 'Добрый день, 4'));

    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(prisma.globalSpammer.upsert).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
  });

  it('adds user to global spammer registry on repeated 4-chat fanout without warnings when toggle is disabled', async () => {
    const nowIso = new Date().toISOString();
    const createSpamUpdate = (chatId: string, messageId: string, text: string): MaxUpdate => ({
      updateId: `upd-${chatId}-${messageId}`,
      type: 'message_created',
      message: {
        messageId,
        chatId,
        senderId: 'user-spam-1',
        senderName: 'Спамер',
        text,
        createdAt: nowIso,
      },
      raw: {
        message: {
          sender: {
            id: 'user-spam-1',
            type: 'user',
          },
          body: {
            text,
          },
        },
      },
    });

    const prisma = {
      chat: {
        upsert: jest.fn().mockImplementation(({ where }: { where: { id: string } }) =>
          Promise.resolve({
            id: where.id,
            title: `Chat ${where.id}`,
            settings: createSettings({ deleteSpammersEnabled: false }),
            domains: [],
            admins: [{ userId: 'owner-1' }],
          }),
        ),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      globalSpammer: {
        upsert: jest.fn(),
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({ violations: [] }),
      hasCommercialSpamMarkers: jest.fn().mockReturnValue(false),
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
    const redisCounter = {
      addToSetWithTtl: jest
        .fn()
        .mockResolvedValueOnce({ added: true, size: 1 })
        .mockResolvedValueOnce({ added: true, size: 2 })
        .mockResolvedValueOnce({ added: true, size: 3 })
        .mockResolvedValueOnce({ added: true, size: 4 })
        .mockResolvedValueOnce({ added: true, size: 1 })
        .mockResolvedValueOnce({ added: true, size: 2 })
        .mockResolvedValueOnce({ added: true, size: 3 })
        .mockResolvedValueOnce({ added: true, size: 4 }),
      incrementWithTtl: jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      {
        get: jest.fn().mockReturnValue('bot-1'),
      } as never,
      redisCounter as never,
    );

    await service.handleUpdate(createSpamUpdate('chat-1', 'msg-1', 'Добрый день, команда 1'));
    await service.handleUpdate(createSpamUpdate('chat-2', 'msg-2', 'Добрый день, команда 2'));
    await service.handleUpdate(createSpamUpdate('chat-3', 'msg-3', 'Добрый день, команда 3'));
    await service.handleUpdate(createSpamUpdate('chat-4', 'msg-4', 'Добрый день, команда 4'));
    await service.handleUpdate(createSpamUpdate('chat-5', 'msg-5', 'Добрый день, команда 5'));
    await service.handleUpdate(createSpamUpdate('chat-6', 'msg-6', 'Добрый день, команда 6'));
    await service.handleUpdate(createSpamUpdate('chat-7', 'msg-7', 'Добрый день, команда 7'));
    await service.handleUpdate(createSpamUpdate('chat-8', 'msg-8', 'Добрый день, команда 8'));

    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(prisma.globalSpammer.upsert).toHaveBeenCalledWith({
      where: { userId: 'user-spam-1' },
      create: expect.objectContaining({
        userId: 'user-spam-1',
        lastReason: 'HIGH_FANOUT_4_CHATS_WARN_THRESHOLD',
        lastChatId: 'chat-8',
      }),
      update: expect.objectContaining({
        lastReason: 'HIGH_FANOUT_4_CHATS_WARN_THRESHOLD',
        lastChatId: 'chat-8',
      }),
    });
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
  });

  it('adds user to global spammer registry on second warning after repeated 4-chat fanout', async () => {
    const nowIso = new Date().toISOString();
    const createSpamUpdate = (chatId: string, messageId: string, text: string): MaxUpdate => ({
      updateId: `upd-${chatId}-${messageId}`,
      type: 'message_created',
      message: {
        messageId,
        chatId,
        senderId: 'user-spam-1',
        senderName: 'Спамер',
        text,
        createdAt: nowIso,
      },
      raw: {
        message: {
          sender: {
            id: 'user-spam-1',
            type: 'user',
          },
          body: {
            text,
          },
        },
      },
    });

    const prisma = {
      chat: {
        upsert: jest.fn().mockImplementation(({ where }: { where: { id: string } }) =>
          Promise.resolve({
            id: where.id,
            title: `Chat ${where.id}`,
            settings: createSettings({ deleteSpammersEnabled: true }),
            domains: [],
            admins: [{ userId: 'owner-1' }],
          }),
        ),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      globalSpammer: {
        upsert: jest.fn(),
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({ violations: [] }),
      hasCommercialSpamMarkers: jest.fn().mockReturnValue(false),
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
    const redisCounter = {
      addToSetWithTtl: jest
        .fn()
        .mockResolvedValueOnce({ added: true, size: 1 })
        .mockResolvedValueOnce({ added: true, size: 2 })
        .mockResolvedValueOnce({ added: true, size: 3 })
        .mockResolvedValueOnce({ added: true, size: 4 })
        .mockResolvedValueOnce({ added: true, size: 1 })
        .mockResolvedValueOnce({ added: true, size: 2 })
        .mockResolvedValueOnce({ added: true, size: 3 })
        .mockResolvedValueOnce({ added: true, size: 4 }),
      incrementWithTtl: jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      {
        get: jest.fn().mockReturnValue('bot-1'),
      } as never,
      redisCounter as never,
    );

    await service.handleUpdate(createSpamUpdate('chat-1', 'msg-1', 'Добрый день, команда 1'));
    await service.handleUpdate(createSpamUpdate('chat-2', 'msg-2', 'Добрый день, команда 2'));
    await service.handleUpdate(createSpamUpdate('chat-3', 'msg-3', 'Добрый день, команда 3'));
    await service.handleUpdate(createSpamUpdate('chat-4', 'msg-4', 'Добрый день, команда 4'));
    await service.handleUpdate(createSpamUpdate('chat-5', 'msg-5', 'Добрый день, команда 5'));
    await service.handleUpdate(createSpamUpdate('chat-6', 'msg-6', 'Добрый день, команда 6'));
    await service.handleUpdate(createSpamUpdate('chat-7', 'msg-7', 'Добрый день, команда 7'));
    await service.handleUpdate(createSpamUpdate('chat-8', 'msg-8', 'Добрый день, команда 8'));

    expect(maxClient.sendMessage).toHaveBeenCalledTimes(2);
    expect(maxClient.sendMessage).toHaveBeenNthCalledWith(
      1,
      'chat-4',
      expect.stringContaining('(1/2)'),
    );
    expect(maxClient.sendMessage).toHaveBeenNthCalledWith(
      2,
      'chat-8',
      expect.stringContaining('(2/2)'),
    );
    expect(prisma.globalSpammer.upsert).toHaveBeenCalledWith({
      where: { userId: 'user-spam-1' },
      create: expect.objectContaining({
        userId: 'user-spam-1',
        lastReason: 'HIGH_FANOUT_4_CHATS_WARN_THRESHOLD',
        lastChatId: 'chat-8',
      }),
      update: expect.objectContaining({
        lastReason: 'HIGH_FANOUT_4_CHATS_WARN_THRESHOLD',
        lastChatId: 'chat-8',
      }),
    });
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
  });

  it('removes bot-authored accounts from group when toggle is enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ removeBotsFromGroupEnabled: true }),
          domains: [],
          admins: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      globalSpammer: {
        upsert: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
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

    await service.handleUpdate(createBotAuthoredUpdate());

    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-bot-1');
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(maxClient.kickMember).toHaveBeenCalledWith('chat-1', 'bot-1');
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'bot-1',
        messageId: 'msg-bot-1',
        ruleCode: 'BOT_ACCOUNT_KICK',
        action: SanctionAction.KICK,
      }),
    });
  });

  it('auto-leaves chats from join denylist on bot_added update', async () => {
    const prisma = {
      chatAdminAllowlist: {
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {};
    const maxClient = {
      leaveCurrentChat: jest.fn().mockResolvedValue(undefined),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
    };
    const configService = {
      get: jest.fn((key: string) =>
        key === 'MAX_JOIN_DENY_CHAT_IDS' ? 'chat-1,chat-2' : undefined,
      ),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      chatContextCache as never,
      undefined,
      configService as never,
    );

    await service.handleUpdate(createBotAddedUpdate());

    expect(maxClient.leaveCurrentChat).toHaveBeenCalledWith('chat-1');
    expect(prisma.chatAdminAllowlist.deleteMany).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-1',
      },
    });
    expect(chatContextCache.invalidate).toHaveBeenCalledWith('chat-1');
    expect(ruleEngine.detect).not.toHaveBeenCalled();
  });

  it('kicks bots immediately from service join events when toggle is enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ removeBotsFromGroupEnabled: true }),
          domains: [],
          admins: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
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

    await service.handleUpdate(createServiceBotJoinedUpdate());

    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(maxClient.kickMember).toHaveBeenCalledWith('chat-1', 'bot-joined-1');
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'bot-joined-1',
        messageId: 'msg-service-bot-join-1',
        ruleCode: 'BOT_ACCOUNT_KICK',
        action: SanctionAction.KICK,
      }),
    });
  });

  it('sends greeting message for joined human members when greeting is enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            greetingEnabled: true,
            greetingBotMessageEnabled: true,
            greetingBotMessageText: 'Добро пожаловать, {user}! {greeting}.',
          }),
          domains: [],
          admins: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
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

    await service.handleUpdate(createServiceUserJoinedUpdate());

    expect(ruleEngine.detect).not.toHaveBeenCalled();
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      `Добро пожаловать, ${boldUser('Новый участник')}! добро пожаловать в чат.`,
    );
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-black-2',
        messageId: 'msg-service-user-join-1',
        ruleCode: 'GREETING_MESSAGE',
        action: SanctionAction.NONE,
      }),
    });
  });

  it('auto-deletes greeting message when greeting delete toggle is enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            greetingEnabled: true,
            greetingBotMessageEnabled: true,
            greetingDeleteBotMessageEnabled: true,
            greetingBotMessageText: 'Добро пожаловать, {user}! {greeting}.',
            deleteBotMessagesEnabled: false,
            deleteBotMessagesDelayMinutes: 0.5,
          }),
          domains: [],
          admins: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      sendMessageImmediateWithId: jest.fn().mockResolvedValue({
        messageId: 'msg-greeting-autodelete-1',
        url: null,
      }),
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

    await service.handleUpdate(createServiceUserJoinedUpdate());

    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-greeting-autodelete-1', {
      delayMs: 30_000,
    });
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-black-2',
        ruleCode: 'GREETING_MESSAGE',
        metadata: expect.objectContaining({
          sentMessageId: 'msg-greeting-autodelete-1',
        }),
      }),
    });
  });

  it('stores greeting sent message id when auto-delete for own bot messages is enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            greetingEnabled: true,
            greetingBotMessageEnabled: true,
            greetingBotMessageText: 'Добро пожаловать, {user}! {greeting}.',
            deleteBotMessagesEnabled: true,
            deleteBotMessagesDelayMinutes: 2,
          }),
          domains: [],
          admins: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      sendMessageImmediateWithId: jest.fn().mockResolvedValue({
        messageId: 'msg-greeting-sent-1',
        url: null,
      }),
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

    await service.handleUpdate(createServiceUserJoinedUpdate());

    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      'chat-1',
      `Добро пожаловать, ${boldUser('Новый участник')}! добро пожаловать в чат.`,
      expect.objectContaining({
        textFormat: 'markdown',
      }),
    );
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-black-2',
        messageId: 'msg-service-user-join-1',
        ruleCode: 'GREETING_MESSAGE',
        action: SanctionAction.NONE,
        metadata: expect.objectContaining({
          reason: 'Greeting message sent for joined member',
          sentMessageId: 'msg-greeting-sent-1',
        }),
      }),
    });
  });

  it('sends greeting message for service join event wrapped in data.message envelope', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            greetingEnabled: true,
            greetingBotMessageEnabled: true,
            greetingBotMessageText: 'Добро пожаловать, {user}! {greeting}.',
          }),
          domains: [],
          admins: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
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

    await service.handleUpdate(createServiceUserJoinedUpdateInDataEnvelope());

    expect(ruleEngine.detect).not.toHaveBeenCalled();
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      `Добро пожаловать, ${boldUser('Новый участник из data')}! добро пожаловать в чат.`,
    );
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-envelope-2',
        messageId: 'msg-service-user-join-envelope-1',
        ruleCode: 'GREETING_MESSAGE',
        action: SanctionAction.NONE,
      }),
    });
  });

  it('sends greeting message when service sender marker is absent but new_members exists', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            greetingEnabled: true,
            greetingBotMessageEnabled: true,
            greetingBotMessageText: 'Добро пожаловать, {user}! {greeting}.',
          }),
          domains: [],
          admins: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
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

    await service.handleUpdate(createServiceUserJoinedUpdateWithoutServiceSender());

    expect(ruleEngine.detect).not.toHaveBeenCalled();
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      `Добро пожаловать, ${boldUser('Новый участник без sender')}! добро пожаловать в чат.`,
    );
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-no-sender-2',
        messageId: 'msg-service-user-join-no-sender-1',
        ruleCode: 'GREETING_MESSAGE',
        action: SanctionAction.NONE,
      }),
    });
  });

  it('sends greeting message for user_added update', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            greetingEnabled: true,
            greetingBotMessageEnabled: true,
            greetingBotMessageText: 'Добро пожаловать, {user}! {greeting}.',
          }),
          domains: [],
          admins: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
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

    await service.handleUpdate(createUserAddedUpdate());

    expect(ruleEngine.detect).not.toHaveBeenCalled();
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      `Добро пожаловать, ${boldUser('Новый участник user_added')}! добро пожаловать в чат.`,
    );
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-added-1',
        messageId: 'user_added:upd-user-added-1',
        ruleCode: 'GREETING_MESSAGE',
        action: SanctionAction.NONE,
      }),
    });
  });

  it('skips moderation flow for user_removed update', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn(),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
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

    await service.handleUpdate(createUserRemovedUpdate());

    expect(prisma.chat.upsert).not.toHaveBeenCalled();
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(maxClient.notifyModerators).not.toHaveBeenCalled();
  });

  it('skips moderation flow for bot_removed update', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn(),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
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

    await service.handleUpdate(createBotRemovedUpdate());

    expect(prisma.chat.upsert).not.toHaveBeenCalled();
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(maxClient.notifyModerators).not.toHaveBeenCalled();
  });

  it('opens private menu for personal bot_started update and skips moderation flow', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn(),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
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

    await service.handleUpdate(createBotStartedPrivateUpdate());

    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      '152517912',
      expect.stringContaining('Центр управления MAX'),
      expect.objectContaining({
        buttons: expect.any(Array),
      }),
    );
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(prisma.chat.upsert).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('skips the long instruction for broadcast handoff bot_started update', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn(),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
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
    const privateControlService = {
      handleBotStarted: jest.fn().mockResolvedValue(undefined),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      undefined,
      undefined,
      privateControlService as never,
    );

    const update = createBotStartedPrivateHandoffUpdate();

    await service.handleUpdate(update);

    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(privateControlService.handleBotStarted).toHaveBeenCalledWith(update);
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(prisma.chat.upsert).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('skips the long instruction for giveaway handoff bot_started update', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn(),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
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
    const privateControlService = {
      handleBotStarted: jest.fn().mockResolvedValue(undefined),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      undefined,
      undefined,
      privateControlService as never,
    );

    const update = createBotStartedPrivateHandoffUpdate('ggh-test-payload');

    await service.handleUpdate(update);

    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(privateControlService.handleBotStarted).toHaveBeenCalledWith(update);
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(prisma.chat.upsert).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('does not send instruction for group bot_started update and skips moderation flow', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn(),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
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

    await service.handleUpdate(createBotStartedGroupUpdate());

    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(prisma.chat.upsert).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('handles /menu in private chat without moderation flow', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn(),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
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
      answerCallback: jest.fn(),
      listBotChats: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      {
        get: jest.fn((key: string) => {
          if (key === 'MAX_BOT_ID') {
            return '777000_bot';
          }

          if (key === 'APP_BASE_URL') {
            return 'https://maxim.play-team.ru';
          }

          return undefined;
        }),
      } as never,
    );

    await service.handleUpdate(createPrivateCommandUpdate('/menu'));

    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      '152517912',
      expect.stringContaining('Центр управления MAX'),
      expect.objectContaining({
        buttons: expect.any(Array),
      }),
    );
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      '152517912',
      expect.any(String),
      expect.objectContaining({
        buttons: expect.arrayContaining([
          expect.arrayContaining([
            expect.objectContaining({ type: 'callback', text: 'Чаты' }),
            expect.objectContaining({ type: 'callback', text: 'Каналы' }),
          ]),
          expect.arrayContaining([
            expect.objectContaining({
              type: 'link',
              text: 'Открыть приложение',
              url: expect.stringContaining('https://max.ru/777000_bot?startapp='),
            }),
          ]),
        ]),
      }),
    );
    expect(prisma.chat.upsert).not.toHaveBeenCalled();
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('handles plain text in private chat and returns menu', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn(),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
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
      answerCallback: jest.fn(),
      listBotChats: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createPrivateCommandUpdate('привет'));

    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      '152517912',
      expect.stringContaining('Центр управления MAX'),
      expect.objectContaining({
        buttons: expect.any(Array),
      }),
    );
    expect(prisma.chat.upsert).not.toHaveBeenCalled();
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('handles attachment-only message in private chat and returns menu', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn(),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
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
      answerCallback: jest.fn(),
      listBotChats: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createPrivateCommandUpdate(''));

    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      '152517912',
      expect.stringContaining('Центр управления MAX'),
      expect.objectContaining({
        buttons: expect.any(Array),
      }),
    );
    expect(prisma.chat.upsert).not.toHaveBeenCalled();
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('handles callback menu command in private chat and returns chats list', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn(),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
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
      answerCallback: jest.fn(),
      listBotChats: jest.fn().mockResolvedValue([
        {
          chatId: '-70000000000001',
          title: 'Тестовый чат 1',
          lastEventTime: null,
        },
        {
          chatId: '-70000000000002',
          title: 'Тестовый чат 2',
          lastEventTime: null,
        },
      ]),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createPrivateCallbackUpdate('private_menu:chats'));

    expect(maxClient.answerCallback).toHaveBeenCalledWith('callback-1', 'Собираю список чатов');
    expect(maxClient.listBotChats).toHaveBeenCalledTimes(1);
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      '152517912',
      expect.stringContaining('Чаты с ботом: 2'),
      expect.objectContaining({
        buttons: expect.any(Array),
      }),
    );
    expect(prisma.chat.upsert).not.toHaveBeenCalled();
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('does not send greeting message when greeting toggle is disabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            greetingEnabled: false,
            greetingBotMessageEnabled: true,
          }),
          domains: [],
          admins: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
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

    await service.handleUpdate(createServiceUserJoinedUpdate());

    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('temporarily disables greeting messages for one hour after more than three joins in one minute', async () => {
    const redisCounter = {
      getString: jest.fn().mockResolvedValue(null),
      incrementByWithTtl: jest
        .fn()
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(3)
        .mockResolvedValueOnce(4),
      setStringWithTtl: jest.fn().mockResolvedValue(undefined),
    };
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            greetingEnabled: true,
            greetingBotMessageEnabled: true,
            greetingBotMessageText: 'Добро пожаловать, {user}! {greeting}.',
          }),
          domains: [],
          admins: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
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
      undefined,
      undefined,
      undefined,
      redisCounter as never,
    );

    await service.handleUpdate(createUserAddedUpdateWithSuffix(1));
    await service.handleUpdate(createUserAddedUpdateWithSuffix(2));
    await service.handleUpdate(createUserAddedUpdateWithSuffix(3));
    await service.handleUpdate(createUserAddedUpdateWithSuffix(4));

    expect(maxClient.sendMessage).toHaveBeenCalledTimes(3);
    expect(redisCounter.incrementByWithTtl).toHaveBeenNthCalledWith(
      4,
      'greeting-burst:v1:chat-1',
      1,
      60,
    );
    expect(redisCounter.setStringWithTtl).toHaveBeenCalledWith(
      'greeting-disabled:v1:chat-1',
      expect.any(String),
      60 * 60,
    );
  });

  it('skips greeting messages while hidden auto-disable window is active', async () => {
    const redisCounter = {
      getString: jest.fn().mockResolvedValue('2026-03-18T10:00:00.000Z'),
      incrementByWithTtl: jest.fn(),
      setStringWithTtl: jest.fn(),
    };
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            greetingEnabled: true,
            greetingBotMessageEnabled: true,
            greetingBotMessageText: 'Добро пожаловать, {user}! {greeting}.',
          }),
          domains: [],
          admins: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
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
      undefined,
      undefined,
      undefined,
      redisCounter as never,
    );

    await service.handleUpdate(createUserAddedUpdateWithSuffix('blocked'));

    expect(redisCounter.getString).toHaveBeenCalledWith('greeting-disabled:v1:chat-1');
    expect(redisCounter.incrementByWithTtl).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('kicks and deletes message from globally blacklisted sender when toggle is enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            deleteSpammersEnabled: true,
            greetingEnabled: true,
            greetingBotMessageEnabled: true,
            greetingBotMessageText: 'Добро пожаловать, {user}! {greeting}.',
          }),
          domains: [],
          admins: [],
        }),
      },
      globalSpammer: {
        findUnique: jest.fn().mockResolvedValue({ userId: 'user-1' }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
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

    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-1');
    expect(maxClient.kickMember).toHaveBeenCalledWith('chat-1', 'user-1');
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'msg-1',
        ruleCode: 'GLOBAL_SPAMMER_KICK',
        action: SanctionAction.KICK,
      }),
    });
  });

  it('does not auto-kick an exempted globally blacklisted sender', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ deleteSpammersEnabled: true }),
          domains: [],
          admins: [{ userId: 'owner-1' }],
        }),
      },
      adminGlobalSpammerExemption: {
        findMany: jest.fn().mockResolvedValue([{ userId: 'user-1' }]),
      },
      globalSpammer: {
        findUnique: jest.fn().mockResolvedValue({ userId: 'user-1' }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({ violations: [] }),
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

    expect(ruleEngine.detect).toHaveBeenCalledTimes(1);
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('kicks globally blacklisted user on service join event when toggle is enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ deleteSpammersEnabled: true }),
          domains: [],
          admins: [],
        }),
      },
      globalSpammer: {
        findMany: jest.fn().mockResolvedValue([{ userId: 'user-black-2' }]),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
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

    await service.handleUpdate(createServiceUserJoinedUpdate());

    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.kickMember).toHaveBeenCalledWith('chat-1', 'user-black-2');
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-black-2',
        messageId: 'msg-service-user-join-1',
        ruleCode: 'GLOBAL_SPAMMER_KICK',
        action: SanctionAction.KICK,
      }),
    });
  });

  it('does not auto-kick an exempted globally blacklisted user on service join event', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ deleteSpammersEnabled: true }),
          domains: [],
          admins: [{ userId: 'owner-1' }],
        }),
      },
      adminGlobalSpammerExemption: {
        findMany: jest.fn().mockResolvedValue([{ userId: 'user-black-2' }]),
      },
      globalSpammer: {
        findMany: jest.fn().mockResolvedValue([{ userId: 'user-black-2' }]),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
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

    await service.handleUpdate(createServiceUserJoinedUpdate());

    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('deletes messages silently while 6h active mute is in effect', async () => {
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
        findFirst: jest.fn().mockResolvedValue({
          id: 'ban-1',
          createdAt: new Date(Date.now() - 5 * 60 * 1000),
          action: SanctionAction.BAN,
          ruleCode: 'DUPLICATE_BAN',
          metadata: { banDurationHours: 6 },
        }),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
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

    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-1');
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'msg-1',
        ruleCode: 'MUTE_ACTIVE_DELETE',
        action: SanctionAction.DELETE_MESSAGE,
      }),
    });
  });

  it('does not keep deleting messages after a later manual unban', async () => {
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
        findFirst: jest.fn().mockResolvedValue({
          id: 'unban-1',
          createdAt: new Date(Date.now() - 2 * 60 * 1000),
          action: SanctionAction.NONE,
          ruleCode: 'MANUAL_UNBAN',
          metadata: null,
        }),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({ violations: [] }),
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

    expect(ruleEngine.detect).toHaveBeenCalledTimes(1);
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('resets link escalation window after a later manual unban', async () => {
    const prisma = {
      violation: {
        count: jest.fn().mockResolvedValue(1),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue({
          createdAt: new Date('2026-03-25T10:00:00.000Z'),
        }),
      },
    };

    const service = new ModerationService(prisma as never, {} as never, {} as never, {} as never);

    const result = await (
      service as unknown as {
        countRecentLinkViolations: (chatId: string, userId: string) => Promise<number>;
      }
    ).countRecentLinkViolations('chat-1', 'user-1');

    expect(result).toBe(1);
    expect(prisma.violation.count).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-1',
        userId: 'user-1',
        ruleCode: 'LINK_BLOCKED',
        createdAt: {
          gte: new Date('2026-03-25T10:00:00.000Z'),
        },
      },
    });
  });

  it('suppresses duplicate escalation while a later manual unban is still inside the duplicate window', async () => {
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
        findFirst: jest.fn().mockResolvedValue({
          action: SanctionAction.NONE,
          ruleCode: 'MANUAL_UNBAN',
          metadata: null,
          createdAt: new Date(Date.now() - 60 * 60 * 1000),
        }),
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
          action: 'MUTE',
          count: 3,
          threshold: 3,
          windowSec: 24 * 60 * 60,
          hash: 'dup-after-unban',
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

    expect(ruleEngine.detect).toHaveBeenCalledTimes(1);
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('honors manual ban durations above 36 hours from moderation metadata', async () => {
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
        findFirst: jest.fn().mockResolvedValue({
          id: 'ban-72h-1',
          createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
          action: SanctionAction.BAN,
          ruleCode: 'MANUAL_BAN',
          metadata: {
            muteDurationHours: 72,
          },
        }),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
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

    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-1');
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'msg-1',
        ruleCode: 'MUTE_ACTIVE_DELETE',
        action: SanctionAction.DELETE_MESSAGE,
      }),
    });
  });

  it('deletes messages during night mode silently when bot notice is disabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            nightModeEnabled: true,
            nightModeStartTimeMinutes: 0,
            nightModeEndTimeMinutes: 0,
            nightModeBotMessageEnabled: false,
          }),
          domains: [],
          admins: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
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

    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-1');
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'msg-1',
        ruleCode: 'NIGHT_MODE_DELETE',
        action: SanctionAction.DELETE_MESSAGE,
      }),
    });
  });

  it('sends night mode notice before deleting the first blocked message in an active window', async () => {
    const nowParts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Moscow',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date());
    const currentHour = Number(nowParts.find((item) => item.type === 'hour')?.value ?? '0');
    const currentMinute = Number(nowParts.find((item) => item.type === 'minute')?.value ?? '0');
    const currentMinutes = currentHour * 60 + currentMinute;
    const startMinutes = (currentMinutes + 23 * 60) % (24 * 60);
    const endMinutes = (currentMinutes + 60) % (24 * 60);

    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            nightModeEnabled: true,
            nightModeStartTimeMinutes: startMinutes,
            nightModeEndTimeMinutes: endMinutes,
            nightModeTimezone: 'Europe/Moscow',
            nightModeBotMessageEnabled: true,
            nightModeBotMessageText: '',
          }),
          domains: [],
          admins: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
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

    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(maxClient.sendMessage.mock.invocationCallOrder[0]).toBeLessThan(
      maxClient.deleteMessage.mock.invocationCallOrder[0],
    );
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-1');
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      expect.stringContaining('Ночной режим, граждане'),
    );
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'system',
        ruleCode: 'NIGHT_MODE_NOTICE',
        action: SanctionAction.NONE,
        metadata: expect.objectContaining({
          reason: 'Night mode notice sent before blocked message',
          sourceMessageId: 'msg-1',
        }),
      }),
    });
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'msg-1',
        ruleCode: 'NIGHT_MODE_DELETE',
        action: SanctionAction.DELETE_MESSAGE,
      }),
    });
  });

  it('adds a comments button to the night mode notice when enabled for the chat', async () => {
    const nowParts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Moscow',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date());
    const currentHour = Number(nowParts.find((item) => item.type === 'hour')?.value ?? '0');
    const currentMinute = Number(nowParts.find((item) => item.type === 'minute')?.value ?? '0');
    const currentMinutes = currentHour * 60 + currentMinute;
    const startMinutes = (currentMinutes + 23 * 60) % (24 * 60);
    const endMinutes = (currentMinutes + 60) % (24 * 60);

    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            nightModeEnabled: true,
            nightModeStartTimeMinutes: startMinutes,
            nightModeEndTimeMinutes: endMinutes,
            nightModeTimezone: 'Europe/Moscow',
            nightModeBotMessageEnabled: true,
            nightModeBotMessageText: '',
            commentsEnabled: true,
            nightModeCommentsEnabled: true,
          }),
          domains: [],
          admins: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
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

    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      expect.stringContaining('Ночной режим, граждане'),
      expect.objectContaining({
        buttons: [
          [
            expect.objectContaining({
              text: expect.stringContaining('💬 Комментарии'),
            }),
          ],
        ],
      }),
    );
  });

  it('deduplicates concurrent night mode notice attempts across service instances', async () => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const redisLocks = new Map<string, string>();
    const prisma = {
      moderationEvent: {
        findFirst: jest.fn().mockImplementation(async () => {
          await sleep(25);
          return null;
        }),
        create: jest.fn().mockImplementation(async () => {
          await sleep(25);
          return undefined;
        }),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const maxClient = {
      sendMessage: jest.fn().mockImplementation(async () => {
        await sleep(25);
      }),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const redisCounter = {
      getString: jest.fn().mockResolvedValue(null),
      setStringWithTtl: jest.fn().mockResolvedValue(undefined),
      acquireLock: jest.fn().mockImplementation(async (key: string) => {
        if (redisLocks.has(key)) {
          return null;
        }

        const token = `lock-${redisLocks.size + 1}`;
        redisLocks.set(key, token);
        return token;
      }),
      releaseLock: jest.fn().mockImplementation(async (key: string, token: string) => {
        if (redisLocks.get(key) === token) {
          redisLocks.delete(key);
        }
      }),
    };

    const serviceA = new ModerationService(
      prisma as never,
      {} as never,
      {} as never,
      maxClient as never,
      undefined,
      undefined,
      undefined,
      redisCounter as never,
    );
    const serviceB = new ModerationService(
      prisma as never,
      {} as never,
      {} as never,
      maxClient as never,
      undefined,
      undefined,
      undefined,
      redisCounter as never,
    );

    const params = {
      chatId: 'chat-1',
      startMinutes: 23 * 60,
      endMinutes: 8 * 60,
      timezone: 'Europe/Moscow',
      botSpeechStyle: null,
      nightModeBotMessageText: '',
      commentsEnabled: false,
      nightModeCommentsEnabled: false,
      nightModeBotButtonEnabled: false,
      nightModeBotButtonUrl: '',
      nightModeBotButtonText: 'Открыть',
      reason: 'concurrent-race-check',
    };

    await Promise.all([
      (
        serviceA as unknown as {
          sendNightModeClosedNoticeIfNeeded: (params: Record<string, unknown>) => Promise<void>;
        }
      ).sendNightModeClosedNoticeIfNeeded(params),
      (
        serviceB as unknown as {
          sendNightModeClosedNoticeIfNeeded: (params: Record<string, unknown>) => Promise<void>;
        }
      ).sendNightModeClosedNoticeIfNeeded(params),
    ]);

    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(1);
    expect(redisCounter.acquireLock).toHaveBeenCalledTimes(2);
    expect(redisCounter.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('deletes messages during manual group close silently', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            nightModeForceCloseEnabled: true,
            nightModeForceCloseForever: false,
            nightModeForceCloseDays: 0,
            nightModeForceCloseHours: 4,
            nightModeForceCloseUntil: new Date(Date.now() + 4 * 60 * 60 * 1_000).toISOString(),
          }),
          domains: [],
          admins: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
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

    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-1');
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'msg-1',
        ruleCode: 'MANUAL_GROUP_CLOSE_DELETE',
        action: SanctionAction.DELETE_MESSAGE,
      }),
    });
  });

  it('sends scheduled night closed notice once per active window', async () => {
    let noticeCreated = false;
    const nowParts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Moscow',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date());
    const currentHour = Number(nowParts.find((item) => item.type === 'hour')?.value ?? '0');
    const currentMinute = Number(nowParts.find((item) => item.type === 'minute')?.value ?? '0');
    const startMinutes = currentHour * 60 + currentMinute;
    const endMinutes = (startMinutes + 60) % (24 * 60);

    const prisma = {
      chatSettings: {
        findMany: jest.fn().mockResolvedValue([
          {
            chatId: 'chat-1',
            botSpeechStyle: null,
            nightModeStartTimeMinutes: startMinutes,
            nightModeEndTimeMinutes: endMinutes,
            nightModeTimezone: 'Europe/Moscow',
            nightModeBotMessageEnabled: true,
            nightModeBotMessageText: '',
            nightModeOpenMessageEnabled: true,
            nightModeOpenMessageText: '',
            nightModeBotButtonEnabled: false,
            nightModeBotButtonUrl: '',
            nightModeBotButtonText: 'Открыть',
          },
        ]),
      },
      moderationEvent: {
        findFirst: jest.fn().mockImplementation((query: { where?: Record<string, unknown> }) => {
          if (query.where?.ruleCode === 'NIGHT_MODE_NOTICE') {
            return Promise.resolve(noticeCreated ? { id: 'evt-night-notice-1' } : null);
          }

          return Promise.resolve(null);
        }),
        create: jest.fn().mockImplementation((payload: { data: { ruleCode?: string } }) => {
          if (payload.data.ruleCode === 'NIGHT_MODE_NOTICE') {
            noticeCreated = true;
          }
          return Promise.resolve(payload);
        }),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
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

    await (
      service as unknown as { processNightModeAnnouncements: () => Promise<void> }
    ).processNightModeAnnouncements();
    await (
      service as unknown as { processNightModeAnnouncements: () => Promise<void> }
    ).processNightModeAnnouncements();

    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      expect.stringContaining('Ночной режим, граждане'),
    );
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        ruleCode: 'NIGHT_MODE_NOTICE',
        action: SanctionAction.NONE,
      }),
    });
  });

  it('includes the rules button in scheduled night closed notice when enabled', async () => {
    let noticeCreated = false;
    const nowParts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Moscow',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date());
    const currentHour = Number(nowParts.find((item) => item.type === 'hour')?.value ?? '0');
    const currentMinute = Number(nowParts.find((item) => item.type === 'minute')?.value ?? '0');
    const startMinutes = currentHour * 60 + currentMinute;
    const endMinutes = (startMinutes + 60) % (24 * 60);

    const prisma = {
      chatSettings: {
        findMany: jest.fn().mockResolvedValue([
          {
            chatId: 'chat-1',
            botSpeechStyle: null,
            nightModeStartTimeMinutes: startMinutes,
            nightModeEndTimeMinutes: endMinutes,
            nightModeTimezone: 'Europe/Moscow',
            nightModeBotMessageEnabled: true,
            nightModeBotMessageText: '',
            commentsEnabled: false,
            nightModeCommentsEnabled: false,
            nightModeOpenMessageEnabled: true,
            nightModeOpenMessageText: '',
            nightModeBotButtonEnabled: false,
            nightModeBotButtonUrl: '',
            nightModeBotButtonText: 'Открыть',
            nightModeRulesButtonEnabled: true,
          },
        ]),
      },
      chatRules: {
        findMany: jest.fn().mockResolvedValue([
          {
            chatId: 'chat-1',
            publishedUrl: 'https://max.ru/chats/chat-1/message/999',
            publishedMessageId: '999',
          },
        ]),
      },
      moderationEvent: {
        findFirst: jest.fn().mockImplementation((query: { where?: Record<string, unknown> }) => {
          if (query.where?.ruleCode === 'NIGHT_MODE_NOTICE') {
            return Promise.resolve(noticeCreated ? { id: 'evt-night-notice-1' } : null);
          }

          return Promise.resolve(null);
        }),
        create: jest.fn().mockImplementation((payload: { data: { ruleCode?: string } }) => {
          if (payload.data.ruleCode === 'NIGHT_MODE_NOTICE') {
            noticeCreated = true;
          }
          return Promise.resolve(payload);
        }),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const maxClient = {
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
    );

    await (
      service as unknown as { processNightModeAnnouncements: () => Promise<void> }
    ).processNightModeAnnouncements();

    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      expect.stringContaining('Ночной режим, граждане'),
      {
        button: {
          text: 'Правила',
          url: 'https://max.ru/chats/chat-1/message/999',
        },
        textFormat: 'markdown',
      },
    );
  });

  it('prefers immediate night notice send with message id over resolved link lookup', async () => {
    const nowParts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Moscow',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date());
    const currentHour = Number(nowParts.find((item) => item.type === 'hour')?.value ?? '0');
    const currentMinute = Number(nowParts.find((item) => item.type === 'minute')?.value ?? '0');
    const startMinutes = currentHour * 60 + currentMinute;
    const endMinutes = (startMinutes + 60) % (24 * 60);

    const prisma = {
      chatSettings: {
        findMany: jest.fn().mockResolvedValue([
          {
            chatId: 'chat-1',
            botSpeechStyle: null,
            nightModeStartTimeMinutes: startMinutes,
            nightModeEndTimeMinutes: endMinutes,
            nightModeTimezone: 'Europe/Moscow',
            nightModeBotMessageEnabled: true,
            nightModeBotMessageText: '',
            nightModeOpenMessageEnabled: true,
            nightModeOpenMessageText: '',
            nightModeBotButtonEnabled: false,
            nightModeBotButtonUrl: '',
            nightModeBotButtonText: 'Открыть',
          },
        ]),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      sendMessageImmediateWithId: jest.fn().mockResolvedValue({
        messageId: 'msg-night-close-1',
        url: null,
      }),
      sendMessageImmediateWithResolvedLink: jest.fn(),
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

    await (
      service as unknown as { processNightModeAnnouncements: () => Promise<void> }
    ).processNightModeAnnouncements();

    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      'chat-1',
      expect.stringContaining('Ночной режим, граждане'),
      expect.objectContaining({
        textFormat: 'markdown',
      }),
    );
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        ruleCode: 'NIGHT_MODE_NOTICE',
        action: SanctionAction.NONE,
        metadata: expect.objectContaining({
          noticeMessageId: 'msg-night-close-1',
        }),
      }),
    });
  });

  it('suppresses repeated scheduled night closed notice after terminal MAX error', async () => {
    const prisma = {
      chatSettings: {
        findMany: jest.fn().mockResolvedValue([
          {
            chatId: 'chat-1',
            botSpeechStyle: null,
            nightModeStartTimeMinutes: 10 * 60,
            nightModeEndTimeMinutes: 11 * 60,
            nightModeTimezone: 'Europe/Moscow',
            nightModeBotMessageEnabled: true,
            nightModeBotMessageText: '',
            nightModeOpenMessageEnabled: true,
            nightModeOpenMessageText: '',
            nightModeBotButtonEnabled: false,
            nightModeBotButtonUrl: '',
            nightModeBotButtonText: 'Открыть',
          },
        ]),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const maxClient = {
      sendMessageImmediateWithId: jest
        .fn()
        .mockRejectedValue(
          createMaxApiError(404, 'Request failed with status code 404', 'chat.not.found'),
        ),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
    );
    (
      service as unknown as {
        getCurrentMinutesInTimeZone: (timeZone: string) => number | null;
      }
    ).getCurrentMinutesInTimeZone = jest.fn(() => 10 * 60 + 15);

    await (
      service as unknown as { processNightModeAnnouncements: () => Promise<void> }
    ).processNightModeAnnouncements();
    await (
      service as unknown as { processNightModeAnnouncements: () => Promise<void> }
    ).processNightModeAnnouncements();

    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(1);
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('sends scheduled night closed notice even when startup missed the exact start minute', async () => {
    const nowParts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Moscow',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date());
    const currentHour = Number(nowParts.find((item) => item.type === 'hour')?.value ?? '0');
    const currentMinute = Number(nowParts.find((item) => item.type === 'minute')?.value ?? '0');
    const currentMinutes = currentHour * 60 + currentMinute;
    const startMinutes = (currentMinutes + 23 * 60) % (24 * 60);
    const endMinutes = (currentMinutes + 60) % (24 * 60);

    const prisma = {
      chatSettings: {
        findMany: jest.fn().mockResolvedValue([
          {
            chatId: 'chat-1',
            botSpeechStyle: null,
            nightModeStartTimeMinutes: startMinutes,
            nightModeEndTimeMinutes: endMinutes,
            nightModeTimezone: 'Europe/Moscow',
            nightModeBotMessageEnabled: true,
            nightModeBotMessageText: '',
            nightModeOpenMessageEnabled: true,
            nightModeOpenMessageText: '',
            nightModeBotButtonEnabled: false,
            nightModeBotButtonUrl: '',
            nightModeBotButtonText: 'Открыть',
          },
        ]),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
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

    await (
      service as unknown as { processNightModeAnnouncements: () => Promise<void> }
    ).processNightModeAnnouncements();

    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      expect.stringContaining('Ночной режим, граждане'),
    );
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        ruleCode: 'NIGHT_MODE_NOTICE',
        action: SanctionAction.NONE,
      }),
    });
  });

  it('sends scheduled night closed notice even when system mode is degrade', async () => {
    const nowParts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Moscow',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date());
    const currentHour = Number(nowParts.find((item) => item.type === 'hour')?.value ?? '0');
    const currentMinute = Number(nowParts.find((item) => item.type === 'minute')?.value ?? '0');
    const currentMinutes = currentHour * 60 + currentMinute;
    const startMinutes = (currentMinutes + 23 * 60) % (24 * 60);
    const endMinutes = (currentMinutes + 60) % (24 * 60);

    const prisma = {
      chatSettings: {
        findMany: jest.fn().mockResolvedValue([
          {
            chatId: 'chat-1',
            botSpeechStyle: null,
            nightModeStartTimeMinutes: startMinutes,
            nightModeEndTimeMinutes: endMinutes,
            nightModeTimezone: 'Europe/Moscow',
            nightModeBotMessageEnabled: true,
            nightModeBotMessageText: '',
            nightModeOpenMessageEnabled: true,
            nightModeOpenMessageText: '',
            nightModeBotButtonEnabled: false,
            nightModeBotButtonUrl: '',
            nightModeBotButtonText: 'Открыть',
          },
        ]),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const systemModeService = {
      getSnapshot: jest.fn().mockReturnValue({
        mode: 'degrade',
        source: 'auto',
        reason: 'action error rate 8.93%',
        updatedAt: new Date().toISOString(),
        manualMode: null,
        queueLagSec: 0,
        action: {
          windowSec: 60,
          total: 100,
          success: 91,
          failure: 9,
          critical: 0,
          errorRate: 0.09,
          criticalRate: 0,
        },
      }),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      systemModeService as never,
    );

    await (
      service as unknown as { processNightModeAnnouncements: () => Promise<void> }
    ).processNightModeAnnouncements();

    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      expect.stringContaining('Ночной режим, граждане'),
    );
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        ruleCode: 'NIGHT_MODE_NOTICE',
        action: SanctionAction.NONE,
      }),
    });
  });

  it('sends scheduled night open notice and deletes previous closed notice', async () => {
    const nowParts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Moscow',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date());
    const currentHour = Number(nowParts.find((item) => item.type === 'hour')?.value ?? '0');
    const currentMinute = Number(nowParts.find((item) => item.type === 'minute')?.value ?? '0');
    const endMinutes = currentHour * 60 + currentMinute;
    const startMinutes = (endMinutes + 23 * 60) % (24 * 60);

    const prisma = {
      chatSettings: {
        findMany: jest.fn().mockResolvedValue([
          {
            chatId: 'chat-1',
            botSpeechStyle: null,
            nightModeStartTimeMinutes: startMinutes,
            nightModeEndTimeMinutes: endMinutes,
            nightModeTimezone: 'Europe/Moscow',
            nightModeBotMessageEnabled: true,
            nightModeBotMessageText: '',
            nightModeOpenMessageEnabled: true,
            nightModeOpenMessageText: '',
            nightModeBotButtonEnabled: false,
            nightModeBotButtonUrl: '',
            nightModeBotButtonText: 'Открыть',
          },
        ]),
      },
      moderationEvent: {
        findFirst: jest
          .fn()
          .mockImplementation(
            (query: { where?: Record<string, unknown>; select?: Record<string, unknown> }) => {
              if (query.where?.ruleCode === 'NIGHT_MODE_OPEN_NOTICE') {
                return Promise.resolve(null);
              }

              if (query.where?.ruleCode === 'NIGHT_MODE_NOTICE') {
                return Promise.resolve({
                  metadata: {
                    noticeMessageId: 'msg-night-close-1',
                  },
                });
              }

              return Promise.resolve(null);
            },
          ),
        create: jest.fn().mockResolvedValue(undefined),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      sendMessageImmediateWithResolvedLink: jest.fn().mockResolvedValue({
        messageId: 'msg-night-open-1',
        url: null,
      }),
      deleteMessage: jest.fn(),
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

    await (
      service as unknown as { processNightModeAnnouncements: () => Promise<void> }
    ).processNightModeAnnouncements();

    expect(maxClient.deleteMessage.mock.invocationCallOrder[0]).toBeLessThan(
      maxClient.sendMessageImmediateWithResolvedLink.mock.invocationCallOrder[0],
    );
    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'chat-1',
      expect.stringContaining('Доброе утро, граждане'),
      expect.objectContaining({
        textFormat: 'markdown',
      }),
    );
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-night-close-1');
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        ruleCode: 'NIGHT_MODE_OPEN_NOTICE',
        action: SanctionAction.NONE,
        metadata: expect.objectContaining({
          closedNoticeDeleted: true,
          closedNoticeMessageId: 'msg-night-close-1',
          noticeMessageId: 'msg-night-open-1',
        }),
      }),
    });
  });

  it('suppresses repeated scheduled night open notice after terminal MAX error', async () => {
    const prisma = {
      chatSettings: {
        findMany: jest.fn().mockResolvedValue([
          {
            chatId: 'chat-1',
            botSpeechStyle: null,
            nightModeStartTimeMinutes: 10 * 60,
            nightModeEndTimeMinutes: 11 * 60,
            nightModeTimezone: 'Europe/Moscow',
            nightModeBotMessageEnabled: true,
            nightModeBotMessageText: '',
            nightModeOpenMessageEnabled: true,
            nightModeOpenMessageText: '',
            nightModeBotButtonEnabled: false,
            nightModeBotButtonUrl: '',
            nightModeBotButtonText: 'Открыть',
          },
        ]),
      },
      moderationEvent: {
        findFirst: jest.fn().mockImplementation((query: { where?: Record<string, unknown> }) => {
          if (query.where?.ruleCode === 'NIGHT_MODE_OPEN_NOTICE') {
            return Promise.resolve(null);
          }

          if (query.where?.ruleCode === 'NIGHT_MODE_NOTICE') {
            return Promise.resolve({
              metadata: {
                noticeMessageId: 'msg-night-close-1',
              },
            });
          }

          return Promise.resolve(null);
        }),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const maxClient = {
      sendMessageImmediateWithResolvedLink: jest
        .fn()
        .mockRejectedValue(
          createMaxApiError(403, 'Request failed with status code 403', 'chat.denied'),
        ),
      deleteMessage: jest.fn().mockResolvedValue(undefined),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
    );
    (
      service as unknown as {
        getCurrentMinutesInTimeZone: (timeZone: string) => number | null;
      }
    ).getCurrentMinutesInTimeZone = jest.fn(() => 11 * 60 + 5);

    await (
      service as unknown as { processNightModeAnnouncements: () => Promise<void> }
    ).processNightModeAnnouncements();
    await (
      service as unknown as { processNightModeAnnouncements: () => Promise<void> }
    ).processNightModeAnnouncements();

    expect(maxClient.deleteMessage).toHaveBeenCalledTimes(1);
    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(1);
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('sends scheduled night open notice after missing the exact end minute when session was observed', async () => {
    let currentMinutes = 10 * 60 + 30;
    let closedNoticeCreated = false;
    let openNoticeCreated = false;

    const prisma = {
      chatSettings: {
        findMany: jest.fn().mockResolvedValue([
          {
            chatId: 'chat-1',
            botSpeechStyle: null,
            nightModeStartTimeMinutes: 10 * 60,
            nightModeEndTimeMinutes: 11 * 60,
            nightModeTimezone: 'Europe/Moscow',
            nightModeBotMessageEnabled: true,
            nightModeBotMessageText: '',
            commentsEnabled: false,
            nightModeCommentsEnabled: false,
            nightModeOpenMessageEnabled: true,
            nightModeOpenMessageText: '',
            nightModeBotButtonEnabled: false,
            nightModeBotButtonUrl: '',
            nightModeBotButtonText: 'Открыть',
            nightModeRulesButtonEnabled: false,
          },
        ]),
      },
      moderationEvent: {
        findFirst: jest
          .fn()
          .mockImplementation(
            (query: { where?: Record<string, unknown>; select?: Record<string, unknown> }) => {
              if (query.where?.ruleCode === 'NIGHT_MODE_OPEN_NOTICE') {
                return Promise.resolve(openNoticeCreated ? { id: 'evt-night-open-1' } : null);
              }

              if (query.where?.ruleCode === 'NIGHT_MODE_NOTICE') {
                return Promise.resolve(
                  closedNoticeCreated
                    ? {
                        id: 'evt-night-close-1',
                        metadata: {
                          noticeMessageId: 'msg-night-close-1',
                        },
                      }
                    : null,
                );
              }

              return Promise.resolve(null);
            },
          ),
        create: jest.fn().mockImplementation((payload: { data: { ruleCode?: string } }) => {
          if (payload.data.ruleCode === 'NIGHT_MODE_NOTICE') {
            closedNoticeCreated = true;
          }
          if (payload.data.ruleCode === 'NIGHT_MODE_OPEN_NOTICE') {
            openNoticeCreated = true;
          }
          return Promise.resolve(payload);
        }),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const maxClient = {
      sendMessageImmediateWithId: jest
        .fn()
        .mockResolvedValueOnce({
          messageId: 'msg-night-close-1',
          url: null,
        })
        .mockResolvedValueOnce({
          messageId: 'msg-night-open-1',
          url: null,
        }),
      deleteMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
    );
    (
      service as unknown as {
        getCurrentMinutesInTimeZone: (timeZone: string) => number | null;
      }
    ).getCurrentMinutesInTimeZone = jest.fn(() => currentMinutes);

    await (
      service as unknown as { processNightModeAnnouncements: () => Promise<void> }
    ).processNightModeAnnouncements();

    currentMinutes = 11 * 60 + 7;

    await (
      service as unknown as { processNightModeAnnouncements: () => Promise<void> }
    ).processNightModeAnnouncements();

    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(2);
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenNthCalledWith(
      2,
      'chat-1',
      expect.stringContaining('Доброе утро, граждане'),
      expect.objectContaining({
        textFormat: 'markdown',
      }),
    );
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-night-close-1');
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        ruleCode: 'NIGHT_MODE_OPEN_NOTICE',
        action: SanctionAction.NONE,
        metadata: expect.objectContaining({
          closedNoticeDeleted: true,
          closedNoticeMessageId: 'msg-night-close-1',
          noticeMessageId: 'msg-night-open-1',
        }),
      }),
    });
  });

  it('does not send scheduled night open notice without a prior closed notice when close notice is enabled', async () => {
    let currentMinutes = 10 * 60 + 30;
    let manualCloseActive = true;

    const prisma = {
      chatSettings: {
        findMany: jest.fn().mockImplementation(() =>
          Promise.resolve([
            {
              chatId: 'chat-1',
              botSpeechStyle: null,
              nightModeStartTimeMinutes: 10 * 60,
              nightModeEndTimeMinutes: 11 * 60,
              nightModeTimezone: 'Europe/Moscow',
              nightModeBotMessageEnabled: true,
              nightModeBotMessageText: '',
              commentsEnabled: false,
              nightModeCommentsEnabled: false,
              nightModeOpenMessageEnabled: true,
              nightModeOpenMessageText: '',
              nightModeBotButtonEnabled: false,
              nightModeBotButtonUrl: '',
              nightModeBotButtonText: 'Открыть',
              nightModeRulesButtonEnabled: false,
              nightModeForceCloseEnabled: manualCloseActive,
              nightModeForceCloseForever: false,
              nightModeForceCloseUntil: manualCloseActive
                ? new Date(Date.now() + 60 * 60 * 1_000).toISOString()
                : '',
            },
          ]),
        ),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const maxClient = {
      sendMessage: jest.fn(),
      deleteMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
    );
    (
      service as unknown as {
        getCurrentMinutesInTimeZone: (timeZone: string) => number | null;
      }
    ).getCurrentMinutesInTimeZone = jest.fn(() => currentMinutes);

    await (
      service as unknown as { processNightModeAnnouncements: () => Promise<void> }
    ).processNightModeAnnouncements();

    currentMinutes = 11 * 60 + 10;
    manualCloseActive = false;

    await (
      service as unknown as { processNightModeAnnouncements: () => Promise<void> }
    ).processNightModeAnnouncements();

    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('delays scheduled night open notice while manual close stays active, then sends it once the chat is reopened', async () => {
    let currentMinutes = 10 * 60 + 30;
    let manualCloseActive = false;
    let closedNoticeCreated = false;
    let openNoticeCreated = false;

    const prisma = {
      chatSettings: {
        findMany: jest.fn().mockImplementation(() =>
          Promise.resolve([
            {
              chatId: 'chat-1',
              botSpeechStyle: null,
              nightModeStartTimeMinutes: 10 * 60,
              nightModeEndTimeMinutes: 11 * 60,
              nightModeTimezone: 'Europe/Moscow',
              nightModeBotMessageEnabled: true,
              nightModeBotMessageText: '',
              commentsEnabled: false,
              nightModeCommentsEnabled: false,
              nightModeOpenMessageEnabled: true,
              nightModeOpenMessageText: '',
              nightModeBotButtonEnabled: false,
              nightModeBotButtonUrl: '',
              nightModeBotButtonText: 'Открыть',
              nightModeRulesButtonEnabled: false,
              nightModeForceCloseEnabled: manualCloseActive,
              nightModeForceCloseForever: false,
              nightModeForceCloseUntil: manualCloseActive
                ? new Date(Date.now() + 60 * 60 * 1_000).toISOString()
                : '',
            },
          ]),
        ),
      },
      moderationEvent: {
        findFirst: jest
          .fn()
          .mockImplementation(
            (query: { where?: Record<string, unknown>; select?: Record<string, unknown> }) => {
              if (query.where?.ruleCode === 'NIGHT_MODE_OPEN_NOTICE') {
                return Promise.resolve(openNoticeCreated ? { id: 'evt-night-open-1' } : null);
              }

              if (query.where?.ruleCode === 'NIGHT_MODE_NOTICE') {
                return Promise.resolve(
                  closedNoticeCreated
                    ? {
                        id: 'evt-night-close-1',
                        metadata: {
                          noticeMessageId: 'msg-night-close-1',
                        },
                      }
                    : null,
                );
              }

              return Promise.resolve(null);
            },
          ),
        create: jest.fn().mockImplementation((payload: { data: { ruleCode?: string } }) => {
          if (payload.data.ruleCode === 'NIGHT_MODE_NOTICE') {
            closedNoticeCreated = true;
          }
          if (payload.data.ruleCode === 'NIGHT_MODE_OPEN_NOTICE') {
            openNoticeCreated = true;
          }
          return Promise.resolve(payload);
        }),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const maxClient = {
      sendMessageImmediateWithId: jest
        .fn()
        .mockResolvedValueOnce({
          messageId: 'msg-night-close-1',
          url: null,
        })
        .mockResolvedValueOnce({
          messageId: 'msg-night-open-1',
          url: null,
        }),
      deleteMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
    );
    (
      service as unknown as {
        getCurrentMinutesInTimeZone: (timeZone: string) => number | null;
      }
    ).getCurrentMinutesInTimeZone = jest.fn(() => currentMinutes);

    await (
      service as unknown as { processNightModeAnnouncements: () => Promise<void> }
    ).processNightModeAnnouncements();

    manualCloseActive = true;
    currentMinutes = 11 * 60 + 5;

    await (
      service as unknown as { processNightModeAnnouncements: () => Promise<void> }
    ).processNightModeAnnouncements();

    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(1);
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();

    manualCloseActive = false;
    currentMinutes = 11 * 60 + 20;

    await (
      service as unknown as { processNightModeAnnouncements: () => Promise<void> }
    ).processNightModeAnnouncements();

    expect(maxClient.deleteMessage.mock.invocationCallOrder[0]).toBeLessThan(
      maxClient.sendMessageImmediateWithId.mock.invocationCallOrder[1],
    );
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(2);
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenNthCalledWith(
      2,
      'chat-1',
      expect.stringContaining('Доброе утро, граждане'),
      expect.objectContaining({
        textFormat: 'markdown',
      }),
    );
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-night-close-1');
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        ruleCode: 'NIGHT_MODE_OPEN_NOTICE',
        action: SanctionAction.NONE,
        metadata: expect.objectContaining({
          closedNoticeDeleted: true,
          closedNoticeMessageId: 'msg-night-close-1',
          noticeMessageId: 'msg-night-open-1',
        }),
      }),
    });
  });

  it('deduplicates concurrent scheduled night open notice attempts across service instances', async () => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const redisLocks = new Map<string, string>();
    let openNoticeCreated = false;
    const prisma = {
      moderationEvent: {
        findFirst: jest
          .fn()
          .mockImplementation(
            async (query: {
              where?: Record<string, unknown>;
              select?: Record<string, unknown>;
            }) => {
              await sleep(25);
              if (query.where?.ruleCode === 'NIGHT_MODE_OPEN_NOTICE') {
                return openNoticeCreated ? { id: 'evt-night-open-1' } : null;
              }

              if (query.where?.ruleCode === 'NIGHT_MODE_NOTICE') {
                return {
                  metadata: {
                    noticeMessageId: 'msg-night-close-1',
                  },
                };
              }

              return null;
            },
          ),
        create: jest.fn().mockImplementation(async (payload: { data: { ruleCode?: string } }) => {
          await sleep(25);
          if (payload.data.ruleCode === 'NIGHT_MODE_OPEN_NOTICE') {
            openNoticeCreated = true;
          }
          return payload;
        }),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const maxClient = {
      sendMessageImmediateWithId: jest.fn().mockImplementation(async () => {
        await sleep(25);
        return {
          messageId: 'msg-night-open-1',
          url: null,
        };
      }),
      deleteMessage: jest.fn().mockImplementation(async () => {
        await sleep(25);
      }),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const redisCounter = {
      getString: jest.fn().mockResolvedValue(null),
      setStringWithTtl: jest.fn().mockResolvedValue(undefined),
      acquireLock: jest.fn().mockImplementation(async (key: string) => {
        if (redisLocks.has(key)) {
          return null;
        }

        const token = `lock-${redisLocks.size + 1}`;
        redisLocks.set(key, token);
        return token;
      }),
      releaseLock: jest.fn().mockImplementation(async (key: string, token: string) => {
        if (redisLocks.get(key) === token) {
          redisLocks.delete(key);
        }
      }),
    };

    const serviceA = new ModerationService(
      prisma as never,
      {} as never,
      {} as never,
      maxClient as never,
      undefined,
      undefined,
      undefined,
      redisCounter as never,
    );
    const serviceB = new ModerationService(
      prisma as never,
      {} as never,
      {} as never,
      maxClient as never,
      undefined,
      undefined,
      undefined,
      redisCounter as never,
    );

    const params = {
      chatId: 'chat-1',
      nightSessionKey: 'Europe/Moscow|1380-480|2026-03-25',
      startMinutes: 23 * 60,
      endMinutes: 8 * 60,
      timezone: 'Europe/Moscow',
      botSpeechStyle: null,
      nightModeOpenMessageEnabled: true,
      nightModeOpenMessageText: '',
    };

    await Promise.all([
      (
        serviceA as unknown as {
          sendNightModeOpenNoticeIfNeeded: (params: Record<string, unknown>) => Promise<void>;
        }
      ).sendNightModeOpenNoticeIfNeeded(params),
      (
        serviceB as unknown as {
          sendNightModeOpenNoticeIfNeeded: (params: Record<string, unknown>) => Promise<void>;
        }
      ).sendNightModeOpenNoticeIfNeeded(params),
    ]);

    expect(maxClient.deleteMessage).toHaveBeenCalledTimes(1);
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledTimes(1);
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(1);
    expect(redisCounter.acquireLock).toHaveBeenCalledTimes(2);
    expect(redisCounter.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('does not apply night mode deletion to chat admins', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            nightModeEnabled: true,
            nightModeStartTimeMinutes: 0,
            nightModeEndTimeMinutes: 0,
            nightModeBotMessageEnabled: true,
          }),
          domains: [],
          admins: [{ userId: 'user-1' }],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
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
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      getChatAdminIds: jest.fn(),
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

    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.findFirst).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith('chat-1');
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
  });

  it('skips moderation for remote chat admins when local allowlist is stale', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings(),
          domains: [],
          admins: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'LINK_BLOCKED', score: 0.9, reason: 'Blocked link' }],
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      getChatAdminIds: jest.fn().mockResolvedValue(['user-1']),
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

    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith('chat-1');
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
  });

  it('lets chat admins permanently ban a forwarded sender from the same chat with the ban command', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            muteDurationHours: 12,
            deleteBotMessagesEnabled: true,
            deleteBotMessagesDelayMinutes: 3,
          }),
          domains: [],
          admins: [{ userId: 'admin-1' }],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const adminService = {
      applyManualSystemBan: jest.fn().mockResolvedValue({
        ok: true,
        action: 'BAN',
        userId: 'user-2',
        muteDurationHours: null,
        unbanScheduledAt: null,
        message: 'Участник забанен в чате.',
      }),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      adminService as never,
    );

    await service.handleUpdate(createAdminForwardedBanUpdate());

    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith('chat-1');
    expect(adminService.applyManualSystemBan).toHaveBeenCalledWith(
      'chat-1',
      'user-2',
      expect.objectContaining({
        userId: 'admin-1',
        chatId: 'chat-1',
        chatTitle: null,
      }),
      'group_command',
    );
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-admin-forward-ban-1', {
      immediate: true,
    });
    const sentTexts = maxClient.sendMessage.mock.calls.map((call) => String(call[1] ?? ''));
    expect(sentTexts.some((text) => text.includes('Участник забанен в чате.'))).toBe(true);
    expect(sentTexts.some((text) => text.includes('Пользователь: **Нарушитель**'))).toBe(true);
  });

  it('lets chat admins mute a replied sender with the default duration', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings(),
          domains: [],
          admins: [{ userId: 'admin-1' }],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const adminService = {
      applyManualSystemBan: jest.fn(),
      applyManualModerationAction: jest.fn().mockResolvedValue({
        ok: true,
        action: 'MUTE',
        userId: 'user-2',
        muteDurationHours: 6,
        muteExpiresAt: '2026-03-27T01:00:00.000Z',
        message: 'Участник замьючен на 6ч. Новые сообщения будут удаляться до конца срока.',
      }),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      adminService as never,
    );

    await service.handleUpdate(createAdminLinkedModerationUpdate());

    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith('chat-1');
    expect(adminService.applyManualModerationAction).toHaveBeenCalledWith(
      'chat-1',
      'user-2',
      expect.objectContaining({
        userId: 'admin-1',
        chatId: 'chat-1',
        chatTitle: null,
      }),
      {
        action: 'MUTE',
        muteDurationHours: 6,
      },
      'group_command',
    );
    expect(adminService.applyManualSystemBan).not.toHaveBeenCalled();
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-admin-link-moderation-1', {
      immediate: true,
    });
    const sentTexts = maxClient.sendMessage.mock.calls.map((call) => String(call[1] ?? ''));
    expect(sentTexts.some((text) => text.includes('Участник замьючен на 6ч.'))).toBe(true);
    expect(sentTexts.some((text) => text.includes('Пользователь: **Нарушитель**'))).toBe(true);
  });

  it('lets chat admins mute a replied sender for an explicit duration', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings(),
          domains: [],
          admins: [{ userId: 'admin-1' }],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const adminService = {
      applyManualSystemBan: jest.fn(),
      applyManualModerationAction: jest.fn().mockResolvedValue({
        ok: true,
        action: 'MUTE',
        userId: 'user-2',
        muteDurationHours: 12,
        muteExpiresAt: '2026-03-27T07:00:00.000Z',
        message: 'Участник замьючен на 12ч. Новые сообщения будут удаляться до конца срока.',
      }),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      adminService as never,
    );

    await service.handleUpdate(createAdminLinkedModerationUpdate('мут 12'));

    expect(adminService.applyManualModerationAction).toHaveBeenCalledWith(
      'chat-1',
      'user-2',
      expect.objectContaining({
        userId: 'admin-1',
        chatId: 'chat-1',
      }),
      {
        action: 'MUTE',
        muteDurationHours: 12,
      },
      'group_command',
    );
    expect(adminService.applyManualSystemBan).not.toHaveBeenCalled();
    const sentTexts = maxClient.sendMessage.mock.calls.map((call) => String(call[1] ?? ''));
    expect(sentTexts.some((text) => text.includes('Участник замьючен на 12ч.'))).toBe(true);
  });

  it('rejects duration suffix for the group ban command', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings(),
          domains: [],
          admins: [{ userId: 'admin-1' }],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const adminService = {
      applyManualSystemBan: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      adminService as never,
    );

    await service.handleUpdate(createAdminForwardedBanUpdate('бан 24'));

    expect(adminService.applyManualSystemBan).not.toHaveBeenCalled();
    const sentTexts = maxClient.sendMessage.mock.calls.map((call) => String(call[1] ?? ''));
    expect(
      sentTexts.some((text) =>
        text.includes(
          'Команда `бан` теперь делает только постоянный системный бан. Используйте просто `бан`.',
        ),
      ),
    ).toBe(true);
  });

  it('rejects admin ban command when the forwarded message comes from another chat', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            muteDurationHours: 12,
            deleteBotMessagesEnabled: true,
            deleteBotMessagesDelayMinutes: 3,
          }),
          domains: [],
          admins: [{ userId: 'admin-1' }],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const adminService = {
      applyManualModerationAction: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      adminService as never,
    );

    await service.handleUpdate(createAdminForwardedBanUpdate('бан', 'chat-2'));

    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith('chat-1');
    expect(adminService.applyManualModerationAction).not.toHaveBeenCalled();
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    const sentTexts = maxClient.sendMessage.mock.calls.map((call) => String(call[1] ?? ''));
    expect(sentTexts.some((text) => text.includes('Команда `бан` или `мут` работает только'))).toBe(
      true,
    );
  });

  it('keeps local allowlist admin bypass even when remote list does not include sender', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings(),
          domains: [],
          admins: [{ userId: 'user-1' }],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
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
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      getChatAdminIds: jest.fn().mockResolvedValue(['another-admin']),
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

    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith('chat-1');
    expect(ruleEngine.detect).not.toHaveBeenCalled();
  });

  it('uses shared cache for remote chat admins to avoid MAX API call', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings(),
          domains: [],
          admins: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'LINK_BLOCKED', score: 0.9, reason: 'Blocked link' }],
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      getChatAdminIds: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const redisCounter = {
      getString: jest.fn().mockResolvedValue(JSON.stringify(['user-1', 'iduser-1'])),
      setStringWithTtl: jest.fn(),
      addToSetWithTtl: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      undefined,
      redisCounter as never,
    );

    await service.handleUpdate(createUpdate());

    expect(redisCounter.getString).toHaveBeenCalledWith('chat-admins:v2:chat-1');
    expect(maxClient.getChatAdminIds).not.toHaveBeenCalled();
    expect(ruleEngine.detect).not.toHaveBeenCalled();
  });

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
        findFirst: jest.fn().mockResolvedValue(null),
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
          action: 'MUTE',
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
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      muteNotice('Алексей', '6ч'),
      expect.objectContaining({ textFormat: 'markdown' }),
      undefined,
    );
    expect(maxClient.kickMember).not.toHaveBeenCalled();
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
        ruleCode: 'DUPLICATE_MUTE',
        action: SanctionAction.MUTE,
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
        findFirst: jest.fn().mockResolvedValue(null),
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
          nextAction: 'MUTE',
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
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      duplicateExplanation('Алексей', 'Предупреждение оформил.'),
    );
  });

  it('sends duplicate explanation in degrade mode when duplicate bot toggle is enabled', async () => {
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
        findFirst: jest.fn().mockResolvedValue(null),
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
        duplicateHit: {
          count: 1,
          windowSec: 60,
          hash: 'dup-hit-degrade-1',
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
    const systemModeService = {
      getSnapshot: jest.fn().mockReturnValue({
        mode: 'degrade',
        source: 'auto',
        reason: 'queue lag',
        updatedAt: new Date().toISOString(),
        manualMode: null,
        queueLagSec: 20,
        action: {
          windowSec: 60,
          total: 100,
          success: 96,
          failure: 4,
          critical: 0,
          errorRate: 0.04,
          criticalRate: 0,
        },
      }),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      systemModeService as never,
    );

    await service.handleUpdate(createUpdate());

    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      duplicateExplanation('Алексей', 'Повтор изъял, пока без протокола.'),
    );
  });

  it('sends duplicate explanation with inline button when button toggle is enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            duplicateBotMessageEnabled: true,
            duplicateBotButtonEnabled: true,
            duplicateBotButtonUrl: 'https://max.ru/help/bots',
            duplicateBotButtonText: 'Правила',
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
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
          hash: 'dup-hash-button',
          nextAction: 'MUTE',
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

    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      duplicateExplanation('Алексей', 'Предупреждение оформил.'),
      {
        button: {
          text: 'Правила',
          url: 'https://max.ru/help/bots',
        },
        textFormat: 'markdown',
      },
    );
  });

  it('sends permanent ban notice for duplicate BAN even when duplicate toggle is disabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ duplicateBotMessageEnabled: false }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
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
          action: 'BAN',
          count: 4,
          threshold: 4,
          windowSec: 48 * 60 * 60,
          hash: 'dup-ban-1',
          nextAction: null,
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
    expect(maxClient.banMember).toHaveBeenCalledWith('chat-1', 'user-1');
    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      permanentBanNotice('Алексей'),
    );
  });

  it('uses permanent ban notice for duplicate BAN regardless of mute duration', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ duplicateBotMessageEnabled: false, muteDurationHours: 12 }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
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
          action: 'BAN',
          count: 4,
          threshold: 4,
          windowSec: 48 * 60 * 60,
          hash: 'dup-ban-12h',
          nextAction: null,
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

    expect(maxClient.banMember).toHaveBeenCalledWith('chat-1', 'user-1');
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      permanentBanNotice('Алексей'),
    );
  });

  it('deletes duplicate hit and sends explanation before WARN stage', async () => {
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
        findFirst: jest.fn().mockResolvedValue(null),
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
        duplicateHit: {
          count: 1,
          windowSec: 60,
          hash: 'dup-hit-1',
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

    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-1');
    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      duplicateExplanation('Алексей', 'Повтор изъял, пока без протокола.'),
    );
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'msg-1',
        ruleCode: 'DUPLICATE_DELETE',
        action: SanctionAction.DELETE_MESSAGE,
      }),
    });
  });

  it('does not call SanctionService for text filter violations', async () => {
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
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'PROFANITY', score: 0.95, reason: 'Profanity detected' }],
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
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(2);
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        ruleCode: 'PROFANITY_DELETE',
        action: SanctionAction.DELETE_MESSAGE,
      }),
    });
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'PROFANITY',
        action: SanctionAction.NONE,
      }),
    });
  });

  it('issues WARN on second text-filter violation in 24h when warning stage is enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            profanityBotMessageEnabled: false,
            profanityWarnEnabled: true,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(2),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'PROFANITY', score: 0.95, reason: 'Profanity detected' }],
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
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      textFilterWarnNotice('Алексей', 'грубую лексику'),
    );
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'PROFANITY',
        action: SanctionAction.WARN,
        metadata: expect.objectContaining({
          textFilterViolationCount24h: 2,
          textFilterEscalationWindowHours: 24,
        }),
      }),
    });
  });

  it('does not send repeated text-filter explanation when warning stage is disabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            profanityBotMessageEnabled: true,
            profanityWarnEnabled: false,
            profanityBanEnabled: false,
            profanityMuteEnabled: false,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(2),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'PROFANITY', score: 0.95, reason: 'Profanity detected' }],
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

    expect(maxClient.sendMessage).not.toHaveBeenCalled();
  });

  it('uses permanent ban flow for text-filter BAN escalation', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            profanityBotMessageEnabled: false,
            profanityBanEnabled: true,
            muteDurationHours: 12,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(3),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'PROFANITY', score: 0.95, reason: 'Profanity detected' }],
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
    expect(maxClient.banMember).toHaveBeenCalledWith('chat-1', 'user-1');
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      permanentBanNotice('Алексей'),
    );
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'PROFANITY',
        action: SanctionAction.BAN,
        metadata: expect.objectContaining({
          textFilterViolationCount24h: 3,
          textFilterEscalationWindowHours: 24,
        }),
      }),
    });
  });

  it('issues MUTE on fourth text-filter violation in 24h when mute stage is enabled', async () => {
    const globalSpammer = {
      upsert: jest.fn(),
    };
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            profanityBotMessageEnabled: false,
            profanityMuteEnabled: true,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(4),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      globalSpammer,
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'PROFANITY', score: 0.95, reason: 'Profanity detected' }],
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
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      muteNotice('Алексей', '6ч'),
    );
    expect(globalSpammer.upsert).not.toHaveBeenCalled();
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'PROFANITY',
        action: SanctionAction.MUTE,
        metadata: expect.objectContaining({
          textFilterViolationCount24h: 4,
          textFilterEscalationWindowHours: 24,
        }),
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
        findFirst: jest.fn().mockResolvedValue(null),
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
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(2);
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'LINK_BLOCKED',
        action: SanctionAction.NONE,
      }),
    });
  });

  it('deletes commercial ad and sends first-step explanation with button', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            commercialAdsFilterEnabled: true,
            textFiltersBotMessageEnabled: true,
            textFiltersWarnEnabled: true,
            textFiltersBotButtonEnabled: true,
            textFiltersBotButtonUrl: 'https://max.ru/channel/rules',
            textFiltersBotButtonText: 'Правила',
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [
          {
            ruleCode: 'COMMERCIAL_AD',
            score: 0.9,
            reason: 'Detected ad',
            metadata: {
              confidenceScore: 88,
              decisionBand: 'HIGH',
              matchedSignals: ['intent:продам', 'contact:пишите в лс'],
              negativeSignals: [],
              appliedThresholds: {
                warnThreshold: 45,
                deleteThreshold: 65,
                sensitivity: 'BALANCED',
              },
            },
          },
        ],
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
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      majorExplanation('Алексей', 'снято с линии', 'коммерческая реклама в этом чате запрещена'),
      {
        button: {
          text: 'Правила',
          url: 'https://max.ru/channel/rules',
        },
        textFormat: 'markdown',
      },
    );
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        ruleCode: 'COMMERCIAL_AD_DELETE',
        action: SanctionAction.DELETE_MESSAGE,
      }),
    });
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'COMMERCIAL_AD',
        action: SanctionAction.NONE,
      }),
    });
  });

  it('deletes low confidence COMMERCIAL_AD as regular text-filter violation', async () => {
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            commercialAdsFilterEnabled: true,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [
          {
            ruleCode: 'COMMERCIAL_AD',
            score: 0.34,
            reason: 'Low confidence ad',
            metadata: {
              confidenceScore: 34,
              decisionBand: 'LOW',
              matchedSignals: ['promo:скидк'],
              negativeSignals: ['context:question'],
              appliedThresholds: {
                warnThreshold: 45,
                deleteThreshold: 65,
                sensitivity: 'BALANCED',
              },
            },
          },
        ],
      }),
    };
    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
    );

    await service.handleUpdate(createUpdate());

    expect(prisma.violation.create).toHaveBeenCalledTimes(1);
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-1');
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        ruleCode: 'COMMERCIAL_AD_DELETE',
        action: SanctionAction.DELETE_MESSAGE,
      }),
    });
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'COMMERCIAL_AD',
        action: SanctionAction.NONE,
      }),
    });
  });

  it('sends warning on second commercial violation when explanation and warning are enabled', async () => {
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            commercialAdsFilterEnabled: true,
            textFiltersBotMessageEnabled: true,
            textFiltersWarnEnabled: true,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(2),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [
          {
            ruleCode: 'COMMERCIAL_AD',
            score: 0.92,
            reason: 'High confidence ad',
            metadata: {
              confidenceScore: 92,
              decisionBand: 'HIGH',
              matchedSignals: ['intent:продам', 'contact:пишите в лс', 'transaction:price'],
              negativeSignals: [],
              appliedThresholds: {
                warnThreshold: 45,
                deleteThreshold: 65,
                sensitivity: 'BALANCED',
              },
            },
          },
        ],
      }),
    };
    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
    );

    await service.handleUpdate(createUpdate());

    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-1');
    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      textFilterWarnNotice('Алексей', 'рекламу'),
    );
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'COMMERCIAL_AD',
        action: SanctionAction.WARN,
        metadata: expect.objectContaining({
          textFilterViolationCount24h: 2,
          textFilterEscalationWindowHours: 24,
        }),
      }),
    });
  });

  it('deletes message and explains required thematic codeword when codeword filter is enabled', async () => {
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            thematicCodewordEnabled: true,
            thematicCodeword: 'недвижимость',
            thematicFiltersBotMessageEnabled: true,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [
          {
            ruleCode: 'TOPIC_FILTER_MISMATCH',
            score: 0.84,
            reason: 'Message without required thematic markers',
            metadata: {
              mode: 'CODEWORD',
              requiredCodeword: 'недвижимость',
              messageFirstToken: 'продам',
              messageLength: 74,
            },
          },
        ],
      }),
    };
    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
    );

    await service.handleUpdate(createUpdate());

    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-1');
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      majorExplanation(
        'Алексей',
        'снято с линии',
        'объявление должно начинаться с кодового слова "недвижимость"',
        'Объявление',
      ),
    );
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        ruleCode: 'TOPIC_FILTER_MISMATCH_DELETE',
        action: SanctionAction.DELETE_MESSAGE,
        metadata: expect.objectContaining({
          mode: 'CODEWORD',
          requiredCodeword: 'недвижимость',
          messageFirstToken: 'продам',
        }),
      }),
    });
  });

  it('escapes markdown in user labels and dynamic reason text for bot moderation messages', async () => {
    const requiredCodeword = '*авторынок*_[]';
    const senderName = '*admin*_[]';
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            thematicCodewordEnabled: true,
            thematicCodeword: requiredCodeword,
            thematicFiltersBotMessageEnabled: true,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [
          {
            ruleCode: 'TOPIC_FILTER_MISMATCH',
            score: 0.84,
            reason: 'Message without required thematic markers',
            metadata: {
              mode: 'CODEWORD',
              requiredCodeword,
            },
          },
        ],
      }),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
    );
    const update = createUpdate();

    await service.handleUpdate({
      ...update,
      message: {
        ...update.message!,
        senderName,
      },
    });

    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      majorExplanation(
        senderName,
        'снято с линии',
        `объявление должно начинаться с кодового слова "${escapeMaxMarkdown(requiredCodeword)}"`,
        'Объявление',
      ),
      expect.objectContaining({ textFormat: 'markdown' }),
      undefined,
    );
  });

  it('issues WARN with thematic codeword text on second codeword violation in 24h', async () => {
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            thematicCodewordEnabled: true,
            thematicCodeword: 'авторынок',
            thematicFiltersBotMessageEnabled: true,
            thematicFiltersWarnEnabled: true,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(2),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [
          {
            ruleCode: 'TOPIC_FILTER_MISMATCH',
            score: 0.84,
            reason: 'Message without required thematic markers',
            metadata: {
              mode: 'CODEWORD',
              requiredCodeword: 'авторынок',
              messageFirstToken: 'продам',
              messageLength: 63,
            },
          },
        ],
      }),
    };
    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
    );

    await service.handleUpdate(createUpdate());

    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      topicFilterWarnNotice('Алексей', 'объявление должно начинаться с кодового слова "авторынок"'),
    );
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'TOPIC_FILTER_MISMATCH',
        action: SanctionAction.WARN,
        metadata: expect.objectContaining({
          mode: 'CODEWORD',
          requiredCodeword: 'авторынок',
          topicFilterViolationCount24h: 2,
        }),
      }),
    });
  });

  it('issues BAN with thematic codeword text on third codeword violation in 24h', async () => {
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            thematicCodewordEnabled: true,
            thematicCodeword: 'недвижимость',
            thematicFiltersBotMessageEnabled: true,
            thematicFiltersWarnEnabled: true,
            thematicFiltersBanEnabled: true,
            muteDurationHours: 12,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(3),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [
          {
            ruleCode: 'TOPIC_FILTER_MISMATCH',
            score: 0.84,
            reason: 'Message without required thematic markers',
            metadata: {
              mode: 'CODEWORD',
              requiredCodeword: 'недвижимость',
              messageFirstToken: 'продам',
              messageLength: 181,
            },
          },
        ],
      }),
    };
    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
    );

    await service.handleUpdate(createUpdate());

    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-1');
    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      'Товарищ **Алексей**, оформляю бан до ручного разбана 👮‍♂️ Причина: объявление должно начинаться с кодового слова "недвижимость".',
    );
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'TOPIC_FILTER_MISMATCH',
        action: SanctionAction.BAN,
        metadata: expect.objectContaining({
          mode: 'CODEWORD',
          requiredCodeword: 'недвижимость',
          topicFilterViolationCount24h: 3,
          topicFilterEscalationWindowHours: 24,
        }),
      }),
    });
  });

  it('issues MUTE on fourth codeword violation in 24h when mute stage is enabled', async () => {
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            thematicCodewordEnabled: true,
            thematicCodeword: 'авторынок',
            thematicFiltersBotMessageEnabled: true,
            thematicFiltersWarnEnabled: true,
            thematicFiltersMuteEnabled: true,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(4),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [
          {
            ruleCode: 'TOPIC_FILTER_MISMATCH',
            score: 0.84,
            reason: 'Message without required thematic markers',
            metadata: {
              mode: 'CODEWORD',
              requiredCodeword: 'авторынок',
              messageFirstToken: 'продам',
              messageLength: 190,
            },
          },
        ],
      }),
    };
    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
    );

    await service.handleUpdate(createUpdate());

    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-1');
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      muteNotice('Алексей', '6ч'),
    );
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'TOPIC_FILTER_MISMATCH',
        action: SanctionAction.MUTE,
        metadata: expect.objectContaining({
          mode: 'CODEWORD',
          requiredCodeword: 'авторынок',
          topicFilterViolationCount24h: 4,
          topicFilterEscalationWindowHours: 24,
        }),
      }),
    });
  });

  it('prioritizes link moderation over duplicate escalation for link messages', async () => {
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
        findFirst: jest.fn().mockResolvedValue(null),
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
        duplicateDecision: {
          action: 'MUTE',
          count: 3,
          threshold: 3,
          windowSec: 24 * 60 * 60,
          hash: 'dup-link-1',
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

    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-1');
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      majorExplanation('Алексей', 'снято с линии', 'в этом чате ссылки не проходят, без ссылок'),
    );
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(2);
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'LINK_BLOCKED',
        action: SanctionAction.NONE,
      }),
    });
  });

  it('sends link explanation with inline button when button toggle is enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            linkBotMessageEnabled: true,
            linkBotButtonEnabled: true,
            linkBotButtonUrl: 'https://max.ru/channel/news',
            linkBotButtonText: 'Канал',
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
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

    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      majorExplanation('Алексей', 'снято с линии', 'в этом чате ссылки не проходят, без ссылок'),
      {
        button: {
          text: 'Канал',
          url: 'https://max.ru/channel/news',
        },
        textFormat: 'markdown',
      },
    );
  });

  it('does not send repeated link explanation when warning stage is disabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            linkBotMessageEnabled: true,
            linkWarnEnabled: false,
            linkBanEnabled: false,
            linkMuteEnabled: false,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(2),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
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

    expect(maxClient.sendMessage).not.toHaveBeenCalled();
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
        findFirst: jest.fn().mockResolvedValue(null),
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
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      majorExplanation('Алексей', 'не по форме', 'в этом чате ссылки не проходят, без ссылок'),
    );
  });

  it('issues WARN on second link in 24h when link warning stage is enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            linkBotMessageEnabled: false,
            linkWarnEnabled: true,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(2),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
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
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      linkWarnNotice('Алексей'),
    );
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'LINK_BLOCKED',
        action: SanctionAction.WARN,
        metadata: expect.objectContaining({
          linkViolationCount24h: 2,
          linkEscalationWindowHours: 24,
        }),
      }),
    });
  });

  it('sends only WARN on second link when explanation and warning are enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            linkBotMessageEnabled: true,
            linkWarnEnabled: true,
            linkBotButtonEnabled: true,
            linkBotButtonUrl: 'https://max.ru/channel/rules',
            linkBotButtonText: 'Правила',
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(2),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
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

    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      linkWarnNotice('Алексей'),
      {
        button: {
          text: 'Правила',
          url: 'https://max.ru/channel/rules',
        },
        textFormat: 'markdown',
      },
    );
  });

  it('adds both manual button and rules button when both toggles are enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            linkBotMessageEnabled: true,
            linkWarnEnabled: true,
            linkBotButtonEnabled: true,
            linkBotButtonUrl: 'https://max.ru/channel/news',
            linkBotButtonText: 'Канал',
            rulesAttachViolationsEnabled: true,
          }),
          rules: {
            publishedUrl: 'https://max.ru/chats/chat-1/message/999',
          },
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(2),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
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
      { resolveAction: jest.fn() } as never,
      maxClient as never,
    );

    await service.handleUpdate(createUpdate());

    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      linkWarnNotice('Алексей'),
      {
        buttons: [
          [
            {
              text: 'Канал',
              url: 'https://max.ru/channel/news',
            },
            {
              text: 'Правила',
              url: 'https://max.ru/chats/chat-1/message/999',
            },
          ],
        ],
        textFormat: 'markdown',
      },
    );
  });

  it('skips rules button when toggle is enabled but rules post is not published yet', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            linkBotMessageEnabled: true,
            linkWarnEnabled: true,
            rulesAttachViolationsEnabled: true,
          }),
          rules: {
            publishedMessageId: null,
            publishedUrl: null,
          },
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(2),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
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
      { resolveAction: jest.fn() } as never,
      maxClient as never,
    );

    await service.handleUpdate(createUpdate());

    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      linkWarnNotice('Алексей'),
      expect.objectContaining({ textFormat: 'markdown' }),
    );
  });

  it('recovers direct rules link by message id when published url is missing', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            linkBotMessageEnabled: true,
            linkWarnEnabled: true,
            rulesAttachViolationsEnabled: true,
          }),
          rules: {
            publishedMessageId: 'mid-rules-1',
            publishedUrl: null,
          },
          domains: [],
          admins: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(2),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
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
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
      resolveMessageLink: jest.fn().mockResolvedValue('https://max.ru/chats/chat-1/message/123'),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
    );

    await service.handleUpdate(createUpdate());

    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      linkWarnNotice('Алексей'),
      {
        button: {
          text: 'Правила',
          url: 'https://max.ru/chats/chat-1/message/123',
        },
        textFormat: 'markdown',
      },
    );
  });

  it('falls back to reply link on rules post when published url is still unavailable', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            linkBotMessageEnabled: true,
            linkWarnEnabled: true,
            rulesAttachViolationsEnabled: true,
          }),
          rules: {
            publishedMessageId: 'mid-rules-2',
            publishedUrl: null,
          },
          domains: [],
          admins: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(2),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      chatRules: {
        update: jest.fn().mockResolvedValue(undefined),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'LINK_BLOCKED', score: 0.9, reason: 'Link detected' }],
      }),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
      resolveMessageLink: jest.fn().mockResolvedValue(null),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
    );

    await service.handleUpdate(createUpdate());

    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      linkWarnNotice('Алексей'),
      {
        messageLink: {
          type: 'reply',
          mid: 'mid-rules-2',
        },
        textFormat: 'markdown',
      },
    );
  });

  it('upgrades legacy callback rules button to direct link when pressed', async () => {
    const prisma = {
      chatRules: {
        findUnique: jest.fn().mockResolvedValue({
          publishedUrl: null,
          publishedMessageId: 'mid-rules-1',
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
    };
    const maxClient = {
      answerCallback: jest.fn(),
      resolveMessageLink: jest.fn().mockResolvedValue('https://max.ru/chats/chat-1/message/777'),
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
    };

    const service = new ModerationService(
      prisma as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
    );

    await service.handleUpdate(createGroupRulesCallbackUpdate());

    expect(maxClient.resolveMessageLink).toHaveBeenCalledWith('mid-rules-1');
    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'chat-1',
      'msg-group-rules-callback-1',
      null,
      {
        button: {
          text: 'Правила',
          url: 'https://max.ru/chats/chat-1/message/777',
        },
      },
    );
    expect(maxClient.answerCallback).toHaveBeenCalledWith(
      'callback-rules-1',
      'Кнопка обновлена. Нажмите ещё раз',
    );
  });

  it('opens channel suggestion flow in private bot chat from channel callback', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn(),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const maxClient = {
      answerCallback: jest.fn(),
    };
    const privateControlService = {
      openChannelSuggestionFromCallback: jest.fn().mockResolvedValue(true),
    };
    const adminService = {
      parseChannelSuggestionStartPayload: jest.fn().mockReturnValue({
        chatId: 'channel-1',
        token: 'cdt-suggest-token-1',
      }),
    };

    const service = new ModerationService(
      prisma as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
      undefined,
      undefined,
      undefined,
      undefined,
      privateControlService as never,
      adminService as never,
    );

    await service.handleUpdate(createChannelSuggestionCallbackUpdate('cds-channel-1:token'));

    expect(adminService.parseChannelSuggestionStartPayload).toHaveBeenCalledWith(
      'cds-channel-1:token',
    );
    expect(privateControlService.openChannelSuggestionFromCallback).toHaveBeenCalledWith({
      userId: 'user-1',
      chatId: 'channel-1',
      token: 'cdt-suggest-token-1',
    });
    expect(maxClient.answerCallback).toHaveBeenCalledWith(
      'callback-suggest-1',
      'Бот написал в личку',
    );
  });

  it('uses permanent ban flow for link BAN escalation', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            linkBotMessageEnabled: false,
            linkBanEnabled: true,
            muteDurationHours: 12,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(3),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
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
    expect(maxClient.banMember).toHaveBeenCalledWith('chat-1', 'user-1');
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      permanentBanNotice('Алексей'),
    );
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'LINK_BLOCKED',
        action: SanctionAction.BAN,
        metadata: expect.objectContaining({
          linkViolationCount24h: 3,
          linkEscalationWindowHours: 24,
        }),
      }),
    });
  });

  it('uses inline button in permanent link BAN notice when button toggle is enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            linkBotMessageEnabled: true,
            linkBanEnabled: true,
            muteDurationHours: 12,
            linkBotButtonEnabled: true,
            linkBotButtonUrl: 'https://max.ru/channel/rules',
            linkBotButtonText: 'Правила',
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(3),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
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

    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      permanentBanNotice('Алексей'),
      {
        button: {
          text: 'Правила',
          url: 'https://max.ru/channel/rules',
        },
        textFormat: 'markdown',
      },
    );
  });

  it('issues MUTE on fourth link in 24h when mute stage is enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            linkBotMessageEnabled: false,
            linkMuteEnabled: true,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(4),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
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
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      muteNotice('Алексей', '6ч'),
    );
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'LINK_BLOCKED',
        action: SanctionAction.MUTE,
        metadata: expect.objectContaining({
          linkViolationCount24h: 4,
          linkEscalationWindowHours: 24,
        }),
      }),
    });
  });

  it('uses inline button in link MUTE message when button toggle is enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            linkBotMessageEnabled: true,
            linkMuteEnabled: true,
            linkBotButtonEnabled: true,
            linkBotButtonUrl: 'https://max.ru/channel/rules',
            linkBotButtonText: 'Правила',
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(4),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
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

    expect(maxClient.sendMessage).toHaveBeenCalledTimes(2);
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      muteNotice('Алексей', '6ч'),
      {
        button: {
          text: 'Правила',
          url: 'https://max.ru/channel/rules',
        },
        textFormat: 'markdown',
      },
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
        findFirst: jest.fn().mockResolvedValue(null),
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
          nextAction: 'MUTE',
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

  it('renders duplicate explanation with actual message status when duplicate deletion fails', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            duplicateBotMessageEnabled: true,
            duplicateBotMessageText:
              'Статус: {message_status}. Контекст: {duplicate_context}. {sanction}',
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
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
          hash: 'hash-status-1',
          nextAction: 'MUTE',
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

    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      'Статус: не по форме. Контекст: идёт повтором. Предупреждение оформил.',
    );
  });

  it('counts forwarded text length for MESSAGE_TOO_LONG and skips sanctions', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ maxMessageLengthEnabled: true, maxMessageLength: 100 }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest
        .fn()
        .mockImplementation(
          async (params: { effectiveLength?: number; settings: { maxMessageLength: number } }) => {
            const length = params.effectiveLength ?? 0;
            if (length > params.settings.maxMessageLength) {
              return {
                violations: [
                  {
                    ruleCode: 'MESSAGE_TOO_LONG',
                    score: 0.82,
                    reason: 'Message too long',
                  },
                ],
              };
            }

            return { violations: [] };
          },
        ),
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

    const forwarded = 'x'.repeat(180);
    await service.handleUpdate(createForwardedUpdate(forwarded));

    expect(ruleEngine.detect).toHaveBeenCalledTimes(1);
    const detectionArgs = (ruleEngine.detect as jest.Mock).mock.calls[0][0] as {
      effectiveLength?: number;
    };
    expect(detectionArgs.effectiveLength).toBeGreaterThan('коротко'.length);
    expect(detectionArgs.effectiveLength).toBeGreaterThan(100);

    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-forwarded-1');
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(2);
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'msg-forwarded-1',
        ruleCode: 'MESSAGE_TOO_LONG',
        action: SanctionAction.NONE,
      }),
    });
  });

  it('includes actual and required length in MESSAGE_TOO_LONG bot explanation', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            maxMessageLengthEnabled: true,
            maxMessageLength: 100,
            messageLimitsBotMessageEnabled: true,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest
        .fn()
        .mockImplementation(
          async (params: { effectiveLength?: number; settings: { maxMessageLength: number } }) => {
            const length = params.effectiveLength ?? 0;
            if (length > params.settings.maxMessageLength) {
              return {
                violations: [
                  {
                    ruleCode: 'MESSAGE_TOO_LONG',
                    score: 0.82,
                    reason: 'Message too long',
                  },
                ],
              };
            }

            return { violations: [] };
          },
        ),
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

    const forwarded = 'x'.repeat(180);
    await service.handleUpdate(createForwardedUpdate(forwarded));

    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      majorExplanation(
        'Алексей',
        'снято с линии',
        'слишком длинное сообщение: 187 символов при лимите 100',
      ),
    );
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
  });

  it('includes configured message count window in MESSAGE_COUNT_LIMIT bot explanation', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            messageCountLimitEnabled: true,
            messageCountLimitMessages: 2,
            messageCountLimitWindowHours: 6,
            messageLimitsBotMessageEnabled: true,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [
          {
            ruleCode: 'MESSAGE_COUNT_LIMIT',
            score: 0.87,
            reason: 'Message count limit hit',
          },
        ],
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

    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      majorExplanation(
        'Алексей',
        'снято с линии',
        'слишком частая отправка сообщений: не более 2 за 6ч',
      ),
    );
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
  });

  it('includes blocked word in MESSAGE_BLOCKED_WORD bot explanation', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            messageLimitsBlockedWords: ['казино'],
            messageLimitsBotMessageEnabled: true,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [
          {
            ruleCode: 'MESSAGE_BLOCKED_WORD',
            score: 0.89,
            reason: 'Blocked word detected: казино',
            metadata: { blockedWord: 'казино' },
          },
        ],
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

    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      majorExplanation('Алексей', 'снято с линии', 'стоп-слово: казино'),
    );
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        ruleCode: 'MESSAGE_BLOCKED_WORD_DELETE',
        metadata: expect.objectContaining({ blockedWord: 'казино' }),
      }),
    });
  });

  it('issues WARN on second MESSAGE_TOO_LONG violation in 12h when warning stage is enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            maxMessageLengthEnabled: true,
            maxMessageLength: 100,
            messageLimitsBotMessageEnabled: true,
            messageLimitsWarnEnabled: true,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(2),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'MESSAGE_TOO_LONG', score: 0.82, reason: 'Message too long' }],
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
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      messageLimitsWarnNotice('Алексей', 'слишком длинное сообщение'),
    );
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'MESSAGE_TOO_LONG',
        action: SanctionAction.WARN,
        metadata: expect.objectContaining({
          messageLimitsViolationCount12h: 2,
          messageLimitsEscalationWindowHours: 12,
        }),
      }),
    });
  });

  it('issues WARN on second MESSAGE_BLOCKED_WORD violation with matched word reason', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            messageLimitsBlockedWords: ['казино'],
            messageLimitsBotMessageEnabled: true,
            messageLimitsWarnEnabled: true,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(2),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [
          {
            ruleCode: 'MESSAGE_BLOCKED_WORD',
            score: 0.89,
            reason: 'Blocked word detected: казино',
            metadata: { blockedWord: 'казино' },
          },
        ],
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

    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      messageLimitsWarnNotice('Алексей', 'стоп-слово: казино'),
    );
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'MESSAGE_BLOCKED_WORD',
        action: SanctionAction.WARN,
        metadata: expect.objectContaining({
          blockedWord: 'казино',
          messageLimitsViolationCount12h: 2,
        }),
      }),
    });
  });

  it('issues permanent BAN on third PHOTO_RATE_LIMIT violation in 12h when ban stage is enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            photoMessageCooldownEnabled: true,
            photoMessageCooldownHours: 12,
            messageLimitsBotMessageEnabled: false,
            messageLimitsWarnEnabled: true,
            messageLimitsBanEnabled: true,
            muteDurationHours: 12,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(3),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'PHOTO_RATE_LIMIT', score: 0.88, reason: 'Photo cooldown hit' }],
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
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).toHaveBeenCalledWith('chat-1', 'user-1');
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      messageLimitsBanNotice('Алексей', 'слишком частая отправка фото'),
    );
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'PHOTO_RATE_LIMIT',
        action: SanctionAction.BAN,
        metadata: expect.objectContaining({
          messageLimitsViolationCount12h: 3,
          messageLimitsEscalationWindowHours: 12,
        }),
      }),
    });
  });

  it('issues MUTE on fourth PHOTO_RATE_LIMIT violation within 12h when mute stage is enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            photoMessageCooldownEnabled: true,
            photoMessageCooldownHours: 12,
            messageLimitsBotMessageEnabled: false,
            messageLimitsWarnEnabled: true,
            messageLimitsMuteEnabled: true,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(4),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'PHOTO_RATE_LIMIT', score: 0.88, reason: 'Photo cooldown hit' }],
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
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      muteNotice('Алексей', '6ч'),
    );
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'PHOTO_RATE_LIMIT',
        action: SanctionAction.MUTE,
        metadata: expect.objectContaining({
          messageLimitsViolationCount12h: 4,
          messageLimitsEscalationWindowHours: 12,
        }),
      }),
    });
  });

  it('detects video attachment in raw payload and deletes message without sanctions', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ videoMessagesEnabled: false }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockImplementation(async (params: { hasVideoAttachment?: boolean }) => {
        if (params.hasVideoAttachment) {
          return {
            violations: [{ ruleCode: 'VIDEO_BLOCKED', score: 0.88, reason: 'Video disabled' }],
          };
        }

        return { violations: [] };
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

    await service.handleUpdate(createVideoAttachmentUpdate());

    const detectionArgs = (ruleEngine.detect as jest.Mock).mock.calls[0][0] as {
      hasVideoAttachment?: boolean;
    };
    expect(detectionArgs.hasVideoAttachment).toBe(true);
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-video-1');
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(2);
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'VIDEO_BLOCKED',
        action: SanctionAction.NONE,
      }),
    });
  });

  it('passes sticker attachments separately from photos to rule engine', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            photoMessageCooldownEnabled: true,
            stickerMessageCooldownEnabled: true,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({ violations: [] }),
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

    await service.handleUpdate(createStickerAttachmentUpdate());

    const detectionArgs = (ruleEngine.detect as jest.Mock).mock.calls[0][0] as {
      hasPhotoAttachment?: boolean;
      hasStickerAttachment?: boolean;
    };
    expect(detectionArgs.hasStickerAttachment).toBe(true);
    expect(detectionArgs.hasPhotoAttachment).toBe(false);
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
  });

  it('does not treat file attachments with image mime as photos', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            photoMessageCooldownEnabled: true,
            fileMessagesEnabled: true,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({ violations: [] }),
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

    await service.handleUpdate(createImageFileAttachmentUpdate());

    const detectionArgs = (ruleEngine.detect as jest.Mock).mock.calls[0][0] as {
      hasPhotoAttachment?: boolean;
      hasFileAttachment?: boolean;
    };
    expect(detectionArgs.hasFileAttachment).toBe(true);
    expect(detectionArgs.hasPhotoAttachment).toBe(false);
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
  });

  it('detects forwarded video attachment and moderates it as regular message content', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ videoMessagesEnabled: false }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockImplementation(async (params: { hasVideoAttachment?: boolean }) => {
        if (params.hasVideoAttachment) {
          return {
            violations: [{ ruleCode: 'VIDEO_BLOCKED', score: 0.88, reason: 'Video disabled' }],
          };
        }

        return { violations: [] };
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

    await service.handleUpdate(createForwardedVideoAttachmentUpdate());

    const detectionArgs = (ruleEngine.detect as jest.Mock).mock.calls[0][0] as {
      hasVideoAttachment?: boolean;
    };
    expect(detectionArgs.hasVideoAttachment).toBe(true);
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-forwarded-video-1');
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(2);
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'VIDEO_BLOCKED',
        action: SanctionAction.NONE,
      }),
    });
  });

  it('detects forwarded voice attachment and moderates it as regular message content', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ voiceMessagesEnabled: false }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockImplementation(async (params: { hasVoiceAttachment?: boolean }) => {
        if (params.hasVoiceAttachment) {
          return {
            violations: [{ ruleCode: 'VOICE_BLOCKED', score: 0.88, reason: 'Voice disabled' }],
          };
        }

        return { violations: [] };
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

    await service.handleUpdate(createForwardedVoiceAttachmentUpdate());

    const detectionArgs = (ruleEngine.detect as jest.Mock).mock.calls[0][0] as {
      hasVoiceAttachment?: boolean;
    };
    expect(detectionArgs.hasVoiceAttachment).toBe(true);
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-forwarded-voice-1');
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(2);
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'VOICE_BLOCKED',
        action: SanctionAction.NONE,
      }),
    });
  });

  it('detects forwarded file attachment and moderates it as regular message content', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ fileMessagesEnabled: false }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockImplementation(async (params: { hasFileAttachment?: boolean }) => {
        if (params.hasFileAttachment) {
          return {
            violations: [{ ruleCode: 'FILE_BLOCKED', score: 0.88, reason: 'File disabled' }],
          };
        }

        return { violations: [] };
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

    await service.handleUpdate(createForwardedFileAttachmentUpdate());

    const detectionArgs = (ruleEngine.detect as jest.Mock).mock.calls[0][0] as {
      hasFileAttachment?: boolean;
    };
    expect(detectionArgs.hasFileAttachment).toBe(true);
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-forwarded-file-1');
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(2);
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'FILE_BLOCKED',
        action: SanctionAction.NONE,
      }),
    });
  });

  it('sends voice restriction explanation with button when message-limits toggle is enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            voiceMessagesEnabled: false,
            messageLimitsBotMessageEnabled: true,
            messageLimitsBotButtonEnabled: true,
            messageLimitsBotButtonUrl: 'https://max.ru/channel/rules',
            messageLimitsBotButtonText: 'Правила чата',
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockImplementation(async (params: { hasVoiceAttachment?: boolean }) => {
        if (params.hasVoiceAttachment) {
          return {
            violations: [{ ruleCode: 'VOICE_BLOCKED', score: 0.88, reason: 'Voice disabled' }],
          };
        }

        return { violations: [] };
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

    await service.handleUpdate(createVoiceAttachmentUpdate());

    const detectionArgs = (ruleEngine.detect as jest.Mock).mock.calls[0][0] as {
      hasVoiceAttachment?: boolean;
    };
    expect(detectionArgs.hasVoiceAttachment).toBe(true);
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-voice-1');
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      majorExplanation('Алексей', 'снято с линии', 'голосовые сообщения в этом чате отключены'),
      {
        button: {
          text: 'Правила чата',
          url: 'https://max.ru/channel/rules',
        },
        textFormat: 'markdown',
      },
    );
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
  });

  describe('required subscription', () => {
    function createPrismaForRequiredSubscription(
      settingsOverrides: Record<string, unknown> = {},
      adminUserIds: string[] = [],
    ) {
      return {
        chat: {
          upsert: jest.fn().mockResolvedValue({
            id: 'chat-1',
            title: 'Chat 1',
            settings: createSettings(settingsOverrides),
            domains: [],
            admins: adminUserIds.map((userId) => ({ userId })),
            rules: {
              publishedUrl: null,
              publishedMessageId: 'mid-rules-1',
            },
          }),
        },
        violation: {
          create: jest.fn(),
          count: jest.fn().mockResolvedValue(1),
        },
        moderationEvent: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
        },
        webhookEvent: {
          findUnique: jest.fn(),
          update: jest.fn(),
        },
        globalSpammer: {
          upsert: jest.fn(),
        },
        chatRules: {
          update: jest.fn(),
        },
      };
    }

    it('passes message through when the user is subscribed to all required channels', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
      });
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(true),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };

      const service = new ModerationService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
      );

      await service.handleUpdate(createUpdate());

      expect(maxClient.hasChatMember).toHaveBeenCalledWith('channel-1', 'user-1', {
        trafficClass: 'critical',
      });
      expect(ruleEngine.detect).toHaveBeenCalledTimes(1);
      expect(maxClient.deleteMessage).not.toHaveBeenCalled();
      expect(maxClient.sendMessage).not.toHaveBeenCalled();
      expect(prisma.violation.create).not.toHaveBeenCalled();
      expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
    });

    it('deletes the message, records violation, and sends buttons only for missing channels', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1', 'channel-2'],
        rulesAttachViolationsEnabled: true,
      });
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const redisCounter = createRequiredSubscriptionRedisCounter();
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest
          .fn()
          .mockResolvedValueOnce({
            title: 'Новости MAX',
            link: 'https://max.ru/channels/news-max',
            participantsCount: 100,
            entityType: 'channel',
          })
          .mockResolvedValueOnce({
            title: 'Афиша района',
            link: 'https://max.ru/channels/afisha',
            participantsCount: 42,
            entityType: 'channel',
          }),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };

      const service = new ModerationService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        undefined,
        undefined,
        redisCounter as never,
      );

      await service.handleUpdate(createUpdate());

      expect(ruleEngine.detect).not.toHaveBeenCalled();
      expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'msg-1');
      expect(prisma.violation.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          chatId: 'chat-1',
          userId: 'user-1',
          ruleCode: 'REQUIRED_SUBSCRIPTION',
          score: 1,
        }),
      });
      expect(prisma.moderationEvent.create.mock.calls).toEqual(
        expect.arrayContaining([
          [
            expect.objectContaining({
              data: expect.objectContaining({
                chatId: 'chat-1',
                userId: 'user-1',
                messageId: 'msg-1',
                ruleCode: 'REQUIRED_SUBSCRIPTION_DELETE',
                action: SanctionAction.DELETE_MESSAGE,
                metadata: expect.objectContaining({
                  requiredChannelIds: ['channel-1', 'channel-2'],
                  missingChannelIds: ['channel-1', 'channel-2'],
                  missingChannelTitles: ['Новости MAX', 'Афиша района'],
                }),
              }),
            }),
          ],
          [
            expect.objectContaining({
              data: expect.objectContaining({
                chatId: 'chat-1',
                userId: 'user-1',
                messageId: 'msg-1',
                ruleCode: 'REQUIRED_SUBSCRIPTION',
                action: SanctionAction.NONE,
                metadata: expect.objectContaining({
                  requiredSubscriptionViolationCount24h: 1,
                  requiredSubscriptionEscalationWindowHours: 24,
                  missingChannelTitles: ['Новости MAX', 'Афиша района'],
                }),
              }),
            }),
          ],
        ]),
      );
      expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
      const [, noticeText, noticeOptions] = maxClient.sendMessage.mock.calls[0] ?? [];
      expect(noticeText).toContain('Новости MAX');
      expect(noticeText).toContain('Афиша района');
      expect(noticeOptions).toEqual(
        expect.objectContaining({
          textFormat: 'markdown',
          messageLink: {
            type: 'reply',
            mid: 'mid-rules-1',
          },
          buttons: [
            [
              {
                text: 'Новости MAX',
                url: 'https://max.ru/channels/news-max',
              },
            ],
            [
              {
                text: 'Афиша района',
                url: 'https://max.ru/channels/afisha',
              },
            ],
          ],
          debugContext: {
            screen: 'moderation',
            action: 'required-subscription-notice',
          },
        }),
      );
    });

    it('suppresses repeated notice during cooldown and reuses membership cache', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
      });
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const redisCounter = createRequiredSubscriptionRedisCounter();
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          entityType: 'channel',
        }),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };

      const service = new ModerationService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        undefined,
        undefined,
        redisCounter as never,
      );

      const secondUpdate = createUpdate();
      secondUpdate.updateId = 'upd-2';
      if (secondUpdate.message) {
        secondUpdate.message.messageId = 'msg-2';
      }

      await service.handleUpdate(createUpdate());
      await service.handleUpdate(secondUpdate);

      expect(maxClient.hasChatMember).toHaveBeenCalledTimes(1);
      expect(maxClient.deleteMessage).toHaveBeenCalledTimes(2);
      expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
      expect(prisma.violation.create).toHaveBeenCalledTimes(2);
      expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(4);
      expect(redisCounter.setStringWithTtl).toHaveBeenCalledWith(
        expect.stringContaining('required-subscription:notice:v1:chat-1:user-1'),
        '1',
        15 * 60,
      );
    });

    it('retries sending the explanation on the next message when the first send fails', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
      });
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const redisCounter = createRequiredSubscriptionRedisCounter();
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          entityType: 'channel',
        }),
        deleteMessage: jest.fn(),
        sendMessage: jest
          .fn()
          .mockRejectedValueOnce(new Error('MAX send failed'))
          .mockResolvedValueOnce(undefined),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };

      const service = new ModerationService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        undefined,
        undefined,
        redisCounter as never,
      );

      const secondUpdate = createUpdate();
      secondUpdate.updateId = 'upd-2';
      if (secondUpdate.message) {
        secondUpdate.message.messageId = 'msg-2';
      }

      await service.handleUpdate(createUpdate());
      await service.handleUpdate(secondUpdate);

      expect(maxClient.hasChatMember).toHaveBeenCalledTimes(1);
      expect(maxClient.deleteMessage).toHaveBeenCalledTimes(2);
      expect(maxClient.sendMessage).toHaveBeenCalledTimes(2);

      const noticeCooldownWrites = redisCounter.setStringWithTtl.mock.calls.filter(
        ([key]) =>
          typeof key === 'string' && key.includes('required-subscription:notice:v1:chat-1:user-1'),
      );
      expect(noticeCooldownWrites).toHaveLength(1);
      expect(noticeCooldownWrites[0]).toEqual([
        expect.stringContaining('required-subscription:notice:v1:chat-1:user-1'),
        '1',
        15 * 60,
      ]);
    });

    it('issues WARN on second required subscription violation in 24h when warning stage is enabled', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
        requiredSubscriptionWarnEnabled: true,
      });
      prisma.violation.count.mockResolvedValue(2);
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const redisCounter = createRequiredSubscriptionRedisCounter();
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          entityType: 'channel',
        }),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };

      const service = new ModerationService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        undefined,
        undefined,
        redisCounter as never,
      );

      await service.handleUpdate(createUpdate());

      expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
      const [, noticeText] = maxClient.sendMessage.mock.calls[0] ?? [];
      expect(noticeText).toContain('предупреждение');
      expect(noticeText).toContain('Новости MAX');
      expect(prisma.moderationEvent.create.mock.calls).toEqual(
        expect.arrayContaining([
          [
            expect.objectContaining({
              data: expect.objectContaining({
                ruleCode: 'REQUIRED_SUBSCRIPTION',
                action: SanctionAction.WARN,
                metadata: expect.objectContaining({
                  requiredSubscriptionViolationCount24h: 2,
                }),
              }),
            }),
          ],
        ]),
      );
      expect(prisma.globalSpammer.upsert).not.toHaveBeenCalled();
      expect(maxClient.kickMember).not.toHaveBeenCalled();
    });

    it('issues BAN on third required subscription violation without adding the user to global spammers', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
        requiredSubscriptionWarnEnabled: true,
        requiredSubscriptionBanEnabled: true,
      });
      prisma.violation.count.mockResolvedValue(3);
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const redisCounter = createRequiredSubscriptionRedisCounter();
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          entityType: 'channel',
        }),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };

      const service = new ModerationService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        undefined,
        undefined,
        redisCounter as never,
      );

      await service.handleUpdate(createUpdate());

      expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
      const [, noticeText] = maxClient.sendMessage.mock.calls[0] ?? [];
      expect(noticeText).toContain('бан');
      expect(noticeText).toContain('Новости MAX');
      expect(prisma.moderationEvent.create.mock.calls).toEqual(
        expect.arrayContaining([
          [
            expect.objectContaining({
              data: expect.objectContaining({
                ruleCode: 'REQUIRED_SUBSCRIPTION',
                action: SanctionAction.BAN,
                metadata: expect.objectContaining({
                  requiredSubscriptionViolationCount24h: 3,
                }),
              }),
            }),
          ],
        ]),
      );
      expect(prisma.globalSpammer.upsert).not.toHaveBeenCalled();
      expect(maxClient.kickMember).not.toHaveBeenCalled();
      expect(maxClient.banMember).toHaveBeenCalledWith('chat-1', 'user-1');
    });

    it('issues BAN on fourth required subscription violation without adding the user to global spammers', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
        requiredSubscriptionWarnEnabled: true,
        requiredSubscriptionBanEnabled: true,
        requiredSubscriptionMuteEnabled: true,
      });
      prisma.violation.count.mockResolvedValue(4);
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const redisCounter = createRequiredSubscriptionRedisCounter();
      const maxClient = {
        hasChatMember: jest.fn().mockResolvedValue(false),
        getChatSnapshot: jest.fn().mockResolvedValue({
          title: 'Новости MAX',
          link: 'https://max.ru/channels/news-max',
          participantsCount: 100,
          entityType: 'channel',
        }),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };

      const service = new ModerationService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        undefined,
        undefined,
        redisCounter as never,
      );

      await service.handleUpdate(createUpdate());

      expect(maxClient.kickMember).not.toHaveBeenCalled();
      expect(maxClient.banMember).toHaveBeenCalledWith('chat-1', 'user-1');
      expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
      const [, noticeText] = maxClient.sendMessage.mock.calls[0] ?? [];
      expect(noticeText).toContain('Новости MAX');
      expect(prisma.moderationEvent.create.mock.calls).toEqual(
        expect.arrayContaining([
          [
            expect.objectContaining({
              data: expect.objectContaining({
                ruleCode: 'REQUIRED_SUBSCRIPTION',
                action: SanctionAction.BAN,
                metadata: expect.objectContaining({
                  requiredSubscriptionViolationCount24h: 4,
                }),
              }),
            }),
          ],
        ]),
      );
      expect(prisma.globalSpammer.upsert).not.toHaveBeenCalled();
    });

    it('fails open when MAX membership lookup errors', async () => {
      const prisma = createPrismaForRequiredSubscription({
        requiredSubscriptionEnabled: true,
        requiredSubscriptionChannelIds: ['channel-1'],
      });
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const redisCounter = createRequiredSubscriptionRedisCounter();
      const maxClient = {
        hasChatMember: jest.fn().mockRejectedValue(new Error('MAX unavailable')),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        resolveMessageLink: jest.fn().mockResolvedValue(null),
      };

      const service = new ModerationService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        undefined,
        undefined,
        redisCounter as never,
      );

      await service.handleUpdate(createUpdate());

      expect(ruleEngine.detect).toHaveBeenCalledTimes(1);
      expect(maxClient.deleteMessage).not.toHaveBeenCalled();
      expect(maxClient.sendMessage).not.toHaveBeenCalled();
      expect(prisma.violation.create).not.toHaveBeenCalled();
      expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
    });

    it('keeps admin bypass ahead of required subscription checks', async () => {
      const prisma = createPrismaForRequiredSubscription(
        {
          requiredSubscriptionEnabled: true,
          requiredSubscriptionChannelIds: ['channel-1'],
        },
        ['user-1'],
      );
      const ruleEngine = {
        detect: jest.fn(),
      };
      const maxClient = {
        hasChatMember: jest.fn(),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
      };

      const service = new ModerationService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
      );

      await service.handleUpdate(createUpdate());

      expect(maxClient.hasChatMember).not.toHaveBeenCalled();
      expect(ruleEngine.detect).not.toHaveBeenCalled();
      expect(maxClient.deleteMessage).not.toHaveBeenCalled();
      expect(maxClient.sendMessage).not.toHaveBeenCalled();
    });
  });

  it('records the first managed poll vote and updates the published message', async () => {
    const prisma = {
      managedPoll: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'poll-1',
          chatId: 'channel-1',
          question: 'Какой режим выбираем?',
          options: ['Соло', 'Сквад'],
          status: 'ACTIVE',
          activeVersion: 1,
          publishedMessageId: 'mid-poll-1',
        }),
      },
      managedPollVote: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue(undefined),
        findMany: jest.fn().mockResolvedValue([{ optionIndex: 0 }]),
      },
      chat: {
        upsert: jest.fn(),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn(),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      globalSpammer: {
        upsert: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      answerCallback: jest.fn().mockResolvedValue(undefined),
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
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

    await service.handleUpdate(createManagedPollCallbackUpdate('poll|poll-1|1|0'));

    expect(prisma.managedPollVote.upsert).toHaveBeenCalledWith({
      where: {
        pollId_pollVersion_userId: {
          pollId: 'poll-1',
          pollVersion: 1,
          userId: 'user-1',
        },
      },
      create: {
        pollId: 'poll-1',
        pollVersion: 1,
        userId: 'user-1',
        optionIndex: 0,
      },
      update: {
        optionIndex: 0,
      },
    });
    expect(maxClient.editMessageInlineKeyboard).not.toHaveBeenCalled();
    expect(maxClient.answerCallback).toHaveBeenCalledWith(
      'callback-poll-1',
      'Голос учтён',
      expect.objectContaining({
        text: expect.stringContaining('Соло - 1 (100%)'),
        options: expect.objectContaining({
          buttons: [
            [expect.objectContaining({ text: 'Соло (1)' })],
            [expect.objectContaining({ text: 'Сквад (0)' })],
          ],
        }),
      }),
    );
  });

  it('does not rewrite the vote when the same option is pressed again', async () => {
    const prisma = {
      managedPoll: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'poll-1',
          chatId: 'channel-1',
          question: 'Какой режим выбираем?',
          options: ['Соло', 'Сквад'],
          status: 'ACTIVE',
          activeVersion: 1,
          publishedMessageId: 'mid-poll-1',
        }),
      },
      managedPollVote: {
        findUnique: jest.fn().mockResolvedValue({ optionIndex: 0 }),
        upsert: jest.fn(),
        findMany: jest.fn().mockResolvedValue([{ optionIndex: 0 }]),
      },
      chat: {
        upsert: jest.fn(),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn(),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      globalSpammer: {
        upsert: jest.fn(),
      },
    };
    const maxClient = {
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
      answerCallback: jest.fn().mockResolvedValue(undefined),
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
    );

    await service.handleUpdate(createManagedPollCallbackUpdate('poll|poll-1|1|0'));

    expect(prisma.managedPollVote.upsert).not.toHaveBeenCalled();
    expect(prisma.managedPollVote.findMany).not.toHaveBeenCalled();
    expect(maxClient.editMessageInlineKeyboard).not.toHaveBeenCalled();
    expect(maxClient.answerCallback).toHaveBeenCalledWith(
      'callback-poll-1',
      'Вы уже выбрали этот вариант',
    );
  });

  it('rejects callbacks for a closed managed poll', async () => {
    const prisma = {
      managedPoll: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'poll-1',
          chatId: 'channel-1',
          question: 'Какой режим выбираем?',
          options: ['Соло', 'Сквад'],
          status: 'CLOSED',
          activeVersion: 1,
          publishedMessageId: 'mid-poll-1',
        }),
      },
      managedPollVote: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        findMany: jest.fn(),
      },
      chat: {
        upsert: jest.fn(),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn(),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      globalSpammer: {
        upsert: jest.fn(),
      },
    };
    const maxClient = {
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
      answerCallback: jest.fn().mockResolvedValue(undefined),
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
    );

    await service.handleUpdate(createManagedPollCallbackUpdate('poll|poll-1|1|0'));

    expect(prisma.managedPollVote.upsert).not.toHaveBeenCalled();
    expect(maxClient.editMessageInlineKeyboard).not.toHaveBeenCalled();
    expect(maxClient.answerCallback).toHaveBeenCalledWith('callback-poll-1', 'Опрос закрыт');
  });
});
