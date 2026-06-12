import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chatRulesSchema,
  chatSettingsScreenResponseSchema,
  chatSettingsSchema,
  type ChatRules,
  type ChatSettingsScreenResponse,
} from '@maxim/contracts';
import {
  buildRulesTextFromSettingsScreen,
  serializeRulesDraftPayload,
  shouldHydrateRulesDraftFromServer,
} from '../src/pages/settings-rules-state';

function createRules(overrides: Partial<ChatRules> = {}): ChatRules {
  return chatRulesSchema.parse({
    ...chatRulesSchema.parse({}),
    ...overrides,
  });
}

function createScreen(
  overrides: Partial<ChatSettingsScreenResponse> = {},
): ChatSettingsScreenResponse {
  return chatSettingsScreenResponseSchema.parse({
    settings: chatSettingsSchema.parse({}),
    rules: createRules(),
    header: {
      id: 'chat-1',
      title: 'Chat 1',
      entityType: 'chat',
      link: null,
      participantsCount: null,
    },
    requiredSubscriptionChannels: [],
    domains: [],
    managedBroadcasts: [],
    ...overrides,
  });
}

test('serializeRulesDraftPayload uses a stable field order for retry snapshots', () => {
  const payload = {
    autoTextEnabled: true,
    text: 'Правила',
    imageBase64: '',
    imageMimeType: '',
    imageFileName: '',
    buttonEnabled: false,
    buttonUrl: '',
    buttonText: 'Открыть',
  };

  assert.equal(
    serializeRulesDraftPayload(payload),
    JSON.stringify({
      text: 'Правила',
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      autoTextEnabled: true,
      buttonEnabled: false,
      buttonUrl: '',
      buttonText: 'Открыть',
    }),
  );
});

test('shouldHydrateRulesDraftFromServer preserves newer local edits during refetch', () => {
  const previousServerDraft = createRules({ text: 'Старый серверный черновик' });
  const currentDraft = createRules({ text: 'Новый локальный черновик' });
  const nextServerDraft = createRules({ text: 'Сервер после прошлого autosave' });

  assert.equal(
    shouldHydrateRulesDraftFromServer({
      currentDraft,
      previousServerSnapshot: serializeRulesDraftPayload(previousServerDraft),
      nextServerDraft,
    }),
    false,
  );
});

test('shouldHydrateRulesDraftFromServer accepts fresh server state when draft was not edited locally', () => {
  const previousServerDraft = createRules({ text: 'Серверный черновик' });
  const nextServerDraft = createRules({ text: 'Серверный черновик после сохранения' });

  assert.equal(
    shouldHydrateRulesDraftFromServer({
      currentDraft: previousServerDraft,
      previousServerSnapshot: serializeRulesDraftPayload(previousServerDraft),
      nextServerDraft,
    }),
    true,
  );
});

test('buildRulesTextFromSettingsScreen assembles a publishable draft from active settings', () => {
  const screen = createScreen({
    settings: chatSettingsSchema.parse({
      linkPolicy: 'ALLOWLIST_ONLY',
      requiredSubscriptionEnabled: true,
      requiredSubscriptionChannelIds: ['channel-1', 'channel-2'],
      russianProfanityFilterEnabled: true,
      antiSpamEnabled: true,
      photoMessagesEnabled: false,
      nightModeEnabled: true,
      nightModeStartTimeMinutes: 1380,
      nightModeEndTimeMinutes: 420,
    }),
    domains: [
      {
        domain: 'docs.max.ru',
        normalizedValue: 'docs.max.ru',
        matchType: 'DOMAIN',
        removeAfterAt: null,
      },
    ],
    requiredSubscriptionChannels: [
      {
        id: 'channel-1',
        title: 'Новости проекта',
        entityType: 'channel',
        link: null,
        participantsCount: null,
      },
      {
        id: 'channel-2',
        title: 'Объявления',
        entityType: 'channel',
        link: null,
        participantsCount: null,
      },
    ],
  });

  const text = buildRulesTextFromSettingsScreen(screen);
  assert.match(text, /^Правила чата:\n\n1\./);
  assert.match(text, /Можно отправлять только ссылки из разрешённого списка\./);
  assert.match(text, /Чтобы писать в чат, сначала подпишитесь на: Новости проекта, Объявления\./);
  assert.match(text, /Пожалуйста, без мата и грубой лексики\./);
  assert.match(text, /Пожалуйста, не флудите и не спамьте\./);
  assert.match(text, /Фото сюда отправлять нельзя\./);
  assert.match(text, /Ночью чат работает тише: ограничения действуют с 23:00 до 07:00\./);
});

test('buildRulesTextFromSettingsScreen treats legacy required subscription expiry as indefinite', () => {
  const screen = createScreen({
    settings: chatSettingsSchema.parse({
      requiredSubscriptionEnabled: true,
      requiredSubscriptionChannelIds: ['channel-1'],
      requiredSubscriptionExpiresAt: '2026-04-01T00:00:00.000Z',
      antiSpamEnabled: true,
    }),
    requiredSubscriptionChannels: [
      {
        id: 'channel-1',
        title: 'Новости проекта',
        entityType: 'channel',
        link: null,
        participantsCount: null,
      },
    ],
  });

  const text = buildRulesTextFromSettingsScreen(screen);
  assert.match(text, /Чтобы писать в чат, сначала подпишитесь на: Новости проекта\./);
  assert.match(text, /Пожалуйста, не флудите и не спамьте\./);
});
