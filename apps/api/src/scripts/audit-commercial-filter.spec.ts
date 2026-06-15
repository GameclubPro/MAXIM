import {
  derivePolicyCategory,
  deriveSafeContextBucket,
  readCliOptions,
} from './audit-commercial-filter';

const emptySnapshot = {
  hit: false,
  score: null,
  confidenceScore: null,
  decisionBand: null,
  primarySubtype: null,
  supportingSubtypes: [],
  evidenceStrength: null,
  classifierVersion: null,
  commercialProbability: null,
  reviewProbability: null,
  classifierReasons: [],
  reviewRecommended: false,
  reviewReasons: [],
  matchedSignals: [],
  negativeSignals: [],
  decisionVersion: null,
  fpRisk: null,
  evidenceTier: null,
  subtype: null,
  actionBand: null,
  reasonCodes: [],
  featureVector: {},
};

describe('audit-commercial-filter CLI options', () => {
  it('keeps --limit all as an unlimited audit', () => {
    expect(readCliOptions(['--limit', 'all']).limit).toBeNull();
    expect(readCliOptions(['--limit=all']).limit).toBeNull();
    expect(readCliOptions(['--limit=ALL']).limit).toBeNull();
  });

  it('uses the default limit only when --limit is omitted', () => {
    expect(readCliOptions([]).limit).toBe(1500);
  });

  it('rejects non-integer limit values instead of truncating them', () => {
    expect(() => readCliOptions(['--limit', '10x'])).toThrow(
      '--limit must be a positive integer or "all"',
    );
    expect(() => readCliOptions(['--limit', '1e6'])).toThrow(
      '--limit must be a positive integer or "all"',
    );
    expect(() => readCliOptions(['--limit', '0'])).toThrow(
      '--limit must be a positive integer or "all"',
    );
  });

  it('keeps missing option values explicit', () => {
    expect(() => readCliOptions(['--limit'])).toThrow('--limit requires a value');
    expect(() => readCliOptions(['--sample'])).toThrow('--sample requires a value');
  });

  it('allows --sample 0 for aggregate-only audits', () => {
    expect(readCliOptions(['--sample', '0']).sample).toBe(0);
  });

  it('rejects non-integer sample values instead of truncating them', () => {
    expect(() => readCliOptions(['--sample', '2x'])).toThrow(
      '--sample must be a non-negative integer',
    );
    expect(() => readCliOptions(['--sample', '1e6'])).toThrow(
      '--sample must be a non-negative integer',
    );
  });
});

describe('deriveSafeContextBucket', () => {
  it('does not classify commercial ads as moderation context just because they mention admins or bots', () => {
    for (const text of [
      'АДМИНИСТРАТОР на ресепшен, 74400 руб., смены, опыт приветствуется, писать в тг',
      'В нашей группе можно купить и продать все, что не запрещено законом РФ',
      'Предлагаем публикацию вашей рекламы в чате, где нет ботов, за подробностями в личные сообщения',
    ]) {
      expect(
        deriveSafeContextBucket({
          text,
          current: emptySnapshot,
          historical: emptySnapshot,
        }),
      ).not.toBe('rules_or_moderation_context');
    }
  });

  it('keeps actual ad-moderation discussions in the rules bucket', () => {
    expect(
      deriveSafeContextBucket({
        text: 'По правилам чата реклама и ссылки запрещены, бот удалит такие объявления.',
        current: emptySnapshot,
        historical: emptySnapshot,
      }),
    ).toBe('rules_or_moderation_context');
  });

  it('does not let text-only rules wording override an existing commercial hit', () => {
    expect(
      deriveSafeContextBucket({
        text: 'Объявления Казань. Тут только ссылки на группы, другие удаляем. Присоединяйся к чату.',
        current: {
          ...emptySnapshot,
          hit: true,
          actionBand: 'REVIEW_ONLY',
          primarySubtype: 'CHANNEL_PLACEMENT',
        },
        historical: emptySnapshot,
      }),
    ).not.toBe('rules_or_moderation_context');
  });
});

describe('derivePolicyCategory', () => {
  it('keeps high-fp review-only detections in the gray zone instead of negative corpus labels', () => {
    expect(
      derivePolicyCategory({
        category: 'current_only',
        current: {
          ...emptySnapshot,
          hit: true,
          confidenceScore: 41,
          decisionBand: 'MEDIUM',
          actionBand: 'REVIEW_ONLY',
          fpRisk: 82,
          reviewRecommended: true,
        },
      }),
    ).toBe('gray_zone');
  });

  it('still flags high-fp hard deletes as false-positive candidates', () => {
    expect(
      derivePolicyCategory({
        category: 'current_only',
        current: {
          ...emptySnapshot,
          hit: true,
          confidenceScore: 80,
          decisionBand: 'HIGH',
          actionBand: 'DELETE',
          fpRisk: 82,
        },
      }),
    ).toBe('false_positive_candidate');
  });
});
