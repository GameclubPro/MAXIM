import type { ChatSettings } from '../prisma/prisma-client';
import type { CommercialCampaignContext } from './commercial-campaign.util';
import {
  COMMERCIAL_BENCHMARK_LOCAL_LIMITS,
  COMMERCIAL_BENCHMARK_REPORT_PREFIX,
  isCommercialBenchmarkMedianGateEnabled,
  type CommercialBenchmarkPercentiles,
} from '../scripts/commercial-benchmark-ci.util';
import { COMMERCIAL_NEGATIVE_CASES } from './commercial-negative.fixture';
import { COMMERCIAL_POSITIVE_CASES } from './commercial-positive.fixture';
import {
  auditCommercialRequiredAnchors,
  buildCommercialFeatureVector,
} from './commercial/commercial-features';
import { resolveCommercialSignalEvidence } from './commercial/commercial-evidence';
import { canCommercialActionDelete } from './commercial/commercial-scorer';
import { RedisCounterService } from './redis-counter.service';
import { RuleEngineService } from './rule-engine.service';
import type { CommercialSubtype, RuleViolation } from './rule-engine.contract';

class NoopRedisCounterService {
  async incrementWithTtl(): Promise<number> {
    return 0;
  }

  async addToSetWithTtl(): Promise<{ added: boolean; size: number }> {
    return { added: true, size: 1 };
  }
}

const BASE_SETTINGS = {
  russianProfanityFilterEnabled: false,
  commercialAdsFilterEnabled: true,
  commercialAdsSensitivity: 'STRICT',
  commercialAdsWarnThreshold: 38,
  commercialAdsDeleteThreshold: 55,
  topicFilterEnabled: false,
  linkMode: 'ALLOW_ALL',
  duplicateDetectionEnabled: false,
  messageCountLimitEnabled: false,
  antiSpamEnabled: false,
  maxMessageLength: 0,
  photoCooldownHours: 0,
  stickerCooldownMinutes: 0,
  messageLimitsBlockedWords: [],
  messageLimitsBlockedDomains: [],
} as unknown as ChatSettings;

function buildSettings(overrides: Partial<ChatSettings> = {}): ChatSettings {
  return {
    ...BASE_SETTINGS,
    ...overrides,
    commercialAdsFilterEnabled: true,
  };
}

function createRuleEngine(): RuleEngineService {
  return new RuleEngineService(new NoopRedisCounterService() as unknown as RedisCounterService);
}

