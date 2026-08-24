import { RuleEngineService } from '../rule-engine.service';

const BASE_SETTINGS = {
  russianProfanityFilterEnabled: true,
  commercialAdsFilterEnabled: false,
  messageLimitsBlockedWords: [],
  messageLimitsBlockedDomains: [],
  phoneNumbersEnabled: true,
  photoMessagesEnabled: true,
  videoMessagesEnabled: true,
  fileMessagesEnabled: true,
  voiceMessagesEnabled: true,
};

describe('structured profanity rule-engine decision', () => {
  const previousRolloutMode = process.env.PROFANITY_V2_ROLLOUT_MODE;

  beforeEach(() => {
    delete process.env.PROFANITY_V2_ROLLOUT_MODE;
  });

  afterAll(() => {
    if (previousRolloutMode === undefined) {
      delete process.env.PROFANITY_V2_ROLLOUT_MODE;
    } else {
      process.env.PROFANITY_V2_ROLLOUT_MODE = previousRolloutMode;
    }
  });

  it('uses BALANCED when generated settings do not contain sensitivity yet', async () => {
    const service = new RuleEngineService({} as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'ты скотина',
      settings: BASE_SETTINGS as never,
      domainAllowlist: [],
    });

    expect(result.violations).toEqual([]);
  });

  it('emits category score and explainable metadata for a STRICT mild hit', async () => {
    const service = new RuleEngineService({} as never);
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'ты скотина',
      settings: { ...BASE_SETTINGS, profanitySensitivity: 'STRICT' } as never,
      domainAllowlist: [],
    });

    expect(result.violations).toEqual([
      {
        ruleCode: 'PROFANITY',
        score: 0.75,
        reason: 'Detected profanity or abusive language pattern',
        metadata: {
          category: 'MILD_INSULT',
          sensitivity: 'STRICT',
          rolloutMode: 'on',
          familyId: 'exact:скотин',
          matchKind: 'EXACT_VARIANT',
          matchedVariant: 'скотина',
          evidence: ['TARGET_CONTEXT'],
          detectorVersion: 'profanity-structured-v1',
        },
      },
    ]);
  });

  it('lets legacy rollout override stored sensitivity without enabling v2-only terms', async () => {
    process.env.PROFANITY_V2_ROLLOUT_MODE = 'legacy';
    const service = new RuleEngineService({} as never);
    const legacyHit = await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'ты скотина',
      settings: { ...BASE_SETTINGS, profanitySensitivity: 'CORE_ONLY' } as never,
      domainAllowlist: [],
    });
    const v2OnlyTerm = await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'ты валенок',
      settings: { ...BASE_SETTINGS, profanitySensitivity: 'STRICT' } as never,
      domainAllowlist: [],
    });

    expect(legacyHit.violations[0]).toEqual(
      expect.objectContaining({
        score: 0.95,
        metadata: expect.objectContaining({
          category: 'MILD_INSULT',
          sensitivity: 'STRICT',
          rolloutMode: 'legacy',
        }),
      }),
    );
    expect(v2OnlyTerm.violations).toEqual([]);
  });
});
