import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';

type AuditSnapshot = {
  hit?: unknown;
  actionBand?: unknown;
  campaignStrength?: unknown;
  evidenceTier?: unknown;
  evidenceStrength?: unknown;
  primarySubtype?: unknown;
  subtype?: unknown;
  reasonCodes?: unknown;
  matchedSignals?: unknown;
  negativeSignals?: unknown;
  featureVector?: unknown;
  safeContextBucket?: unknown;
  deleteSuppressed?: unknown;
  suppressionReasons?: unknown;
};

type AuditSummaryRecord = {
  label?: unknown;
  expectedAction?: unknown;
  policyCategory?: unknown;
  segment?: unknown;
  safeContextBucket?: unknown;
  current?: unknown;
  historical?: unknown;
};

export type CommercialAuditAlert = {
  code: string;
  severity: 'warning' | 'critical';
  count: number;
};

export type CommercialAuditSummary = {
  records: number;
  labels: Record<string, number>;
  actions: Record<string, number>;
  policyCategories: Record<string, number>;
  subtypes: Record<string, number>;
  segments: Record<string, number>;
  safeContextBuckets: Record<string, number>;
  safeContextDeletes: Record<string, number>;
  safeContextEnforcements: Record<string, number>;
  campaignOnlyDeletes: number;
  campaignOnlyEnforcements: number;
  grayDeletes: number;
  grayEnforcements: number;
  deleteFalsePositiveCandidates: number;
  enforcementFalsePositiveCandidates: number;
  deleteSuppressed: number;
  genericGoodsDeletes: number;
  genericGoodsEnforcements: number;
  recruitmentDeleteWithoutRisk: number;
  recruitmentEnforcementWithoutRisk: number;
  riskyRulesOrNewsContext: number;
  alerts: CommercialAuditAlert[];
};

type CliOptions = {
  inputPath: string;
  outputPath?: string;
  alertsPath?: string;
  failOnAlert: boolean;
};

const DELETE_ACTIONS = new Set(['DELETE', 'DELETE_AND_ESCALATE']);
const ENFORCEMENT_ACTIONS = new Set(['WARN', ...DELETE_ACTIONS]);
const RULES_OR_NEWS_SAFE_BUCKETS = new Set([
  'rules_or_moderation_context',
  'spam_complaint_or_fraud_warning',
  'news_or_analytics',
  'public_training_or_help',
]);

