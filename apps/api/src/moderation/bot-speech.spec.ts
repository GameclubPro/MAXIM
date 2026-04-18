import {
  BOT_SPEECH_EDITABLE_FIELD_KEYS,
  applyBotSpeechStylePreset,
  getBotSpeechEditableTemplate,
  getBotSpeechSystemTemplate,
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
    requiredSubscriptionBotMessageText: '',
    requiredSubscriptionWarnMessageText: '',
    textFiltersBotMessageText: '',
    textFiltersWarnMessageText: '',
    duplicateBotMessageText: '',
    messageLimitsBotMessageText: '',
    nightModeBotMessageText: '',
    nightModeOpenMessageText: '',
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
      null,
    );
    const policeWarnText = (service as any).buildMessageLimitsWarnExplanation(
      userLabel,
      'MESSAGE_TOO_LONG',
      null,
      'POLICE',
    );

    expect(legacyLinkText).toBe(
      'Товарищ **Алексей**, ссылку изъял 👮‍♂️ В этом чате с ними строго. Если вопрос по делу, согласуйте с админом.',
    );
    expect(legacyWarnText).toBe(
      'Товарищ **Алексей**, предупреждение оформил 👮‍♂️ Причина: слишком длинное сообщение.',
    );
    expect(policeLinkText).toBe(legacyLinkText);
    expect(policeWarnText).toBe(legacyWarnText);
  });

  it('renders robot, friendly and ironic templates with style presets', () => {
    const service = createService();
    const userLabel = '**Алексей**';

    expect((service as any).buildGreetingMessage(userLabel, '', 'ROBOT')).toBe(
      '🤖 **Алексей**, доступ открыт. На линии Майор Максимов. Работаем чисто и по правилам.',
    );
    expect(
      (service as any).buildNightModeOpenedNotice(23 * 60, 8 * 60, 'Europe/Moscow', '', 'ROBOT'),
    ).toBe('☀️ Ночной режим завершен. Группа снова открыта.');

    expect((service as any).buildLinkExplanation(userLabel, true, '', 'ROBOT')).toBe(
      '🔗 **Алексей**, сообщение снято с линии. Причина: в этом чате ссылки не проходят, без ссылок.',
    );
    expect(
      (service as any).buildRequiredSubscriptionWarnExplanation(
        userLabel,
        ['Новости MAX'],
        '',
        'ROBOT',
      ),
    ).toBe(
      '⚠️ **Алексей**, это предупреждение. Для сообщений нужна подписка на Новости MAX. Причина: для сообщений нужна подписка на обязательные чаты или каналы.',
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
    ).toBe(
      '📏 **Алексей**, сообщение снято с линии. Причина: слишком длинное сообщение: 187 символов при лимите 100.',
    );

    expect((service as any).buildDuplicateHitExplanation(userLabel, true, '', 'ROBOT')).toBe(
      '♻️ **Алексей**, дубль найден. 🧹 Дубль убран.',
    );

    expect((service as any).buildDuplicateHitExplanation(userLabel, false, '', 'ROBOT')).toBe(
      '♻️ **Алексей**, дубль найден. 🧾 Дубль отмечен без санкции.',
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
        'ROBOT',
      ),
    ).toBe('♻️ **Алексей**, дубль найден. ⚠️ Предупреждение записано.');

    expect(
      (service as any).buildMessageLimitsWarnExplanation(
        userLabel,
        'MESSAGE_TOO_LONG',
        null,
        'ROBOT',
      ),
    ).toBe(
      '⚠️ **Алексей**, это предупреждение. Причина: слишком длинное сообщение.',
    );

    expect((service as any).buildGreetingMessage(userLabel, '', 'POLICE')).toBe(
      'Здравия желаю, **Алексей** 🤝 На смене Майор Максимов. Осваивайтесь, но порядок не нарушаем.',
    );

    expect((service as any).buildDuplicateHitExplanation(userLabel, true, '', 'POLICE')).toBe(
      'Товарищ **Алексей**, повтор сообщения зафиксировал 👮‍♂️ Повтор изъял, пока без протокола.',
    );

    expect((service as any).buildGreetingMessage(userLabel, '', 'FRIENDLY')).toBe(
      'Привет, **Алексей** 🙂 На связи Майор Максимов. Осваивайтесь спокойно, я помогу держать чат в порядке.',
    );
    expect(
      (service as any).buildNightModeOpenedNotice(23 * 60, 8 * 60, 'Europe/Moscow', '', 'FRIENDLY'),
    ).toBe('Доброе утро ☀️ Группа снова открыта. Можно снова возвращаться к разговору.');

    expect((service as any).buildLinkExplanation(userLabel, true, '', 'FRIENDLY')).toBe(
      '**Алексей**, ссылку убрал: в этом чате они отключены. Если она нужна по делу, лучше сначала согласовать с админом.',
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
      '**Алексей**, сообщение не прошло. Причина: слишком длинное сообщение: 187 символов при лимите 100.',
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
      '**Алексей**, сообщение не прошло. Причина: слишком частая отправка фото: не чаще одного раза в 2ч. Если фото несколько, лучше собрать их в альбом или коллаж.',
    );

    expect((service as any).buildDuplicateHitExplanation(userLabel, true, '', 'FRIENDLY')).toBe(
      '**Алексей**, такое сообщение уже отправлялось. Пока просто убрал повтор.',
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
    ).toBe('**Алексей**, такое сообщение уже отправлялось. Это уже предупреждение.');

    expect(
      (service as any).buildMessageLimitsWarnExplanation(
        userLabel,
        'MESSAGE_TOO_LONG',
        null,
        'FRIENDLY',
      ),
    ).toBe('**Алексей**, это предупреждение. Причина: слишком длинное сообщение.');
    expect(
      (service as any).buildRequiredSubscriptionMuteExplanation(
        userLabel,
        ['Новости MAX'],
        'FRIENDLY',
      ),
    ).toBe(
      '**Алексей**, сообщения без подписки повторились, поэтому выдан мут. Сначала подпишитесь на Новости MAX.',
    );

    expect((service as any).buildGreetingMessage(userLabel, '', 'IRONIC')).toBe(
      '**Алексей**, добро пожаловать 🙂 На связи Майор Максимов. Здесь можно почти всё, кроме привычки спорить с правилами.',
    );
    expect(
      (service as any).buildNightModeOpenedNotice(23 * 60, 8 * 60, 'Europe/Moscow', '', 'IRONIC'),
    ).toBe('Доброе утро ☀️ Группа снова открыта. Можно снова писать, но без лишнего театра.');

    expect((service as any).buildLinkExplanation(userLabel, true, '', 'IRONIC')).toBe(
      '**Алексей**, ссылку убрал. Интернет и так переполнен, не будем делать филиал ещё и здесь.',
    );

    expect((service as any).buildDuplicateHitExplanation(userLabel, true, '', 'IRONIC')).toBe(
      '**Алексей**, мысль уже была в эфире. Повтор убрал. Эхо здесь карьеру не сделает.',
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
    ).toBe(
      '**Алексей**, мысль уже была в эфире. Да, это уже предупреждение. Повтор не сделал мысль убедительнее.',
    );
  });

  it('renders feminine police templates for female bot persona', () => {
    expect(getBotSpeechEditableTemplate('POLICE', 'greetingBotMessageText', 'female')).toContain(
      'На смене {bot_character_name}',
    );
    expect(getBotSpeechEditableTemplate('POLICE', 'linkBotMessageText', 'female')).toBe(
      'Товарищ {user}, ссылку изъяла 👮‍♀️ В этом чате с ними строго. Если вопрос по делу, согласуйте с админом.',
    );
    expect(getBotSpeechEditableTemplate('POLICE', 'duplicateBotMessageText', 'female')).toBe(
      'Товарищ {user}, повтор сообщения зафиксировала 👮‍♀️ {sanction}',
    );
    expect(getBotSpeechSystemTemplate('POLICE', 'messageLimitsWarn', 'female')).toBe(
      'Товарищ {user}, предупреждение оформила 👮‍♀️ Причина: {reason}.',
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
      '**Алексей**, это уже предупреждение. Причина: слишком длинное сообщение. Лимиты, как назло, умеют считать.',
    );

    expect((service as any).buildLinkMuteExplanation(userLabel, 'IRONIC')).toBe(
      '**Алексей**, со ссылками вы решили идти до финала. Поэтому теперь мут.',
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
