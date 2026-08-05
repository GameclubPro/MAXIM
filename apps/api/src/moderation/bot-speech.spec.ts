import {
  BOT_SPEECH_EDITABLE_FIELD_KEYS,
  BOT_SPEECH_PERSONA_VALUES,
  BOT_SPEECH_STYLE_VALUES,
  BOT_SPEECH_SYSTEM_TEMPLATE_KEYS,
  applyBotSpeechStylePreset,
  getBotSpeechEditableTemplate,
  getBotSpeechSystemTemplate,
  hasBotSpeechEditableOverrides,
  type BotSpeechSettingsSubset,
} from '@maxim/contracts/bot-speech';
import { ModerationService } from './moderation.service';

function extractTemplatePlaceholders(template: string): string[] {
  return [...template.matchAll(/\{([a-z_]+)\}/gu)].map((match) => match[1]!).sort();
}

const EXPECTED_EDITABLE_PLACEHOLDERS = {
  greetingBotMessageText: ['bot_character_name', 'user'],
  linkBotMessageText: ['message_status', 'reason', 'user'],
  linkWarnMessageText: ['reason', 'user'],
  requiredSubscriptionBotMessageText: ['channels', 'message_status', 'user'],
  requiredSubscriptionWarnMessageText: ['channels', 'reason', 'user'],
  invitationAccessBotMessageText: [
    'invited_count',
    'message_status',
    'remaining_invites',
    'required_invites',
    'required_invites_count',
    'user',
  ],
  invitationAccessWarnMessageText: [
    'invited_count',
    'reason',
    'required_invites',
    'required_invites_count',
    'user',
  ],
  textFiltersBotMessageText: ['message_status', 'reason', 'user'],
  textFiltersWarnMessageText: ['reason', 'user'],
  duplicateBotMessageText: ['sanction', 'user'],
  messageLimitsBotMessageText: ['message_status', 'reason', 'user'],
  messageLimitsWarnMessageText: ['reason', 'user'],
  phoneNumbersBotMessageText: ['message_status', 'reason', 'user'],
  nightModeBotMessageText: ['night_status', 'night_timezone', 'night_window'],
  nightModeOpenMessageText: ['opening_status'],
} satisfies Record<(typeof BOT_SPEECH_EDITABLE_FIELD_KEYS)[number], string[]>;

const EXPECTED_SYSTEM_PLACEHOLDERS = {
  linkEdited: ['message_status', 'reason', 'user'],
  linkEditedWarn: ['reason', 'user'],
  linkMute: ['user'],
  requiredSubscriptionMute: ['channels', 'user'],
  requiredSubscriptionBan: ['channels', 'user'],
  invitationAccessMute: ['remaining_invites', 'required_invites', 'user'],
  invitationAccessBan: ['user'],
  textFiltersMuteCommercial: ['user'],
  textFiltersMuteProfanity: ['user'],
  textFiltersMuteGeneric: ['user'],
  muteNotice: ['mute_duration', 'user'],
  permanentBanNotice: ['user'],
  messageLimitsWarn: ['reason', 'user'],
  messageLimitsMute: ['reason', 'user'],
  messageLimitsBan: ['reason', 'user'],
  duplicateWarn: [],
  duplicateMute: ['mute_duration'],
  duplicateBan: [],
  duplicatePassiveDeleted: [],
  duplicatePassiveKept: [],
} satisfies Record<(typeof BOT_SPEECH_SYSTEM_TEMPLATE_KEYS)[number], string[]>;

function createBotSpeechSettings(
  overrides: Partial<BotSpeechSettingsSubset> = {},
): BotSpeechSettingsSubset {
  return {
    botSpeechStyle: null,
    greetingBotMessageText: '',
    linkBotMessageText: '',
    linkWarnMessageText: '',
    requiredSubscriptionBotMessageText: '',
    requiredSubscriptionWarnMessageText: '',
    invitationAccessBotMessageText: '',
    invitationAccessWarnMessageText: '',
    textFiltersBotMessageText: '',
    textFiltersWarnMessageText: '',
    duplicateBotMessageText: '',
    messageLimitsBotMessageText: '',
    messageLimitsWarnMessageText: '',
    phoneNumbersBotMessageText: '',
    nightModeBotMessageText: '',
    nightModeOpenMessageText: '',
    ...overrides,
  };
}

