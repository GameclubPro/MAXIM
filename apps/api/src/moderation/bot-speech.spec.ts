import {
  BOT_SPEECH_EDITABLE_FIELD_KEYS,
  applyBotSpeechStylePreset,
  hasBotSpeechEditableOverrides,
  type BotSpeechSettingsSubset,
} from '@maxim/contracts';
import { ModerationService } from './moderation.service';

function createBotSpeechSettings(
  overrides: Partial<BotSpeechSettingsSubset> = {},
): BotSpeechSettingsSubset {
  return {
    botSpeechStyle: null,
    greetingBotMessageText: '',
    linkBotMessageText: '',
    linkWarnMessageText: '',
    textFiltersBotMessageText: '',
    textFiltersWarnMessageText: '',
    duplicateBotMessageText: '',
    messageLimitsBotMessageText: '',
    nightModeBotMessageText: '',
    ...overrides,
  };
}

function createService(): ModerationService {
  return new ModerationService({} as never, {} as never, {} as never, {} as never);
}

describe('bot speech styles', () => {
  it('keeps legacy police text when style is null and matches explicit POLICE', () => {
    const service = createService();
    const userLabel = '**Алексей**';

    const legacyLinkText = (service as any).buildLinkExplanation(userLabel, true, '', null);
    const policeLinkText = (service as any).buildLinkExplanation(userLabel, true, '', 'POLICE');
    const legacyWarnText = (service as any).buildMessageLimitsWarnExplanation(
      userLabel,
      'MESSAGE_TOO_LONG',
      null,
    );
    const policeWarnText = (service as any).buildMessageLimitsWarnExplanation(
      userLabel,
      'MESSAGE_TOO_LONG',
      'POLICE',
    );

    expect(legacyLinkText).toBe(
      'Товарищ **Алексей**, Майор Максимов на связи 👮‍♂️ Сообщение снято с линии: в этом чате ссылки не проходят, без ссылок. Поправьте и едем дальше.',
    );
    expect(legacyWarnText).toBe(
      'Товарищ **Алексей**, фиксирую предупреждение. Причина: слишком длинное сообщение.',
    );
    expect(policeLinkText).toBe(legacyLinkText);
    expect(policeWarnText).toBe(legacyWarnText);
  });

  it('renders robot, friendly and ironic templates with style presets', () => {
    const service = createService();
    const userLabel = '**Алексей**';

    expect((service as any).buildGreetingMessage(userLabel, '', 'ROBOT')).toBe(
      'Система: **Алексей**, доступ в чат открыт.',
    );

    expect((service as any).buildLinkExplanation(userLabel, true, '', 'ROBOT')).toBe(
      'Система: **Алексей**. Ссылка удалена. Причина: в этом чате ссылки не проходят, без ссылок.',
    );

    expect(
      (service as any).buildMessageLimitsExplanation(
        userLabel,
        'MESSAGE_TOO_LONG',
        true,
        1,
        5,
        187,
        100,
        '',
        'ROBOT',
      ),
    ).toBe(
      'Система: **Алексей**. Сообщение отклонено. Причина: слишком длинное сообщение: 187 символов при лимите 100.',
    );

    expect(
      (service as any).buildDuplicateHitExplanation(userLabel, true, '', 'ROBOT'),
    ).toBe('Система: **Алексей**. Зафиксирован повтор сообщения. Сообщение удалено.');

    expect(
      (service as any).buildDuplicateExplanation(
        userLabel,
        {
          action: 'WARN',
          count: 2,
          threshold: 2,
          windowSec: 30,
          hash: 'dup-hash',
          nextAction: 'KICK',
        },
        6,
        '',
        'ROBOT',
      ),
    ).toBe('Система: **Алексей**. Зафиксирован повтор сообщения. Предупреждение зарегистрировано.');

    expect((service as any).buildMessageLimitsWarnExplanation(userLabel, 'MESSAGE_TOO_LONG', 'ROBOT')).toBe(
      'Система: **Алексей**. Предупреждение. Причина: слишком длинное сообщение.',
    );

    expect((service as any).buildGreetingMessage(userLabel, '', 'FRIENDLY')).toBe(
      'Привет, **Алексей** 🙂 Рады видеть тебя в чате.',
    );

    expect((service as any).buildLinkExplanation(userLabel, true, '', 'FRIENDLY')).toBe(
      '**Алексей**, ссылку пришлось убрать. В этом чате они отключены. Если она по делу, лучше сначала уточнить у админа.',
    );

    expect(
      (service as any).buildMessageLimitsExplanation(
        userLabel,
        'MESSAGE_TOO_LONG',
        true,
        1,
        5,
        187,
        100,
        '',
        'FRIENDLY',
      ),
    ).toBe(
      '**Алексей**, сообщение не прошло: слишком длинное сообщение: 187 символов при лимите 100. Чуть поправьте и можно снова.',
    );

    expect(
      (service as any).buildDuplicateHitExplanation(userLabel, true, '', 'FRIENDLY'),
    ).toBe('**Алексей**, такое сообщение уже было. Пока просто убрал повтор.');

    expect(
      (service as any).buildDuplicateExplanation(
        userLabel,
        {
          action: 'WARN',
          count: 2,
          threshold: 2,
          windowSec: 30,
          hash: 'dup-hash',
          nextAction: 'KICK',
        },
        6,
        '',
        'FRIENDLY',
      ),
    ).toBe('**Алексей**, такое сообщение уже было. Это уже предупреждение.');

    expect((service as any).buildMessageLimitsWarnExplanation(userLabel, 'MESSAGE_TOO_LONG', 'FRIENDLY')).toBe(
      '**Алексей**, это предупреждение. Причина: слишком длинное сообщение.',
    );

    expect((service as any).buildGreetingMessage(userLabel, '', 'IRONIC')).toBe(
      '**Алексей**, добро пожаловать 🙂 Осваивайтесь, правила тут тоже не бездельничают.',
    );

    expect((service as any).buildLinkExplanation(userLabel, true, '', 'IRONIC')).toBe(
      '**Алексей**, ссылку убрал. Интернет, конечно, огромный, но сюда его тащить не надо.',
    );

    expect(
      (service as any).buildDuplicateHitExplanation(userLabel, true, '', 'IRONIC'),
    ).toBe('**Алексей**, это сообщение уже было. Повтор убрал. Коллекцию можно не собирать.');

    expect(
      (service as any).buildDuplicateExplanation(
        userLabel,
        {
          action: 'WARN',
          count: 2,
          threshold: 2,
          windowSec: 30,
          hash: 'dup-hash',
          nextAction: 'KICK',
        },
        6,
        '',
        'IRONIC',
      ),
    ).toBe('**Алексей**, это сообщение уже было. Да, это уже предупреждение.');
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
    ).toBe(
      'Ручной разбор для **Алексей**. Причина: в этом чате ссылки не проходят, без ссылок.',
    );

    expect((service as any).buildMessageLimitsWarnExplanation(userLabel, 'MESSAGE_TOO_LONG', 'IRONIC')).toBe(
      '**Алексей**, это уже предупреждение. Причина: слишком длинное сообщение. Лимиты тут правда считают.',
    );

    expect((service as any).buildLinkKickExplanation(userLabel, 'IRONIC')).toBe(
      '**Алексей**, со ссылками вышел небольшой сериал, поэтому дальше чат без вас.',
    );
  });

  it('applies style presets by clearing all editable overrides and saving the base style', () => {
    const nextSettings = applyBotSpeechStylePreset(
      createBotSpeechSettings({
        botSpeechStyle: 'POLICE',
        greetingBotMessageText: 'Привет',
        linkBotMessageText: 'Свой текст',
        messageLimitsBotMessageText: 'Еще свой текст',
      }),
      'FRIENDLY',
    );

    expect(hasBotSpeechEditableOverrides(nextSettings)).toBe(false);
    expect(nextSettings.botSpeechStyle).toBe('FRIENDLY');

    for (const key of BOT_SPEECH_EDITABLE_FIELD_KEYS) {
      expect(nextSettings[key]).toBe('');
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
