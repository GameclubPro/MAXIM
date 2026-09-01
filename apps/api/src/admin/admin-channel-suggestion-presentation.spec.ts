import { buildChannelSuggestionAdminMessagePayload } from './admin-channel-suggestion-presentation';

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