function createService(): ModerationService {
  return new ModerationService({} as never, {} as never, {} as never, {} as never);
}

describe('bot speech styles', () => {
  it('uses the current police preset when style is null and matches explicit POLICE', () => {
    const service = createService();
    const userLabel = '**Алексей**';

    const legacyLinkText = (service as any).buildLinkExplanation(userLabel, true, '', null);
    const policeLinkText = (service as any).buildLinkExplanation(userLabel, true, '', 'POLICE');
    const legacyWarnText = (service as any).buildMessageLimitsWarnExplanation(
      userLabel,
      'MESSAGE_TOO_LONG',
      null,
      null,
    );
    const policeWarnText = (service as any).buildMessageLimitsWarnExplanation(
      userLabel,
      'MESSAGE_TOO_LONG',
      null,
      'POLICE',
    );

    expect(legacyLinkText).toBe(
      '**Алексей**, сообщение удалено: эта ссылка запрещена настройками чата. Без самодеятельности.',
    );
    expect(legacyWarnText).toBe(
      '**Алексей**, предупреждение зафиксировано. Основание: сообщение превышает допустимую длину.',
    );
    expect(policeLinkText).toBe(legacyLinkText);
    expect(policeWarnText).toBe(legacyWarnText);
  });

  it('renders robot, friendly and ironic templates with style presets', () => {
    const service = createService();
    const userLabel = '**Алексей**';

    expect((service as any).buildGreetingMessage(userLabel, '', 'ROBOT')).toBe(
      'Привет, **Алексей**. Я Майор Максимов. Подскажу правила и помогу освоиться в чате.',
    );
    expect(
      (service as any).buildNightModeOpenedNotice(23 * 60, 8 * 60, 'Europe/Moscow', '', 'ROBOT'),
    ).toBe('Чат снова открыт. Можно отправлять сообщения.');

    expect((service as any).buildLinkExplanation(userLabel, true, '', 'ROBOT')).toBe(
      '**Алексей**, сообщение удалено: эта ссылка запрещена настройками чата.',
    );
    expect(
      (service as any).buildRequiredSubscriptionWarnExplanation(
        userLabel,
        ['Новости MAX'],
        '',
        'ROBOT',
      ),
    ).toBe(
      '**Алексей**, предупреждение: обязательная подписка ещё не подтверждена. Подпишитесь на Новости MAX.',
    );

    expect(
      (service as any).buildMessageLimitsExplanation(
        userLabel,
        'MESSAGE_TOO_LONG',
        true,
        1,
        5,
        1,
        5,
        187,
        100,
        null,
        '',
        'ROBOT',
      ),
    ).toBe('**Алексей**, сообщение удалено: длина сообщения 187 символов при лимите 100.');

    expect((service as any).buildDuplicateHitExplanation(userLabel, true, '', 'ROBOT')).toBe(
      '**Алексей**, сообщение распознано как повтор. Повтор удалён, дополнительной санкции нет.',
    );

    expect((service as any).buildDuplicateHitExplanation(userLabel, false, '', 'ROBOT')).toBe(
      '**Алексей**, сообщение распознано как повтор. Повтор отмечен, дополнительной санкции нет.',
    );

    expect(
      (service as any).buildDuplicateHitExplanation(userLabel, true, '', 'ROBOT', 'image'),
    ).toBe('**Алексей**, фото распознано как повтор. Повтор удалён, дополнительной санкции нет.');

    expect(
      (service as any).buildDuplicateHitExplanation(userLabel, true, '', 'FRIENDLY', 'image_set'),
    ).toBe('**Алексей**, альбом повторился. Повтор удалён, дополнительной санкции нет.');

    expect(
      (service as any).buildDuplicateExplanation(
        userLabel,
        {
          action: 'WARN',
          count: 2,
          threshold: 2,
          windowSec: 30,
          hash: 'dup-hash',
          nextAction: 'MUTE',
        },
        6,
        true,
        '',
        'ROBOT',
      ),
    ).toBe('**Алексей**, сообщение распознано как повтор. Предупреждение за повтор зафиксировано.');

    expect(
      (service as any).buildMessageLimitsWarnExplanation(
        userLabel,
        'MESSAGE_TOO_LONG',
        null,
        'ROBOT',
      ),
    ).toBe('**Алексей**, предупреждение: сообщение превышает допустимую длину.');

    expect((service as any).buildGreetingMessage(userLabel, '', 'POLICE')).toBe(
      'Приветствую, **Алексей**. На связи Майор Максимов. Здесь всё просто: соблюдаем правила, остальное разберём по факту.',
    );

    expect((service as any).buildDuplicateHitExplanation(userLabel, true, '', 'POLICE')).toBe(
      '**Алексей**, повтор зафиксирован. Повтор удалён. Профилактика сработала.',
    );

    expect((service as any).buildGreetingMessage(userLabel, '', 'FRIENDLY')).toBe(
      'Привет, **Алексей** 👋 На связи Майор Максимов. Помогу освоиться и не запутаться в правилах.',
    );
    expect(
      (service as any).buildNightModeOpenedNotice(23 * 60, 8 * 60, 'Europe/Moscow', '', 'FRIENDLY'),
    ).toBe('Чат снова открыт. Можно снова писать.');

    expect((service as any).buildLinkExplanation(userLabel, true, '', 'FRIENDLY')).toBe(
      '**Алексей**, сообщение удалено: эта ссылка запрещена настройками чата. В следующих сообщениях учитывайте правила для ссылок.',
    );

    expect(
      (service as any).buildMessageLimitsExplanation(
        userLabel,
        'MESSAGE_TOO_LONG',
        true,
        1,
        5,
        1,
        5,
        187,
        100,
        null,
        '',
        'FRIENDLY',
      ),
    ).toBe(
      '**Алексей**, сообщение удалено: длина сообщения 187 символов при лимите 100. Учтите это перед следующей отправкой.',
    );

    expect(
      (service as any).buildMessageLimitsExplanation(
        userLabel,
        'PHOTO_RATE_LIMIT',
        true,
        1,
        5,
        2,
        5,
        undefined,
        undefined,
        null,
        '',
        'FRIENDLY',
      ),
    ).toBe(
      '**Алексей**, сообщение удалено: между отправками фото должно пройти не менее 2 ч. Учтите это перед следующей отправкой.',
    );

    expect((service as any).buildDuplicateHitExplanation(userLabel, true, '', 'FRIENDLY')).toBe(
      '**Алексей**, сообщение повторилось. Повтор удалён, дополнительной санкции нет.',
    );

    expect((service as any).buildDuplicateHitExplanation(userLabel, false, '', 'FRIENDLY')).toBe(
      '**Алексей**, сообщение повторилось. Повтор отмечен, пока без санкции.',
    );

    expect(
      (service as any).buildDuplicateExplanation(
        userLabel,
        {
          action: 'WARN',
          count: 2,
          threshold: 2,
          windowSec: 30,
          hash: 'dup-hash',
          nextAction: 'MUTE',
        },
        6,
        true,
        '',
        'FRIENDLY',
      ),
    ).toBe('**Алексей**, сообщение повторилось. Это предупреждение за повтор.');

    expect(
      (service as any).buildMessageLimitsWarnExplanation(
        userLabel,
        'MESSAGE_TOO_LONG',
        null,
        'FRIENDLY',
      ),
    ).toBe('**Алексей**, это предупреждение: сообщение превышает допустимую длину.');
    expect(
      (service as any).buildRequiredSubscriptionMuteExplanation(
        userLabel,
        ['Новости MAX'],
        'FRIENDLY',
      ),
    ).toBe(
      '**Алексей**, за сообщения без подписки включён мут. Чтобы писать после его окончания, подпишитесь на Новости MAX.',
    );

    expect((service as any).buildGreetingMessage(userLabel, '', 'IRONIC')).toBe(
      'Привет, **Алексей**. На связи Майор Максимов. У правил здесь хорошая память, а у меня короткие комментарии.',
    );
    expect(
      (service as any).buildNightModeOpenedNotice(23 * 60, 8 * 60, 'Europe/Moscow', '', 'IRONIC'),
    ).toBe('Чат снова открыт. Лента снова принимает реплики.');

    expect((service as any).buildLinkExplanation(userLabel, true, '', 'IRONIC')).toBe(
      '**Алексей**, ссылка решила пройти без пропуска. Сообщение удалено: эта ссылка запрещена настройками чата.',
    );

    expect((service as any).buildDuplicateHitExplanation(userLabel, true, '', 'IRONIC')).toBe(
      '**Алексей**, сообщение вышло на бис. Повтор удалён.',
    );

    expect(
      (service as any).buildDuplicateExplanation(
        userLabel,
        {
          action: 'WARN',
          count: 2,
          threshold: 2,
          windowSec: 30,
          hash: 'dup-hash',
          nextAction: 'MUTE',
        },
        6,
        true,
        '',
        'IRONIC',
      ),
    ).toBe('**Алексей**, сообщение вышло на бис. Предупреждение за повтор.');
  });

  it('keeps inherited invitation counters grammatical without rewriting custom copy', () => {
    const service = createService();
    const userLabel = '**Алексей**';

    expect(
      (service as any).buildInvitationAccessExplanation(userLabel, true, 3, 2, '', 'ROBOT'),
    ).toBe(
      '**Алексей**, сообщение удалено. Чтобы писать в чат, нужно пригласить 3 друзей. Прогресс: 2/3; осталось пригласить 1 друга.',
    );
    expect((service as any).buildInvitationAccessMuteExplanation(userLabel, 3, 1, 'POLICE')).toBe(
      '**Алексей**, условие по приглашениям не выполнено. Включён мут. Нужно пригласить 3 друзей; осталось пригласить 2 друзей.',
    );
    expect(
      (service as any).buildInvitationAccessExplanation(
        userLabel,
        true,
        3,
        2,
        'Осталось: {remaining_invites}.',
        'ROBOT',
      ),
    ).toBe('Осталось: 1 друга.');
  });

  it('keeps current sanction defaults gender-neutral for every bot persona', () => {
    expect(getBotSpeechEditableTemplate('POLICE', 'linkBotMessageText', 'female')).toBe(
      getBotSpeechEditableTemplate('POLICE', 'linkBotMessageText', 'male'),
    );
    expect(getBotSpeechEditableTemplate('POLICE', 'duplicateBotMessageText', 'neutral')).toBe(
      getBotSpeechEditableTemplate('POLICE', 'duplicateBotMessageText', 'male'),
    );
    expect(getBotSpeechSystemTemplate('POLICE', 'messageLimitsWarn', 'female')).toBe(
      getBotSpeechSystemTemplate('POLICE', 'messageLimitsWarn', 'neutral'),
    );
    expect(getBotSpeechSystemTemplate('POLICE', 'messageLimitsWarn', 'neutral')).not.toMatch(
      /\b(?:взял|взяла|прикрыл|прикрыла)\b/u,
    );
  });

  it('keeps system notices on the selected base style when one editable field is overridden', () => {
    const service = createService();
    const userLabel = '**Алексей**';

    expect(
      (service as any).buildLinkExplanation(
        userLabel,
        true,
        'Ручной разбор для {user}. Причина: {reason}.',
        'IRONIC',
      ),
    ).toBe('Ручной разбор для **Алексей**. Причина: в этом чате ссылки не проходят, без ссылок.');

    expect(
      (service as any).buildMessageLimitsWarnExplanation(
        userLabel,
        'MESSAGE_TOO_LONG',
        null,
        'IRONIC',
      ),
    ).toBe(
      '**Алексей**, предупреждение: сообщение превышает допустимую длину. У ограничений чата всё довольно буквально.',
    );

    expect((service as any).buildLinkMuteExplanation(userLabel, 'IRONIC')).toBe(
      '**Алексей**, за запрещённую ссылку включён мут. Переход временно закрыт.',
    );
    expect((service as any).buildMuteNotice(userLabel, 6, 'IRONIC')).toBe(
      '**Алексей**, мут включён на 6ч. До конца срока новые сообщения будут удаляться.',
    );
  });

  it('uses subtle edited-message copy for default link notices', () => {
    const service = createService();
    const userLabel = '**Алексей**';

    expect((service as any).buildLinkExplanation(userLabel, true, '', 'POLICE', true)).toBe(
      '**Алексей**, сообщение удалено: добавленная при редактировании ссылка запрещена настройками чата. Правка правила не отменяет.',
    );
    expect((service as any).buildLinkWarnExplanation(userLabel, '', 'POLICE', true)).toBe(
      '**Алексей**, предупреждение зафиксировано: добавленная при редактировании ссылка запрещена настройками чата. Правка правила не отменяет.',
    );

    expect(
      (service as any).buildLinkWarnExplanation(
        userLabel,
        'Ручной текст: {warning}. Причина: {reason}.',
        'POLICE',
        true,
      ),
    ).toBe(
      'Ручной текст: вынесено предупреждение за ссылку после редактирования. Причина: ссылка появилась после тихой правки; в этом чате ссылки всё ещё нельзя.',
    );
  });

  it('uses new defaults only for inherited fields and preserves legacy custom rendering', () => {
    const service = createService();
    const userLabel = '**Алексей**';
    const formerRobotDefault = '🔗 {user}, сообщение {message_status}. Причина: {reason}.';

    expect((service as any).buildLinkExplanation(userLabel, true, '', 'ROBOT')).toBe(
      '**Алексей**, сообщение удалено: эта ссылка запрещена настройками чата.',
    );
    expect(
      (service as any).buildLinkExplanation(userLabel, true, formerRobotDefault, 'ROBOT'),
    ).toBe(
      '🔗 **Алексей**, сообщение снято с линии. Причина: в этом чате ссылки не проходят, без ссылок.',
    );

    expect(
      (service as any).buildDuplicateExplanation(
        userLabel,
        {
          action: 'WARN',
          count: 2,
          threshold: 2,
          windowSec: 30,
          hash: 'dup-custom-hash',
          nextAction: 'MUTE',
        },
        6,
        false,
        'Статус: {message_status}. Контекст: {duplicate_context}. {sanction}',
        'ROBOT',
      ),
    ).toBe('Статус: не по форме. Контекст: идёт повтором. ⚠️ Предупреждение записано.');

    expect((service as any).buildPhoneNumbersExplanation(userLabel, true, '', 'POLICE')).toBe(
      '**Алексей**, сообщение удалено: номера телефонов в сообщениях запрещены. Дальше без номера в тексте.',
    );
    expect(
      (service as any).buildPhoneNumbersExplanation(
        userLabel,
        true,
        '☎️ {user}, сообщение {message_status}. Причина: {reason}.',
        'POLICE',
      ),
    ).toBe(
      '☎️ **Алексей**, сообщение снято с линии. Причина: телефонные номера в этом чате запрещены.',
    );

    expect(
      (service as any).buildTextFilterExplanation(
        userLabel,
        'COMMERCIAL_AD',
        true,
        'Своя проверка: {message_status}; {reason}.',
        'POLICE',
      ),
    ).toBe('Своя проверка: снято с линии; коммерческая реклама в этом чате запрещена.');
  });

  it('preserves every non-empty custom template without trimming whitespace', () => {
    const service = createService();
    const customTemplate = '  Свой текст для {user}.\n';

    expect(
      (service as any).buildLinkExplanation('**Алексей**', true, customTemplate, 'ROBOT'),
    ).toBe('  Свой текст для **Алексей**.\n');
    expect(
      hasBotSpeechEditableOverrides(
        createBotSpeechSettings({
          linkBotMessageText: '   ',
        }),
      ),
    ).toBe(true);
  });

  it('keeps shared default templates accurate for ads and blocked content', () => {
    const service = createService();
    const userLabel = '**Алексей**';

    expect(
      (service as any).buildTextFilterExplanation(userLabel, 'COMMERCIAL_AD', true, '', 'FRIENDLY'),
    ).toBe(
      '**Алексей**, сообщение удалено: коммерческая реклама запрещена правилами чата. Давайте дальше без этого.',
    );
    expect(
      (service as any).buildMessageLimitsExplanation(
        userLabel,
        'MESSAGE_BLOCKED_WORD',
        true,
        5,
        1,
        1,
        5,
        undefined,
        undefined,
        'казино',
        '',
        'IRONIC',
      ),
    ).toBe(
      '**Алексей**, сообщение удалено: сообщение совпало со стоп-листом чата. Настройки не считают себя рекомендациями.',
    );
    expect(
      (service as any).buildMessageLimitsMuteExplanation(
        userLabel,
        'VOICE_BLOCKED',
        null,
        'POLICE',
      ),
    ).toBe(
      '**Алексей**, включён мут. Основание: отправка голосовых сообщений в этом чате отключена.',
    );
  });

  it('keeps placeholder sets aligned and all current presets persona-neutral', () => {
    const genderedOrForeignPersonaCopy =
      /\b(?:Майор|Максимов|Максимова|Капитан|взял|взяла|прикрыл|прикрыла|включил|включила|убрал|убрала)\b/iu;

    for (const fieldKey of BOT_SPEECH_EDITABLE_FIELD_KEYS) {
      const expectedPlaceholders = EXPECTED_EDITABLE_PLACEHOLDERS[fieldKey];
      for (const style of BOT_SPEECH_STYLE_VALUES) {
        const neutralTemplate = getBotSpeechEditableTemplate(style, fieldKey, 'neutral');
        expect(extractTemplatePlaceholders(neutralTemplate)).toEqual(expectedPlaceholders);
        expect(neutralTemplate).not.toMatch(genderedOrForeignPersonaCopy);
        for (const persona of BOT_SPEECH_PERSONA_VALUES) {
          expect(getBotSpeechEditableTemplate(style, fieldKey, persona)).toBe(neutralTemplate);
        }
      }
    }

    for (const templateKey of BOT_SPEECH_SYSTEM_TEMPLATE_KEYS) {
      const expectedPlaceholders = EXPECTED_SYSTEM_PLACEHOLDERS[templateKey];
      for (const style of BOT_SPEECH_STYLE_VALUES) {
        const neutralTemplate = getBotSpeechSystemTemplate(style, templateKey, 'neutral');
        expect(extractTemplatePlaceholders(neutralTemplate)).toEqual(expectedPlaceholders);
        expect(neutralTemplate).not.toMatch(genderedOrForeignPersonaCopy);
        for (const persona of BOT_SPEECH_PERSONA_VALUES) {
          expect(getBotSpeechSystemTemplate(style, templateKey, persona)).toBe(neutralTemplate);
        }
      }
    }
  });

  it('keeps link mute copy accurate when the configured threshold is one', () => {
    for (const style of BOT_SPEECH_STYLE_VALUES) {
      expect(getBotSpeechSystemTemplate(style, 'linkMute')).not.toMatch(/повтор|новые ссылки/iu);
    }
  });

  it('keeps inherited fields empty while switching them to the selected style fallback', () => {
    const nextSettings = applyBotSpeechStylePreset(
      createBotSpeechSettings({
        botSpeechStyle: 'POLICE',
      }),
      'FRIENDLY',
    );

    expect(hasBotSpeechEditableOverrides(nextSettings)).toBe(false);
    expect(nextSettings.botSpeechStyle).toBe('FRIENDLY');

    for (const key of BOT_SPEECH_EDITABLE_FIELD_KEYS) {
      expect(nextSettings[key]).toBe('');
      expect(getBotSpeechEditableTemplate(nextSettings.botSpeechStyle, key)).not.toBe('');
    }
    expect(
      getBotSpeechEditableTemplate(nextSettings.botSpeechStyle, 'greetingBotMessageText'),
    ).toBe(
      'Привет, {user} 👋 На связи {bot_character_name}. Помогу освоиться и не запутаться в правилах.',
    );
  });

  it('preserves every custom template byte-for-byte when switching styles', () => {
    const settings = createBotSpeechSettings({ botSpeechStyle: 'POLICE' });
    for (const [index, key] of BOT_SPEECH_EDITABLE_FIELD_KEYS.entries()) {
      settings[key] = index === 0 ? '   ' : `  Свой текст ${key}.\n`;
    }

    const nextSettings = applyBotSpeechStylePreset(settings, 'IRONIC');

    expect(nextSettings.botSpeechStyle).toBe('IRONIC');
    expect(hasBotSpeechEditableOverrides(nextSettings)).toBe(true);
    for (const key of BOT_SPEECH_EDITABLE_FIELD_KEYS) {
      expect(nextSettings[key]).toBe(settings[key]);
    }
  });

  it('detects manual overrides before preset reset', () => {
    expect(
      hasBotSpeechEditableOverrides(
        createBotSpeechSettings({
          textFiltersWarnMessageText: 'Ручное предупреждение',
        }),
      ),
    ).toBe(true);
  });
});