export function summarizeCommercialAuditRecords(
  records: readonly AuditSummaryRecord[],
): CommercialAuditSummary {
  const labels = new Map<string, number>();
  const actions = new Map<string, number>();
  const policyCategories = new Map<string, number>();
  const subtypes = new Map<string, number>();
  const segments = new Map<string, number>();
  const safeContextBuckets = new Map<string, number>();
  const safeContextDeletes = new Map<string, number>();
  const safeContextEnforcements = new Map<string, number>();
  let campaignOnlyDeletes = 0;
  let campaignOnlyEnforcements = 0;
  let grayDeletes = 0;
  let grayEnforcements = 0;
  let deleteFalsePositiveCandidates = 0;
  let enforcementFalsePositiveCandidates = 0;
  let deleteSuppressed = 0;
  let genericGoodsDeletes = 0;
  let genericGoodsEnforcements = 0;
  let recruitmentDeleteWithoutRisk = 0;
  let recruitmentEnforcementWithoutRisk = 0;
  let riskyRulesOrNewsContext = 0;

  for (const record of records) {
    const label = readString(record.label) ?? 'unknown';
    const expectedAction = readString(record.expectedAction);
    const policyCategory = readString(record.policyCategory) ?? 'unknown';
    const segment = readString(record.segment) ?? 'unknown';
    const current = readSnapshot(record.current);
    const action = readString(current.actionBand) ?? 'NONE';
    const subtype = readString(current.primarySubtype) ?? readString(current.subtype) ?? 'NONE';
    const safeContextBucket =
      readString(record.safeContextBucket) ?? readString(current.safeContextBucket) ?? 'none';
    const reasonCodes = readStringArray(current.reasonCodes);
    const matchedSignals = readStringArray(current.matchedSignals);
    const negativeSignals = readStringArray(current.negativeSignals);
    const isDelete = DELETE_ACTIONS.has(action);
    const isEnforcement = ENFORCEMENT_ACTIONS.has(action);
    const grayOverEnforcement =
      label === 'gray_candidate' && isActionOverExpected(action, expectedAction);
    const deleteProfile = readDeleteProfile(current, reasonCodes, matchedSignals);

    pushCount(labels, label);
    pushCount(actions, action);
    pushCount(policyCategories, policyCategory);
    pushCount(segments, segment);
    pushCount(subtypes, subtype);
    pushCount(safeContextBuckets, safeContextBucket);

    if (readBoolean(current.deleteSuppressed)) {
      deleteSuppressed += 1;
    }
    if (isDelete && safeContextBucket !== 'none') {
      pushCount(safeContextDeletes, safeContextBucket);
    }
    if (isEnforcement && safeContextBucket !== 'none') {
      pushCount(safeContextEnforcements, safeContextBucket);
    }
    if (policyCategory === 'campaign_only' && isDelete) {
      campaignOnlyDeletes += 1;
    }
    if (policyCategory === 'campaign_only' && isEnforcement) {
      campaignOnlyEnforcements += 1;
    }
    if (grayOverEnforcement && isDelete) {
      grayDeletes += 1;
    }
    if (grayOverEnforcement && isEnforcement) {
      grayEnforcements += 1;
    }
    if (label === 'negative_candidate' && isDelete) {
      deleteFalsePositiveCandidates += 1;
    }
    if (label === 'negative_candidate' && isEnforcement) {
      enforcementFalsePositiveCandidates += 1;
    }
    if (
      isDelete &&
      (subtype === 'GOODS' || subtype === 'GENERIC') &&
      isWeakGenericGoodsDelete(deleteProfile)
    ) {
      genericGoodsDeletes += 1;
    }
    if (
      isEnforcement &&
      (subtype === 'GOODS' || subtype === 'GENERIC') &&
      isWeakGenericGoodsDelete(deleteProfile)
    ) {
      genericGoodsEnforcements += 1;
    }
    if (isDelete && subtype === 'RECRUITMENT' && isWeakRecruitmentDelete(deleteProfile)) {
      recruitmentDeleteWithoutRisk += 1;
    }
    if (isEnforcement && subtype === 'RECRUITMENT' && isWeakRecruitmentDelete(deleteProfile)) {
      recruitmentEnforcementWithoutRisk += 1;
    }
    if (
      RULES_OR_NEWS_SAFE_BUCKETS.has(safeContextBucket) &&
      (matchedSignals.some((signal) => signal.startsWith('risk:')) ||
        negativeSignals.some((signal) => signal.startsWith('context:')))
    ) {
      riskyRulesOrNewsContext += 1;
    }
  }

  const summary: CommercialAuditSummary = {
    records: records.length,
    labels: toSortedRecord(labels),
    actions: toSortedRecord(actions),
    policyCategories: toSortedRecord(policyCategories),
    subtypes: toSortedRecord(subtypes),
    segments: toSortedRecord(segments),
    safeContextBuckets: toSortedRecord(safeContextBuckets),
    safeContextDeletes: toSortedRecord(safeContextDeletes),
    safeContextEnforcements: toSortedRecord(safeContextEnforcements),
    campaignOnlyDeletes,
    campaignOnlyEnforcements,
    grayDeletes,
    grayEnforcements,
    deleteFalsePositiveCandidates,
    enforcementFalsePositiveCandidates,
    deleteSuppressed,
    genericGoodsDeletes,
    genericGoodsEnforcements,
    recruitmentDeleteWithoutRisk,
    recruitmentEnforcementWithoutRisk,
    riskyRulesOrNewsContext,
    alerts: [],
  };
  summary.alerts = buildCommercialAuditAlerts(summary);
  return summary;
}

