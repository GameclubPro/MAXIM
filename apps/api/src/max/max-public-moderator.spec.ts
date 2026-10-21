import { publicModerator } from './max-public-moderator';

const moderators = [
  { id: 'id613002203036_bot', name: 'Максимов', portrait: 'maximov' },
  { id: 'id613070470872_9_bot', name: 'Максимов 2', portrait: 'maximov' },
  { id: 'id613002203036_4_bot', name: 'Максимова', portrait: 'maximova' },
  { id: 'id613070470872_5_bot', name: 'Максимова 2', portrait: 'maximova' },
  { id: 'id613002203036_5_bot', name: 'Рэкс', portrait: 'rex' },
  { id: 'id613070470872_6_bot', name: 'Рэкс 2', portrait: 'rex' },
] as const;

describe('publicModerator', () => {
  describe.each(moderators)('$id', ({ id, name, portrait }) => {
    it.each([null, '214634782'])('uses the canonical profile with contactId %p', (contactId) => {
      expect(publicModerator({ id, contactId })).toMatchObject({
        name,
        portrait,
        url: `https://max.ru/${id}`,
      });
    });
  });

  it('does not turn the inferred numeric contact identity into a public username', () => {
    expect(publicModerator({ id: 'id613002203036_bot', contactId: '613002203036' })).toMatchObject({
      name: 'Максимов',
      portrait: 'maximov',
      url: 'https://max.ru/id613002203036_bot',
    });
  });

  it('preserves the existing opaque selection key regardless of contact identity', () => {
    const id = 'id613002203036_bot';
    const before = publicModerator({ id, contactId: null });
    const after = publicModerator({ id, contactId: '214634782' });

    expect(before.key).toBe('9e2c37302fc74fe9b8a9e252');
    expect(after).toEqual(before);
  });

  it('uses an unknown canonical handle without borrowing a contact profile', () => {
    expect(
      publicModerator({ id: 'community_helper_bot', contactId: 'id613002203036_4_bot' }),
    ).toMatchObject({
      name: 'Бот сообщества',
      portrait: 'neutral',
      url: 'https://max.ru/community_helper_bot',
    });
  });

  it('normalizes surrounding whitespace for both identity and URL', () => {
    expect(publicModerator({ id: ' id613002203036_4_bot ', contactId: '214634783' })).toMatchObject(
      {
        name: 'Максимова',
        portrait: 'maximova',
        url: 'https://max.ru/id613002203036_4_bot',
      },
    );
  });

  it.each([
    '',
    '   ',
    '613002203036',
    '000123',
    '___',
    '123_456',
    '@helper_bot',
    'helper/bot',
    'helper_bot?start=other',
    'helper_bot#other',
    'helper-bot',
    'helper bot',
    'https://max.ru/id613002203036_bot',
    'бот',
  ])('does not fabricate a public link for invalid handle %p', (id) => {
    expect(publicModerator({ id, contactId: '214634782' })).toMatchObject({
      name: 'Бот сообщества',
      portrait: 'neutral',
      url: null,
    });
  });
});
