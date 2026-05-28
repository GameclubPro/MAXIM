import {
  computeVkParsingPostContentHash,
  composeVkParsingPublishText,
  describeVkParsingSkipReason,
  prepareVkParsingPublishPayload,
  resolveVkParsingPostSkipReason,
  stripVkParsingLinksFromText,
} from './vk-parsing-content';

describe('vk-parsing-content', () => {
  const baseSettings = {
    stripLinksEnabled: false,
    skipAdsEnabled: false,
  };

  it('appends selected links that are missing from the text', () => {
    expect(
      composeVkParsingPublishText('Новость\nhttps://vk.ru/already-there', [
        'https://vk.ru/already-there',
        'https://example.com/missing',
      ]),
    ).toBe('Новость\nhttps://vk.ru/already-there\nhttps://example.com/missing');
  });

  it('strips inline and attached links when link stripping is enabled', () => {
    const prepared = prepareVkParsingPublishPayload(
      {
        text: 'Смотрите https://example.com/a\nи vk.ru/public',
        photoUrls: ['https://sun.example/photo.jpg'],
        linkUrls: ['https://example.com/a'],
      },
      { stripLinksEnabled: true },
    );

    expect(prepared).toEqual({
      text: 'Смотрите\nи',
      photoUrls: ['https://sun.example/photo.jpg'],
      linkUrls: [],
    });
    expect(stripVkParsingLinksFromText('текст www.example.com  хвост')).toBe('текст хвост');
  });

  it('returns empty-after-link-filter skip reason for link-only posts', () => {
    expect(
      resolveVkParsingPostSkipReason(
        {
          text: 'https://example.com/only-link',
          photoUrls: [],
          linkUrls: ['https://example.com/only-link'],
          attachments: [],
          raw: {},
        },
        { ...baseSettings, stripLinksEnabled: true },
      ),
    ).toBe('EMPTY_AFTER_LINK_FILTER');
  });

  it('returns ad skip reason from cached flags and VK raw markers', () => {
    expect(
      resolveVkParsingPostSkipReason(
        {
          text: 'обычный текст',
          photoUrls: [],
          linkUrls: [],
          attachments: [],
          raw: {},
          isAdvertising: 'yes',
        },
        { ...baseSettings, skipAdsEnabled: true },
      ),
    ).toBe('AD');

    expect(
      resolveVkParsingPostSkipReason(
        {
          text: 'обычный текст',
          photoUrls: [],
          linkUrls: [],
          attachments: [],
          raw: { marked_as_ads: 1 },
        },
        { ...baseSettings, skipAdsEnabled: true },
      ),
    ).toBe('AD');
  });

  it('describes skip reasons with user-facing messages', () => {
    expect(describeVkParsingSkipReason('AD')).toBe('Пост пропущен фильтром рекламы.');
    expect(describeVkParsingSkipReason('EMPTY_AFTER_LINK_FILTER')).toBe(
      'Пост пропущен: после удаления ссылок не осталось содержимого.',
    );
  });

  it('keeps content hash stable for identical normalized content', () => {
    const left = computeVkParsingPostContentHash({
      text: '  Пост  ',
      photoUrls: ['https://sun.example/a.jpg'],
      linkUrls: ['https://example.com/a'],
      attachmentTypes: ['photo'],
      advertisingMarkers: ['erid:abc'],
    });
    const right = computeVkParsingPostContentHash({
      text: 'Пост',
      photoUrls: ['https://sun.example/a.jpg'],
      linkUrls: ['https://example.com/a'],
      attachmentTypes: ['photo'],
      advertisingMarkers: ['erid:abc'],
    });
    const changed = computeVkParsingPostContentHash({
      text: 'Пост',
      photoUrls: ['https://sun.example/b.jpg'],
      linkUrls: ['https://example.com/a'],
      attachmentTypes: ['photo'],
      advertisingMarkers: ['erid:abc'],
    });

    expect(left).toBe(right);
    expect(changed).not.toBe(left);
  });
});
