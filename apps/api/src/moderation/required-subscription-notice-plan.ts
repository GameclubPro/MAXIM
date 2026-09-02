import { createHash } from 'node:crypto';

import { UnrecoverableError } from 'bullmq';
import { normalizeDeleteBotMessagesDelayMinutes } from '@maxim/contracts';
import type { BotSpeechMediaFieldKey } from '@maxim/contracts/bot-speech';

import { EventType, Operator, Prisma, SanctionAction } from '../prisma/prisma-client';
import { renderSupportedMarkdownAsHtml } from '../common/max-markdown.util';
import type { MaxSendMessageOptions } from '../max/max-client.service';
import { withModerationReleaseButton } from './moderation-release-callback.util';
import { REQUIRED_SUBSCRIPTION_RULE_CODE } from './moderation.service.support';

export type RequiredSubscriptionNoticeAction = Extract<
  SanctionAction,
  'NONE' | 'WARN' | 'MUTE' | 'BAN'
>;

export type RequiredSubscriptionNoticePlan = {
  version: 1;
  action: RequiredSubscriptionNoticeAction;
  renderedText: string;
  messageOptions: MaxSendMessageOptions;
  mediaFieldKey: BotSpeechMediaFieldKey | null;
  deleteBotMessagesEnabled: boolean;
  deleteBotMessagesDelayMinutes: number;
};

export type RequiredSubscriptionPersistedDecision = {
  action: RequiredSubscriptionNoticeAction;
  eventId: string | null;
  violationCount24h: number | null;
};

export const REQUIRED_SUBSCRIPTION_NOTICE_PLAN_VERSION = 1 as const;
export const REQUIRED_SUBSCRIPTION_NOTICE_PLAN_RULE_CODE = 'REQUIRED_SUBSCRIPTION_NOTICE_PLAN';
export const REQUIRED_SUBSCRIPTION_NOTICE_PLAN_MAX_BYTES = 64 * 1_024;

const REQUIRED_SUBSCRIPTION_NOTICE_PLAN_TEST_CACHE_MAX = 1_000;
const REQUIRED_SUBSCRIPTION_NOTICE_MEDIA_FIELD_KEYS = new Set<BotSpeechMediaFieldKey>([
  'requiredSubscriptionBotMessageText',
  'requiredSubscriptionWarnMessageText',
]);

type RequiredSubscriptionNoticePlanModel = {
  findUnique?: (args: {
    where: { id: string };
    select: { metadata: true };
  }) => Promise<{ metadata: unknown } | null>;
  findFirst?: (args: Record<string, unknown>) => Promise<{
    id?: unknown;
    action?: unknown;
    metadata?: unknown;
  } | null>;
  upsert?: (args: {
    where: { id: string };
    create: Prisma.ModerationEventUncheckedCreateInput;
    update: Record<string, never>;
    select: { metadata: true };
  }) => Promise<{ metadata: unknown }>;
};

export async function buildRequiredSubscriptionNoticePlan(params: {
  action: RequiredSubscriptionNoticeAction;
  baseMessageOptions?: MaxSendMessageOptions;
  sanctionEventId: string | null;
  deleteBotMessagesEnabled: boolean;
  deleteBotMessagesDelayMinutes: number;
  copy: {
    explanation: () => Promise<string>;
    warning: () => Promise<string>;
    mute: () => string;
    ban: () => string;
  };
}): Promise<RequiredSubscriptionNoticePlan> {
  let noticeMarkdown: string;
  let mediaFieldKey: BotSpeechMediaFieldKey | null = null;

  if (params.action === SanctionAction.WARN) {
    noticeMarkdown = await params.copy.warning();
    mediaFieldKey = 'requiredSubscriptionWarnMessageText';
  } else if (params.action === SanctionAction.MUTE) {
    noticeMarkdown = params.copy.mute();
  } else if (params.action === SanctionAction.BAN) {
    noticeMarkdown = params.copy.ban();
  } else {
    noticeMarkdown = await params.copy.explanation();
    mediaFieldKey = 'requiredSubscriptionBotMessageText';
  }

  let messageOptions = withRequiredSubscriptionHtmlMessageOptions(params.baseMessageOptions);
  if (params.sanctionEventId && params.action === SanctionAction.MUTE) {
    messageOptions = withModerationReleaseButton(messageOptions, {
      action: 'UNMUTE',
      sanctionEventId: params.sanctionEventId,
    });
  } else if (params.sanctionEventId && params.action === SanctionAction.BAN) {
    messageOptions = withModerationReleaseButton(messageOptions, {
      action: 'UNBAN',
      sanctionEventId: params.sanctionEventId,
    });
  }

  return {
    version: REQUIRED_SUBSCRIPTION_NOTICE_PLAN_VERSION,
    action: params.action,
    renderedText: renderRequiredSubscriptionNoticeHtml(noticeMarkdown),
    messageOptions,
    mediaFieldKey,
    deleteBotMessagesEnabled: params.deleteBotMessagesEnabled,
    deleteBotMessagesDelayMinutes: normalizeDeleteBotMessagesDelayMinutes(
      params.deleteBotMessagesDelayMinutes,
    ),
  };
}

