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
    ).toBe(
      '🌙 Чат закрыт по расписанию: 23:00-08:00 (Москва). До открытия новые сообщения будут удаляться.',
    );

    expect(
      buildNightModeOpenedNotice({
        startMinutes: 23 * 60,
        endMinutes: 8 * 60,
        timezone: 'Europe/Moscow',
        templateText: '',
        botSpeechStyle: 'FRIENDLY',
        activeBotSpeechProfile,
      }),
    ).toBe('Чат снова открыт. Можно снова писать.');
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
      'Капитан Максимова: 22:30-07:15, Asia/Yekaterinburg. Новые сообщения временно не принимаются. ',
    );

    expect(
      buildNightModeOpenedNotice({
        startMinutes: 22 * 60 + 30,
        endMinutes: 7 * 60 + 15,
        timezone: 'Asia/Yekaterinburg',
        templateText: '{bot_character_name}: {opening_status}',
        botSpeechStyle: 'FRIENDLY',
        activeBotSpeechProfile: {
          persona: 'female',
          characterName: 'Капитан Максимова',
        },
      }),
    ).toBe('Капитан Максимова: Группа снова открыта.');
  });

  it('preserves whitespace-only custom text instead of replacing it with an inherited default', () => {
    expect(
      buildNightModeClosedNotice({
        startMinutes: 23 * 60,
        endMinutes: 8 * 60,
        timezone: 'Europe/Moscow',
        templateText: '   ',
        botSpeechStyle: 'ROBOT',
        activeBotSpeechProfile,
      }),
    ).toBe('   ');
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
        text: '🌙 Чат закрыт по расписанию:\n23:00-08:00 (Москва). До открытия новые сообщения будут удаляться.',
        settings,
        activeBotSpeechProfile,
      }),
    ).toBe(true);
    expect(
      isNightModeNoticeMessage({
        text: 'Чат снова открыт.   Обычный режим восстановлен.',
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
        text: '🌙 Чат закрыт по расписанию: 23:00-08:00 (Москва). До открытия новые сообщения будут удаляться.',
        settings,
        activeBotSpeechProfile,
      }),
    ).toBe(false);
    expect(
      isNightModeNoticeMessage({
        text: 'Чат снова открыт. Обычный режим восстановлен.',
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
