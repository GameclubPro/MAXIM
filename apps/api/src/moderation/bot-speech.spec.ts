import {
  BOT_SPEECH_EDITABLE_FIELD_KEYS,
  applyBotSpeechStylePreset,
  getBotSpeechEditableTemplate,
  getBotSpeechSystemTemplate,
  hasBotSpeechEditableOverrides,
  type BotSpeechSettingsSubset,
} from '@maxim/contracts/bot-speech';
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
      'Товарищ **Алексей**, ссылку снял с линии 🚨 Тут со ссылками без самодеятельности.',
    );
    expect(legacyWarnText).toBe(
      'Товарищ **Алексей**, взял на карандаш 📝 Причина: слишком длинное сообщение.',
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
    ).toBe('⚠️ **Алексей**, это предупреждение. Причина: слишком длинное сообщение.');

    expect((service as any).buildGreetingMessage(userLabel, '', 'POLICE')).toBe(
      'Здравия, **Алексей** 👮‍♂️ На линии Майор Максимов. Осваивайтесь спокойно, тут порядок без лишней драмы.',
    );

    expect((service as any).buildDuplicateHitExplanation(userLabel, true, '', 'POLICE')).toBe(
      'Товарищ **Алексей**, вижу повтор 👀 Этот экземпляр прикрыл.',
    );

    expect((service as any).buildGreetingMessage(userLabel, '', 'FRIENDLY')).toBe(
      'Привет, **Алексей** 🫶 На связи Майор Максимов. Помогу освоиться и держать чат в порядке.',
    );
    expect(
      (service as any).buildNightModeOpenedNotice(23 * 60, 8 * 60, 'Europe/Moscow', '', 'FRIENDLY'),
    ).toBe('☀️ Доброе утро. Группа снова открыта. Можно снова писать ✨');

    expect((service as any).buildLinkExplanation(userLabel, true, '', 'FRIENDLY')).toBe(
      '🔗 **Алексей**, ссылку убрал. Здесь они отключены. Если она по делу, лучше согласовать с админом.',
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
      '📏 **Алексей**, сообщение не прошло. Причина: слишком длинное сообщение: 187 символов при лимите 100.',
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
      '📏 **Алексей**, сообщение не прошло. Причина: слишком частая отправка фото: не чаще одного раза в 2ч. Если фото несколько, лучше собрать их в альбом или коллаж.',
    );

    expect((service as any).buildDuplicateHitExplanation(userLabel, true, '', 'FRIENDLY')).toBe(
      '♻️ **Алексей**, это уже повтор. 🧹 Повтор убрал.',
    );

    expect((service as any).buildDuplicateHitExplanation(userLabel, false, '', 'FRIENDLY')).toBe(
      '♻️ **Алексей**, это уже повтор. 👀 Повтор заметил, пока без санкций.',
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
    ).toBe('♻️ **Алексей**, это уже повтор. ⚠️ Это уже предупреждение.');

    expect(
      (service as any).buildMessageLimitsWarnExplanation(
        userLabel,
        'MESSAGE_TOO_LONG',
        null,
        'FRIENDLY',
      ),
    ).toBe('⚠️ **Алексей**, это предупреждение. Причина: слишком длинное сообщение.');
    expect(
      (service as any).buildRequiredSubscriptionMuteExplanation(
        userLabel,
        ['Новости MAX'],
        'FRIENDLY',
      ),
    ).toBe(
      '🔒 **Алексей**, сообщения без подписки повторились, поэтому включил мут. Сначала подпишитесь на Новости MAX.',
    );

    expect((service as any).buildGreetingMessage(userLabel, '', 'IRONIC')).toBe(
      '**Алексей**, привет 😏 На связи Майор Максимов. Осваивайтесь спокойно, а правила лучше не проверять на характер.',
    );
    expect(
      (service as any).buildNightModeOpenedNotice(23 * 60, 8 * 60, 'Europe/Moscow', '', 'IRONIC'),
    ).toBe(
      '☀️ Тихий режим снят. Группа снова открыта. Можно снова писать, только без резкого старта.',
    );

    expect((service as any).buildLinkExplanation(userLabel, true, '', 'IRONIC')).toBe(
      '**Алексей**, ссылку убрал 🔗 Тут и без внешнего интернета хватает приключений.',
    );

    expect((service as any).buildDuplicateHitExplanation(userLabel, true, '', 'IRONIC')).toBe(
      '**Алексей**, это уже было 👀 ♻️ Повтор убрал. Второй дубль тут был лишним.',
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
      '**Алексей**, это уже было 👀 ⚠️ Это уже предупреждение. Повтор не сделал мысль сильнее.',
    );
  });

  it('renders feminine police templates for female bot persona', () => {
    expect(getBotSpeechEditableTemplate('POLICE', 'greetingBotMessageText', 'female')).toContain(
      'На линии {bot_character_name}',
    );
    expect(getBotSpeechEditableTemplate('POLICE', 'linkBotMessageText', 'female')).toBe(
      'Товарищ {user}, ссылку сняла с линии 🚨 Тут со ссылками без самодеятельности.',
    );
    expect(getBotSpeechEditableTemplate('POLICE', 'duplicateBotMessageText', 'female')).toBe(
      'Товарищ {user}, вижу повтор 👀 {sanction}',
    );
    expect(getBotSpeechSystemTemplate('POLICE', 'messageLimitsWarn', 'female')).toBe(
      'Товарищ {user}, взяла на карандаш 📝 Причина: {reason}.',
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
      '**Алексей**, это уже предупреждение ⚠️ Причина: слишком длинное сообщение. Лимиты спорить не любят.',
    );

    expect((service as any).buildLinkMuteExplanation(userLabel, 'IRONIC')).toBe(
      '**Алексей**, со ссылками снова перебор 🔒 Поэтому теперь мут.',
    );
  });

  it('uses subtle edited-message copy for default link notices', () => {
    const service = createService();
    const userLabel = '**Алексей**';

    expect((service as any).buildLinkExplanation(userLabel, true, '', 'POLICE', true)).toBe(
      '**Алексей**, ссылку убрал. Расчёт на тихую правку был элегантный, но протокол внимательный: ссылки здесь не проходят.',
    );
    expect((service as any).buildLinkWarnExplanation(userLabel, '', 'POLICE', true)).toBe(
      '**Алексей**, предупреждение за ссылку. Расчёт на тихую правку был элегантный, но протокол внимательный: ссылки здесь всё ещё нельзя.',
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
