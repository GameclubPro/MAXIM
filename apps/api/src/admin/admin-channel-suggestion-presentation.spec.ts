import {
  buildChannelSuggestionAdminMessagePayload,
  buildPublishedChannelSuggestionMessagePayload,
} from './admin-channel-suggestion-presentation';

const baseParams = {
  status: 'published' as const,
  channelTitle: 'Канал',
  authorAttribution: {
    userId: '42',
    displayName: 'Подписчик',
    mentionDisplayName: null,
    username: null,
    profileUrl: null,
  },
  text: 'Текст предложки',
  textFormat: 'plain' as const,
  textMarkup: [],
  reviewedBy: 'Редактор',
  publishedUrl: null,
};

describe('channel suggestion admin presentation', () => {
  const contentVariants = [
    { text: 'Текст предложки', textFormat: 'plain' as const, textMarkup: [], format: 'markdown' },
    {
      text: '**Текст предложки**',
      textFormat: 'markdown' as const,
      textMarkup: [],
      format: 'html',
    },
    {
      text: 'Текст предложки',
      textFormat: 'plain' as const,
      textMarkup: [{ type: 'strong' as const, from: 0, length: 5, url: null, userLink: null }],
      format: 'html',
    },
    { text: '', textFormat: 'plain' as const, textMarkup: [], format: 'markdown' },
  ];

  describe.each(contentVariants)('author links with $format output and "$text"', (content) => {
    it.each(['pending', 'published', 'drafted', 'cancelled'] as const)(
      'retains the stored full-name link in a %s card without a mention-specific field',
      (status) => {
        const result = buildChannelSuggestionAdminMessagePayload({
          ...baseParams,
          ...content,
          status,
          authorAttribution: {
            ...baseParams.authorAttribution,
            displayName: 'Анна [QA] & Редактор',
          },
        });
        const link =
          content.format === 'html'
            ? '<a href="max://user/42">Анна [QA] &amp; Редактор</a>'
            : '[Анна \\[QA\\] & Редактор](max://user/42)';

        expect(result.text).toContain(`Отправитель: ${link}`);
        expect(result.textFormat).toBe(content.format);
      },
    );

    it('builds a public profile link from a stored username', () => {
      const result = buildChannelSuggestionAdminMessagePayload({
        ...baseParams,
        ...content,
        authorAttribution: {
          ...baseParams.authorAttribution,
          displayName: null,
          username: '@anna',
        },
      });

      expect(result.text).toContain(
        content.format === 'html'
          ? 'Отправитель: <a href="https://max.ru/anna">@anna</a>'
          : 'Отправитель: [@anna](https://max.ru/anna)',
      );
      expect(result.text).not.toContain('max://user/');
    });

    it('retains the stored full-name link in a publication', () => {
      const result = buildPublishedChannelSuggestionMessagePayload(
        baseParams.authorAttribution,
        content.text,
        content.textFormat,
        content.textMarkup,
      );

      expect(result.text).toContain(
        content.format === 'html'
          ? 'От подписчика <a href="max://user/42">Подписчик</a>'
          : 'От подписчика [Подписчик](max://user/42)',
      );
      expect(result.textFormat).toBe(content.format);
    });
  });

  it.each(['42', ' 42 ', null])(
    'does not invent a mention from an ID-only name %s',
    (displayName) => {
      const result = buildChannelSuggestionAdminMessagePayload({
        ...baseParams,
        authorAttribution: { ...baseParams.authorAttribution, displayName },
      });

      expect(result.text).toContain('Отправитель: 42');
      expect(result.text).not.toContain('max://user/');
    },
  );

  it('prefers the explicit mention name over a stored display name', () => {
    const result = buildChannelSuggestionAdminMessagePayload({
      ...baseParams,
      authorAttribution: {
        ...baseParams.authorAttribution,
        mentionDisplayName: 'Анна Каренина',
      },
    });

    expect(result.text).toContain('Отправитель: [Анна Каренина](max://user/42)');
  });

  it('prefers a direct profile URL over username and mention fallbacks', () => {
    const result = buildChannelSuggestionAdminMessagePayload({
      ...baseParams,
      authorAttribution: {
        ...baseParams.authorAttribution,
        username: 'anna',
        profileUrl: 'https://max.ru/u/anna-profile',
      },
    });

    expect(result.text).toContain('Отправитель: [Подписчик](https://max.ru/u/anna-profile)');
    expect(result.text).not.toContain('max://user/');
  });

  it('keeps confirmed publication copy as the Major default', () => {
    const result = buildChannelSuggestionAdminMessagePayload(baseParams);

    expect(result.text).toContain('Предложка опубликована');
    expect(result.text).not.toContain('передана в публикацию');
  });

  it('uses truthful publication-created copy for Publik suggestions', () => {
    const result = buildChannelSuggestionAdminMessagePayload({
      ...baseParams,
      publishedPresentation: 'publication_created',
    });

    expect(result.text).toContain('Предложка передана в публикацию');
    expect(result.text).not.toContain('Предложка опубликована');
  });
});
