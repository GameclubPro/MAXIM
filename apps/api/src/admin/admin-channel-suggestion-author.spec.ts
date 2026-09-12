import { resolveChannelSuggestionAuthorAttribution } from './admin-channel-suggestion-author';
import {
  buildChannelSuggestionAdminMessagePayload,
  buildPublishedChannelSuggestionMessagePayload,
} from './admin-channel-suggestion-presentation';

describe('channel suggestion author mentions', () => {
  const userId = '214634784';

  function createParams() {
    return {
      chatId: 'channel-1',
      user: { userId, displayName: 'Анна Каренина' },
      botId: 'publisher-bot',
      trafficClass: 'interactive' as const,
      loadProfiles: jest.fn().mockResolvedValue(new Map()),
      loadLocalDisplayNames: jest.fn().mockResolvedValue(new Map()),
      logger: { debug: jest.fn() },
    };
  }

  it.each(['missing', 'failed'])(
    'retains the signed author name as a mention when the remote profile is %s',
    async (remoteState) => {
      const params = createParams();
      if (remoteState === 'failed') {
        params.loadProfiles.mockRejectedValue(new Error('MAX unavailable'));
      }

      const author = await resolveChannelSuggestionAuthorAttribution(params);

      expect(author).toMatchObject({
        userId,
        displayName: 'Анна Каренина',
        mentionDisplayName: 'Анна Каренина',
      });
      expect(params.loadProfiles).toHaveBeenCalledTimes(1);
      expect(params.loadProfiles).toHaveBeenCalledWith(
        params.chatId,
        [userId],
        expect.objectContaining({ botId: 'publisher-bot', timeoutMs: expect.any(Number) }),
      );
    },
  );

  it.each(['plain', 'markdown'] as const)(
    'keeps locally resolved mentions in admin cards and publications with %s content',
    async (textFormat) => {
      const params = createParams();
      params.loadLocalDisplayNames.mockResolvedValue(new Map([[userId, 'Анна [QA] & Редактор']]));
      const author = await resolveChannelSuggestionAuthorAttribution(params);
      const expectedLink =
        textFormat === 'plain'
          ? `[Анна \\[QA\\] & Редактор](max://user/${userId})`
          : `<a href="max://user/${userId}">Анна [QA] &amp; Редактор</a>`;
      const adminCard = buildChannelSuggestionAdminMessagePayload({
        status: 'pending',
        channelTitle: 'Канал',
        authorAttribution: author,
        text: 'Текст предложки',
        textFormat,
        textMarkup: [],
        reviewedBy: null,
        publishedUrl: null,
      });
      const publication = buildPublishedChannelSuggestionMessagePayload(
        author,
        'Текст предложки',
        textFormat,
        [],
      );

      expect(adminCard.text).toContain(`Отправитель: ${expectedLink}`);
      expect(publication.text).toContain(`От подписчика ${expectedLink}`);
      expect(adminCard.textFormat).toBe(textFormat === 'plain' ? 'markdown' : 'html');
      expect(publication.textFormat).toBe(adminCard.textFormat);
    },
  );

  it('prefers a remote full name without loading local history', async () => {
    const params = createParams();
    params.loadProfiles.mockResolvedValue(
      new Map([[userId, { userId, displayName: 'Анна Новая', username: null, profileUrl: null }]]),
    );

    expect(await resolveChannelSuggestionAuthorAttribution(params)).toMatchObject({
      displayName: 'Анна Новая',
      mentionDisplayName: 'Анна Новая',
    });
    expect(params.loadLocalDisplayNames).not.toHaveBeenCalled();
  });

  it('does not turn a user ID or username into a false mention', async () => {
    const params = createParams();
    params.user.displayName = userId;
    params.loadLocalDisplayNames.mockResolvedValue(new Map([[userId, userId]]));
    params.loadProfiles.mockResolvedValue(
      new Map([[userId, { userId, displayName: userId, username: 'anna', profileUrl: null }]]),
    );

    expect(await resolveChannelSuggestionAuthorAttribution(params)).toMatchObject({
      displayName: null,
      mentionDisplayName: null,
      profileUrl: 'https://max.ru/anna',
    });
  });
});