function actionRank(action: string | null): number | null {
  switch (action) {
    case 'ALLOW':
    case 'NONE':
      return 0;
    case 'REVIEW_ONLY':
      return 1;
    case 'WARN':
      return 2;
    case 'DELETE':
      return 3;
    case 'DELETE_AND_ESCALATE':
      return 4;
    default:
      return null;
  }
}

function isActionOverExpected(action: string, expectedAction: string | null): boolean {
  const actualRank = actionRank(action);
  const expectedRank = actionRank(expectedAction);
  return (
    actualRank !== null && (expectedRank === null ? actualRank >= 2 : actualRank > expectedRank)
  );
}

export function buildCommercialAuditAlerts(
  summary: Omit<CommercialAuditSummary, 'alerts'>,
): CommercialAuditAlert[] {
  const alerts: CommercialAuditAlert[] = [];
  const add = (code: string, severity: CommercialAuditAlert['severity'], count: number) => {
    if (count > 0) {
      alerts.push({ code, severity, count });
    }
  };

  add('delete_false_positive_candidate', 'critical', summary.deleteFalsePositiveCandidates);
  add(
    'enforcement_false_positive_candidate',
    'critical',
    summary.enforcementFalsePositiveCandidates,
  );
  add('gray_candidate_delete', 'critical', summary.grayDeletes);
  add('gray_candidate_enforcement', 'critical', summary.grayEnforcements);
  add('campaign_only_delete', 'critical', summary.campaignOnlyDeletes);
  add(
    'safe_context_delete',
    'critical',
    Object.values(summary.safeContextDeletes).reduce((sum, value) => sum + value, 0),
  );
  add(
    'safe_context_enforcement',
    'critical',
    Object.values(summary.safeContextEnforcements).reduce((sum, value) => sum + value, 0),
  );
  add('generic_goods_delete', 'warning', summary.genericGoodsDeletes);
  add('generic_goods_enforcement', 'warning', summary.genericGoodsEnforcements);
  add('recruitment_delete_without_risk', 'warning', summary.recruitmentDeleteWithoutRisk);
  add('recruitment_enforcement_without_risk', 'warning', summary.recruitmentEnforcementWithoutRisk);
  add('risky_rules_or_news_context', 'warning', summary.riskyRulesOrNewsContext);

  return alerts;
}

async function readJsonl(pathname: string): Promise<AuditSummaryRecord[]> {
  const payload = await readFile(resolve(pathname), 'utf8');
  const records: AuditSummaryRecord[] = [];
  for (const [index, line] of payload.split(/\r?\n/u).entries()) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`Invalid JSONL at line ${index + 1}: ${String(error)}`);
    }
    const record = asRecord(parsed);
    if (!record) {
      throw new Error(`Invalid commercial audit record at line ${index + 1}`);
    }
    records.push(record);
  }
  return records;
}

function readCliOptions(argv: readonly string[]): CliOptions {
  const inputPath = readStringOption(argv, '--input');
  if (!inputPath) {
    throw new Error('Usage: npm run moderation:commercial-audit-summary -- --input <audit.jsonl>');
  }
  return {
    inputPath,
    outputPath: readStringOption(argv, '--output'),
    alertsPath: readStringOption(argv, '--alerts-output'),
    failOnAlert: argv.includes('--fail-on-alert'),
  };
}

