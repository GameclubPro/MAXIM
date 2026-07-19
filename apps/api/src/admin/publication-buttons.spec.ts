import { readStoredPublicationButtons } from './publication-buttons';

describe('readStoredPublicationButtons', () => {
  it('keeps valid legacy buttons and drops malformed stored URLs', () => {
    expect(
      readStoredPublicationButtons([
        {
          text: 'Broken',
          url: 'https://max.ru/chat/example/https://nested.example.test',
        },
        {
          text: ' Open ',
          url: ' https://example.test/post ',
        },
      ]),
    ).toEqual([{ text: 'Open', url: 'https://example.test/post', row: 0 }]);
  });

  it('returns an empty list for non-array persisted data', () => {
    expect(readStoredPublicationButtons({ text: 'Open' })).toEqual([]);
  });
});
