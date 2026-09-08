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

const SAFE_NORMALIZATION_CASES = [
  'EBIT составил 500 млн рублей',
  'EBITDA выросла на 20%',
  'В отчете указан показатель ebitda.',
  'Ты сравнил EBIT и EBITDA за квартал?',
  'Use hue to adjust color',
  'Лампы Philips Hue доступны в магазине',
  'Тебе нравится цвет Philips Hue?',
  'Проверьте параметр hue в редакторе',
  'Christiaan Huygens discovered Titan',
  'Напишите на hue@example.com',
  'Отчет отправлен на ebitda@company.ru',
  'Копия для huygens@example.org',
  'Открой ebitda.csv',
  'Счет ebitda-2026.xlsx',
  'Сучки на доске можно зашлифовать',
  'Доска сухая, небольшие сучки на поверхности',
  'Брак в древесине: сучки',
  'Бак на 36л воды',
  'Объем 36 л',
  'Топливо 36л',
  'Продается рюкзак на 36л',
  'Тебе нужен бак объемом 36л?',
  'Объем 36л, а вы какую модель выбрали?',
  'Бак на 36 л, но ты можешь взять меньший.',
  'Канистра 36л и 2л воды.',
  'Мне 36 лет, работаю инженером.',
  'Возраст: 36лет.',
  'Тебе 36 лет?',
  '36л',
  '36 л',
  '36-летний инженер.',
  'Бак 36 литров.',
  'Мотор на 36 л.с., бензин.',
  'Пидоров Павел выступил на конференции',
  '  Пидоров Павел выступил на конференции',
  '\n\tПидоров Павел выступил на конференции',
  'https://example.com Пидоров Павел выступил на конференции',
  'Ссылка https://example.com: Пидоров Павел выступил на конференции',
  'https://example.com Мудаков Михаил ведет трансляцию',
  'https://example.com Михаил Мудаков ведет трансляцию',
  'https://example.com Сукин Борис выступил',
] as const;

const CORE_MAT_CONTROLS = [
  'блять',
  'pohuy',
  'zaebal',
  'p1zda',
  'х*у*й',
  'б л я т ь',
  'ты 36л',
  'ты 36 л',
  'Объем 36л, а ты 36л',
  'EBITDA выросла, но ты заебал',
  'Лампы Philips Hue хорошие, а ты pohuy пишешь',
  'https://example.com блять',
  'блять, напишите на hue@example.com',
  'Напишите на ebitda@company.ru, блять',
  'Блять <hue@example.com>',
  'блять, открой ebitda.csv',
  'Счет ebitda-2026.xlsx, блять',
  'Объем 36л, а ты е б а т ь пишешь.',
  'Бак 36л, ты 36л конечно.',
] as const;

const SEVERE_ABUSE_CONTROLS = [
  'Пидоров Павел выступил, а ты пидор',
  'https://example.com Мудаков Михаил выступил, а ты мудак',
  'Сукин Борис выступил, а ты сукин сын',
  'https://example.com Сукин Борис выступил, а ты сукин сын',
  'Мудак <hue@example.com>',
  'Напиши на hue@example.com, мудак',
  'Мудак, открой ebitda.csv',
  'Счет ebitda-2026.xlsx, а ты мудак',
  'Доска с сучками, а ты сука',
  'На доске сучки, а вы сучки',
] as const;

describe('profanity normalization false-positive regressions', () => {
  const previousRolloutMode = process.env.PROFANITY_V2_ROLLOUT_MODE;

  afterAll(() => {
    if (previousRolloutMode === undefined) {
      delete process.env.PROFANITY_V2_ROLLOUT_MODE;
    } else {
      process.env.PROFANITY_V2_ROLLOUT_MODE = previousRolloutMode;
    }
  });

  describe.each(['on', 'legacy'] as const)('%s rollout', (rolloutMode) => {
    beforeEach(() => {
      process.env.PROFANITY_V2_ROLLOUT_MODE = rolloutMode;
    });

    describe.each(['CORE_ONLY', 'BALANCED', 'STRICT'] as const)(
      '%s sensitivity',
      (profanitySensitivity) => {
        async function detectProfanity(text: string) {
          const service = new RuleEngineService({} as never);
          const result = await service.detect({
            chatId: 'chat-1',
            userId: 'user-1',
            text,
            settings: { ...BASE_SETTINGS, profanitySensitivity } as never,
            domainAllowlist: [],
          });
          return result.violations.find(({ ruleCode }) => ruleCode === 'PROFANITY');
        }

        it.each(SAFE_NORMALIZATION_CASES)('allows %s', async (text) => {
          expect(await detectProfanity(text)).toBeUndefined();
        });

        it.each(CORE_MAT_CONTROLS)('detects independent mat in %s', async (text) => {
          expect((await detectProfanity(text))?.metadata?.category).toBe('CORE_MAT');
        });

        it.each(SEVERE_ABUSE_CONTROLS)(
          'does not let an earlier surname exempt later abuse in %s',
          async (text) => {
            const expectedCategory =
              rolloutMode === 'on' && profanitySensitivity === 'CORE_ONLY'
                ? undefined
                : 'SEVERE_ABUSE';
            expect((await detectProfanity(text))?.metadata?.category).toBe(expectedCategory);
          },
        );
      },
    );
  });
});
