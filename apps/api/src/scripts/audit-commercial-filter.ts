import type { MaxUpdate } from '@maxim/contracts';
import {
  createPrismaClient,
  Prisma,
  PrismaClient,
  type ChatSettings,
} from '../prisma/prisma-client';
import { config as loadEnv } from 'dotenv';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  InMemoryCommercialCampaignTracker,
  type CommercialCampaignContext,
} from '../moderation/commercial-campaign.util';
import { COMMERCIAL_HARD_NEGATIVE_REASON_PREFIXES } from '../moderation/commercial/commercial-suppressors';
import { RuleEngineService, type RuleViolation } from '../moderation/rule-engine.service';

const DEFAULT_LOOKBACK_DAYS = 7;
const DEFAULT_LIMIT = 1500;
const DEFAULT_SAMPLE = 6;
const PROGRESS_EVERY = 250;

loadEnv({ quiet: true });
loadEnv({ path: resolve(__dirname, '../../../../.env'), override: false, quiet: true });

type CliOptions = {
  since: Date;
  until: Date;
  limit: number | null;
  sample: number;
  chatId?: string;
  exportJsonlPath?: string;
  exportCorpusJsonlPath?: string;
  includeStableHits: boolean;
  exportAllCorpus: boolean;
};

type AuditCandidateRow = {
  webhookEventId: string;
  createdAt: Date;
  botId: string | null;
  chatId: string;
  chatTitle: string | null;
  chatEntityType: string | null;
  messageId: string;
  senderId: string | null;
  text: string;
  normalizedPayload: Prisma.JsonValue;
  historicalEventId: string | null;
  historicalScore: number | null;
  historicalMetadata: Prisma.JsonValue | null;
  hasHistoricalCommercialEvent: boolean;
};

type ChatContext = {
  settings: ChatSettings;
  domainAllowlist: string[];
  adminUserIds: Set<string>;
  botIdVariants: Set<string>;
};

type AuditSkipReason =
  | 'missing-chat-context'
  | 'missing-sender'
  | 'membership'
  | 'service-authored'
  | 'bot-authored'
  | 'own-bot'
  | 'local-admin';

type AuditCategory = 'stable_hit' | 'historical_only' | 'current_only' | 'stable_clear';
type AuditPolicyCategory =
  | 'hard_delete'
  | 'gray_zone'
  | 'campaign_only'
  | 'false_positive_candidate'
  | 'false_negative_candidate'
  | 'none';

type AuditSegment =
  | 'CHANNEL_PLACEMENT'
  | 'PROPERTY'
  | 'RECRUITMENT'
  | 'INFO_PRODUCT'
  | 'GOODS'
  | 'SERVICES'
  | 'OTHER';

type AuditSafeContextBucket =
  | 'rules_or_moderation_context'
  | 'spam_complaint_or_fraud_warning'
  | 'news_or_analytics'
  | 'brand_mention_only'
  | 'private_one_off_sale'
  | 'ordinary_recruitment'
  | 'public_training_or_help'
  | 'request_or_recommendation'
  | 'none';

type AuditCorpusLabel =
  | 'positive_candidate'
  | 'negative_candidate'
  | 'gray_candidate'
  | 'unlabeled';

type AuditCorpusLabelSource = 'commercial-audit-policy-v1' | null;

type AuditCorpusSettings = Pick<
  ChatSettings,
  'commercialAdsSensitivity' | 'commercialAdsWarnThreshold' | 'commercialAdsDeleteThreshold'
>;

type CommercialSnapshot = {
  hit: boolean;
  score: number | null;
  confidenceScore: number | null;
  decisionBand: string | null;
  primarySubtype: string | null;
  supportingSubtypes: string[];
  evidenceStrength: string | null;
  classifierVersion: string | null;
  commercialProbability: number | null;
  reviewProbability: number | null;
  classifierReasons: string[];
  reviewRecommended: boolean;
  reviewReasons: string[];
  matchedSignals: string[];
  negativeSignals: string[];
  decisionVersion: string | null;
  fpRisk: number | null;
  evidenceTier: string | null;
  subtype: string | null;
  actionBand: string | null;
  reasonCodes: string[];
  featureVector: Record<string, number>;
};

type AuditRecord = {
  category: AuditCategory;
  policyCategory: AuditPolicyCategory;
  segment: AuditSegment;
  safeContextBucket: AuditSafeContextBucket;
  label: AuditCorpusLabel;
  labelSource: AuditCorpusLabelSource;
  expectedAction: string | null;
  expectedSubtype: string | null;
  isHardNegative: boolean;
  createdAt: Date;
  webhookEventId: string;
  chatId: string;
  chatTitle: string | null;
  chatEntityType: string | null;
  messageId: string;
  senderId: string | null;
  text: string;
  sanitizedText: string;
  historical: CommercialSnapshot;
  current: CommercialSnapshot;
  settings: AuditCorpusSettings;
  commercialCampaignContext: CommercialCampaignContext | null;
};

const NOOP_REDIS_COUNTER = {
  async incrementWithTtl(): Promise<number> {
    return 0;
  },
} as const;

const CHANNEL_SEGMENT_PATTERNS = [
  /(?:^|[^\p{L}\p{N}_-])канал(?:ы|а|у|е|ом|ов|ам|ами|ах)?(?=$|[^\p{L}\p{N}_-])/iu,
  /(?:^|[^\p{L}\p{N}_-])(?:трафик|перелив|вп|max-tracker|er(?:24|48|72)|1\s*\/\s*(?:24|48|72))(?=$|[^\p{L}\p{N}_-])/iu,
  /(?:^|[^\p{L}\p{N}_-])(?:места\s+на\s+завтра|цена\s+за\s+пост|активная\s+аудитория)(?=$|[^\p{L}\p{N}_-])/iu,
] as const;

const PROPERTY_SEGMENT_PATTERNS = [
  /(?:^|[^\p{L}\p{N}_-])(?:квартир|студи|дом|участ|ижс|днт|снт|жк|этаж|ипотек|обремен|дкп)(?=[\p{L}\p{N}_-]|$)/iu,
  /(?:^|[^\p{L}\p{N}_-])(?:комисси|ключах|показ(?:\s|$)|евро\s*\d+\s*к|\d+\s*к\.?\s*кв\.?)(?=[\p{L}\p{N}_-]|$)/iu,
] as const;

