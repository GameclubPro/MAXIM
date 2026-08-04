import {
  normalizeMaxUserDisplayName,
  resolveMaxUserDisplayName,
} from './max-user-display-name.util';

describe('resolveMaxUserDisplayName', () => {
  it('prefers explicit full display names over split and legacy names', () => {
    expect(
      resolveMaxUserDisplayName({
        display_name: 'Полное отображаемое имя',
        first_name: 'Имя',
        last_name: 'Фамилия',
        name: 'Короткое имя',
        nickname: 'Ник',
      }),
    ).toBe('Полное отображаемое имя');
  });

  it('prefers split first and last names over legacy names', () => {
    expect(
      resolveMaxUserDisplayName({
        first_name: 'Анна',
        last_name: 'Каренина',
        name: 'Анна',
        nickname: 'Аня',
      }),
    ).toBe('Анна Каренина');
  });

  it('checks all aliases and sources before falling back to legacy names', () => {
    expect(
      resolveMaxUserDisplayName(
        { display_name: ' ', name: 'Короткое имя' },
        { fullName: ' Полное имя ' },
      ),
    ).toBe('Полное имя');
  });

  it('combines split name fields found in separate wrapper levels', () => {
    expect(
      resolveMaxUserDisplayName({ first_name: 'Анна', name: 'Аня' }, { lastName: 'Каренина' }),
    ).toBe('Анна Каренина');
  });

  it('uses a trimmed legacy name when no full name is available', () => {
    expect(resolveMaxUserDisplayName(null, { nickname: ' Пользователь ' })).toBe('Пользователь');
  });

  it('rejects user ids passed as display names', () => {
    expect(normalizeMaxUserDisplayName('  Иван   Петров  ', '195714583')).toBe('Иван Петров');
    expect(normalizeMaxUserDisplayName('195714583', '195714583')).toBeNull();
    expect(normalizeMaxUserDisplayName('613002203036')).toBeNull();
    expect(normalizeMaxUserDisplayName('user-1', 'user-1')).toBeNull();
  });
});