export function withRequiredSubscriptionHtmlMessageOptions(
  options?: MaxSendMessageOptions,
): MaxSendMessageOptions {
  return {
    ...(options ?? {}),
    textFormat: 'html',
  };
}

export function buildRequiredSubscriptionNoticePlanId(chatId: string, messageId: string): string {
  const digest = createHash('sha256')
    .update(chatId.trim())
    .update('\u0000')
    .update(messageId.trim())
    .update('\u0000')
    .update(REQUIRED_SUBSCRIPTION_RULE_CODE)
    .digest('hex');
  return `required-subscription-notice-plan-v1:${digest}`;
}

export function serializeRequiredSubscriptionNoticePlan(
  plan: RequiredSubscriptionNoticePlan,
): string {
  const serialized = JSON.stringify(plan);
  if (Buffer.byteLength(serialized, 'utf8') > REQUIRED_SUBSCRIPTION_NOTICE_PLAN_MAX_BYTES) {
    throw new UnrecoverableError('Required subscription notice plan exceeds the storage limit');
  }
  return serialized;
}

export function parseRequiredSubscriptionNoticePlanMetadata(
  value: unknown,
): RequiredSubscriptionNoticePlan | null {
  const metadata = asRecord(value);
  const envelope = asRecord(metadata?.requiredSubscriptionNoticePlan);
  if (
    envelope?.version !== REQUIRED_SUBSCRIPTION_NOTICE_PLAN_VERSION ||
    typeof envelope.payload !== 'string' ||
    Buffer.byteLength(envelope.payload, 'utf8') > REQUIRED_SUBSCRIPTION_NOTICE_PLAN_MAX_BYTES
  ) {
    return null;
  }

  try {
    const parsed = JSON.parse(envelope.payload) as Record<string, unknown>;
    const action = parseRequiredSubscriptionNoticeAction(parsed.action);
    const renderedText = typeof parsed.renderedText === 'string' ? parsed.renderedText : '';
    const messageOptions = asRecord(parsed.messageOptions);
    const mediaFieldKey =
      parsed.mediaFieldKey === null
        ? null
        : typeof parsed.mediaFieldKey === 'string' &&
            REQUIRED_SUBSCRIPTION_NOTICE_MEDIA_FIELD_KEYS.has(
              parsed.mediaFieldKey as BotSpeechMediaFieldKey,
            )
          ? (parsed.mediaFieldKey as BotSpeechMediaFieldKey)
          : undefined;
    const deleteBotMessagesDelayMinutes = parsed.deleteBotMessagesDelayMinutes;
    if (
      parsed.version !== REQUIRED_SUBSCRIPTION_NOTICE_PLAN_VERSION ||
      !action ||
      !renderedText ||
      Buffer.byteLength(renderedText, 'utf8') > REQUIRED_SUBSCRIPTION_NOTICE_PLAN_MAX_BYTES ||
      !messageOptions ||
      mediaFieldKey === undefined ||
      typeof parsed.deleteBotMessagesEnabled !== 'boolean' ||
      typeof deleteBotMessagesDelayMinutes !== 'number' ||
      !Number.isFinite(deleteBotMessagesDelayMinutes) ||
      normalizeDeleteBotMessagesDelayMinutes(deleteBotMessagesDelayMinutes) !==
        deleteBotMessagesDelayMinutes
    ) {
      return null;
    }

    return {
      version: REQUIRED_SUBSCRIPTION_NOTICE_PLAN_VERSION,
      action,
      renderedText,
      messageOptions: messageOptions as MaxSendMessageOptions,
      mediaFieldKey,
      deleteBotMessagesEnabled: parsed.deleteBotMessagesEnabled,
      deleteBotMessagesDelayMinutes,
    };
  } catch {
    return null;
  }
}

export class RequiredSubscriptionNoticePlanStore {
  private readonly model: RequiredSubscriptionNoticePlanModel;
  private readonly testFallbackCache = new Map<string, RequiredSubscriptionNoticePlan>();

  constructor(model: unknown) {
    this.model = model as RequiredSubscriptionNoticePlanModel;
  }

