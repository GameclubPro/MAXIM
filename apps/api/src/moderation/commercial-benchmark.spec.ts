import type { ChatSettings } from '../prisma/prisma-client';
import type { CommercialCampaignContext } from './commercial-campaign.util';
import { COMMERCIAL_NEGATIVE_CASES } from './commercial-negative.fixture';
import { COMMERCIAL_POSITIVE_CASES } from './commercial-positive.fixture';
import { RedisCounterService } from './redis-counter.service';
import { RuleEngineService } from './rule-engine.service';
import type { RuleViolation } from './rule-engine.contract';

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
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function readMetadata(violation: RuleViolation | undefined): Record<string, unknown> {
  return violation?.metadata && typeof violation.metadata === 'object' && !Array.isArray(violation.metadata)
    ? violation.metadata
    : {};
}

describe('commercial deterministic benchmark', () => {
  it('meets recall, false-positive, subtype, and action-policy gates', async () => {
    const service = createRuleEngine();
    const falseNegatives: string[] = [];
    const falsePositives: string[] = [];
    const subtypeMisses: string[] = [];
    const deleteWithoutStrongEvidence: string[] = [];
    const bySubtype = new Map<string, number>();
    const byAction = new Map<string, number>();
    const falseNegativeSignals = new Map<string, number>();
    const falsePositiveSignals = new Map<string, number>();

    for (const item of COMMERCIAL_POSITIVE_CASES) {
      const violation = await detectCommercialViolation(service, item.text, item.overrides, {
        commercialCampaignContext: item.campaignContext,
      });
      if (!violation) {
        falseNegatives.push(item.label);
        continue;
      }

      const metadata = readMetadata(violation);
      const subtype = String(metadata.primarySubtype ?? 'UNKNOWN');
      const actionBand = String(metadata.actionBand ?? 'UNKNOWN');
      bySubtype.set(subtype, (bySubtype.get(subtype) ?? 0) + 1);
      byAction.set(actionBand, (byAction.get(actionBand) ?? 0) + 1);
      if (subtype !== item.expectedSubtype) {
        subtypeMisses.push(`${item.label}: expected=${item.expectedSubtype} actual=${subtype}`);
      }

      const matchedSignals = readStringArray(metadata.matchedSignals);
      const evidenceTier = String(metadata.evidenceTier ?? metadata.evidenceStrength ?? 'NONE');
      const hasDirectEvidence =
        matchedSignals.includes('transaction:price') ||
        matchedSignals.includes('contact:phone') ||
        matchedSignals.some((signal) => signal.startsWith('deal-channel:')) ||
        matchedSignals.includes('combo:contact+price');
      const hasHighRiskEvidence = matchedSignals.some((signal) => signal.startsWith('risk:'));
      if (
        (actionBand === 'DELETE' || actionBand === 'DELETE_AND_ESCALATE') &&
        !hasDirectEvidence &&
        !hasHighRiskEvidence &&
        evidenceTier !== 'DIRECT' &&
        evidenceTier !== 'HIGH_RISK'
      ) {
        deleteWithoutStrongEvidence.push(item.label);
      }
    }

    for (const item of COMMERCIAL_NEGATIVE_CASES) {
      const violation = await detectCommercialViolation(service, item.text, item.overrides);
      if (!violation) {
        continue;
      }
      falsePositives.push(item.label);
      for (const signal of readStringArray(readMetadata(violation).matchedSignals)) {
        falsePositiveSignals.set(signal, (falsePositiveSignals.get(signal) ?? 0) + 1);
      }
    }

    for (const label of falseNegatives) {
      falseNegativeSignals.set(label, 1);
    }

    const truePositives = COMMERCIAL_POSITIVE_CASES.length - falseNegatives.length;
    const trueNegatives = COMMERCIAL_NEGATIVE_CASES.length - falsePositives.length;
    const recall = truePositives / COMMERCIAL_POSITIVE_CASES.length;
    const falsePositiveRate = falsePositives.length / COMMERCIAL_NEGATIVE_CASES.length;
    const subtypeAccuracy =
      (COMMERCIAL_POSITIVE_CASES.length - subtypeMisses.length) / COMMERCIAL_POSITIVE_CASES.length;
    const report = {
      confusionMatrix: {
        TP: truePositives,
        FP: falsePositives.length,
        FN: falseNegatives.length,
        TN: trueNegatives,
      },
      bySubtype: Object.fromEntries([...bySubtype.entries()].sort()),
      byAction: Object.fromEntries([...byAction.entries()].sort()),
      topFalsePositiveSignals: Object.fromEntries(
        [...falsePositiveSignals.entries()].sort((left, right) => right[1] - left[1]).slice(0, 8),
      ),
      topFalseNegativeSignals: Object.fromEntries([...falseNegativeSignals.entries()].slice(0, 8)),
    };

    expect(report).toMatchSnapshot();
    expect(recall).toBeGreaterThanOrEqual(0.95);
    expect(falsePositiveRate).toBeLessThanOrEqual(0.002);
    expect(subtypeAccuracy).toBeGreaterThanOrEqual(0.9);
    expect(falsePositives).toEqual([]);
    expect(deleteWithoutStrongEvidence).toEqual([]);
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

    expect(p95).toBeLessThanOrEqual(5);
    expect(p99).toBeLessThanOrEqual(15);
  });
});

