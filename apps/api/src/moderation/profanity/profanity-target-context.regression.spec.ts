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

const NEUTRAL_CONTEXT_CASES = [
  'В детском центре аутист пишет рассказ.',
  'В центре помощи алкоголик пришел на прием.',
  'Она аутистка, ей нужна спокойная среда и понятные инструкции.',
  'Она наркоманка в ремиссии и получает помощь врача.',
  'Она алкоголичка в ремиссии, семья ищет группу поддержки.',
  'Утром во дворе запел петух. Ты уже купил корм?',
  'В вольере живет макака. Вы можете посмотреть ее утром.',
  'В мастерской лежит шкура. Ты заберешь ее завтра?',
  'Фонд помогает детям с синдромом Дауна. Вы можете присоединиться.',
  'Зимой на полке лежат валенки. Ты можешь забрать их завтра.',
] as const;

const SEVERE_ABUSE_CASES = [
  'Ты петух, уйди из чата.',
  'Ты аутист, заткнись.',
  'Ты аутистка, заткнись.',
  'Ты наркоманка, отстань.',
  'Ты макака.',
  'Ты... петух!',
  'Ты - петух!',
  'ты п.е.т.у.х',
  'ты п е т у х',
  'Аутист пишет книгу. Ты петух.',
  'Она аутистка, ей нужна помощь. А ты петух, вали отсюда.',
  'Правила прочитаны. Ты петух.',
  '«ты петух»',
] as const;

describe('profanity target context regressions', () => {
  const previousRolloutMode = process.env.PROFANITY_V2_ROLLOUT_MODE;
  const service = new RuleEngineService({} as never);

  afterAll(() => {
    if (previousRolloutMode === undefined) {
      delete process.env.PROFANITY_V2_ROLLOUT_MODE;
    } else {
      process.env.PROFANITY_V2_ROLLOUT_MODE = previousRolloutMode;
    }
  });

  async function detect(text: string, profanitySensitivity: 'BALANCED' | 'STRICT') {
    const result = await service.detect({
      chatId: 'chat-1',
      userId: 'user-1',
      text,
      settings: { ...BASE_SETTINGS, profanitySensitivity } as never,
      domainAllowlist: [],
    });

    return result.violations.find(({ ruleCode }) => ruleCode === 'PROFANITY');
  }

  describe.each(['on', 'legacy'] as const)('%s rollout', (rolloutMode) => {
    beforeEach(() => {
      process.env.PROFANITY_V2_ROLLOUT_MODE = rolloutMode;
    });

    describe.each(['BALANCED', 'STRICT'] as const)('%s sensitivity', (sensitivity) => {
      it.each(NEUTRAL_CONTEXT_CASES)('allows neutral context: %s', async (text) => {
        expect({ text, violation: await detect(text, sensitivity) }).toEqual({
          text,
          violation: undefined,
        });
      });

      it.each(SEVERE_ABUSE_CASES)('keeps explicit abuse detected: %s', async (text) => {
        expect(await detect(text, sensitivity)).toEqual(
          expect.objectContaining({
            metadata: expect.objectContaining({
              category: 'SEVERE_ABUSE',
              rolloutMode,
              evidence: expect.arrayContaining(['TARGET_CONTEXT']),
            }),
          }),
        );
      });
    });
  });

  it.each(['Ты валенок, отстань.', 'Ты... валенок!'])(
    'keeps mild direct abuse detected in STRICT: %s',
    async (text) => {
      process.env.PROFANITY_V2_ROLLOUT_MODE = 'on';

      expect(await detect(text, 'STRICT')).toEqual(
        expect.objectContaining({
          metadata: expect.objectContaining({
            category: 'MILD_INSULT',
            evidence: expect.arrayContaining(['TARGET_CONTEXT']),
          }),
        }),
      );
    },
  );
});
