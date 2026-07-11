import {
  buildLegacyDuplicatePassiveSanctionLabel,
  buildLegacyDuplicateSanctionLabel,
  buildMessageLimitsExplanationReplacements,
  hasCustomBotSpeechTemplate,
  resolveBotSpeechDuplicateContext,
  resolveBotSpeechMessageStatus,
  resolveMessageLimitsSanctionReason,
  resolveTextFilterExplanationReason,
} from './bot-speech-custom-override.util';

describe('bot speech custom override compatibility', () => {
  it('treats only non-empty stored values as custom', () => {
    expect(hasCustomBotSpeechTemplate('')).toBe(false);
    expect(hasCustomBotSpeechTemplate('   ')).toBe(true);
    expect(hasCustomBotSpeechTemplate('Свой текст')).toBe(true);
  });

  it('keeps legacy status and duplicate placeholders for custom templates', () => {
    expect(resolveBotSpeechMessageStatus('Свой {message_status}', true)).toBe('снято с линии');
    expect(resolveBotSpeechMessageStatus('', true)).toBe('удалено');
    expect(resolveBotSpeechDuplicateContext('Свой {duplicate_context}', false)).toBe(
      'идёт повтором',
    );
    expect(resolveBotSpeechDuplicateContext('', false)).toBe('отмечено как повтор');
  });

  it.each([
    ['male', 'Взял на карандаш 📝.'],
    ['female', 'Взяла на карандаш 📝.'],
    ['neutral', 'Предупреждение за повтор зафиксировано 📝.'],
  ] as const)(
    'keeps police duplicate warnings consistent with the %s persona',
    (persona, expected) => {
      expect(
        buildLegacyDuplicateSanctionLabel({
          style: 'POLICE',
          persona,
          action: 'WARN',
          muteDurationLabel: '2 часа',
        }),
      ).toBe(expected);
    },
  );

  it.each([
    ['male', '🔒 Включил мут на 2 часа.'],
    ['female', '🔒 Включила мут на 2 часа.'],
    ['neutral', '🔒 Мут включён на 2 часа.'],
  ] as const)(
    'keeps friendly duplicate mutes consistent with the %s persona',
    (persona, expected) => {
      expect(
        buildLegacyDuplicateSanctionLabel({
          style: 'FRIENDLY',
          persona,
          action: 'MUTE',
          muteDurationLabel: '2 часа',
        }),
      ).toBe(expected);
    },
  );

  it.each([
    ['POLICE', false, 'Повтор зафиксирован, пока без санкций.'],
    ['POLICE', true, 'Этот экземпляр снят с линии.'],
    [null, false, 'Повтор зафиксирован, пока без санкций.'],
    ['FRIENDLY', false, '👀 Повтор отмечен, пока без санкций.'],
    ['FRIENDLY', true, '🧹 Повтор убран.'],
    ['IRONIC', false, '👀 Повтор отмечен. Пока без санкций, но мысль уже учтена.'],
    ['IRONIC', true, '♻️ Повтор убран. Второй дубль тут был лишним.'],
  ] as const)(
    'uses neutral duplicate placeholder copy for Rex in %s style when deleted=%s',
    (style, messageDeleted, expected) => {
      expect(
        buildLegacyDuplicatePassiveSanctionLabel({
          style,
          persona: 'neutral',
          messageDeleted,
        }),
      ).toBe(expected);
    },
  );

  it.each([
    ['FRIENDLY', 'male', '🧹 Повтор убрал.'],
    ['FRIENDLY', 'female', '🧹 Повтор убрала.'],
    ['IRONIC', 'male', '♻️ Повтор убрал. Второй дубль тут был лишним.'],
    ['IRONIC', 'female', '♻️ Повтор убрала. Второй дубль тут был лишним.'],
  ] as const)(
    'keeps passive duplicate copy consistent for the %s style and %s persona',
    (style, persona, expected) => {
      expect(
        buildLegacyDuplicatePassiveSanctionLabel({
          style,
          persona,
          messageDeleted: true,
        }),
      ).toBe(expected);
    },
  );

  it('keeps legacy text-filter reasons only for custom templates', () => {
    expect(resolveTextFilterExplanationReason('COMMERCIAL_AD', 'Свой {reason}')).toBe(
      'коммерческая реклама в этом чате запрещена',
    );
    expect(resolveTextFilterExplanationReason('COMMERCIAL_AD', '')).toBe(
      'коммерческая реклама запрещена правилами чата',
    );
  });

  it('keeps legacy message-limit placeholders while inherited defaults use current copy', () => {
    const custom = buildMessageLimitsExplanationReplacements({
      templateText: 'Статус: {message_status}. Причина: {reason}.',
      ruleCode: 'MESSAGE_TOO_LONG',
      messageDeleted: true,
      messageCountLimitMessages: 5,
      messageCountLimitWindowHours: 1,
      photoCooldownHours: 2,
      stickerCooldownMinutes: 5,
      messageLength: 187,
      maxMessageLength: 100,
    });
    const inherited = buildMessageLimitsExplanationReplacements({
      templateText: '',
      ruleCode: 'MESSAGE_TOO_LONG',
      messageDeleted: true,
      messageCountLimitMessages: 5,
      messageCountLimitWindowHours: 1,
      photoCooldownHours: 2,
      stickerCooldownMinutes: 5,
      messageLength: 187,
      maxMessageLength: 100,
    });

    expect(custom).toMatchObject({
      message_status: 'снято с линии',
      reason: 'слишком длинное сообщение: 187 символов при лимите 100',
    });
    expect(inherited).toMatchObject({
      message_status: 'удалено',
      reason: 'длина сообщения 187 символов при лимите 100',
    });
  });

  it('does not expose blocked tokens and preserves custom blocked-list wording', () => {
    expect(
      buildMessageLimitsExplanationReplacements({
        templateText: 'Причина: {reason}.',
        ruleCode: 'MESSAGE_BLOCKED_WORD',
        messageDeleted: true,
        messageCountLimitMessages: 5,
        messageCountLimitWindowHours: 1,
        photoCooldownHours: 2,
        stickerCooldownMinutes: 5,
        blockedWord: 'казино',
      }).reason,
    ).toBe('такие сообщения запрещены в чате');
    expect(
      buildMessageLimitsExplanationReplacements({
        templateText: '',
        ruleCode: 'MESSAGE_BLOCKED_WORD',
        messageDeleted: true,
        messageCountLimitMessages: 5,
        messageCountLimitWindowHours: 1,
        photoCooldownHours: 2,
        stickerCooldownMinutes: 5,
        blockedWord: 'казино',
      }).reason,
    ).toBe('сообщение совпало со стоп-листом чата');
    expect(resolveMessageLimitsSanctionReason('MESSAGE_BLOCKED_WORD', 'казино', 'Свой')).toBe(
      'такие сообщения запрещены в чате',
    );
    expect(resolveMessageLimitsSanctionReason('MESSAGE_BLOCKED_WORD', 'казино', '')).toBe(
      'сообщение совпало со стоп-листом чата',
    );
    expect(resolveMessageLimitsSanctionReason('PHOTO_RATE_LIMIT', null, '')).toBe(
      'фото отправляются чаще, чем разрешено в чате',
    );
    expect(resolveMessageLimitsSanctionReason('PHOTO_RATE_LIMIT', null, 'Свой шаблон')).toBe(
      'слишком частая отправка фото',
    );
    expect(resolveMessageLimitsSanctionReason('STICKER_RATE_LIMIT', null, '')).toBe(
      'стикеры отправляются чаще, чем разрешено в чате',
    );
    expect(resolveMessageLimitsSanctionReason('UNKNOWN_LIMIT', null, '')).toBe(
      'нарушено ограничение на отправку сообщений',
    );
  });
});