  async read(chatId: string, messageId: string): Promise<RequiredSubscriptionNoticePlan | null> {
    const planId = buildRequiredSubscriptionNoticePlanId(chatId, messageId);
    if (typeof this.model.findUnique !== 'function') {
      return this.testFallbackCache.get(planId) ?? null;
    }

    const row = await this.model.findUnique({
      where: { id: planId },
      select: { metadata: true },
    });
    if (!row) {
      return null;
    }

    const plan = parseRequiredSubscriptionNoticePlanMetadata(row.metadata);
    if (!plan) {
      throw new UnrecoverableError(`Invalid required subscription notice plan ${planId}`);
    }
    return plan;
  }

  async persist(params: {
    chatId: string;
    userId: string;
    messageId: string;
    botId?: string | null;
    plan: RequiredSubscriptionNoticePlan;
  }): Promise<RequiredSubscriptionNoticePlan> {
    const planId = buildRequiredSubscriptionNoticePlanId(params.chatId, params.messageId);
    const serializedPlan = serializeRequiredSubscriptionNoticePlan(params.plan);
    const metadata = {
      requiredSubscriptionNoticePlan: {
        version: REQUIRED_SUBSCRIPTION_NOTICE_PLAN_VERSION,
        payload: serializedPlan,
      },
    } satisfies Prisma.InputJsonObject;
    if (typeof this.model.upsert !== 'function') {
      if (process.env.NODE_ENV !== 'test') {
        throw new Error('Required subscription notice plan persistence is unavailable');
      }
      const existing = this.testFallbackCache.get(planId);
      if (existing) {
        return existing;
      }
      if (this.testFallbackCache.size >= REQUIRED_SUBSCRIPTION_NOTICE_PLAN_TEST_CACHE_MAX) {
        const oldestKey = this.testFallbackCache.keys().next().value;
        if (typeof oldestKey === 'string') {
          this.testFallbackCache.delete(oldestKey);
        }
      }
      this.testFallbackCache.set(planId, params.plan);
      return params.plan;
    }

    const row = await this.model.upsert({
      where: { id: planId },
      create: {
        id: planId,
        chatId: params.chatId,
        userId: params.userId,
        messageId: params.messageId,
        ...(params.botId ? { botId: params.botId } : {}),
        eventType: EventType.SYSTEM,
        ruleCode: REQUIRED_SUBSCRIPTION_NOTICE_PLAN_RULE_CODE,
        action: SanctionAction.NONE,
        maskedExcerpt: null,
        score: 0,
        operator: Operator.BOT,
        metadata,
      },
      update: {},
      select: { metadata: true },
    });
    const persistedPlan = parseRequiredSubscriptionNoticePlanMetadata(row.metadata);
    if (!persistedPlan) {
      throw new UnrecoverableError(`Invalid required subscription notice plan ${planId}`);
    }
    return persistedPlan;
  }

  async readDecision(params: {
    chatId: string;
    userId: string;
    messageId: string;
  }): Promise<RequiredSubscriptionPersistedDecision | null> {
    if (typeof this.model.findFirst !== 'function') {
      return null;
    }

    const event = await this.model.findFirst({
      where: {
        chatId: params.chatId,
        userId: params.userId,
        messageId: params.messageId,
        ruleCode: REQUIRED_SUBSCRIPTION_RULE_CODE,
        action: {
          in: [SanctionAction.NONE, SanctionAction.WARN, SanctionAction.MUTE, SanctionAction.BAN],
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        action: true,
        metadata: true,
      },
    });
    const action = parseRequiredSubscriptionNoticeAction(event?.action);
    if (!event || !action) {
      return null;
    }
    const metadata = asRecord(event.metadata);
    const rawViolationCount = metadata?.requiredSubscriptionViolationCount24h;
    const violationCount24h =
      typeof rawViolationCount === 'number' &&
      Number.isInteger(rawViolationCount) &&
      rawViolationCount > 0
        ? rawViolationCount
        : null;

    return {
      action,
      eventId: readString(event.id),
      violationCount24h,
    };
  }
}

function parseRequiredSubscriptionNoticeAction(
  value: unknown,
): RequiredSubscriptionNoticeAction | null {
  return value === SanctionAction.NONE ||
    value === SanctionAction.WARN ||
    value === SanctionAction.MUTE ||
    value === SanctionAction.BAN
    ? value
    : null;
}

function renderRequiredSubscriptionNoticeHtml(text: string): string {
  return renderSupportedMarkdownAsHtml(text, { blockMode: 'raw' }).replace(/(?:\*\*\*|\*\*)/g, '');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }
  const normalized = String(value).trim();
  return normalized || null;
}
