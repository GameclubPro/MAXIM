import { deriveSafeContextBucket, readCliOptions } from './audit-commercial-filter';

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
  });

  it('uses the default limit only when --limit is omitted', () => {
    expect(readCliOptions([]).limit).toBe(1500);
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
});
