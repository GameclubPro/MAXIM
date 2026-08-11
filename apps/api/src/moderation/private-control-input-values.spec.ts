import { BadRequestException } from '@nestjs/common';
import {
  formatPrivateControlEnumValue,
  formatPrivateControlSettingValue,
  formatPrivateControlTime,
  parsePrivateControlBroadcastSendAt,
  parsePrivateControlDateInput,
  parsePrivateControlInputValue,
  parsePrivateControlIntegerInput,
  parsePrivateControlRemovalDateInput,
  parsePrivateControlTimeToMinutes,
} from './private-control-input-values';

describe('private control input values', () => {
  describe('date inputs', () => {
    it('parses a local date and time in the selected IANA timezone', () => {
      expect(parsePrivateControlBroadcastSendAt('24.03.2026 17:00', 'Asia/Yekaterinburg')).toBe(
        '2026-03-24T12:00:00.000Z',
      );
    });

    it('uses Moscow UTC+03:00 when a timezone is not provided', () => {
      expect(parsePrivateControlDateInput('24.03.2026 17:00').toISOString()).toBe(
        '2026-03-24T14:00:00.000Z',
      );
    });

    it('passes ISO date values through the native Date parser', () => {
      expect(parsePrivateControlDateInput('2026-03-24T17:00:00+05:00').toISOString()).toBe(
        '2026-03-24T12:00:00.000Z',
      );
    });

    it.each([
      ['invalid date', () => parsePrivateControlDateInput('not-a-date')],
      [
        'invalid timezone',
        () => parsePrivateControlDateInput('24.03.2026 17:00', 'Invalid/Timezone'),
      ],
    ] as const)('rejects an %s', (_label, parse) => {
      expect(parse).toThrow(BadRequestException);
      expect(parse).toThrow('Не удалось распознать дату и время.');
    });

    it.each([
      ['', parsePrivateControlRemovalDateInput],
      ['-', parsePrivateControlRemovalDateInput],
      ['', parsePrivateControlBroadcastSendAt],
      ['-', parsePrivateControlBroadcastSendAt],
    ] as const)('returns null for optional date input %j', (rawText, parse) => {
      expect(parse(rawText)).toBeNull();
    });
  });

  describe('integer inputs', () => {
    it('accepts both inclusive bounds', () => {
      expect(parsePrivateControlIntegerInput('1', 1, 10)).toBe(1);
      expect(parsePrivateControlIntegerInput('10', 1, 10)).toBe(10);
    });

    it('preserves parseInt prefix parsing', () => {
      expect(parsePrivateControlIntegerInput('12abc', 1, 20)).toBe(12);
    });

    it('rejects non-numeric input', () => {
      expect(() => parsePrivateControlIntegerInput('none', 1, 10)).toThrow('Введите целое число.');
    });

    it.each(['0', '11'])('rejects values outside the configured range', (rawText) => {
      expect(() => parsePrivateControlIntegerInput(rawText, 1, 10)).toThrow(
        'Число должно быть от 1 до 10.',
      );
    });
  });

  describe('time inputs', () => {
    it.each([
      ['00:00', 0],
      ['23:59', 1439],
      [' 7:05 ', 425],
    ] as const)('parses %s', (rawText, expected) => {
      expect(parsePrivateControlTimeToMinutes(rawText)).toBe(expected);
    });

    it.each(['7', '7:5', 'text'])('rejects malformed time %j', (rawText) => {
      expect(() => parsePrivateControlTimeToMinutes(rawText)).toThrow(
        'Введите время в формате HH:MM.',
      );
    });

    it.each(['24:00', '12:60'])('rejects out-of-range time %j', (rawText) => {
      expect(() => parsePrivateControlTimeToMinutes(rawText)).toThrow(
        'Время вне допустимого диапазона.',
      );
    });
  });

  describe('setting inputs', () => {
    it('parses number and time field values', () => {
      expect(parsePrivateControlInputValue('number', 10, 20, '15')).toBe(15);
      expect(parsePrivateControlInputValue('time', undefined, undefined, '08:30')).toBe(510);
    });

    it.each(['text', 'url', 'timezone'] as const)(
      'clears %s fields when the input is a hyphen',
      (type) => {
        expect(parsePrivateControlInputValue(type, undefined, undefined, '-')).toBe('');
      },
    );

    it.each(['text', 'url', 'timezone'] as const)('preserves %s input', (type) => {
      expect(parsePrivateControlInputValue(type, undefined, undefined, ' value ')).toBe(' value ');
    });

    it.each(['boolean', 'enum'] as const)('rejects direct %s input', (type) => {
      expect(() => parsePrivateControlInputValue(type, undefined, undefined, 'value')).toThrow(
        'Unsupported field type for input',
      );
    });
  });

  describe('formatting', () => {
    it.each([
      [-10, '00:00'],
      [0, '00:00'],
      [90.9, '01:30'],
      [1439, '23:59'],
      [2000, '23:59'],
    ] as const)('clamps and formats %s minutes', (minutes, expected) => {
      expect(formatPrivateControlTime(minutes)).toBe(expected);
    });

    it.each([
      ['ALLOWLIST_ONLY', 'Разрешать только цели из списка разрешённых'],
      ['BLOCKLIST_ONLY', 'Удалять все кликабельные ссылки'],
      ['ALERT_ONLY', 'Только предупреждать'],
      ['BALANCED', 'Сбалансированный'],
      ['STRICT', 'Строгий'],
      ['SAME_IMAGE', 'Та же картинка'],
      ['MINOR_EDITS', 'С небольшими изменениями'],
      ['SAME_AUTHOR', 'У одного автора'],
      ['CHAT', 'Во всём чате'],
      ['UNKNOWN', 'UNKNOWN'],
    ] as const)('formats enum value %s', (value, expected) => {
      expect(formatPrivateControlEnumValue(value)).toBe(expected);
    });

    it('formats booleans, empty values, time, enum and other scalars', () => {
      expect(formatPrivateControlSettingValue(true, 'boolean')).toBe('Включено');
      expect(formatPrivateControlSettingValue(false, 'boolean')).toBe('Выключено');
      expect(formatPrivateControlSettingValue(null, 'text')).toBe('—');
      expect(formatPrivateControlSettingValue(undefined, 'text')).toBe('—');
      expect(formatPrivateControlSettingValue('   ', 'text')).toBe('—');
      expect(formatPrivateControlSettingValue(90, 'time')).toBe('01:30');
      expect(formatPrivateControlSettingValue('STRICT', 'enum')).toBe('Строгий');
      expect(formatPrivateControlSettingValue(42, 'text')).toBe('42');
    });

    it('normalizes and compacts long strings to 64 characters', () => {
      expect(formatPrivateControlSettingValue(`  ${'x'.repeat(70)}  `, 'text')).toBe(
        `${'x'.repeat(63)}…`,
      );
    });
  });
});