const RECRUITMENT_SEGMENT_PATTERNS = [
  /(?:^|[^\p{L}\p{N}_-])(?:ваканси|работ|подработ|смен|вахт|требу(?:ется|ются)?)(?=[\p{L}\p{N}_-]|$)/iu,
] as const;

const INFO_PRODUCT_SEGMENT_PATTERNS = [
  /(?:^|[^\p{L}\p{N}_-])(?:курс|вебинар|марафон|обучен|наставнич|разбор|созвон|урок)(?=[\p{L}\p{N}_-]|$)/iu,
] as const;

const RULES_OR_MODERATION_CONTEXT_PATTERNS = [
  /(?:^|[^\p{L}\p{N}_-])(?:реклам[\p{L}\p{N}_-]*|объявлен[\p{L}\p{N}_-]*|ссылк[\p{L}\p{N}_-]*|спам[\p{L}\p{N}_-]*)(?:[\p{L}\p{N}\s.,:;!?'"«»()/%+-]{0,80})(?:запрещ[её]н[\p{L}\p{N}_-]*|нельзя|удал[яи][\p{L}\p{N}_-]*|бан[\p{L}\p{N}_-]*|мут[\p{L}\p{N}_-]*|модерац[\p{L}\p{N}_-]*|модератор[\p{L}\p{N}_-]*|админ[\p{L}\p{N}_-]*|фильтр[\p{L}\p{N}_-]*)/iu,
  /(?:^|[^\p{L}\p{N}_-])(?:запрещ[её]н[\p{L}\p{N}_-]*|нельзя|удал[яи][\p{L}\p{N}_-]*|бан[\p{L}\p{N}_-]*|мут[\p{L}\p{N}_-]*|модерац[\p{L}\p{N}_-]*|модератор[\p{L}\p{N}_-]*|админ[\p{L}\p{N}_-]*|фильтр[\p{L}\p{N}_-]*)(?:[\p{L}\p{N}\s.,:;!?'"«»()/%+-]{0,80})(?:реклам[\p{L}\p{N}_-]*|объявлен[\p{L}\p{N}_-]*|ссылк[\p{L}\p{N}_-]*|спам[\p{L}\p{N}_-]*)/iu,
  /(?:^|[^\p{L}\p{N}_-])(?:пример|образец|цитат[\p{L}\p{N}_-]*)(?:[\p{L}\p{N}\s.,:;!?'"«»()/%+-]{0,60})(?:реклам[\p{L}\p{N}_-]*|объявлен[\p{L}\p{N}_-]*|спам[\p{L}\p{N}_-]*)/iu,
  /(?:^|[^\p{L}\p{N}_-])(?:бот|фильтр[\p{L}\p{N}_-]*)(?:[\p{L}\p{N}\s.,:;!?'"«»()/%+-]{0,60})(?:удал[яи][\p{L}\p{N}_-]*|бан[\p{L}\p{N}_-]*|мут[\p{L}\p{N}_-]*|блокир[\p{L}\p{N}_-]*|фильтру[\p{L}\p{N}_-]*)(?:[\p{L}\p{N}\s.,:;!?'"«»()/%+-]{0,60})(?:реклам[\p{L}\p{N}_-]*|объявлен[\p{L}\p{N}_-]*|ссылк[\p{L}\p{N}_-]*|спам[\p{L}\p{N}_-]*)?/iu,
] as const;

export function readCliOptions(argv: readonly string[]): CliOptions {
  const args = [...argv];
  const now = new Date();
  const since =
    readDateOption(args, '--since') ??
    new Date(now.getTime() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const until = readDateOption(args, '--until') ?? now;
  const parsedLimit = readLimitOption(args, '--limit');
  const limit = parsedLimit === undefined ? DEFAULT_LIMIT : parsedLimit;
  const sample = readPositiveIntOption(args, '--sample') ?? DEFAULT_SAMPLE;
  const chatId = readStringOption(args, '--chat-id');
  const exportJsonlPath = readStringOption(args, '--export-jsonl');
  const exportCorpusJsonlPath = readStringOption(args, '--export-corpus-jsonl');
  const includeStableHits = args.includes('--include-stable-hits');
  const exportAllCorpus = args.includes('--export-all-corpus');

  if (since.getTime() > until.getTime()) {
    throw new Error('--since must be earlier than or equal to --until');
  }

  return {
    since,
    until,
    limit,
    sample,
    ...(chatId ? { chatId } : {}),
    ...(exportJsonlPath ? { exportJsonlPath } : {}),
    ...(exportCorpusJsonlPath ? { exportCorpusJsonlPath } : {}),
    includeStableHits,
    exportAllCorpus,
  };
}

function readDateOption(args: readonly string[], name: string): Date | undefined {
  const value = readStringOption(args, name);
  if (!value) {
    return undefined;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${name} must be a valid ISO-8601 date`);
  }

  return parsed;
}

function readPositiveIntOption(args: readonly string[], name: string): number | undefined {
  const value = readStringOption(args, name);
  if (!value) {
    return undefined;
  }

  const parsed = parsePositiveInteger(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function readLimitOption(args: readonly string[], name: string): number | null | undefined {
  const value = readStringOption(args, name);
  if (!value) {
    return undefined;
  }

  if (value.toLowerCase() === 'all') {
    return null;
  }

  const parsed = parsePositiveInteger(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer or "all"`);
  }

  return parsed;
}

function parsePositiveInteger(value: string): number {
  if (!/^\d+$/u.test(value)) {
    return Number.NaN;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : Number.NaN;
}

function readStringOption(args: readonly string[], name: string): string | undefined {
  const index = args.findIndex((arg) => arg === name);
  if (index >= 0) {
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${name} requires a value`);
    }

    return value.trim() || undefined;
  }

  const inlinePrefix = `${name}=`;
  const inlineValue = args.find((arg) => arg.startsWith(inlinePrefix));
  if (!inlineValue) {
    return undefined;
  }

  const value = inlineValue.slice(inlinePrefix.length);
  if (!value) {
    throw new Error(`${name} requires a value`);
  }

  return value.trim() || undefined;
}

async function loadCandidates(
  prisma: PrismaClient,
  options: CliOptions,
): Promise<AuditCandidateRow[]> {
  const chatFilterSql = options.chatId ? Prisma.sql`and c.id = ${options.chatId}` : Prisma.sql``;
  const limitSql = options.limit === null ? Prisma.sql`` : Prisma.sql`limit ${options.limit}`;

  return prisma.$queryRaw<AuditCandidateRow[]>(Prisma.sql`
    with base as (
      select
        w.id as "webhookEventId",
        w.created_at as "createdAt",
        w.bot_id as "botId",
        c.id as "chatId",
        c.title as "chatTitle",
        c.entity_type::text as "chatEntityType",
        w.normalized_payload #>> '{message,messageId}' as "messageId",
        nullif(w.normalized_payload #>> '{message,senderId}', '') as "senderId",
        w.normalized_payload #>> '{message,text}' as "text",
        w.normalized_payload as "normalizedPayload"
      from webhook_events w
      join chats c
        on c.id = w.normalized_payload #>> '{message,chatId}'
      join chat_settings s
        on s.chat_id = c.id
      where w.created_at >= ${options.since}
        and w.created_at <= ${options.until}
        and w.status = 'PROCESSED'
        and w.normalized_payload ->> 'type' = 'message_created'
        and coalesce(w.normalized_payload #>> '{message,text}', '') <> ''
        and coalesce(w.normalized_payload #>> '{message,messageId}', '') <> ''
        and s.commercial_ads_filter_enabled = true
        ${chatFilterSql}
      order by w.created_at desc
      ${limitSql}
    )
    select
      base.*,
      historical.id as "historicalEventId",
      historical.score as "historicalScore",
      historical.metadata as "historicalMetadata",
      (historical.id is not null) as "hasHistoricalCommercialEvent"
    from base
    left join lateral (
      select
        e.id,
        e.score,
        e.metadata
      from moderation_events e
      where e.chat_id = base."chatId"
        and e.message_id = base."messageId"
        and e.rule_code = 'COMMERCIAL_AD'
      order by e.created_at asc
      limit 1
    ) historical on true
    order by base."createdAt" desc
  `);
}

async function loadChatContexts(
  prisma: PrismaClient,
  chatIds: readonly string[],
): Promise<Map<string, ChatContext>> {
  if (chatIds.length === 0) {
    return new Map();
  }

  const rows = await prisma.chat.findMany({
    where: {
      id: {
        in: [...chatIds],
      },
    },
    include: {
      settings: true,
      domains: {
        where: {
          OR: [{ removeAfterAt: null }, { removeAfterAt: { gt: new Date() } }],
        },
        select: {
          domain: true,
        },
      },
      admins: {
        select: {
          userId: true,
        },
      },
      botMemberships: {
        select: {
          botId: true,
        },
      },
    },
  });

  return new Map(
    rows
      .filter((row): row is typeof row & { settings: ChatSettings } => row.settings !== null)
      .map((row) => {
        const botIdVariants = new Set<string>();
        for (const botId of [
          row.botId,
          row.primaryBotId,
          ...row.botMemberships.map((item) => item.botId),
        ]) {
          for (const variant of buildIdVariants(botId)) {
            botIdVariants.add(variant);
          }
        }

        return [
          row.id,
          {
            settings: row.settings,
            domainAllowlist: row.domains.map((item) => item.domain),
            adminUserIds: new Set(
              row.admins.map((item) => item.userId.trim()).filter((item) => item.length > 0),
            ),
            botIdVariants,
          },
        ] satisfies [string, ChatContext];
      }),
  );
}

function buildIdVariants(value: string | null | undefined): Set<string> {
  if (typeof value !== 'string') {
    return new Set<string>();
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return new Set<string>();
  }

  const variants = new Set<string>([normalized]);

  if (normalized.startsWith('id') && normalized.length > 2) {
    variants.add(normalized.slice(2));
  }

  if (normalized.endsWith('_bot') && normalized.length > 4) {
    variants.add(normalized.slice(0, -4));
  }

  if (normalized.startsWith('id') && normalized.endsWith('_bot') && normalized.length > 6) {
    variants.add(normalized.slice(2, -4));
  }

  for (const variant of [...variants]) {
    const primary = variant.split('_')[0];
    if (/^\d+$/u.test(primary)) {
      variants.add(primary);
      variants.add(`id${primary}`);
      variants.add(`${primary}_bot`);
      variants.add(`id${primary}_bot`);
    }
  }

  return variants;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readLowerString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
}

function extractSenderEntities(update: MaxUpdate): Array<Record<string, unknown>> {
  const raw = asRecord(update.raw);
  const message = asRecord(raw?.message);

  return [
    asRecord(message?.sender),
    asRecord(message?.from),
    asRecord(raw?.sender),
    asRecord(raw?.from),
  ].filter((item): item is Record<string, unknown> => item !== null);
}

function isBotEntity(node: Record<string, unknown>): boolean {
  const type = readLowerString(node.type) ?? readLowerString(node.kind);
  if (type === 'bot') {
    return true;
  }

  return node.is_bot === true || node.isBot === true || node.bot === true;
}

function isServiceEntity(node: Record<string, unknown>): boolean {
  const type = readLowerString(node.type) ?? readLowerString(node.kind);
  if (type === 'service') {
    return true;
  }

  return node.is_service === true || node.isService === true;
}

function resolveSkipReason(
  row: AuditCandidateRow,
  update: MaxUpdate,
  chatContext: ChatContext | undefined,
): AuditSkipReason | null {
  if (!chatContext) {
    return 'missing-chat-context';
  }

  const senderId = (update.message?.senderId ?? row.senderId ?? '').trim();
  if (!senderId) {
    return 'missing-sender';
  }

  if (update.membership) {
    return 'membership';
  }

  for (const entity of extractSenderEntities(update)) {
    if (isServiceEntity(entity)) {
      return 'service-authored';
    }
    if (isBotEntity(entity)) {
      return 'bot-authored';
    }
  }

  const senderVariants = buildIdVariants(senderId);
  if (
    senderVariants.has(senderId.toLowerCase().trim()) &&
    senderId.toLowerCase().trim().endsWith('_bot')
  ) {
    return 'own-bot';
  }

  for (const variant of senderVariants) {
    if (chatContext.botIdVariants.has(variant)) {
      return 'own-bot';
    }
  }

  if (chatContext.adminUserIds.has(senderId)) {
    return 'local-admin';
  }

  return null;
}

function extractCommercialViolation(violations: readonly RuleViolation[]): RuleViolation | null {
  return violations.find((item) => item.ruleCode === 'COMMERCIAL_AD') ?? null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function readOptionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readOptionalBoolean(value: unknown): boolean {
  return value === true;
}

function snapshotFromViolation(violation: RuleViolation | null): CommercialSnapshot {
  if (!violation) {
    return {
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
  }

  const metadata = asRecord(violation.metadata);
  return {
    hit: true,
    score: Number.isFinite(violation.score) ? violation.score : null,
    confidenceScore: readOptionalNumber(metadata?.confidenceScore),
    decisionBand: readOptionalString(metadata?.decisionBand),
    primarySubtype: readOptionalString(metadata?.primarySubtype),
    supportingSubtypes: readStringArray(metadata?.supportingSubtypes),
    evidenceStrength: readOptionalString(metadata?.evidenceStrength),
    classifierVersion: readOptionalString(metadata?.classifierVersion),
    commercialProbability: readOptionalNumber(metadata?.commercialProbability),
    reviewProbability: readOptionalNumber(metadata?.reviewProbability),
    classifierReasons: readStringArray(metadata?.classifierReasons),
    reviewRecommended: readOptionalBoolean(metadata?.reviewRecommended),
    reviewReasons: readStringArray(metadata?.reviewReasons),
    matchedSignals: readStringArray(metadata?.matchedSignals),
    negativeSignals: readStringArray(metadata?.negativeSignals),
    decisionVersion: readOptionalString(metadata?.decisionVersion),
    fpRisk: readOptionalNumber(metadata?.fpRisk),
    evidenceTier: readOptionalString(metadata?.evidenceTier),
    subtype: readOptionalString(metadata?.subtype),
    actionBand: readOptionalString(metadata?.actionBand),
    reasonCodes: readStringArray(metadata?.reasonCodes),
    featureVector: readNumericRecord(metadata?.featureVector),
  };
}

function snapshotFromHistorical(
  hasHistoricalCommercialEvent: boolean,
  score: number | null,
  metadata: Prisma.JsonValue | null,
): CommercialSnapshot {
  const normalizedMetadata = asRecord(metadata);
  return {
    hit: hasHistoricalCommercialEvent,
    score: typeof score === 'number' && Number.isFinite(score) ? score : null,
    confidenceScore: readOptionalNumber(normalizedMetadata?.confidenceScore),
    decisionBand: readOptionalString(normalizedMetadata?.decisionBand),
    primarySubtype: readOptionalString(normalizedMetadata?.primarySubtype),
    supportingSubtypes: readStringArray(normalizedMetadata?.supportingSubtypes),
    evidenceStrength: readOptionalString(normalizedMetadata?.evidenceStrength),
    classifierVersion: readOptionalString(normalizedMetadata?.classifierVersion),
    commercialProbability: readOptionalNumber(normalizedMetadata?.commercialProbability),
    reviewProbability: readOptionalNumber(normalizedMetadata?.reviewProbability),
    classifierReasons: readStringArray(normalizedMetadata?.classifierReasons),
    reviewRecommended: readOptionalBoolean(normalizedMetadata?.reviewRecommended),
    reviewReasons: readStringArray(normalizedMetadata?.reviewReasons),
    matchedSignals: readStringArray(normalizedMetadata?.matchedSignals),
    negativeSignals: readStringArray(normalizedMetadata?.negativeSignals),
    decisionVersion: readOptionalString(normalizedMetadata?.decisionVersion),
    fpRisk: readOptionalNumber(normalizedMetadata?.fpRisk),
    evidenceTier: readOptionalString(normalizedMetadata?.evidenceTier),
    subtype: readOptionalString(normalizedMetadata?.subtype),
    actionBand: readOptionalString(normalizedMetadata?.actionBand),
    reasonCodes: readStringArray(normalizedMetadata?.reasonCodes),
    featureVector: readNumericRecord(normalizedMetadata?.featureVector),
  };
}

function readNumericRecord(value: unknown): Record<string, number> {
  const record = asRecord(value);
  if (!record) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(record).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === 'number' && Number.isFinite(entry[1]),
    ),
  );
}

function deriveCategory(historicalHit: boolean, currentHit: boolean): AuditCategory {
  if (historicalHit && currentHit) {
    return 'stable_hit';
  }
  if (historicalHit) {
    return 'historical_only';
  }
  if (currentHit) {
    return 'current_only';
  }
  return 'stable_clear';
}

export function derivePolicyCategory(params: {
  category: AuditCategory;
  current: CommercialSnapshot;
}): AuditPolicyCategory {
  const { category, current } = params;
  if (category === 'historical_only') {
    return 'false_negative_candidate';
  }
  if (!current.hit) {
    return 'none';
  }
  if (
    (current.actionBand === 'WARN' || current.actionBand === 'REVIEW_ONLY') &&
    ((current.fpRisk ?? 0) >= 70 || current.reviewRecommended)
  ) {
    return 'gray_zone';
  }
  if ((current.fpRisk ?? 0) >= 70) {
    return 'false_positive_candidate';
  }
  if (
    current.evidenceStrength === 'CAMPAIGN' ||
    current.matchedSignals.some((item) => item.startsWith('campaign:'))
  ) {
    const hasDirectDeal =
      current.matchedSignals.includes('transaction:price') ||
      current.matchedSignals.includes('contact:phone') ||
      current.matchedSignals.some((item) => item.startsWith('deal-channel:'));
    if (!hasDirectDeal) {
      return 'campaign_only';
    }
  }
  if (current.actionBand === 'DELETE' || current.actionBand === 'DELETE_AND_ESCALATE') {
    return 'hard_delete';
  }
  if (
    current.reviewRecommended ||
    current.actionBand === 'WARN' ||
    current.actionBand === 'REVIEW_ONLY'
  ) {
    return 'gray_zone';
  }
  return 'none';
}

function hasHardNegativeSignals(snapshot: CommercialSnapshot): boolean {
  return snapshot.negativeSignals.some((signal) =>
    COMMERCIAL_HARD_NEGATIVE_REASON_PREFIXES.some((prefix) => signal.startsWith(prefix)),
  );
}

function deriveCorpusLabel(params: {
  category: AuditCategory;
  policyCategory: AuditPolicyCategory;
  current: CommercialSnapshot;
  historical: CommercialSnapshot;
}): Pick<
  AuditRecord,
  'label' | 'labelSource' | 'expectedAction' | 'expectedSubtype' | 'isHardNegative'
> {
  const { category, policyCategory, current, historical } = params;
  const currentSubtype = current.primarySubtype ?? current.subtype;
  const historicalSubtype = historical.primarySubtype ?? historical.subtype;
  const hardNegative =
    policyCategory === 'false_positive_candidate' || hasHardNegativeSignals(current);

  if (policyCategory === 'false_positive_candidate' || category === 'stable_clear') {
    return {
      label: 'negative_candidate',
      labelSource: 'commercial-audit-policy-v1',
      expectedAction: 'ALLOW',
      expectedSubtype: null,
      isHardNegative: hardNegative || category === 'stable_clear',
    };
  }

  if (policyCategory === 'false_negative_candidate') {
    return {
      label: 'positive_candidate',
      labelSource: 'commercial-audit-policy-v1',
      expectedAction: historical.actionBand ?? 'WARN',
      expectedSubtype: historicalSubtype,
      isHardNegative: false,
    };
  }

  if (policyCategory === 'gray_zone' || policyCategory === 'campaign_only') {
    return {
      label: 'gray_candidate',
      labelSource: 'commercial-audit-policy-v1',
      expectedAction: current.actionBand ?? 'REVIEW_ONLY',
      expectedSubtype: currentSubtype,
      isHardNegative: hardNegative,
    };
  }

  if (
    policyCategory === 'hard_delete' ||
    category === 'stable_hit' ||
    category === 'current_only'
  ) {
    return {
      label: 'positive_candidate',
      labelSource: 'commercial-audit-policy-v1',
      expectedAction: current.actionBand ?? 'WARN',
      expectedSubtype: currentSubtype,
      isHardNegative: false,
    };
  }

  return {
    label: 'unlabeled',
    labelSource: null,
    expectedAction: null,
    expectedSubtype: currentSubtype ?? historicalSubtype,
    isHardNegative: hardNegative,
  };
}

function mapSubtypeToSegment(subtype: string | null): AuditSegment | null {
  switch (subtype) {
    case 'CHANNEL_PLACEMENT':
    case 'GROUP_PROMOTION':
      return 'CHANNEL_PLACEMENT';
    case 'PROPERTY_AGENT':
    case 'PROPERTY_COMMERCIAL':
      return 'PROPERTY';
    case 'RECRUITMENT':
      return 'RECRUITMENT';
    case 'INFO_PRODUCT':
      return 'INFO_PRODUCT';
    case 'GOODS_RETAIL':
    case 'GOODS':
      return 'GOODS';
    case 'BUYOUT':
    case 'SERVICES':
      return 'SERVICES';
    default:
      return null;
  }
}

function deriveSegment(record: {
  text: string;
  currentSubtype: string | null;
  historicalSubtype: string | null;
  currentSignals: readonly string[];
  historicalSignals: readonly string[];
}): AuditSegment {
  const subtypeSegment = mapSubtypeToSegment(record.currentSubtype ?? record.historicalSubtype);
  if (subtypeSegment) {
    return subtypeSegment;
  }

  const signalText = [...record.currentSignals, ...record.historicalSignals]
    .join(' ')
    .toLowerCase();
  const text = record.text.toLowerCase();
  const combined = `${signalText}\n${text}`;

  if (
    combined.includes('channel-placement:') ||
    combined.includes('group-promo') ||
    CHANNEL_SEGMENT_PATTERNS.some((pattern) => pattern.test(combined))
  ) {
    return 'CHANNEL_PLACEMENT';
  }

  if (
    combined.includes('property-') ||
    PROPERTY_SEGMENT_PATTERNS.some((pattern) => pattern.test(combined))
  ) {
    return 'PROPERTY';
  }

  if (
    combined.includes('recruitment') ||
    combined.includes('job-seeking') ||
    RECRUITMENT_SEGMENT_PATTERNS.some((pattern) => pattern.test(combined))
  ) {
    return 'RECRUITMENT';
  }

  if (
    combined.includes('info-product') ||
    INFO_PRODUCT_SEGMENT_PATTERNS.some((pattern) => pattern.test(combined))
  ) {
    return 'INFO_PRODUCT';
  }

  if (
    combined.includes('service') ||
    combined.includes('business') ||
    combined.includes('deal') ||
    combined.includes('promo')
  ) {
    return 'SERVICES';
  }

  if (
    combined.includes('intent:') ||
    combined.includes('transaction:') ||
    combined.includes('contact:') ||
    combined.includes('group-trade:')
  ) {
    return 'GOODS';
  }

  return 'OTHER';
}

export function deriveSafeContextBucket(params: {
  text: string;
  current: CommercialSnapshot;
  historical: CommercialSnapshot;
}): AuditSafeContextBucket {
  const negativeSignals = [...params.current.negativeSignals, ...params.historical.negativeSignals];
  const text = params.text.toLowerCase();
  const hasCommercialHit = params.current.hit || params.historical.hit;
  const hasSignal = (signal: string): boolean => negativeSignals.includes(signal);
  const hasSignalPrefix = (prefix: string): boolean =>
    negativeSignals.some((signal) => signal.startsWith(prefix));

  if (hasSignal('context:moderation-ad-discussion') || hasSignal('context:quoted-ad-example')) {
    return 'rules_or_moderation_context';
  }

  if (
    !hasCommercialHit &&
    RULES_OR_MODERATION_CONTEXT_PATTERNS.some((pattern) => pattern.test(text))
  ) {
    return 'rules_or_moderation_context';
  }

  if (
    hasSignal('context:public-fraud-warning') ||
    /(?:^|[^\p{L}\p{N}_-])(?:мошенник[\p{L}\p{N}_-]*|спам[\p{L}\p{N}_-]*|спамер[\p{L}\p{N}_-]*|жалоб[\p{L}\p{N}_-]*|полици[\p{L}\p{N}_-]*|мвд|предупрежда(?:ет|ют|ем)|осторожн[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
      text,
    )
  ) {
    return 'spam_complaint_or_fraud_warning';
  }

  if (
    hasSignal('context:local-news-subscribe') ||
    hasSignal('context:channel-metrics-not-selling') ||
    /(?:^|[^\p{L}\p{N}_-])(?:новост[\p{L}\p{N}_-]*|отчет|отч[её]т|аналитик[\p{L}\p{N}_-]*|статистик[\p{L}\p{N}_-]*|обзор|рынк[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
      text,
    )
  ) {
    return 'news_or_analytics';
  }

  if (
    hasSignal('context:official-civic-instruction') ||
    hasSignal('context:public-voting-contest') ||
    /(?:^|[^\p{L}\p{N}_-])(?:администраци[\p{L}\p{N}_-]*|госуслуг[\p{L}\p{N}_-]*|компенсаци[\p{L}\p{N}_-]*|голосовани[\p{L}\p{N}_-]*|обучени[\p{L}\p{N}_-]*\s+бесплатн[\p{L}\p{N}_-]*|центр\s+занятост[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
      text,
    )
  ) {
    return 'public_training_or_help';
  }

  if (hasSignalPrefix('job-seeking:')) {
    return 'ordinary_recruitment';
  }

  if (hasSignalPrefix('search:') || hasSignalPrefix('search-pattern:')) {
    return 'request_or_recommendation';
  }

  if (
    hasSignalPrefix('private:') ||
    hasSignalPrefix('private-single:') ||
    hasSignalPrefix('private-goods:')
  ) {
    return 'private_one_off_sale';
  }

  if (
    /(?:^|[^\p{L}\p{N}_-])(?:отзыв|жалоба|подскажите|посоветуйте|кто\s+знает)(?:[\p{L}\p{N}\s.,:;()/%+-]{0,100})(?:wildberries|wb|вб|ozon|озон|авито|банк|маркетплейс[\p{L}\p{N}_-]*)(?=$|[^\p{L}\p{N}_-])/iu.test(
      text,
    )
  ) {
    return 'brand_mention_only';
  }

  return 'none';
}

function makeExcerpt(text: string, limit = 220): string {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  if (normalized.length <= limit) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function formatSignals(signals: readonly string[]): string {
  if (signals.length === 0) {
    return 'none';
  }

  return signals.slice(0, 6).join(', ');
}

function formatCounts<T extends string>(counts: Map<T, number>): string {
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
}

function pushCount<T extends string>(map: Map<T, number>, key: T) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

async function exportJsonl(pathname: string, records: readonly AuditRecord[]) {
  await mkdir(dirname(pathname), { recursive: true });
  const payload = records
    .map((record) =>
      JSON.stringify({
        category: record.category,
        policyCategory: record.policyCategory,
        segment: record.segment,
        label: record.label,
        labelSource: record.labelSource,
        expectedAction: record.expectedAction,
        expectedSubtype: record.expectedSubtype,
        isHardNegative: record.isHardNegative,
        createdAt: record.createdAt.toISOString(),
        webhookEventId: record.webhookEventId,
        chatId: record.chatId,
        chatTitle: record.chatTitle,
        chatEntityType: record.chatEntityType,
        safeContextBucket: record.safeContextBucket,
        messageId: record.messageId,
        senderId: record.senderId,
        text: record.sanitizedText,
        settings: record.settings,
        commercialCampaignContext: record.commercialCampaignContext,
        historical: record.historical,
        current: record.current,
      }),
    )
    .join('\n');
  await writeFile(pathname, `${payload}\n`, 'utf8');
}

async function exportCorpusJsonl(pathname: string, records: readonly AuditRecord[]) {
  await mkdir(dirname(pathname), { recursive: true });
  const payload = records
    .map((record) =>
      JSON.stringify({
        label: record.label,
        labelSource: record.labelSource,
        expectedAction: record.expectedAction,
        expectedSubtype: record.expectedSubtype,
        isHardNegative: record.isHardNegative,
        category: record.category,
        policyCategory: record.policyCategory,
        segment: record.segment,
        safeContextBucket: record.safeContextBucket,
        text: record.sanitizedText,
        settings: record.settings,
        commercialCampaignContext: record.commercialCampaignContext,
        historical: record.historical,
        current: record.current,
      }),
    )
    .join('\n');
  await writeFile(pathname, `${payload}\n`, 'utf8');
}

function pickAuditCorpusSettings(settings: ChatSettings): AuditCorpusSettings {
  return {
    commercialAdsSensitivity: settings.commercialAdsSensitivity,
    commercialAdsWarnThreshold: settings.commercialAdsWarnThreshold,
    commercialAdsDeleteThreshold: settings.commercialAdsDeleteThreshold,
  };
}

function sanitizeAuditText(value: string): string {
  return value
    .replace(/https?:\/\/\S+/giu, '[url]')
    .replace(
      /\b(?:t\.me|max\.ru|vk\.com|wa\.me|clck\.ru|bit\.ly|goo\.su|tinyurl\.com)\/\S+/giu,
      '[url]',
    )
    .replace(
      /(?:^|[^\d])(?:\+?7|8)[\s‐‑‒–—―-]*\(?\d{3}\)?[\s‐‑‒–—―-]?\d{3}[\s‐‑‒–—―-]?\d{2}[\s‐‑‒–—―-]?\d{2}(?=$|[^\d])/gu,
      ' [phone] ',
    )
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/giu, '[email]')
    .replace(/@[a-z0-9_]{4,32}/giu, '@[handle]')
    .replace(/\s+/gu, ' ')
    .trim();
}

async function main() {
  const options = readCliOptions(process.argv.slice(2));
  const prisma = createPrismaClient();
  const ruleEngine = new RuleEngineService(NOOP_REDIS_COUNTER as never);

  try {
    await prisma.$connect();
    const candidates = await loadCandidates(prisma, options);
    const orderedCandidates = [...candidates].sort(
      (left, right) => left.createdAt.getTime() - right.createdAt.getTime(),
    );
    const chatContexts = await loadChatContexts(
      prisma,
      Array.from(new Set(candidates.map((item) => item.chatId))),
    );
    const campaignTracker = new InMemoryCommercialCampaignTracker();

    const skipCounts = new Map<AuditSkipReason, number>();
    const categoryCounts = new Map<AuditCategory, number>();
    const policyCategoryCounts = new Map<AuditPolicyCategory, number>();
    const corpusLabelCounts = new Map<AuditCorpusLabel, number>();
    const segmentCounts = new Map<`${AuditCategory}:${AuditSegment}`, number>();
    const safeContextBucketCounts = new Map<AuditSafeContextBucket, number>();
    const currentSignalCounts = new Map<string, number>();
    const currentSubtypeCounts = new Map<string, number>();
    const currentReviewReasonCounts = new Map<string, number>();
    const currentClassifierReasonCounts = new Map<string, number>();
    const currentClassifierVersionCounts = new Map<string, number>();
    let currentReviewRecommendedCount = 0;
    const auditedRecords: AuditRecord[] = [];

    console.log(
      [
        'COMMERCIAL_AD audit started',
        `window=${options.since.toISOString()}..${options.until.toISOString()}`,
        `limit=${options.limit === null ? 'all' : options.limit}`,
        `sample=${options.sample}`,
        `chatId=${options.chatId ?? 'ALL'}`,
        `candidates=${candidates.length}`,
      ].join(' '),
    );

    for (const [index, row] of orderedCandidates.entries()) {
      const update = row.normalizedPayload as MaxUpdate;
      const chatContext = chatContexts.get(row.chatId);
      const skipReason = resolveSkipReason(row, update, chatContext);
      if (skipReason) {
        pushCount(skipCounts, skipReason);
        continue;
      }
      if (!chatContext) {
        pushCount(skipCounts, 'missing-chat-context');
        continue;
      }

      const senderId = (update.message?.senderId ?? row.senderId ?? '').trim();
      const text = typeof update.message?.text === 'string' ? update.message.text : row.text;
      const commercialCampaignContext = campaignTracker.track({
        createdAt: row.createdAt,
        chatId: row.chatId,
        senderId,
        text,
      });
      const detection = await ruleEngine.detect({
        chatId: row.chatId,
        userId: senderId,
        text,
        settings: chatContext.settings,
        domainAllowlist: chatContext.domainAllowlist,
        effectiveLength: text.length,
        skipDuplicateState: true,
        commercialCampaignContext,
      });

      const current = snapshotFromViolation(extractCommercialViolation(detection.violations));
      const historical = snapshotFromHistorical(
        row.hasHistoricalCommercialEvent,
        row.historicalScore,
        row.historicalMetadata,
      );
      const category = deriveCategory(historical.hit, current.hit);
      const segment = deriveSegment({
        text,
        currentSubtype: current.primarySubtype,
        historicalSubtype: historical.primarySubtype,
        currentSignals: current.matchedSignals,
        historicalSignals: historical.matchedSignals,
      });
      const safeContextBucket = deriveSafeContextBucket({ text, current, historical });
      const policyCategory = derivePolicyCategory({ category, current });
      const corpusLabel = deriveCorpusLabel({ category, policyCategory, current, historical });
      const sanitizedText = sanitizeAuditText(text);

      pushCount(categoryCounts, category);
      pushCount(policyCategoryCounts, policyCategory);
      pushCount(corpusLabelCounts, corpusLabel.label);
      pushCount(segmentCounts, `${category}:${segment}`);
      pushCount(safeContextBucketCounts, safeContextBucket);
      for (const signal of current.matchedSignals) {
        pushCount(currentSignalCounts, signal);
      }
      if (current.primarySubtype) {
        pushCount(currentSubtypeCounts, current.primarySubtype);
      }
      if (current.classifierVersion) {
        pushCount(currentClassifierVersionCounts, current.classifierVersion);
      }
      if (current.reviewRecommended) {
        currentReviewRecommendedCount += 1;
      }
      for (const reason of current.reviewReasons) {
        pushCount(currentReviewReasonCounts, reason);
      }
      for (const reason of current.classifierReasons) {
        pushCount(currentClassifierReasonCounts, reason);
      }

      auditedRecords.push({
        category,
        policyCategory,
        segment,
        safeContextBucket,
        ...corpusLabel,
        createdAt: row.createdAt,
        webhookEventId: row.webhookEventId,
        chatId: row.chatId,
        chatTitle: row.chatTitle,
        chatEntityType: row.chatEntityType,
        messageId: row.messageId,
        senderId,
        text,
        sanitizedText,
        historical,
        current,
        settings: pickAuditCorpusSettings(chatContext.settings),
        commercialCampaignContext,
      });

      if ((index + 1) % PROGRESS_EVERY === 0) {
        console.log(`processed=${index + 1}/${orderedCandidates.length}`);
      }
    }

    auditedRecords.sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());

    const mismatches = auditedRecords.filter(
      (record) => record.category === 'historical_only' || record.category === 'current_only',
    );
    const policyRelevant = auditedRecords.filter((record) => record.policyCategory !== 'none');
    const exportable = options.exportAllCorpus
      ? auditedRecords
      : options.includeStableHits
        ? auditedRecords.filter((record) => record.category !== 'stable_clear')
        : [
            ...new Map(
              [...mismatches, ...policyRelevant].map((record) => [record.webhookEventId, record]),
            ).values(),
          ];
    const deleteFalsePositiveCandidates = auditedRecords.filter(
      (record) =>
        record.label === 'negative_candidate' &&
        (record.current.actionBand === 'DELETE' ||
          record.current.actionBand === 'DELETE_AND_ESCALATE'),
    ).length;
    const grayDeleteCandidates = auditedRecords.filter(
      (record) =>
        record.label === 'gray_candidate' &&
        (record.current.actionBand === 'DELETE' ||
          record.current.actionBand === 'DELETE_AND_ESCALATE'),
    ).length;
    const campaignOnlyDeleteCandidates = auditedRecords.filter(
      (record) =>
        record.policyCategory === 'campaign_only' &&
        (record.current.actionBand === 'DELETE' ||
          record.current.actionBand === 'DELETE_AND_ESCALATE'),
    ).length;

    console.log('');
    console.log('Summary');
    console.log(`evaluated=${auditedRecords.length}`);
    console.log(`skipped=${[...skipCounts.values()].reduce((sum, value) => sum + value, 0)}`);
    console.log(`skip_breakdown=${formatCounts(skipCounts) || 'none'}`);
    console.log(`category_breakdown=${formatCounts(categoryCounts) || 'none'}`);
    console.log(`policy_category_breakdown=${formatCounts(policyCategoryCounts) || 'none'}`);
    console.log(`corpus_label_breakdown=${formatCounts(corpusLabelCounts) || 'none'}`);
    console.log(`safe_context_bucket_breakdown=${formatCounts(safeContextBucketCounts) || 'none'}`);
    console.log(
      `historical_only_segments=${
        formatCounts(
          new Map(
            [...segmentCounts.entries()]
              .filter(([key]) => key.startsWith('historical_only:'))
              .map(([key, value]) => [key.slice('historical_only:'.length) as AuditSegment, value]),
          ),
        ) || 'none'
      }`,
    );
    console.log(
      `current_only_segments=${
        formatCounts(
          new Map(
            [...segmentCounts.entries()]
              .filter(([key]) => key.startsWith('current_only:'))
              .map(([key, value]) => [key.slice('current_only:'.length) as AuditSegment, value]),
          ),
        ) || 'none'
      }`,
    );
    console.log(
      `top_current_signals=${
        formatCounts(
          new Map([...currentSignalCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)),
        ) || 'none'
      }`,
    );
    console.log(
      `current_primary_subtypes=${
        formatCounts(
          new Map([...currentSubtypeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)),
        ) || 'none'
      }`,
    );
    console.log(
      `current_classifier_versions=${
        formatCounts(
          new Map(
            [...currentClassifierVersionCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
          ),
        ) || 'none'
      }`,
    );
    console.log(`current_review_recommended=${currentReviewRecommendedCount}`);
    console.log(`delete_false_positive_candidates=${deleteFalsePositiveCandidates}`);
    console.log(`gray_delete_candidates=${grayDeleteCandidates}`);
    console.log(`campaign_only_delete_candidates=${campaignOnlyDeleteCandidates}`);
    console.log(
      `current_review_reasons=${
        formatCounts(
          new Map(
            [...currentReviewReasonCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10),
          ),
        ) || 'none'
      }`,
    );
    console.log(
      `current_classifier_reasons=${
        formatCounts(
          new Map(
            [...currentClassifierReasonCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10),
          ),
        ) || 'none'
      }`,
    );

    const categoriesToPrint: AuditCategory[] = ['historical_only', 'current_only', 'stable_hit'];
    for (const category of categoriesToPrint) {
      if (category === 'stable_hit' && !options.includeStableHits) {
        continue;
      }

      const rows = auditedRecords
        .filter((record) => record.category === category)
        .slice(0, options.sample);
      if (rows.length === 0) {
        continue;
      }

      console.log('');
      console.log(category);
      for (const record of rows) {
        console.log(
          [
            `- ${record.createdAt.toISOString()}`,
            `chat=${record.chatTitle ?? record.chatId}`,
            `chatId=${record.chatId}`,
            `messageId=${record.messageId}`,
            `senderId=${record.senderId ?? 'unknown'}`,
            `segment=${record.segment}`,
            `safeContext=${record.safeContextBucket}`,
            `policy=${record.policyCategory}`,
            `label=${record.label}`,
            `expectedAction=${record.expectedAction ?? 'n/a'}`,
            `expectedSubtype=${record.expectedSubtype ?? 'n/a'}`,
          ].join(' '),
        );
        console.log(`  text=${makeExcerpt(record.text)}`);
        console.log(
          `  historical score=${record.historical.score ?? 'n/a'} subtype=${record.historical.primarySubtype ?? 'n/a'} review=${record.historical.reviewRecommended ? 'yes' : 'no'} signals=${formatSignals(record.historical.matchedSignals)}`,
        );
        console.log(
          `  current confidence=${record.current.confidenceScore ?? 'n/a'} band=${record.current.decisionBand ?? 'n/a'} action=${record.current.actionBand ?? 'n/a'} fpRisk=${record.current.fpRisk ?? 'n/a'} subtype=${record.current.primarySubtype ?? 'n/a'} review=${record.current.reviewRecommended ? 'yes' : 'no'} evidence=${record.current.evidenceTier ?? record.current.evidenceStrength ?? 'n/a'} signals=${formatSignals(record.current.matchedSignals)}`,
        );
        if (record.current.classifierVersion) {
          console.log(
            `  classifier version=${record.current.classifierVersion} commercial=${record.current.commercialProbability ?? 'n/a'} review=${record.current.reviewProbability ?? 'n/a'} reasons=${formatSignals(record.current.classifierReasons)}`,
          );
        }
        if (record.current.reviewReasons.length > 0) {
          console.log(`  current_review_reasons=${formatSignals(record.current.reviewReasons)}`);
        }
      }
    }

    if (options.exportJsonlPath) {
      await exportJsonl(options.exportJsonlPath, exportable);
      console.log('');
      console.log(`exported=${exportable.length} path=${options.exportJsonlPath}`);
    }
    if (options.exportCorpusJsonlPath) {
      await exportCorpusJsonl(options.exportCorpusJsonlPath, exportable);
      console.log('');
      console.log(`exported_corpus=${exportable.length} path=${options.exportCorpusJsonlPath}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