async function detectCommercialViolation(
  service: RuleEngineService,
  text: string,
  overrides: Partial<ChatSettings> = {},
  options: { commercialCampaignContext?: CommercialCampaignContext | null } = {},
): Promise<RuleViolation | undefined> {
  const result = await service.detect({
    chatId: 'commercial-benchmark-chat',
    userId: 'commercial-benchmark-user',
    text,
    settings: buildSettings(overrides),
    domainAllowlist: [],
    commercialCampaignContext: options.commercialCampaignContext,
    skipDuplicateState: true,
    skipStatefulMessageLimits: true,
  });

  return result.violations.find((item) => item.ruleCode === 'COMMERCIAL_AD');
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function readMetadata(violation: RuleViolation | undefined): Record<string, unknown> {
  return violation?.metadata &&
    typeof violation.metadata === 'object' &&
    !Array.isArray(violation.metadata)
    ? violation.metadata
    : {};
}

function readCommercialSubtype(value: unknown): CommercialSubtype | null {
  const subtypes = new Set<CommercialSubtype>([
    'CHANNEL_PLACEMENT',
    'PROPERTY_AGENT',
    'PROPERTY_COMMERCIAL',
    'RECRUITMENT',
    'INFO_PRODUCT',
    'BUYOUT',
    'SERVICES',
    'GOODS_RETAIL',
    'GOODS',
    'GROUP_PROMOTION',
    'GENERIC',
  ]);

  return typeof value === 'string' && subtypes.has(value as CommercialSubtype)
    ? (value as CommercialSubtype)
    : null;
}

function calculateSubtypeAccuracy(params: {
  totalPositiveCases: number;
  detectedPositiveCases: number;
  detectedSubtypeMisses: number;
}): number {
  if (params.totalPositiveCases === 0) {
    return 1;
  }

  return (params.detectedPositiveCases - params.detectedSubtypeMisses) / params.totalPositiveCases;
}

describe('commercial deterministic benchmark', () => {
  const useMedianGate = isCommercialBenchmarkMedianGateEnabled(process.env);
  let hotPathMetrics: CommercialBenchmarkPercentiles | null = null;
  let adversarialMetrics: CommercialBenchmarkPercentiles | null = null;

  afterAll(() => {
    if (!useMedianGate) {
      return;
    }
    if (!hotPathMetrics || !adversarialMetrics) {
      throw new Error('Commercial benchmark did not produce both performance reports');
    }
    process.stdout.write(
      `${COMMERCIAL_BENCHMARK_REPORT_PREFIX}${JSON.stringify({
        hotPath: hotPathMetrics,
        adversarial: adversarialMetrics,
      })}\n`,
    );
  });

  it('counts undetected positive cases as subtype errors', () => {
    expect(
      calculateSubtypeAccuracy({
        totalPositiveCases: 4,
        detectedPositiveCases: 3,
        detectedSubtypeMisses: 1,
      }),
    ).toBe(0.5);
  });

  it('warms service-phone commercial paths before the first measured detection', async () => {
    const service = createRuleEngine();
    const startedAt = performance.now();
    const violation = await detectCommercialViolation(service, 'ГРУЗОПЕРЕВОЗКИ +7 900 000 10 42', {
      commercialAdsSensitivity: 'BALANCED',
      commercialAdsWarnThreshold: 57,
      commercialAdsDeleteThreshold: 77,
    });
    const elapsedMs = performance.now() - startedAt;

    expect(violation?.metadata).toEqual(
      expect.objectContaining({
        primarySubtype: 'SERVICES',
        actionBand: 'WARN',
      }),
    );
    expect(elapsedMs).toBeLessThanOrEqual(150);
  });

  it('meets recall, false-positive, subtype, and action-policy gates', async () => {
    const service = createRuleEngine();
    const falseNegatives: string[] = [];
    const hardFalseNegatives: string[] = [];
    const grayFalseNegatives: string[] = [];
    const falsePositives: string[] = [];
    const subtypeMisses: string[] = [];
    const deleteWithoutStrongEvidence: string[] = [];
    const deleteFalsePositives: string[] = [];
    const missingExpectedSignals: string[] = [];
    const missingRequiredAnchors: string[] = [];
    const unsafeDeleteActions: string[] = [];
    const hardEnforcementMisses: string[] = [];
    const bySubtype = new Map<string, number>();
    const byAction = new Map<string, number>();
    const falseNegativeSignals = new Map<string, number>();
    const falsePositiveSignals = new Map<string, number>();
    const hardPositiveCases = COMMERCIAL_POSITIVE_CASES.filter(
      (item) => item.reviewRecommended !== true && item.requireClassifier !== true,
    );
    const grayPositiveCases = COMMERCIAL_POSITIVE_CASES.filter(
      (item) => item.reviewRecommended === true || item.requireClassifier === true,
    );
    const hardEnforcementCases = COMMERCIAL_POSITIVE_CASES.filter(
      (item) =>
        item.reviewRecommended !== true &&
        item.requireClassifier !== true &&
        item.expectedSignals.some((signal) => signal.startsWith('risk:')),
    );
    const hardEnforcementLabels = new Set(hardEnforcementCases.map((item) => item.label));

    for (const item of COMMERCIAL_POSITIVE_CASES) {
      const violation = await detectCommercialViolation(service, item.text, item.overrides, {
        commercialCampaignContext: item.campaignContext,
      });
      if (!violation) {
        falseNegatives.push(item.label);
        if (hardEnforcementLabels.has(item.label)) {
          hardEnforcementMisses.push(`${item.label}: action=ALLOW`);
        }
        if (item.reviewRecommended === true || item.requireClassifier === true) {
          grayFalseNegatives.push(item.label);
        } else {
          hardFalseNegatives.push(item.label);
        }
        continue;
      }

      const metadata = readMetadata(violation);
      const subtype = String(metadata.primarySubtype ?? 'UNKNOWN');
      const typedSubtype = readCommercialSubtype(metadata.primarySubtype);
      const actionBand = String(metadata.actionBand ?? 'UNKNOWN');
      if (
        hardEnforcementLabels.has(item.label) &&
        actionBand !== 'WARN' &&
        actionBand !== 'DELETE' &&
        actionBand !== 'DELETE_AND_ESCALATE'
      ) {
        hardEnforcementMisses.push(`${item.label}: action=${actionBand}`);
      }
      bySubtype.set(subtype, (bySubtype.get(subtype) ?? 0) + 1);
      byAction.set(actionBand, (byAction.get(actionBand) ?? 0) + 1);
      if (subtype !== item.expectedSubtype) {
        subtypeMisses.push(`${item.label}: expected=${item.expectedSubtype} actual=${subtype}`);
      }

      const matchedSignals = readStringArray(metadata.matchedSignals);
      const negativeSignals = readStringArray(metadata.negativeSignals);
      const expectedSignalsMissing = item.expectedSignals.filter(
        (signal) => !matchedSignals.includes(signal),
      );
      if (expectedSignalsMissing.length > 0) {
        missingExpectedSignals.push(`${item.label}: missing=${expectedSignalsMissing.join(',')}`);
      }
      const featureVector = buildCommercialFeatureVector(matchedSignals, negativeSignals);
      if (typedSubtype) {
        const anchorAudit = auditCommercialRequiredAnchors({
          subtype: typedSubtype,
          featureVector,
          matchedSignals,
        });
        if (!anchorAudit.hasRequiredAnchors) {
          missingRequiredAnchors.push(
            `${item.label}: subtype=${subtype} missing=${anchorAudit.missingAnchors.join(',')}`,
          );
        }
      }
      const evidenceTier = String(metadata.evidenceTier ?? metadata.evidenceStrength ?? 'NONE');
      const evidence = resolveCommercialSignalEvidence(matchedSignals);
      const hasDirectEvidence = evidence.hasActionDirectDealEvidence;
      const hasHighRiskEvidence = evidence.hasHighRiskEvidence;
      const hasEscalationRiskEvidence = evidence.hasEscalationRiskEvidence;
      if (
        (actionBand === 'DELETE' || actionBand === 'DELETE_AND_ESCALATE') &&
        !hasDirectEvidence &&
        !hasHighRiskEvidence &&
        evidenceTier !== 'DIRECT' &&
        evidenceTier !== 'HIGH_RISK'
      ) {
        deleteWithoutStrongEvidence.push(item.label);
      }
      if (
        !canCommercialActionDelete({
          actionBand,
          evidenceTier,
          hasHighRiskEvidence,
          hasEscalationRiskEvidence,
          hasDirectDealEvidence: hasDirectEvidence,
          fpRisk: typeof metadata.fpRisk === 'number' ? metadata.fpRisk : null,
        }) &&
        (actionBand === 'DELETE' || actionBand === 'DELETE_AND_ESCALATE')
      ) {
        unsafeDeleteActions.push(`${item.label}: action=${actionBand} evidence=${evidenceTier}`);
      }
    }

    for (const item of COMMERCIAL_NEGATIVE_CASES) {
      const violation = await detectCommercialViolation(service, item.text, item.overrides, {
        commercialCampaignContext: item.campaignContext ?? null,
      });
      if (!violation) {
        continue;
      }
      falsePositives.push(item.label);
      const metadata = readMetadata(violation);
      const actionBand = String(metadata.actionBand ?? 'UNKNOWN');
      if (actionBand === 'DELETE' || actionBand === 'DELETE_AND_ESCALATE') {
        deleteFalsePositives.push(item.label);
      }
      for (const signal of readStringArray(metadata.matchedSignals)) {
        falsePositiveSignals.set(signal, (falsePositiveSignals.get(signal) ?? 0) + 1);
      }
    }

    for (const label of falseNegatives) {
      falseNegativeSignals.set(label, 1);
    }

    const truePositives = COMMERCIAL_POSITIVE_CASES.length - falseNegatives.length;
    const hardTruePositives = hardPositiveCases.length - hardFalseNegatives.length;
    const grayTruePositives = grayPositiveCases.length - grayFalseNegatives.length;
    const trueNegatives = COMMERCIAL_NEGATIVE_CASES.length - falsePositives.length;
    const recall = truePositives / COMMERCIAL_POSITIVE_CASES.length;
    const hardRecall = hardTruePositives / hardPositiveCases.length;
    const hardEnforcementRecall =
      (hardEnforcementCases.length - hardEnforcementMisses.length) / hardEnforcementCases.length;
    const grayRecall =
      grayPositiveCases.length > 0 ? grayTruePositives / grayPositiveCases.length : 1;
    const falsePositiveRate = falsePositives.length / COMMERCIAL_NEGATIVE_CASES.length;
    const subtypeAccuracy = calculateSubtypeAccuracy({
      totalPositiveCases: COMMERCIAL_POSITIVE_CASES.length,
      detectedPositiveCases: truePositives,
      detectedSubtypeMisses: subtypeMisses.length,
    });
    const report = {
      confusionMatrix: {
        TP: truePositives,
        FP: falsePositives.length,
        FN: falseNegatives.length,
        TN: trueNegatives,
      },
      hardEnforcement: {
        eligible: hardEnforcementCases.length,
        misses: hardEnforcementMisses.length,
      },
      bySubtype: Object.fromEntries([...bySubtype.entries()].sort()),
      byAction: Object.fromEntries([...byAction.entries()].sort()),
      topFalsePositiveSignals: Object.fromEntries(
        [...falsePositiveSignals.entries()].sort((left, right) => right[1] - left[1]).slice(0, 8),
      ),
      topFalseNegativeSignals: Object.fromEntries([...falseNegativeSignals.entries()].slice(0, 8)),
    };

    expect(hardEnforcementMisses).toEqual([]);
    expect(report).toMatchSnapshot();
    expect(hardRecall).toBeGreaterThanOrEqual(0.98);
    expect(hardEnforcementRecall).toBeGreaterThanOrEqual(0.98);
    expect(grayRecall).toBeGreaterThanOrEqual(0.8);
    expect(recall).toBeGreaterThanOrEqual(0.95);
    expect(falsePositives).toEqual([]);
    expect(falsePositiveRate).toBeLessThanOrEqual(0.001);
    expect(subtypeAccuracy).toBeGreaterThanOrEqual(0.93);
    expect(deleteFalsePositives).toEqual([]);
    expect(deleteWithoutStrongEvidence).toEqual([]);
    expect(unsafeDeleteActions).toEqual([]);
    expect(missingExpectedSignals).toEqual([]);
    expect(missingRequiredAnchors).toEqual([]);
  });

  it('keeps campaign-only commercial repeats out of delete actions', async () => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      'В наличии свежая партия, доставка по городу. Подробности и заказ в личные сообщения.',
      {},
      {
        commercialCampaignContext: {
          senderDistinctChatCount: 5,
          sameTextDistinctChatCount: 3,
          repeatedPhoneDistinctChatCount: 0,
          repeatedLinkDistinctChatCount: 0,
          nearTextDistinctChatCount: 3,
          repeatedDomainDistinctChatCount: 0,
          repeatedHandleDistinctChatCount: 0,
          senderDistinctChatCount5m: 4,
          senderDistinctChatCount30m: 5,
          senderDistinctChatCount120m: 5,
        },
      },
    );

    expect(violation).toBeDefined();
    const actionBand = String(readMetadata(violation).actionBand ?? 'UNKNOWN');
    expect(actionBand).not.toBe('DELETE');
    expect(actionBand).not.toBe('DELETE_AND_ESCALATE');
    expect(['WARN', 'REVIEW_ONLY']).toContain(actionBand);
  });

  it.each([
    [
      'messaging automation spam repeated across chats',
      'ПРОДАЖА КАЧЕСТВЕННОЙ РАССЫЛКИ, ДЕШЕВО. ЛУЧШИЕ ТАРИФЫ ПИСАТЬ В ЛС. ПОЛУЧИТЬ КЛИЕНТСКУЮ БАЗУ И ДЕНЬГИ. ПРОДАЮ САЙТ НА ЗАКАЗ НЕДОРОГО ТГ ЗАБЛОКИРОВАЛИ? САЙТ ПОМОЖЕТ РЕШИТЬ ЛЮБУЮ ПРОБЛЕМУ. ТАК ЖЕ ПИСАТЬ В ЛС',
    ],
    [
      'remote bank vacancy repeated across chats',
      'Требуются сотрудники на удаленку в Альфа банк, подойдет всем 18+ студентам и мамам в декрете. Работаем в агентском портале через телефон, график свободный, ЗП белая на карту. Все вопросы в л/с Новичкам бонус 10000тыс.',
    ],
  ])('keeps campaign-only high-risk %s out of delete actions', async (_label, text) => {
    const service = createRuleEngine();
    const violation = await detectCommercialViolation(
      service,
      text,
      {},
      {
        commercialCampaignContext: {
          senderDistinctChatCount: 4,
          sameTextDistinctChatCount: 4,
          repeatedPhoneDistinctChatCount: 0,
          repeatedLinkDistinctChatCount: 0,
          nearTextDistinctChatCount: 4,
          repeatedDomainDistinctChatCount: 0,
          repeatedHandleDistinctChatCount: 0,
          senderDistinctChatCount5m: 2,
          senderDistinctChatCount30m: 4,
          senderDistinctChatCount120m: 4,
        },
      },
    );

    expect(violation).toBeDefined();
    const actionBand = String(readMetadata(violation).actionBand ?? 'UNKNOWN');
    expect(actionBand).not.toBe('DELETE');
    expect(actionBand).not.toBe('DELETE_AND_ESCALATE');
    expect(['WARN', 'REVIEW_ONLY']).toContain(actionBand);
  });

  it('keeps hot-path commercial detection within the deterministic perf budget', async () => {
    const service = createRuleEngine();
    const samples = [
      ...COMMERCIAL_POSITIVE_CASES.slice(0, 10).map((item) => item.text),
      ...COMMERCIAL_NEGATIVE_CASES.slice(0, 10).map((item) => item.text),
    ];
    const timings: number[] = [];

    for (let index = 0; index < 10_000; index += 1) {
      const text = samples[index % samples.length] ?? 'обычное сообщение';
      const startedAt = performance.now();
      await detectCommercialViolation(service, text);
      timings.push(performance.now() - startedAt);
    }

    timings.sort((left, right) => left - right);
    const p95 = timings[Math.floor(timings.length * 0.95)] ?? 0;
    const p99 = timings[Math.floor(timings.length * 0.99)] ?? 0;

    hotPathMetrics = { p95Ms: p95, p99Ms: p99 };
    if (!useMedianGate) {
      expect(p95).toBeLessThanOrEqual(COMMERCIAL_BENCHMARK_LOCAL_LIMITS.hotPath.p95Ms);
      expect(p99).toBeLessThanOrEqual(COMMERCIAL_BENCHMARK_LOCAL_LIMITS.hotPath.p99Ms);
    }
  });

  it('keeps adversarial commercial near-misses within the deterministic perf budget', async () => {
    const service = createRuleEngine();
    const samples = [
      `продам ${Array.from({ length: 1200 }, (_, index) => index % 10).join(' ')} x`,
      `попробуйте ${Array.from({ length: 80 }, (_, index) => `label${index}`).join('.')}.invalidtld`,
      `напишите ${Array.from({ length: 900 }, () => 'a').join('.')}@${Array.from(
        { length: 120 },
        () => 'b',
      ).join('-')}-invalid`,
      `розыгрыш ${Array.from({ length: 420 }, () => '1').join(' ')} рублей за спортX`,
      'Бесплатный подбор новостроек. Квартиры от застройщика без комиссии.',
      `Мой канал с заметками про ручную работу ${Array.from({ length: 120 }, () => 'скидок').join(
        ' ',
      )} и заказов там нет.`,
      `Открыла для себя аромат ${Array.from({ length: 80 }, () => 'для себя').join(
        ' ',
      )}, но это личный отзыв без продаж.`,
      `Травы ${Array.from({ length: 80 }, (_, index) => `${index + 10}р.кг`).join(
        ' ',
      )} обсуждали в рецепте без заказов.`,
      `Продаем бензин ${Array.from({ length: 1100 }, () => 'x').join(
        '.',
      )}. Это архивный перечень без цены и контактов.`,
      `Редакция цитирует: „${Array.from({ length: 360 }, () => 'x. Отдельно: x').join(
        ' ',
      )}“. Это архив примеров, не предложение.`,
      'Приглашаю на обсуждение салона, окрашивание и цены выросли, телефон администратора не нужен.',
    ];
    const timings: number[] = [];

    for (let index = 0; index < 500; index += 1) {
      const text = samples[index % samples.length] ?? 'обычное сообщение';
      const startedAt = performance.now();
      const violation = await detectCommercialViolation(service, text);
      timings.push(performance.now() - startedAt);
      if (text.includes('новостроек')) {
        expect(violation).toBeUndefined();
      }
    }

    timings.sort((left, right) => left - right);
    const p95 = timings[Math.floor(timings.length * 0.95)] ?? 0;
    const p99 = timings[Math.floor(timings.length * 0.99)] ?? 0;

    adversarialMetrics = { p95Ms: p95, p99Ms: p99 };
    if (!useMedianGate) {
      expect(p95).toBeLessThanOrEqual(COMMERCIAL_BENCHMARK_LOCAL_LIMITS.adversarial.p95Ms);
      expect(p99).toBeLessThanOrEqual(COMMERCIAL_BENCHMARK_LOCAL_LIMITS.adversarial.p99Ms);
    }
  });
});