function readStringOption(argv: readonly string[], name: string): string | undefined {
  const index = argv.findIndex((arg) => arg === name);
  if (index < 0) {
    return undefined;
  }
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function readSnapshot(value: unknown): AuditSnapshot {
  return asRecord(value) ?? {};
}

type DeleteProfile = {
  campaignStrength: string | null;
  evidenceTier: string | null;
  reasonCodes: readonly string[];
  matchedSignals: readonly string[];
  featureVector: Record<string, number>;
};

function readDeleteProfile(
  current: AuditSnapshot,
  reasonCodes: readonly string[],
  matchedSignals: readonly string[],
): DeleteProfile {
  return {
    campaignStrength: readString(current.campaignStrength),
    evidenceTier: readString(current.evidenceTier) ?? readString(current.evidenceStrength),
    reasonCodes,
    matchedSignals,
    featureVector: readNumericRecord(current.featureVector),
  };
}

function isWeakGenericGoodsDelete(profile: DeleteProfile): boolean {
  if (hasRiskEvidence(profile)) {
    return false;
  }
  const hasDirectEvidence =
    profile.evidenceTier === 'DIRECT' || profile.reasonCodes.includes('evidence:action-direct');
  const hasDealContact =
    numericFeature(profile, 'dealEvidence') > 0 && numericFeature(profile, 'contactEvidence') > 0;
  const hasDistributionOrBusiness =
    isStandardOrStrongCampaign(profile.campaignStrength) ||
    numericFeature(profile, 'massDistribution') > 0 ||
    numericFeature(profile, 'businessContext') > 0;
  const hasPriceOrLink =
    numericFeature(profile, 'priceStructure') > 0 ||
    profile.matchedSignals.some((signal) => signal.startsWith('deal-channel:'));
  return !(hasDirectEvidence && hasDealContact && hasDistributionOrBusiness && hasPriceOrLink);
}

function isWeakRecruitmentDelete(profile: DeleteProfile): boolean {
  if (hasRiskEvidence(profile)) {
    return false;
  }
  const hasDirectEvidence =
    profile.evidenceTier === 'DIRECT' || profile.reasonCodes.includes('evidence:action-direct');
  const hasDealContact =
    numericFeature(profile, 'dealEvidence') > 0 && numericFeature(profile, 'contactEvidence') > 0;
  const hasRecruitmentSignal = profile.matchedSignals.some((signal) =>
    signal.startsWith('recruitment:'),
  );
  const hasConditions =
    numericFeature(profile, 'priceStructure') > 0 ||
    profile.reasonCodes.some((reason) => reason.startsWith('evidence:direct:'));
  return !(hasDirectEvidence && hasDealContact && hasRecruitmentSignal && hasConditions);
}

function hasRiskEvidence(profile: DeleteProfile): boolean {
  return (
    profile.reasonCodes.includes('risk:escalation-grade') ||
    profile.matchedSignals.some((signal) => signal.startsWith('risk:'))
  );
}

function isStandardOrStrongCampaign(campaignStrength: string | null): boolean {
  return campaignStrength === 'STANDARD' || campaignStrength === 'STRONG';
}

function numericFeature(profile: DeleteProfile, key: string): number {
  return profile.featureVector[key] ?? 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readBoolean(value: unknown): boolean {
  return value === true;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function readNumericRecord(value: unknown): Record<string, number> {
  const record = asRecord(value);
  if (!record) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(record).flatMap(([key, item]) =>
      typeof item === 'number' && Number.isFinite(item) ? [[key, item]] : [],
    ),
  );
}

function pushCount(map: Map<string, number>, key: string) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function toSortedRecord(map: Map<string, number>): Record<string, number> {
  return Object.fromEntries(
    [...map.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])),
  );
}

async function writeJson(pathname: string, value: unknown): Promise<void> {
  await mkdir(dirname(pathname), { recursive: true });
  await writeFile(pathname, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function main() {
  const options = readCliOptions(process.argv.slice(2));
  const records = await readJsonl(options.inputPath);
  const summary = summarizeCommercialAuditRecords(records);
  const payload = JSON.stringify(summary, null, 2);

  if (options.outputPath) {
    await writeJson(options.outputPath, summary);
  } else {
    console.log(payload);
  }
  if (options.alertsPath) {
    await writeJson(options.alertsPath, summary.alerts);
  }
  if (options.failOnAlert && summary.alerts.length > 0) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
