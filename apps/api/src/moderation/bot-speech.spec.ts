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

  it('renders robot and friendly editable templates with style presets', () => {
    const service = createService();
    const userLabel = '**Алексей**';

    expect((service as any).buildGreetingMessage(userLabel, '', 'ROBOT')).toBe(
      'Пользователь **Алексей**: добро пожаловать в чат. Доступ открыт.',
    );

    expect((service as any).buildGreetingMessage(userLabel, '', 'FRIENDLY')).toBe(
      'Привет, **Алексей** 🙂 Рады видеть тебя в чате.',
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
      '**Алексей**, сообщение снято с линии: слишком длинное сообщение: 187 символов при лимите 100. Поправьте и попробуйте еще раз.',
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
    ).toBe(
      'Ручной разбор для **Алексей**. Причина: в этом чате ссылки не проходят, без ссылок.',
    );

    expect((service as any).buildMessageLimitsWarnExplanation(userLabel, 'MESSAGE_TOO_LONG', 'IRONIC')).toBe(
      '**Алексей**, предупреждение зафиксировано. Причина: слишком длинное сообщение. Лимиты тут всерьез.',
    );

    expect((service as any).buildLinkKickExplanation(userLabel, 'IRONIC')).toBe(
      '**Алексей**, ссылки не поняли намек, поэтому дальше чат без вас.',
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
