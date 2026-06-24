import {
  buildNightModeClosedNotice,
  buildNightModeOpenedNotice,
  formatNightModeMinutesAsTime,
  isNightModeNoticeMessage,
} from './night-mode-transition-notice.util';

const activeBotSpeechProfile = {
  persona: 'male' as const,
  characterName: 'Майор Максимов',
};

describe('night mode transition notice util', () => {
  it('builds closed and opened notices from the selected bot speech preset', () => {
    expect(
      buildNightModeClosedNotice({
        startMinutes: 23 * 60,
        endMinutes: 8 * 60,
        timezone: 'Europe/Moscow',
        templateText: '',
        botSpeechStyle: 'ROBOT',
        activeBotSpeechProfile,
      }),
    ).toBe('🌙 Ночной режим активен: 23:00-08:00 (Москва). Новые сообщения временно не принимаются.');

    expect(
      buildNightModeOpenedNotice({
        startMinutes: 23 * 60,
        endMinutes: 8 * 60,
        timezone: 'Europe/Moscow',
        templateText: '',
        botSpeechStyle: 'FRIENDLY',
        activeBotSpeechProfile,
      }),
    ).toBe('☀️ Доброе утро. Группа снова открыта. Можно снова писать ✨');
  });

  it('renders override placeholders with profile, window, timezone, and status values', () => {
    expect(
      buildNightModeClosedNotice({
        startMinutes: 22 * 60 + 30,
        endMinutes: 7 * 60 + 15,
        timezone: 'Asia/Yekaterinburg',
        templateText:
          '{bot_character_name}: {night_window}, {night_timezone}. {night_status} {user}',
        botSpeechStyle: null,
        activeBotSpeechProfile: {
          persona: 'female',
          characterName: 'Капитан Максимова',
        },
      }),
    ).toBe(
      'Капитан Максимова: 22:30-07:15, Asia/Yekaterinburg. Новые сообщения временно не принимаются.',
    );
  });

  it('matches closed and opened notice messages with whitespace normalization', () => {
    const settings = {
      nightModeEnabled: true,
      nightModeBotMessageEnabled: true,
      nightModeOpenMessageEnabled: true,
      nightModeStartTimeMinutes: 23 * 60,
      nightModeEndTimeMinutes: 8 * 60,
      nightModeTimezone: 'Europe/Moscow',
      nightModeBotMessageText: '',
      nightModeOpenMessageText: '',
      botSpeechStyle: 'ROBOT' as const,
    };

    expect(
      isNightModeNoticeMessage({
        text: '🌙 Ночной режим активен:\n23:00-08:00 (Москва). Новые сообщения временно не принимаются.',
        settings,
        activeBotSpeechProfile,
      }),
    ).toBe(true);
    expect(
      isNightModeNoticeMessage({
        text: '☀️ Ночной режим завершен.   Группа снова открыта.',
        settings,
        activeBotSpeechProfile,
      }),
    ).toBe(true);
  });

  it('does not match notices when night mode or the corresponding notice type is disabled', () => {
    const settings = {
      nightModeEnabled: true,
      nightModeBotMessageEnabled: false,
      nightModeOpenMessageEnabled: true,
      nightModeStartTimeMinutes: 23 * 60,
      nightModeEndTimeMinutes: 8 * 60,
      nightModeTimezone: 'Europe/Moscow',
      nightModeBotMessageText: '',
      nightModeOpenMessageText: '',
      botSpeechStyle: 'ROBOT' as const,
    };

    expect(
      isNightModeNoticeMessage({
        text: '🌙 Ночной режим активен: 23:00-08:00 (Москва). Новые сообщения временно не принимаются.',
        settings,
        activeBotSpeechProfile,
      }),
    ).toBe(false);
    expect(
      isNightModeNoticeMessage({
        text: '☀️ Ночной режим завершен. Группа снова открыта.',
        settings: {
          ...settings,
          nightModeEnabled: false,
          nightModeBotMessageEnabled: true,
        },
        activeBotSpeechProfile,
      }),
    ).toBe(false);
  });

  it('formats out-of-range minutes with the legacy fallback value', () => {
    expect(formatNightModeMinutesAsTime(0)).toBe('00:00');
    expect(formatNightModeMinutesAsTime(1_439)).toBe('23:59');
    expect(formatNightModeMinutesAsTime(-1)).toBe('00:00');
    expect(formatNightModeMinutesAsTime(1_440)).toBe('00:00');
  });
});
