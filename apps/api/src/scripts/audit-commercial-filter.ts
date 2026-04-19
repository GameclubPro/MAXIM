import type { MaxUpdate } from '@maxim/contracts';
import { Prisma, PrismaClient, type ChatSettings } from '@prisma/client';
import { config as loadEnv } from 'dotenv';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { InMemoryCommercialCampaignTracker } from '../moderation/commercial-campaign.util';
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
  limit: number;
  sample: number;
  chatId?: string;
  exportJsonlPath?: string;
  includeStableHits: boolean;
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

type AuditSegment =
  | 'CHANNEL_PLACEMENT'
  | 'PROPERTY'
  | 'RECRUITMENT'
  | 'INFO_PRODUCT'
  | 'GOODS'
  | 'SERVICES'
  | 'OTHER';

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
};

type AuditRecord = {
  category: AuditCategory;
  segment: AuditSegment;
  createdAt: Date;
  webhookEventId: string;
  chatId: string;
  chatTitle: string | null;
  chatEntityType: string | null;
  messageId: string;
  senderId: string | null;
  text: string;
  historical: CommercialSnapshot;
  current: CommercialSnapshot;
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

function readCliOptions(argv: readonly string[]): CliOptions {
  const args = [...argv];
  const now = new Date();
  const since =
    readDateOption(args, '--since') ??
    new Date(now.getTime() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const until = readDateOption(args, '--until') ?? now;
  const limit = readPositiveIntOption(args, '--limit') ?? DEFAULT_LIMIT;
  const sample = readPositiveIntOption(args, '--sample') ?? DEFAULT_SAMPLE;
  const chatId = readStringOption(args, '--chat-id');
  const exportJsonlPath = readStringOption(args, '--export-jsonl');
  const includeStableHits = args.includes('--include-stable-hits');

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
    includeStableHits,
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

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function readStringOption(args: readonly string[], name: string): string | undefined {
  const index = args.findIndex((arg) => arg === name);
  if (index < 0) {
    return undefined;
  }

  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }

  return value.trim() || undefined;
}

async function loadCandidates(
  prisma: PrismaClient,
  options: CliOptions,
): Promise<AuditCandidateRow[]> {
  const chatFilterSql = options.chatId ? Prisma.sql`and c.id = ${options.chatId}` : Prisma.sql``;

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
      limit ${options.limit}
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
  };
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
        segment: record.segment,
        createdAt: record.createdAt.toISOString(),
        webhookEventId: record.webhookEventId,
        chatId: record.chatId,
        chatTitle: record.chatTitle,
        chatEntityType: record.chatEntityType,
        messageId: record.messageId,
        senderId: record.senderId,
        text: record.text,
        historical: record.historical,
        current: record.current,
      }),
    )
    .join('\n');
  await writeFile(pathname, `${payload}\n`, 'utf8');
}

async function main() {
  const options = readCliOptions(process.argv.slice(2));
  const prisma = new PrismaClient();
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
    const segmentCounts = new Map<`${AuditCategory}:${AuditSegment}`, number>();
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
        `limit=${options.limit}`,
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

      pushCount(categoryCounts, category);
      pushCount(segmentCounts, `${category}:${segment}`);
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
        segment,
        createdAt: row.createdAt,
        webhookEventId: row.webhookEventId,
        chatId: row.chatId,
        chatTitle: row.chatTitle,
        chatEntityType: row.chatEntityType,
        messageId: row.messageId,
        senderId,
        text,
        historical,
        current,
      });

      if ((index + 1) % PROGRESS_EVERY === 0) {
        console.log(`processed=${index + 1}/${orderedCandidates.length}`);
      }
    }

    auditedRecords.sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());

    const mismatches = auditedRecords.filter(
      (record) => record.category === 'historical_only' || record.category === 'current_only',
    );
    const exportable = options.includeStableHits
      ? auditedRecords.filter((record) => record.category !== 'stable_clear')
      : mismatches;

    console.log('');
    console.log('Summary');
    console.log(`evaluated=${auditedRecords.length}`);
    console.log(`skipped=${[...skipCounts.values()].reduce((sum, value) => sum + value, 0)}`);
    console.log(`skip_breakdown=${formatCounts(skipCounts) || 'none'}`);
    console.log(`category_breakdown=${formatCounts(categoryCounts) || 'none'}`);
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
          ].join(' '),
        );
        console.log(`  text=${makeExcerpt(record.text)}`);
        console.log(
          `  historical score=${record.historical.score ?? 'n/a'} subtype=${record.historical.primarySubtype ?? 'n/a'} review=${record.historical.reviewRecommended ? 'yes' : 'no'} signals=${formatSignals(record.historical.matchedSignals)}`,
        );
        console.log(
          `  current confidence=${record.current.confidenceScore ?? 'n/a'} band=${record.current.decisionBand ?? 'n/a'} subtype=${record.current.primarySubtype ?? 'n/a'} review=${record.current.reviewRecommended ? 'yes' : 'no'} evidence=${record.current.evidenceStrength ?? 'n/a'} signals=${formatSignals(record.current.matchedSignals)}`,
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
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(message);
  process.exitCode = 1;
});
