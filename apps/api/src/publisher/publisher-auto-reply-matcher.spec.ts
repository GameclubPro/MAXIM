import {
  PUBLISHER_AUTO_REPLY_MATCHER_LIMITS,
  arePublisherAutoReplyMatchDecisionsEqual,
  matchPublisherAutoReply,
  type PublisherAutoReplyTriggerCandidate,
} from './publisher-auto-reply-matcher';

function trigger(
  overrides: Partial<PublisherAutoReplyTriggerCandidate> = {},
): PublisherAutoReplyTriggerCandidate {
  return {
    ruleId: 'rule-1',
    triggerId: 'trigger-1',
    position: 0,
    phrase: 'Прайс',
    normalizedPhrase: 'прайс',
    matchInContext: false,
    fuzzyMatch: false,
    ...overrides,
  };
}

describe('Publisher auto-reply matcher', () => {
  it('compares complete shadow decisions without exposing phrase text', () => {
    const first = matchPublisherAutoReply('прайс', [trigger()]);
    const same = matchPublisherAutoReply('прайс', [trigger()]);
    const anotherRule = matchPublisherAutoReply('прайс', [
      trigger({ ruleId: 'rule-2', triggerId: 'trigger-2' }),
    ]);

    expect(arePublisherAutoReplyMatchDecisionsEqual(first, same)).toBe(true);
    expect(arePublisherAutoReplyMatchDecisionsEqual(first, anotherRule)).toBe(false);
  });

  it('preserves legacy full-message normalization for whitespace and Russian case', () => {
    expect(
      matchPublisherAutoReply('  ПРАЙС\n  НА   сегодня ', [
        trigger({ phrase: 'Прайс на сегодня', normalizedPhrase: 'прайс на сегодня' }),
      ]),
    ).toEqual({
      kind: 'matched',
      winner: {
        ruleId: 'rule-1',
        triggerId: 'trigger-1',
        phrase: 'Прайс на сегодня',
        normalizedPhrase: 'прайс на сегодня',
        matchKind: 'exact_full',
        distance: 0,
        position: 0,
      },
    });
  });

  it('uses contiguous Unicode word tokens instead of substring boundaries', () => {
    const candidate = trigger({
      phrase: 'кот',
      normalizedPhrase: 'кот',
      matchInContext: true,
    });

    expect(matchPublisherAutoReply('Это скот', [candidate])).toEqual({ kind: 'no_match' });
    expect(matchPublisherAutoReply('Где кот, подскажите?', [candidate])).toMatchObject({
      kind: 'matched',
      winner: { matchKind: 'exact_context', normalizedPhrase: 'кот' },
    });
  });

  it('treats punctuation as token separators for context matching', () => {
    expect(
      matchPublisherAutoReply('Нужен прайс, пожалуйста.', [trigger({ matchInContext: true })]),
    ).toMatchObject({
      kind: 'matched',
      winner: { matchKind: 'exact_context', distance: 0 },
    });
  });

  it('maps ё to е only during fuzzy comparison', () => {
    const candidate = trigger({
      phrase: 'Береза',
      normalizedPhrase: 'береза',
      fuzzyMatch: false,
    });

    expect(matchPublisherAutoReply('берёза', [candidate])).toEqual({ kind: 'no_match' });
    expect(matchPublisherAutoReply('берёза', [{ ...candidate, fuzzyMatch: true }])).toMatchObject({
      kind: 'matched',
      winner: { matchKind: 'fuzzy_full', distance: 0 },
    });
  });

  it.each([
    ['adjacent transposition', 'парйс', 'прайс'],
    ['insertion', 'доставкка', 'доставка'],
    ['deletion', 'доставк', 'доставка'],
  ])('matches one bounded fuzzy %s', (_label, message, normalizedPhrase) => {
    expect(
      matchPublisherAutoReply(message, [
        trigger({ phrase: normalizedPhrase, normalizedPhrase, fuzzyMatch: true }),
      ]),
    ).toMatchObject({
      kind: 'matched',
      winner: { matchKind: 'fuzzy_full', distance: 1 },
    });
  });

  it('keeps fuzzy phrases shorter than five alphanumeric code points exact-only', () => {
    expect(
      matchPublisherAutoReply('цено', [
        trigger({ phrase: 'Цена', normalizedPhrase: 'цена', fuzzyMatch: true }),
      ]),
    ).toEqual({ kind: 'no_match' });
  });

  it.each([
    ['abcdefghi', 'abxdeyghi', false, 2],
    ['abcdefghij', 'abxdeyghij', true, 2],
    ['abcdefghijklmnopqrst', 'xbcdefghijklmnopyrsz', true, 3],
  ])(
    'applies the configured fuzzy threshold for %s',
    (normalizedPhrase, message, matched, distance) => {
      const result = matchPublisherAutoReply(message, [
        trigger({ phrase: normalizedPhrase, normalizedPhrase, fuzzyMatch: true }),
      ]);
      if (!matched) {
        expect(result).toEqual({ kind: 'no_match' });
        return;
      }
      expect(result).toMatchObject({
        kind: 'matched',
        winner: { matchKind: 'fuzzy_full', distance },
      });
    },
  );

  it('uses same-token-count windows for fuzzy context matching', () => {
    expect(
      matchPublisherAutoReply('Нужна быстрая доствка сегодня', [
        trigger({
          phrase: 'быстрая доставка',
          normalizedPhrase: 'быстрая доставка',
          matchInContext: true,
          fuzzyMatch: true,
        }),
      ]),
    ).toMatchObject({
      kind: 'matched',
      winner: { matchKind: 'fuzzy_context', distance: 1 },
    });
    expect(
      matchPublisherAutoReply('Нужна доставка сегодня', [
        trigger({
          phrase: 'быстрая доставка',
          normalizedPhrase: 'быстрая доставка',
          matchInContext: true,
          fuzzyMatch: true,
        }),
      ]),
    ).toEqual({ kind: 'no_match' });
  });

  it('ranks exact full above exact context', () => {
    const result = matchPublisherAutoReply('прайс!', [
      trigger({
        ruleId: 'rule-context',
        triggerId: 'trigger-context',
        matchInContext: true,
      }),
      trigger({
        ruleId: 'rule-full',
        triggerId: 'trigger-full',
        phrase: 'Прайс!',
        normalizedPhrase: 'прайс!',
      }),
    ]);

    expect(result).toMatchObject({
      kind: 'matched',
      winner: { ruleId: 'rule-full', matchKind: 'exact_full' },
    });
  });

  it('ranks an exact context match above a fuzzy full match', () => {
    const result = matchPublisherAutoReply('нужен прайс', [
      trigger({
        ruleId: 'rule-fuzzy',
        triggerId: 'trigger-fuzzy',
        phrase: 'Нужен прайсс',
        normalizedPhrase: 'нужен прайсс',
        fuzzyMatch: true,
      }),
      trigger({
        ruleId: 'rule-exact',
        triggerId: 'trigger-exact',
        matchInContext: true,
      }),
    ]);

    expect(result).toMatchObject({
      kind: 'matched',
      winner: { ruleId: 'rule-exact', matchKind: 'exact_context' },
    });
  });

  it('ranks lower fuzzy distance before trigger specificity', () => {
    const result = matchPublisherAutoReply('доставка', [
      trigger({
        ruleId: 'rule-distance-2',
        triggerId: 'trigger-distance-2',
        phrase: 'Достовко',
        normalizedPhrase: 'достовко',
        fuzzyMatch: true,
      }),
      trigger({
        ruleId: 'rule-distance-1',
        triggerId: 'trigger-distance-1',
        phrase: 'Доставко',
        normalizedPhrase: 'доставко',
        fuzzyMatch: true,
      }),
    ]);

    expect(result).toMatchObject({
      kind: 'matched',
      winner: { ruleId: 'rule-distance-1', distance: 1 },
    });
  });

  it('prefers a more specific exact phrase with more tokens', () => {
    const result = matchPublisherAutoReply('Нужна быстрая доставка', [
      trigger({
        ruleId: 'rule-short',
        triggerId: 'trigger-short',
        phrase: 'Доставка',
        normalizedPhrase: 'доставка',
        matchInContext: true,
      }),
      trigger({
        ruleId: 'rule-specific',
        triggerId: 'trigger-specific',
        phrase: 'Быстрая доставка',
        normalizedPhrase: 'быстрая доставка',
        matchInContext: true,
      }),
    ]);

    expect(result).toMatchObject({
      kind: 'matched',
      winner: { ruleId: 'rule-specific', triggerId: 'trigger-specific' },
    });
  });

  it('collapses equal matches from the same rule deterministically', () => {
    const result = matchPublisherAutoReply('цена срок', [
      trigger({
        ruleId: 'rule-shared',
        triggerId: 'trigger-later',
        position: 1,
        phrase: 'Срок',
        normalizedPhrase: 'срок',
        matchInContext: true,
      }),
      trigger({
        ruleId: 'rule-shared',
        triggerId: 'trigger-first',
        position: 0,
        phrase: 'Цена',
        normalizedPhrase: 'цена',
        matchInContext: true,
      }),
    ]);

    expect(result).toMatchObject({
      kind: 'matched',
      winner: { ruleId: 'rule-shared', triggerId: 'trigger-first', position: 0 },
    });
  });

  it('returns stable tied winners for equal best matches across rules', () => {
    const candidates = [
      trigger({
        ruleId: 'rule-b',
        triggerId: 'trigger-b',
        phrase: 'Срок',
        normalizedPhrase: 'срок',
        matchInContext: true,
      }),
      trigger({
        ruleId: 'rule-a',
        triggerId: 'trigger-a',
        phrase: 'Цена',
        normalizedPhrase: 'цена',
        matchInContext: true,
      }),
    ];

    const expected = {
      kind: 'ambiguous',
      winners: [
        expect.objectContaining({ ruleId: 'rule-a', triggerId: 'trigger-a' }),
        expect.objectContaining({ ruleId: 'rule-b', triggerId: 'trigger-b' }),
      ],
    };
    expect(matchPublisherAutoReply('цена срок', candidates)).toEqual(expected);
    expect(matchPublisherAutoReply('цена срок', [...candidates].reverse())).toEqual(expected);
  });

  it.each([
    [
      'message code points',
      'я'.repeat(PUBLISHER_AUTO_REPLY_MATCHER_LIMITS.messageCodePoints + 1),
      [trigger()],
    ],
    [
      'message tokens',
      Array.from({ length: PUBLISHER_AUTO_REPLY_MATCHER_LIMITS.messageTokens + 1 }, () => 'я').join(
        ' ',
      ),
      [trigger()],
    ],
    [
      'candidate count',
      'прайс',
      Array.from({ length: PUBLISHER_AUTO_REPLY_MATCHER_LIMITS.candidates + 1 }, (_, index) =>
        trigger({ ruleId: `rule-${index}`, triggerId: `trigger-${index}` }),
      ),
    ],
    [
      'fuzzy candidate count',
      'совсем другое сообщение',
      Array.from({ length: PUBLISHER_AUTO_REPLY_MATCHER_LIMITS.fuzzyCandidates + 1 }, (_, index) =>
        trigger({ ruleId: `rule-${index}`, triggerId: `trigger-${index}`, fuzzyMatch: true }),
      ),
    ],
  ])('fails closed when the %s budget is exceeded', (_label, message, candidates) => {
    expect(matchPublisherAutoReply(message, candidates)).toEqual({
      kind: 'no_match',
      reason: 'budget_exceeded',
    });
  });

  it('keeps exact matching available when only the fuzzy phase exceeds its budget', () => {
    const candidates = Array.from(
      { length: PUBLISHER_AUTO_REPLY_MATCHER_LIMITS.fuzzyCandidates + 1 },
      (_, index) =>
        trigger({
          ruleId: `rule-${index}`,
          triggerId: `trigger-${index}`,
          normalizedPhrase: index === 0 ? 'точный ответ' : `другая фраза ${index}`,
          phrase: index === 0 ? 'Точный ответ' : `Другая фраза ${index}`,
          fuzzyMatch: true,
        }),
    );

    expect(matchPublisherAutoReply('ТОЧНЫЙ   ОТВЕТ', candidates)).toMatchObject({
      kind: 'matched',
      winner: { ruleId: 'rule-0', matchKind: 'exact_full', distance: 0 },
    });
  });
});
