import {
  buildCommercialMarkerContext,
  collectFirstPatternLabels,
  createCommercialTextMatcher,
} from './commercial-match-utils';

describe('commercial match utils', () => {
  it('does not evaluate pattern variants for labels that are already present', () => {
    const seeded = /seeded/u;
    const first = /first/u;
    const duplicateFirst = /duplicate-first/u;
    const second = /second/u;
    const predicate = jest.fn((pattern: RegExp) => pattern !== duplicateFirst);

    expect(
      collectFirstPatternLabels(
        [
          { label: 'seeded', pattern: seeded },
          { label: 'first', pattern: first },
          { label: 'first', pattern: duplicateFirst },
          { label: 'second', pattern: second },
        ],
        predicate,
        3,
        ['seeded'],
      ),
    ).toEqual(['seeded', 'first', 'second']);
    expect(predicate).toHaveBeenCalledTimes(2);
    expect(predicate).toHaveBeenNthCalledWith(1, first);
    expect(predicate).toHaveBeenNthCalledWith(2, second);
  });

  it('deduplicates repeated tokens without changing prefix marker matches', () => {
    const text = `${Array.from({ length: 1_200 }, (_, index) => index % 10).join(' ')} скидки скидки`;
    const context = buildCommercialMarkerContext(text, text, {
      rawLoweredTextIsCommercialNormalized: true,
    });
    const matcher = createCommercialTextMatcher(text, text, {
      rawLoweredTextIsCommercialNormalized: true,
    });

    expect(context.normalizedTokensWithoutUrls).toEqual([
      '0',
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      'скидки',
    ]);
    expect(matcher.hasMarker('скидк')).toBe(true);
    expect(matcher.hasMarker('заказ')).toBe(false);
  });
});
