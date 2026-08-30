import { REQUIRED_SUBSCRIPTION_MAX_CHANNELS, type MaxUpdate } from '@maxim/contracts';
import { USER_AGREEMENT_SHORT_NOTICE } from '../common/user-agreement-notice';
import { markMaxMemberMutationAttempted } from '../max/max-client.service';
import { ChatEntityType, EventType, Operator, SanctionAction } from '../prisma/prisma-client';
import { WebhookParser } from '../webhook/webhook.parser';
import { ChatRulesPublishFenceRetryError } from './chat-rules-own-bot-message-classifier';
import { createDuplicateSanctionAuthorization } from './duplicate-execution-guards';
import { buildActiveMuteStateKey } from './moderation-state.util';
import { buildModerationReleaseCallbackPayload } from './moderation-release-callback.util';
import { ModerationSanctionStateLockLeaseLostError } from './moderation-sanction-state-lock.service';
import {
  INCIDENT_EXTERNAL_FORWARD_FIXTURE,
  INCIDENT_EXTERNAL_URL,
  INCIDENT_PROFILE_MENTION_FORWARD_FIXTURE,
} from './navigation/navigation-evidence.fixtures';
import {
  DEVELOPER_FORCED_GLOBAL_SPAMMER_WARM_MARKER_TTL_SEC,
  buildDeveloperForcedGlobalSpammerCacheKey,
  buildDeveloperForcedGlobalSpammerWarmMarkerKey,
} from './developer-forced-global-spammer-cache';
import { ModerationService } from './moderation.service';
import { resolveModerationDeleteIntentRollout } from './moderation-delete-intent-rollout.util';
import {
  WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX,
  WebhookCanonicalExecutionService,
} from './webhook-canonical-execution.service';
import { WebhookOrderedPredecessorPendingError } from './webhook-ordered-predecessor-fence';
import {
  WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_HEARTBEAT_MS,
  WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_MAX_LIFETIME_MS,
  WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PERSIST_RETRY_MS,
  WEBHOOK_HOT_PATH_TIMEOUT_TERMINAL_QUARANTINE_PREFIX,
} from '../webhook/webhook-timeout-quarantine';
import { RuleEngineService } from './rule-engine.service.impl';
import {
  ADMIN_CONTACT_DISPLAY_NAME_LOOKUP_TIMEOUT_MS,
  DEVELOPER_FORCED_GLOBAL_SPAMMER_HOT_PATH_TIMEOUT_MS,
  DUPLICATE_FOLLOW_UP_HOT_PATH_TIMEOUT_MS,
  GLOBAL_SPAMMER_CONFIRMED_FANOUT_EPISODE_THRESHOLD,
  GLOBAL_SPAMMER_EXEMPTION_HOT_PATH_TIMEOUT_MS,
  GLOBAL_SPAMMER_EXEMPTION_HOT_PATH_MAX_ADMIN_IDS,
  GLOBAL_SPAMMER_HIGH_FANOUT_MIN_CHATS,
  GLOBAL_SPAMMER_TRACK_HOT_PATH_TIMEOUT_MS,
  MODERATION_ACTION_ACCESS_LOSS_HOT_PATH_TIMEOUT_MS,
  MODERATION_ACTION_DISPATCH_TIMEOUT_MS,
  REQUIRED_SUBSCRIPTION_MEMBERSHIP_HOT_PATH_TIMEOUT_MS,
  SHARED_CHAT_EXECUTION_LOCK_AMBIGUOUS_RETRY_AFTER_MS,
} from './moderation.service.support';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace jest {
    interface Matchers<R> {
      toHaveBeenCalledWithPrefix(...expected: unknown[]): R;
    }
  }
}

expect.extend({
  toHaveBeenCalledWithPrefix(this: jest.MatcherContext, received: unknown, ...expected: unknown[]) {
    if (typeof received !== 'function' || !('mock' in received)) {
      return {
        pass: false,
        message: () => 'Expected a Jest mock function',
      };
    }

    const mockFn = received as jest.Mock;
    const calls = mockFn.mock.calls ?? [];
    const pass = calls.some((call) =>
      expected.every((expectedArg, index) => this.equals(call[index], expectedArg)),
    );

    return {
      pass,
      message: () =>
        pass
          ? `Expected mock not to be called with prefix ${this.utils.printExpected(expected)}`
          : `Expected mock to be called with prefix ${this.utils.printExpected(expected)}, but got ${this.utils.printReceived(calls)}`,
    };
  },
});

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, resolve, reject };
}

function extractSqlText(arg: unknown): string {
  if (Array.isArray(arg)) {
    return arg.map((part) => extractSqlText(part)).join(' ');
  }

  if (arg && typeof arg === 'object' && 'strings' in arg) {
    const sqlArg = arg as { strings?: unknown; values?: unknown };
    const strings = sqlArg.strings;
    const values = sqlArg.values;
    const parts: string[] = [];
    if (Array.isArray(strings)) {
      parts.push(strings.map((part) => String(part)).join(' '));
    }
    if (Array.isArray(values)) {
      parts.push(values.map((part) => extractSqlText(part)).join(' '));
    }
    if (parts.length > 0) {
      return parts.filter(Boolean).join(' ');
    }
  }

  return String(arg ?? '');
}

function escapeMaxMarkdown(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/([*_`[\]()~+])/g, '\\$1');
}

function userMention(name: string, userId = 'user-1'): string {
  return `[${escapeMaxMarkdown(name)}](max://user/${encodeURIComponent(userId)})`;
}

function userMentionHtml(name: string, userId = 'user-1'): string {
  const escapedName = name
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
  return `<a href="max://user/${encodeURIComponent(userId)}">${escapedName}</a>`;
}

function majorExplanation(
  name: string,
  messageStatus: 'удалено' | 'не удалено',
  reason: string,
  subject = 'Сообщение',
): string {
  if (reason === 'эта ссылка запрещена настройками чата') {
    return `${userMentionHtml(name)}, сообщение ${messageStatus}: ${reason}. Без самодеятельности.`;
  }

  if (subject === 'Объявление') {
    return `${userMentionHtml(name)}, объявление ${messageStatus}. Основание: ${reason}. Исправьте по форме и отправьте снова.`;
  }

  if (
    reason.includes('стоп-слово') ||
    reason.includes('стоп-лист') ||
    reason.includes('длина сообщения') ||
    reason.includes('отправка видео') ||
    reason.includes('отправка файлов') ||
    reason.includes('отправка голосовых сообщений') ||
    reason.includes('номера телефонов') ||
    reason.includes('лимит')
  ) {
    return `${userMentionHtml(name)}, сообщение ${messageStatus}: ${reason}. При следующей отправке учтите ограничение.`;
  }

  return `${userMentionHtml(name)}, сообщение ${messageStatus}: ${reason}. Дальше держимся правил.`;
}

function duplicateExplanation(name: string, sanction: string): string {
  return `${userMentionHtml(name)}, повтор зафиксирован. ${sanction}`;
}

function muteNotice(name: string, duration: string): string {
  return `${userMentionHtml(name)}, мут включён на ${duration}. До конца срока новые сообщения будут удаляться.`;
}

function permanentBanNotice(name: string, userId = 'user-1'): string {
  return `${userMentionHtml(name, userId)}, бан включён до ручного снятия.`;
}

function textFilterWarnNotice(name: string, reason: string): string {
  return `${userMentionHtml(name)}, предупреждение зафиксировано: ${reason}. Повторять не стоит.`;
}

function linkWarnNotice(name: string): string {
  return `${userMentionHtml(name)}, предупреждение зафиксировано: эта ссылка запрещена настройками чата. Дальше без запрещённых ссылок.`;
}

function editedLinkWarnNotice(name: string): string {
  return `${userMentionHtml(name)}, предупреждение зафиксировано: добавленная при редактировании ссылка запрещена настройками чата. Правка правила не отменяет.`;
}

function messageLimitsWarnNotice(name: string, reason: string): string {
  return `${userMentionHtml(name)}, предупреждение зафиксировано. Основание: ${reason}.`;
}

function messageLimitsBanNotice(name: string, reason: string): string {
  return `${userMentionHtml(name)}, бан включён до ручного снятия. Основание: ${reason}.`;
}

function expectImmediateDeleteMessage(mockFn: jest.Mock, chatId: string, messageId: string) {
  expect(mockFn).toHaveBeenCalledWith(
    chatId,
    messageId,
    expect.objectContaining({
      immediate: true,
      trafficClass: 'critical',
      actionHealthLane: 'critical',
      sourceTag: 'moderation_delete',
      timeoutMs: MODERATION_ACTION_DISPATCH_TIMEOUT_MS,
    }),
  );
}

function expectImmediateKickMember(mockFn: jest.Mock, chatId: string, userId: string) {
  expect(mockFn).toHaveBeenCalledWith(
    chatId,
    userId,
    expect.objectContaining({
      immediate: true,
      trafficClass: 'critical',
      actionHealthLane: 'critical',
      sourceTag: 'moderation_sanction',
      timeoutMs: MODERATION_ACTION_DISPATCH_TIMEOUT_MS,
    }),
  );
}

function expectImmediateBanMember(mockFn: jest.Mock, chatId: string, userId: string) {
  expect(mockFn).toHaveBeenCalledWith(
    chatId,
    userId,
    expect.objectContaining({
      immediate: true,
      trafficClass: 'critical',
      actionHealthLane: 'critical',
      sourceTag: 'moderation_sanction',
      timeoutMs: MODERATION_ACTION_DISPATCH_TIMEOUT_MS,
    }),
  );
}

function nightModeNotice(window: string, timezone: string): string {
  return `🌙 Ночной режим: ${window} (${timezone}). До открытия новые сообщения будут удаляться. Всё по графику.`;
}

function nightModeOpenNotice(): string {
  return 'Чат снова открыт. Возвращаемся к обычному режиму.';
}

function createMaxApiError(status: number, message: string, code?: string): Error {
  return Object.assign(new Error(message), {
    response: {
      status,
      data: {
        ...(code ? { code } : {}),
        message,
      },
    },
  });
}

function createRedisCounterMock() {
  const stringCache = new Map<string, string>();
  const counters = new Map<string, number>();
  const counterMembers = new Set<string>();
  const locks = new Set<string>();

  return {
    stringCache,
    getString: jest.fn(async (key: string) => stringCache.get(key) ?? null),
    setStringWithTtl: jest.fn(async (key: string, value: string) => {
      stringCache.set(key, value);
    }),
    acquireLock: jest.fn(async (key: string) => {
      if (locks.has(key)) {
        return null;
      }

      locks.add(key);
      return `lock-${key}`;
    }),
    renewLock: jest.fn(
      async (key: string, token: string) => locks.has(key) && token === `lock-${key}`,
    ),
    acquireLockBeforeDeadline: jest.fn(async (key: string) => {
      if (locks.has(key)) {
        return { kind: 'busy' as const };
      }

      locks.add(key);
      return { kind: 'acquired' as const };
    }),
    releaseLock: jest.fn(async (key: string) => {
      locks.delete(key);
    }),
    incrementWithTtl: jest.fn(async (key: string) => {
      const count = (counters.get(key) ?? 0) + 1;
      counters.set(key, count);
      return count;
    }),
    incrementOncePerMemberWithTtl: jest.fn(async (counterKey: string, memberKey: string) => {
      if (counterMembers.has(memberKey)) {
        return {
          inserted: false,
          count: counters.get(counterKey) ?? 0,
        };
      }

      counterMembers.add(memberKey);
      const count = (counters.get(counterKey) ?? 0) + 1;
      counters.set(counterKey, count);
      return { inserted: true, count };
    }),
  };
}

function createModerationServiceWithManualBridge(params: {
  prisma: unknown;
  ruleEngine: unknown;
  sanctionService: unknown;
  maxClient: unknown;
  manualBridge: unknown;
  chatContextCache?: unknown;
  maxBotLinkService?: unknown;
  sanctionStateFence?: unknown;
}) {
  return new ModerationService(
    params.prisma as never,
    params.ruleEngine as never,
    params.sanctionService as never,
    params.maxClient as never,
    params.chatContextCache as never,
    undefined, // systemModeService
    undefined, // configService
    undefined, // redisCounter
    undefined, // privateControlService
    undefined, // adminDialogLinkService
    undefined, // membershipLookupService
    params.maxBotLinkService as never,
    undefined, // maxBotContextService
    undefined, // queueMetricsService
    undefined, // backgroundRuntimeGovernorService
    undefined, // runtimeDiagnosticsService
    undefined, // maxChatAdminRosterSyncService
    undefined, // globalSpammerIntelligence
    undefined, // managedEntityAccessLossService
    undefined, // injectedModerationAccessService
    undefined, // injectedNightModeTransitionRuntime
    params.manualBridge as never,
    undefined, // injectedNightModeTransitionDelivery
    undefined, // injectedBotSpeechMediaService
    undefined, // injectedNightModeTransitionEventService
    undefined, // karavanStorefrontRelayService
    undefined, // managedPollService
    undefined, // injectedWebhookCanonicalExecutionService
    undefined, // moderationDeleteIntentService
    undefined, // maxActionLedgerService
    undefined, // channelPostSignatureService
    undefined, // injectedModerationSanctionStateLock
    (params.sanctionStateFence ?? {
      isSanctionEventInvalidated: jest.fn().mockResolvedValue(false),
    }) as never,
  );
}

function createModerationServiceWithSanctionStateLock(params: {
  prisma: unknown;
  ruleEngine: unknown;
  sanctionService: unknown;
  maxClient: unknown;
  redisCounter: unknown;
  sanctionStateLock: unknown;
  sanctionStateFence?: unknown;
  maxBotLinkService?: unknown;
}) {
  const maxClient = params.maxClient as {
    banMember?: (
      chatId: string,
      userId: string,
      options?: { beforeImmediateMemberMutation?: () => Promise<void> },
    ) => unknown;
  };
  const banMemberOverride = maxClient.banMember;
  const guardedMaxClient = {
    ...maxClient,
    ...(typeof banMemberOverride === 'function'
      ? {
          banMember: jest.fn(
            async (
              chatId: string,
              userId: string,
              options?: { beforeImmediateMemberMutation?: () => Promise<void> },
            ) => {
              await options?.beforeImmediateMemberMutation?.();
              return banMemberOverride(chatId, userId, options);
            },
          ),
        }
      : {}),
  };
  return new ModerationService(
    params.prisma as never,
    params.ruleEngine as never,
    params.sanctionService as never,
    guardedMaxClient as never,
    undefined, // chatContextCache
    undefined, // systemModeService
    undefined, // configService
    params.redisCounter as never,
    undefined, // privateControlService
    undefined, // adminDialogLinkService
    undefined, // membershipLookupService
    params.maxBotLinkService as never,
    undefined, // maxBotContextService
    undefined, // queueMetricsService
    undefined, // backgroundRuntimeGovernorService
    undefined, // runtimeDiagnosticsService
    undefined, // maxChatAdminRosterSyncService
    undefined, // globalSpammerIntelligence
    undefined, // managedEntityAccessLossService
    undefined, // injectedModerationAccessService
    undefined, // injectedNightModeTransitionRuntime
    undefined, // injectedManualModerationService
    undefined, // injectedNightModeTransitionDelivery
    undefined, // injectedBotSpeechMediaService
    undefined, // injectedNightModeTransitionEventService
    undefined, // karavanStorefrontRelayService
    undefined, // managedPollService
    undefined, // injectedWebhookCanonicalExecutionService
    undefined, // moderationDeleteIntentService
    undefined, // maxActionLedgerService
    undefined, // channelPostSignatureService
    params.sanctionStateLock as never,
    params.sanctionStateFence as never,
  );
}

function createSettings(overrides: Record<string, unknown> = {}) {
  return {
    id: 'settings-1',
    chatId: 'chat-1',
    duplicateWarnEnabled: true,
    duplicateMuteEnabled: true,
    duplicateBanEnabled: true,
    antiDuplicateEnabled: true,
    duplicateWarnWindowSec: 12 * 60 * 60,
    duplicateWarnMaxCount: 2,
    duplicateMuteWindowSec: 24 * 60 * 60,
    duplicateMuteMaxCount: 3,
    duplicateBanWindowSec: 48 * 60 * 60,
    duplicateBanMaxCount: 4,
    linkPolicy: 'ALLOWLIST_ONLY',
    linkPolicyRevision: 7,
    linkPolicyEffectiveAt: new Date('2026-08-10T00:00:00.000Z'),
    linkEscalationWindowHours: 24,
    botSpeechStyle: null,
    botSpeechMedia: {},
    greetingEnabled: false,
    greetingBotMessageEnabled: true,
    greetingDeleteBotMessageEnabled: false,
    greetingDeleteBotMessageDelayMinutes: 2,
    greetingBotMessageText: '',
    greetingBotButtonEnabled: false,
    greetingBotButtonUrl: '',
    greetingBotButtonText: 'Открыть',
    greetingRulesButtonEnabled: false,
    deleteBotMessagesEnabled: false,
    deleteBotMessagesDelayMinutes: 2,
    removeBotsFromGroupEnabled: false,
    deleteSpammersEnabled: false,

    antiSpamEnabled: true,
    messageCountLimitEnabled: false,
    messageCountLimitMessages: 5,
    messageCountLimitWindowHours: 1,
    maxMessageLengthEnabled: false,
    maxMessageLength: 1500,
    photoMessageCooldownEnabled: false,
    photoMessageCooldownHours: 1,
    stickerMessageCooldownEnabled: false,
    stickerMessageCooldownMinutes: 5,
    photoMessagesEnabled: true,
    videoMessagesEnabled: true,
    fileMessagesEnabled: true,
    voiceMessagesEnabled: true,
    phoneNumbersEnabled: true,
    messageLimitsBlockedWords: [],
    messageLimitsBlockedDomains: [],
    messageLimitsBotMessageEnabled: false,
    messageLimitsBotMessageText: '',
    messageLimitsWarnEnabled: false,
    messageLimitsWarnMessageText: '',
    messageLimitsBanEnabled: false,
    messageLimitsMuteEnabled: false,
    messageLimitsBotButtonEnabled: false,
    messageLimitsBotButtonUrl: '',
    messageLimitsBotButtonText: 'Открыть',
    russianProfanityFilterEnabled: true,
    commercialAdsFilterEnabled: false,
    commercialAdsSensitivity: 'BALANCED',
    commercialAdsWarnThreshold: 45,
    commercialAdsDeleteThreshold: 65,
    profanityBotMessageEnabled: false,
    profanityWarnEnabled: false,
    profanityBanEnabled: false,
    profanityMuteEnabled: false,
    textFiltersBotMessageEnabled: false,
    textFiltersBotMessageText: '',
    textFiltersWarnEnabled: false,
    textFiltersWarnMessageText: '',
    textFiltersBanEnabled: false,
    textFiltersMuteEnabled: false,
    textFiltersBotButtonEnabled: false,
    textFiltersBotButtonUrl: '',
    textFiltersBotButtonText: 'Открыть',
    textFiltersRulesButtonEnabled: false,
    thematicCodewordEnabled: false,
    thematicCodeword: '',
    thematicFiltersBotMessageEnabled: false,
    thematicFiltersWarnEnabled: false,
    thematicFiltersBanEnabled: false,
    thematicFiltersMuteEnabled: false,
    thematicFiltersBotButtonEnabled: false,
    thematicFiltersBotButtonUrl: '',
    thematicFiltersBotButtonText: 'Открыть',
    thematicFiltersRulesButtonEnabled: false,
    commentsEnabled: false,
    commentsAdminsEnabled: true,
    commentsAllEnabled: false,
    commentsChatBroadcastsEnabled: false,
    karavanStorefrontEnabled: false,
    karavanStorefrontAdminsOnly: false,
    nightModeEnabled: false,
    nightModeStartTimeMinutes: 23 * 60,
    nightModeEndTimeMinutes: 8 * 60,
    nightModeTimezone: 'Europe/Moscow',
    nightModeBotMessageEnabled: false,
    nightModeBotMessageText: '',
    nightModeCommentsEnabled: false,
    nightModeOpenMessageEnabled: true,
    nightModeOpenMessageText: '',
    nightModeBotButtonEnabled: false,
    nightModeBotButtonUrl: '',
    nightModeBotButtonText: 'Открыть',
    nightModeRulesButtonEnabled: false,
    nightModeForceCloseEnabled: false,
    nightModeForceCloseForever: false,
    nightModeForceCloseHours: 8,
    nightModeForceCloseDays: 0,
    nightModeForceCloseUntil: '',
    requiredSubscriptionEnabled: false,
    requiredSubscriptionChannelIds: [],
    requiredSubscriptionDurationDays: 7,
    requiredSubscriptionExpiresAt: '',
    requiredSubscriptionBotMessageEnabled: true,
    requiredSubscriptionBotMessageText: '',
    requiredSubscriptionButtonText: '',
    requiredSubscriptionWarnEnabled: false,
    requiredSubscriptionWarnMessageText: '',
    requiredSubscriptionBanEnabled: false,
    requiredSubscriptionMuteEnabled: false,
    requiredSubscriptionMuteDurationHours: 6,
    invitationAccessEnabled: false,
    invitationAccessRequiredCount: 1,
    invitationAccessBotMessageEnabled: true,
    invitationAccessBotMessageText: '',
    invitationAccessWarnEnabled: false,
    invitationAccessWarnMessageText: '',
    invitationAccessBanEnabled: false,
    invitationAccessMuteEnabled: false,
    invitationAccessMuteDurationHours: 6,
    linkBotMessageEnabled: true,
    linkBotMessageText: '',
    linkWarnEnabled: false,
    linkWarnMessageText: '',
    linkBanEnabled: false,
    linkMuteEnabled: false,
    linkBotButtonEnabled: false,
    linkBotButtonUrl: '',
    linkBotButtonText: 'Открыть',
    linkRulesButtonEnabled: false,
    duplicateBotMessageEnabled: false,
    duplicateBotMessageText: '',
    duplicateBotButtonEnabled: false,
    duplicateBotButtonUrl: '',
    duplicateBotButtonText: 'Открыть',
    duplicateRulesButtonEnabled: false,
    messageLimitsRulesButtonEnabled: false,
    rulesAttachViolationsEnabled: false,
    adminBanCommandName: 'бан',
    adminBanAllCommandName: 'Бан!',
    adminMuteCommandName: 'мут',
    adminPermanentMuteCommandName: 'мут 88',
    adminRulesCommandName: 'правило',
    adminSilenceCommandName: 'тишина',
    adminOpenChatCommandName: 'тишина выкл',
    adminMuteCommandAliases: 'мут, мьют, мью, mute',
    adminRulesCommandAliases: 'правило, правила, rule, rules',
    muteDurationHours: 6,
    warnThreshold: 3,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function createUpdate(): MaxUpdate {
  return {
    updateId: 'upd-1',
    type: 'message_created',
    message: {
      messageId: 'msg-1',
      chatId: 'chat-1',
      senderId: 'user-1',
      senderName: 'Алексей',
      text: 'same text',
      createdAt: new Date().toISOString(),
    },
    raw: {},
  };
}

function installImmediateTimeoutForDelay(targetDelayMs: number) {
  const realSetTimeout = global.setTimeout;
  return jest.spyOn(global, 'setTimeout').mockImplementation(((
    callback: (...args: unknown[]) => void,
    delayMs?: number,
  ) => {
    if (delayMs === targetDelayMs) {
      callback();
      return {
        unref() {
          return this;
        },
      } as unknown as NodeJS.Timeout;
    }
    return realSetTimeout(callback, delayMs);
  }) as typeof setTimeout);
}

type LiveNavigationEnvelopeType = 'message_created' | 'message_edited';

function createLiveNavigationEnvelopeUpdate(
  type: LiveNavigationEnvelopeType,
  content: Record<string, unknown>,
  options: {
    messageId?: string;
    senderId?: string;
    senderName?: string;
  } = {},
): MaxUpdate {
  const messageId = options.messageId ?? `msg-live-navigation-${type}`;
  const senderId = options.senderId ?? 'user-1';
  const senderName = options.senderName ?? 'Алексей';
  const body =
    content.body && typeof content.body === 'object' && !Array.isArray(content.body)
      ? (content.body as Record<string, unknown>)
      : {};
  const message = {
    ...content,
    id: messageId,
    sender: {
      id: senderId,
      display_name: senderName,
    },
    recipient: {
      chat_id: 'chat-1',
      title: 'Chat 1',
    },
    body: {
      ...body,
      mid: messageId,
    },
  };

  return new WebhookParser().parse({
    update_type: type,
    timestamp: '2026-08-11T02:56:00.000Z',
    [type]: { message },
  });
}

function createLiveNavigationHarness(
  options: {
    linkPolicy?: 'ALLOWLIST_ONLY' | 'BLOCKLIST_ONLY' | 'ALERT_ONLY';
    cachedAllowlist?: string[];
    freshAllowlist?: string[];
    freshAllowlistError?: Error;
    adminUserIds?: string[];
    plainTextClickabilityEnabled?: boolean;
    profileMentionsEnabled?: boolean;
    linkPolicyEffectiveAt?: Date | string | null;
    maxBotLinkService?: { isKnownBotUserId: jest.Mock };
  } = {},
) {
  const cachedAllowlist = options.cachedAllowlist ?? [];
  const freshAllowlist = options.freshAllowlist ?? cachedAllowlist;
  const prisma = {
    chat: {
      upsert: jest.fn().mockResolvedValue({
        id: 'chat-1',
        title: 'Chat 1',
        settings: createSettings({
          antiSpamEnabled: false,
          antiDuplicateEnabled: false,
          russianProfanityFilterEnabled: false,
          commercialAdsFilterEnabled: false,
          linkPolicy: options.linkPolicy ?? 'BLOCKLIST_ONLY',
          ...(Object.prototype.hasOwnProperty.call(options, 'linkPolicyEffectiveAt')
            ? { linkPolicyEffectiveAt: options.linkPolicyEffectiveAt }
            : {}),
          linkBotMessageEnabled: false,
          linkWarnEnabled: false,
          linkBanEnabled: false,
          linkMuteEnabled: false,
        }),
        domains: cachedAllowlist.map((domain) => ({ domain })),
        admins: (options.adminUserIds ?? []).map((userId) => ({ userId })),
        rules: {
          publishedUrl: null,
          publishedMessageId: null,
        },
      }),
    },
    domainAllowlist: {
      findMany: options.freshAllowlistError
        ? jest.fn().mockRejectedValue(options.freshAllowlistError)
        : jest.fn().mockResolvedValue(freshAllowlist.map((domain) => ({ domain }))),
    },
    violation: {
      create: jest.fn(),
      count: jest.fn().mockResolvedValue(1),
    },
    moderationEvent: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
    },
    webhookEvent: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  };
  const ruleEngine = new RuleEngineService(createRedisCounterMock() as never);
  const detectSpy = jest.spyOn(ruleEngine, 'detect');
  const maxClient = {
    deleteMessage: jest.fn(),
    sendMessage: jest.fn(),
    kickMember: jest.fn(),
    banMember: jest.fn(),
    notifyModerators: jest.fn(),
  };
  const configService = {
    get: jest.fn((key: string) => {
      if (
        key === 'MODERATION_LINK_TEXT_CLICKABILITY_ENABLED' &&
        options.plainTextClickabilityEnabled !== undefined
      ) {
        return options.plainTextClickabilityEnabled;
      }
      if (
        key === 'MODERATION_LINK_PROFILE_MENTIONS_ENABLED' &&
        options.profileMentionsEnabled !== undefined
      ) {
        return options.profileMentionsEnabled;
      }
      return undefined;
    }),
  };
  const service = new ModerationService(
    prisma as never,
    ruleEngine,
    { resolveAction: jest.fn() } as never,
    maxClient as never,
    undefined,
    undefined,
    configService as never,
    undefined,
    undefined,
    undefined,
    undefined,
    options.maxBotLinkService as never,
  );

  return { service, prisma, ruleEngine, detectSpy, maxClient };
}

function createNumericSenderNameUpdate(): MaxUpdate {
  return new WebhookParser().parse({
    update_type: 'message_created',
    timestamp: '2026-08-04T12:00:00.000Z',
    message: {
      sender_name: '195714583',
      sender: {
        user_id: 195714583,
      },
      recipient: {
        chat_id: 'chat-1',
        chat_type: 'chat',
      },
      body: {
        mid: 'msg-numeric-sender-1',
        text: 'https://blocked.example',
      },
      timestamp: '2026-08-04T12:00:00.000Z',
    },
  });
}

function createNumericSenderLinkBanHarness(
  options: {
    localRows?: Array<{ sender_name: string | null }>;
    getChatMemberProfiles?: jest.Mock;
    banMember?: jest.Mock;
  } = {},
) {
  const prisma = {
    $queryRaw: jest
      .fn()
      .mockImplementation(async (query: unknown) =>
        extractSqlText(query).includes('chat_user_display_names') ? (options.localRows ?? []) : [],
      ),
    chat: {
      upsert: jest.fn().mockResolvedValue({
        id: 'chat-1',
        title: 'Chat 1',
        settings: createSettings({
          linkBotMessageEnabled: false,
          linkBanEnabled: true,
          muteDurationHours: 12,
        }),
        domains: [],
      }),
    },
    violation: {
      create: jest.fn(),
      count: jest.fn().mockResolvedValue(3),
    },
    moderationEvent: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockResolvedValueOnce({ id: 'delete-event-numeric-sender' })
        .mockResolvedValueOnce({ id: 'sanction-event-numeric-sender' }),
    },
    webhookEvent: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  };
  const ruleEngine = {
    detect: jest.fn().mockResolvedValue({
      violations: [{ ruleCode: 'LINK_BLOCKED', score: 0.9, reason: 'Link detected' }],
    }),
  };
  const sanctionService = {
    resolveAction: jest.fn(),
  };
  const maxClient = {
    deleteMessage: jest.fn(),
    sendMessage: jest.fn(),
    kickMember: jest.fn(),
    banMember: options.banMember ?? jest.fn().mockResolvedValue(undefined),
    notifyModerators: jest.fn(),
    getChatMemberProfiles: options.getChatMemberProfiles ?? jest.fn().mockResolvedValue(new Map()),
  };
  const service = new ModerationService(
    prisma as never,
    ruleEngine as never,
    sanctionService as never,
    maxClient as never,
  );

  return {
    service,
    prisma,
    ruleEngine,
    sanctionService,
    maxClient,
    update: createNumericSenderNameUpdate(),
  };
}

function createPhotoAttachmentUpdate(suffix: number): MaxUpdate {
  return {
    updateId: `upd-photo-${suffix}`,
    type: 'message_created',
    message: {
      messageId: `msg-photo-${suffix}`,
      chatId: 'chat-1',
      senderId: 'user-1',
      senderName: 'Алексей',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      message: {
        attachments: [
          {
            type: 'image',
            payload: {
              url: `https://cdn.example/photo-${suffix}.jpg`,
            },
          },
        ],
      },
    },
  };
}

function createAdminForwardedBanUpdate(
  text = 'бан',
  forwardedChatId: string | number = 'chat-1',
  forwardedMessageId = 'mid-forward-ban-1',
): MaxUpdate {
  return {
    updateId: 'upd-admin-forward-ban-1',
    type: 'message_created',
    message: {
      messageId: 'msg-admin-forward-ban-1',
      chatId: 'chat-1',
      senderId: 'admin-1',
      senderName: 'Админ',
      text,
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'message_created',
      message: {
        sender: {
          user_id: 'admin-1',
          display_name: 'Админ',
        },
        recipient: {
          chat_id: 'chat-1',
        },
        body: {
          text,
          forwarded_message: {
            sender: {
              user_id: 'user-2',
              display_name: 'Нарушитель',
            },
            recipient: {
              chat_id: forwardedChatId,
              title: forwardedChatId === 'chat-1' ? 'Chat 1' : 'Другой чат',
            },
            body: {
              mid: forwardedMessageId,
              text: 'spam message',
            },
          },
        },
      },
    },
  };
}

function createAdminLinkedModerationUpdate(
  text = 'мут',
  linkedChatId: string | number = 'chat-1',
): MaxUpdate {
  return {
    updateId: 'upd-admin-link-moderation-1',
    type: 'message_created',
    message: {
      messageId: 'msg-admin-link-moderation-1',
      chatId: 'chat-1',
      senderId: 'admin-1',
      senderName: 'Админ',
      text,
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'message_created',
      message: {
        sender: {
          user_id: 'admin-1',
          display_name: 'Админ',
        },
        recipient: {
          chat_id: 'chat-1',
        },
        link: {
          sender: {
            user_id: 'user-2',
            display_name: 'Нарушитель',
          },
          recipient: {
            chat_id: linkedChatId,
            title: linkedChatId === 'chat-1' ? 'Chat 1' : 'Другой чат',
          },
          body: {
            text: 'spam message',
          },
        },
        body: {
          text,
        },
      },
    },
  };
}

function createAdminReplyModerationUpdate(text = 'бан'): MaxUpdate {
  return {
    updateId: 'upd-admin-reply-moderation-1',
    type: 'message_created',
    message: {
      messageId: 'msg-admin-reply-moderation-1',
      chatId: 'chat-1',
      senderId: 'admin-1',
      senderName: 'Админ',
      text,
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'message_created',
      message: {
        sender: {
          user_id: 'admin-1',
          display_name: 'Админ',
        },
        recipient: {
          chat_id: 'chat-1',
        },
        link: {
          type: 'reply',
          sender: {
            user_id: 'user-2',
            display_name: 'Нарушитель',
          },
          message: {
            mid: 'mid-reply-target-1',
            text: 'spam message',
          },
        },
        body: {
          text,
        },
      },
    },
  };
}

function createAdminForwardedRulesUpdate(
  text = 'правило',
  forwardedChatId: string | number = 'chat-1',
): MaxUpdate {
  return {
    updateId: 'upd-admin-forward-rules-1',
    type: 'message_created',
    message: {
      messageId: 'msg-admin-forward-rules-1',
      chatId: 'chat-1',
      senderId: 'admin-1',
      senderName: 'Админ',
      text,
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'message_created',
      message: {
        sender: {
          user_id: 'admin-1',
          display_name: 'Админ',
        },
        recipient: {
          chat_id: 'chat-1',
        },
        body: {
          text,
          forwarded_message: {
            recipient: {
              chat_id: forwardedChatId,
              title: forwardedChatId === 'chat-1' ? 'Chat 1' : 'Другой чат',
            },
            body: {
              mid: 'mid-rules-source-1',
              text: '1. Без спама.\n2. Без ссылок.',
            },
          },
        },
      },
    },
  };
}

function createBotAuthoredUpdate(): MaxUpdate {
  return {
    updateId: 'upd-bot-1',
    type: 'message_created',
    message: {
      messageId: 'msg-bot-1',
      chatId: 'chat-1',
      senderId: 'bot-1',
      text: 'service notice',
      createdAt: new Date().toISOString(),
    },
    raw: {
      message: {
        sender: {
          id: 'bot-1',
          type: 'bot',
          is_bot: true,
        },
      },
    },
  };
}

function createOwnBotUpdateWithoutBotFlags(
  text = 'service notice',
  messageId = 'msg-own-bot-no-flags-1',
): MaxUpdate {
  return {
    updateId: 'upd-own-bot-no-flags-1',
    type: 'message_created',
    message: {
      messageId,
      chatId: 'chat-1',
      senderId: '613002203036',
      text,
      createdAt: new Date().toISOString(),
    },
    raw: {
      message: {
        sender: {
          user_id: 613002203036,
        },
      },
    },
  };
}

function createServiceBotJoinedUpdate(): MaxUpdate {
  return {
    updateId: 'upd-service-bot-join-1',
    type: 'message_created',
    message: {
      messageId: 'msg-service-bot-join-1',
      chatId: 'chat-1',
      senderId: 'service-1',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      message: {
        sender: {
          id: 'service-1',
          type: 'service',
          is_service: true,
        },
        body: {
          new_members: [
            {
              user_id: 'bot-joined-1',
              type: 'bot',
              is_bot: true,
            },
          ],
        },
      },
    },
  };
}

function createBotAddedUpdate(chatId = 'chat-1', botId?: string): MaxUpdate {
  return {
    updateId: 'upd-bot-added-1',
    type: 'bot_added',
    ...(botId ? { botId } : {}),
    message: {
      messageId: 'bot_added:upd-bot-added-1',
      chatId,
      senderId: 'admin-1',
      senderName: 'Админ',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'bot_added',
      chat_id: chatId,
      timestamp: Date.now(),
    },
  };
}

function createServiceUserJoinedUpdate(): MaxUpdate {
  return {
    updateId: 'upd-service-user-join-1',
    type: 'message_created',
    message: {
      messageId: 'msg-service-user-join-1',
      chatId: 'chat-1',
      senderId: 'service-1',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      message: {
        sender: {
          id: 'service-1',
          type: 'service',
          is_service: true,
        },
        body: {
          new_members: [
            {
              user_id: 'user-black-2',
              type: 'user',
              display_name: 'Новый участник',
            },
          ],
        },
      },
    },
  };
}

function createServiceUserJoinedUpdateWithSplitName(): MaxUpdate {
  return {
    updateId: 'upd-service-user-join-split-name-1',
    type: 'message_created',
    message: {
      messageId: 'msg-service-user-join-split-name-1',
      chatId: 'chat-1',
      senderId: 'service-1',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      message: {
        sender: {
          id: 'service-1',
          type: 'service',
          is_service: true,
        },
        body: {
          new_members: [
            {
              user_id: 'user-split-name-1',
              type: 'user',
              first_name: 'Анна',
              last_name: 'Каренина',
              username: 'anna',
            },
          ],
        },
      },
    },
  };
}

function createServiceUserJoinedUpdateInDataEnvelope(): MaxUpdate {
  return {
    updateId: 'upd-service-user-join-envelope-1',
    type: 'message_created',
    message: {
      messageId: 'msg-service-user-join-envelope-1',
      chatId: 'chat-1',
      senderId: 'service-1',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'message_created',
      data: {
        message: {
          sender: {
            id: 'service-1',
            type: 'service',
            is_service: true,
          },
          body: {
            new_members: [
              {
                user_id: 'user-envelope-2',
                type: 'user',
                display_name: 'Новый участник из data',
              },
            ],
          },
        },
      },
    },
  };
}

function createServiceUserJoinedUpdateWithoutServiceSender(): MaxUpdate {
  return {
    updateId: 'upd-service-user-join-no-sender-1',
    type: 'message_created',
    message: {
      messageId: 'msg-service-user-join-no-sender-1',
      chatId: 'chat-1',
      senderId: '',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'message_created',
      message: {
        body: {
          new_members: [
            {
              user_id: 'user-no-sender-2',
              type: 'user',
              display_name: 'Новый участник без sender',
            },
          ],
        },
      },
    },
  };
}

function createUserAddedUpdate(): MaxUpdate {
  return {
    updateId: 'upd-user-added-1',
    type: 'user_added',
    message: {
      messageId: 'user_added:upd-user-added-1',
      chatId: 'chat-1',
      senderId: 'user-added-1',
      senderName: 'Новый участник user_added',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'user_added',
      chat_id: 'chat-1',
      user: {
        user_id: 'user-added-1',
        type: 'user',
        display_name: 'Новый участник user_added',
      },
      timestamp: Date.now(),
    },
  };
}

function createUserAddedUpdateWithSuffix(suffix: number | string): MaxUpdate {
  const normalizedSuffix = String(suffix);
  return {
    updateId: `upd-user-added-${normalizedSuffix}`,
    type: 'user_added',
    message: {
      messageId: `user_added:upd-user-added-${normalizedSuffix}`,
      chatId: 'chat-1',
      senderId: `user-added-${normalizedSuffix}`,
      senderName: `Новый участник user_added ${normalizedSuffix}`,
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'user_added',
      chat_id: 'chat-1',
      user: {
        user_id: `user-added-${normalizedSuffix}`,
        type: 'user',
        display_name: `Новый участник user_added ${normalizedSuffix}`,
      },
      timestamp: Date.now(),
    },
  };
}

function createUserRemovedUpdate(): MaxUpdate {
  return {
    updateId: 'upd-user-removed-1',
    type: 'user_removed',
    message: {
      messageId: 'user_removed:upd-user-removed-1',
      chatId: 'chat-1',
      senderId: 'user-removed-1',
      senderName: 'Пользователь вышел',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'user_removed',
      chat_id: 'chat-1',
      user: {
        user_id: 'user-removed-1',
        type: 'user',
        display_name: 'Пользователь вышел',
      },
      timestamp: Date.now(),
    },
  };
}

function createBotRemovedUpdate(): MaxUpdate {
  return {
    updateId: 'upd-bot-removed-1',
    type: 'bot_removed',
    message: {
      messageId: 'bot_removed:upd-bot-removed-1',
      chatId: 'chat-1',
      senderId: 'bot-removed-1',
      senderName: 'Бот вышел',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'bot_removed',
      chat_id: 'chat-1',
      user: {
        user_id: 'bot-removed-1',
        type: 'bot',
        display_name: 'Бот вышел',
      },
      timestamp: Date.now(),
    },
  };
}

function createBotStartedPrivateUpdate(): MaxUpdate {
  return {
    updateId: 'upd-bot-started-private-1',
    type: 'bot_started',
    message: {
      messageId: 'bot_started:upd-bot-started-private-1',
      chatId: '152517912',
      senderId: 'user-started-1',
      senderName: 'Пользователь bot_started',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'bot_started',
      chat_id: 152517912,
      chat: {
        id: 152517912,
        type: 'dialog',
      },
      user: {
        user_id: 'user-started-1',
        type: 'user',
        display_name: 'Пользователь bot_started',
      },
      timestamp: Date.now(),
    },
  };
}

function createBotStartedPrivateHandoffUpdate(startPayload = 'broadcast_handoff'): MaxUpdate {
  return {
    updateId: 'upd-bot-started-private-handoff-1',
    type: 'bot_started',
    message: {
      messageId: 'bot_started:upd-bot-started-private-handoff-1',
      chatId: '152517912',
      senderId: 'user-started-1',
      senderName: 'Пользователь bot_started',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'bot_started',
      chat_id: 152517912,
      start_payload: startPayload,
      chat: {
        id: 152517912,
        type: 'dialog',
      },
      user: {
        user_id: 'user-started-1',
        type: 'user',
        display_name: 'Пользователь bot_started',
      },
      timestamp: Date.now(),
    },
  };
}

function createBotStartedGroupUpdate(): MaxUpdate {
  return {
    updateId: 'upd-bot-started-group-1',
    type: 'bot_started',
    message: {
      messageId: 'bot_started:upd-bot-started-group-1',
      chatId: '-71527833503751',
      senderId: 'user-started-group-1',
      senderName: 'Пользователь bot_started group',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'bot_started',
      chat_id: -71527833503751,
      chat: {
        id: -71527833503751,
        type: 'chat',
      },
      user: {
        user_id: 'user-started-group-1',
        type: 'user',
        display_name: 'Пользователь bot_started group',
      },
      timestamp: Date.now(),
    },
  };
}

function createPrivateCommandUpdate(text: string): MaxUpdate {
  return {
    updateId: 'upd-private-command-1',
    type: 'message_created',
    message: {
      messageId: 'msg-private-command-1',
      chatId: '152517912',
      senderId: 'user-private-1',
      senderName: 'Пользователь private',
      text,
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'message_created',
      message: {
        body: {
          mid: 'msg-private-command-1',
          text,
        },
        sender: {
          user_id: 'user-private-1',
          type: 'user',
        },
        recipient: {
          chat_id: 152517912,
          chat_type: 'dialog',
        },
      },
    },
  };
}

function createPrivateCallbackUpdate(payload: string): MaxUpdate {
  return {
    updateId: 'upd-private-callback-1',
    type: 'message_callback',
    message: {
      messageId: 'msg-private-callback-1',
      chatId: '152517912',
      senderId: '613002203036',
      senderName: 'Майор Максимов',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'message_callback',
      callback: {
        callback_id: 'callback-1',
        payload,
        user: {
          user_id: 'user-private-1',
        },
      },
      message: {
        recipient: {
          chat_id: 152517912,
        },
      },
    },
  };
}

function createGroupRulesCallbackUpdate(options: { botId?: string } = {}): MaxUpdate {
  return {
    updateId: 'upd-group-rules-callback-1',
    ...(options.botId ? { botId: options.botId } : {}),
    type: 'message_callback',
    message: {
      messageId: 'msg-group-rules-callback-1',
      chatId: 'chat-1',
      senderId: 'user-1',
      senderName: 'Алексей',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'message_callback',
      callback: {
        callback_id: 'callback-rules-1',
        payload: 'rules:open',
        user: {
          user_id: 'user-1',
        },
      },
      message: {
        recipient: {
          chat_id: 'chat-1',
        },
      },
    },
  };
}

function createModerationReleaseCallbackUpdate(params: {
  action: 'UNBAN' | 'UNMUTE';
  sanctionEventId?: string;
  messageChatId?: string;
  actorUserId?: string | null;
  callbackId?: string;
  updateId?: string;
}): MaxUpdate {
  const sanctionEventId = params.sanctionEventId ?? 'sanction-event-1';
  const messageChatId = params.messageChatId ?? 'chat-1';
  const actorUserId = params.actorUserId === undefined ? 'admin-1' : params.actorUserId;
  const callbackId = params.callbackId ?? 'callback-release-1';

  return {
    updateId: params.updateId ?? 'upd-release-1',
    botId: 'bot-1',
    type: 'message_callback',
    message: {
      messageId: 'msg-release-1',
      chatId: messageChatId,
      senderId: 'bot-1',
      senderName: 'Майор Максимов',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'message_callback',
      callback: {
        callback_id: callbackId,
        payload: buildModerationReleaseCallbackPayload(params.action, sanctionEventId),
        ...(actorUserId
          ? {
              user: {
                user_id: actorUserId,
              },
            }
          : {}),
      },
      message: {
        recipient: {
          chat_id: messageChatId,
        },
      },
    },
  };
}

function createChannelSuggestionCallbackUpdate(payload: string): MaxUpdate {
  return {
    updateId: 'upd-channel-suggest-callback-1',
    botId: 'bot-channel-1',
    type: 'message_callback',
    message: {
      messageId: 'msg-channel-suggest-callback-1',
      chatId: 'channel-1',
      senderId: '613002203036',
      senderName: 'Майор Максимов',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'message_callback',
      callback: {
        callback_id: 'callback-suggest-1',
        payload,
        user: {
          user_id: 'user-1',
        },
      },
      message: {
        recipient: {
          chat_id: 'channel-1',
        },
      },
    },
  };
}

function createOldUpdate(): MaxUpdate {
  return {
    updateId: 'upd-old-1',
    type: 'message_created',
    message: {
      messageId: 'msg-old-1',
      chatId: 'chat-1',
      senderId: 'user-1',
      senderName: 'Алексей',
      text: 'old text',
      createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    },
    raw: {},
  };
}

function createRequiredSubscriptionRedisCounter() {
  const stringCache = new Map<string, string>();

  return {
    stringCache,
    addToSetWithTtl: jest.fn().mockResolvedValue({ added: false, size: 1 }),
    incrementWithTtl: jest.fn().mockResolvedValue(1),
    getString: jest.fn(async (key: string) => stringCache.get(key) ?? null),
    setStringWithTtl: jest.fn(async (key: string, value: string) => {
      stringCache.set(key, value);
    }),
  };
}

function createForwardedUpdate(forwardedText: string): MaxUpdate {
  return {
    updateId: 'upd-forwarded-1',
    type: 'message_created',
    message: {
      messageId: 'msg-forwarded-1',
      chatId: 'chat-1',
      senderId: 'user-1',
      senderName: 'Алексей',
      text: 'коротко',
      createdAt: new Date().toISOString(),
    },
    raw: {
      message: {
        body: {
          text: 'коротко',
          forwarded_message: {
            body: {
              text: forwardedText,
            },
          },
        },
      },
    },
  };
}

function createLinkedForwardUpdate(suffix = 1): MaxUpdate {
  return {
    updateId: `upd-linked-forward-${suffix}`,
    type: 'message_created',
    message: {
      messageId: `msg-linked-forward-${suffix}`,
      chatId: 'chat-1',
      senderId: 'user-1',
      senderName: 'Алексей',
      text: `пересланный текст ${suffix}`,
      createdAt: new Date().toISOString(),
    },
    raw: {
      message: {
        body: null,
        link: {
          type: 'forward',
          message: {
            body: {
              text: `пересланный текст ${suffix}`,
            },
          },
        },
      },
    },
  };
}

function createVideoAttachmentUpdate(suffix = 1): MaxUpdate {
  return {
    updateId: `upd-video-${suffix}`,
    type: 'message_created',
    message: {
      messageId: `msg-video-${suffix}`,
      chatId: 'chat-1',
      senderId: 'user-1',
      senderName: 'Алексей',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      message: {
        attachments: [
          {
            type: 'video',
            payload: {
              url: `https://cdn.example/video-${suffix}.mp4`,
            },
          },
        ],
      },
    },
  };
}

function createStickerAttachmentUpdate(suffix = 1): MaxUpdate {
  return {
    updateId: `upd-sticker-${suffix}`,
    type: 'message_created',
    message: {
      messageId: `msg-sticker-${suffix}`,
      chatId: 'chat-1',
      senderId: 'user-1',
      senderName: 'Алексей',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      message: {
        attachments: [
          {
            type: 'sticker',
            payload: {
              mime_type: 'image/webp',
              url: `https://cdn.example/sticker-${suffix}.webp`,
            },
          },
        ],
      },
    },
  };
}

function createVoiceAttachmentUpdate(suffix = 1): MaxUpdate {
  return {
    updateId: `upd-voice-${suffix}`,
    type: 'message_created',
    message: {
      messageId: `msg-voice-${suffix}`,
      chatId: 'chat-1',
      senderId: 'user-1',
      senderName: 'Алексей',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      message: {
        attachments: [
          {
            type: 'voice',
            payload: {
              url: `https://cdn.example/voice-${suffix}.ogg`,
            },
          },
        ],
      },
    },
  };
}

function createFileAttachmentUpdate(suffix = 1): MaxUpdate {
  return {
    updateId: `upd-file-${suffix}`,
    type: 'message_created',
    message: {
      messageId: `msg-file-${suffix}`,
      chatId: 'chat-1',
      senderId: 'user-1',
      senderName: 'Алексей',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      message: {
        attachments: [
          {
            type: 'file',
            payload: {
              file_name: `document-${suffix}.pdf`,
              url: `https://cdn.example/document-${suffix}.pdf`,
            },
          },
        ],
      },
    },
  };
}

function createMediaGroupMarkerUpdate(suffix = 1): MaxUpdate {
  return {
    updateId: `upd-media-group-${suffix}`,
    type: 'message_created',
    message: {
      messageId: `msg-media-group-${suffix}`,
      chatId: 'chat-1',
      senderId: 'user-1',
      senderName: 'Алексей',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      message: {
        body: {
          media_group_id: `group-${suffix}`,
        },
      },
    },
  };
}

function createForwardedVideoAttachmentUpdate(): MaxUpdate {
  return {
    updateId: 'upd-forwarded-video-1',
    type: 'message_created',
    message: {
      messageId: 'msg-forwarded-video-1',
      chatId: 'chat-1',
      senderId: 'user-1',
      senderName: 'Алексей',
      text: 'переслано',
      createdAt: new Date().toISOString(),
    },
    raw: {
      message: {
        body: {
          text: 'переслано',
          forwarded_message: {
            attachments: [
              {
                type: 'video',
                payload: {
                  url: 'https://cdn.example/forwarded-video.mp4',
                },
              },
            ],
          },
        },
      },
    },
  };
}

function createForwardedVoiceAttachmentUpdate(): MaxUpdate {
  return {
    updateId: 'upd-forwarded-voice-1',
    type: 'message_created',
    message: {
      messageId: 'msg-forwarded-voice-1',
      chatId: 'chat-1',
      senderId: 'user-1',
      senderName: 'Алексей',
      text: 'переслано',
      createdAt: new Date().toISOString(),
    },
    raw: {
      message: {
        body: {
          text: 'переслано',
          forwarded_message: {
            attachments: [
              {
                type: 'voice',
                payload: {
                  url: 'https://cdn.example/forwarded-voice.ogg',
                },
              },
            ],
          },
        },
      },
    },
  };
}

function createForwardedFileAttachmentUpdate(): MaxUpdate {
  return {
    updateId: 'upd-forwarded-file-1',
    type: 'message_created',
    message: {
      messageId: 'msg-forwarded-file-1',
      chatId: 'chat-1',
      senderId: 'user-1',
      senderName: 'Алексей',
      text: 'переслано',
      createdAt: new Date().toISOString(),
    },
    raw: {
      message: {
        body: {
          text: 'переслано',
          forwarded_message: {
            attachments: [
              {
                type: 'file',
                payload: {
                  file_name: 'forwarded.pdf',
                  url: 'https://cdn.example/forwarded.pdf',
                },
              },
            ],
          },
        },
      },
    },
  };
}

function createImageFileAttachmentUpdate(): MaxUpdate {
  return {
    updateId: 'upd-image-file-1',
    type: 'message_created',
    message: {
      messageId: 'msg-image-file-1',
      chatId: 'chat-1',
      senderId: 'user-1',
      senderName: 'Алексей',
      text: '',
      createdAt: new Date().toISOString(),
    },
    raw: {
      message: {
        attachments: [
          {
            type: 'file',
            payload: {
              mime_type: 'image/jpeg',
              file_name: 'photo-as-file.jpg',
              url: 'https://cdn.example/photo-as-file.jpg',
            },
          },
        ],
      },
    },
  };
}

function createReplyToPhotoUpdate(): MaxUpdate {
  return {
    updateId: 'upd-reply-photo-1',
    type: 'message_created',
    message: {
      messageId: 'msg-reply-photo-1',
      chatId: 'chat-1',
      senderId: 'user-1',
      senderName: 'Алексей',
      text: 'Спасибо, понял',
      createdAt: new Date().toISOString(),
    },
    raw: {
      message: {
        body: {
          text: 'Спасибо, понял',
        },
        link: {
          type: 'reply',
          message: {
            text: '',
            attachments: [
              {
                type: 'image',
                payload: {
                  mime_type: 'image/jpeg',
                  url: 'https://cdn.example/admin-photo.jpg',
                },
              },
            ],
          },
        },
      },
    },
  };
}

export {
  REQUIRED_SUBSCRIPTION_MAX_CHANNELS,
  USER_AGREEMENT_SHORT_NOTICE,
  markMaxMemberMutationAttempted,
  ChatEntityType,
  EventType,
  Operator,
  SanctionAction,
  WebhookParser,
  ChatRulesPublishFenceRetryError,
  createDuplicateSanctionAuthorization,
  buildActiveMuteStateKey,
  buildModerationReleaseCallbackPayload,
  ModerationSanctionStateLockLeaseLostError,
  INCIDENT_EXTERNAL_FORWARD_FIXTURE,
  INCIDENT_EXTERNAL_URL,
  INCIDENT_PROFILE_MENTION_FORWARD_FIXTURE,
  DEVELOPER_FORCED_GLOBAL_SPAMMER_WARM_MARKER_TTL_SEC,
  buildDeveloperForcedGlobalSpammerCacheKey,
  buildDeveloperForcedGlobalSpammerWarmMarkerKey,
  ModerationService,
  resolveModerationDeleteIntentRollout,
  WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX,
  WebhookCanonicalExecutionService,
  WebhookOrderedPredecessorPendingError,
  WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_HEARTBEAT_MS,
  WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_MAX_LIFETIME_MS,
  WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PERSIST_RETRY_MS,
  WEBHOOK_HOT_PATH_TIMEOUT_TERMINAL_QUARANTINE_PREFIX,
  RuleEngineService,
  ADMIN_CONTACT_DISPLAY_NAME_LOOKUP_TIMEOUT_MS,
  DEVELOPER_FORCED_GLOBAL_SPAMMER_HOT_PATH_TIMEOUT_MS,
  DUPLICATE_FOLLOW_UP_HOT_PATH_TIMEOUT_MS,
  GLOBAL_SPAMMER_CONFIRMED_FANOUT_EPISODE_THRESHOLD,
  GLOBAL_SPAMMER_EXEMPTION_HOT_PATH_TIMEOUT_MS,
  GLOBAL_SPAMMER_EXEMPTION_HOT_PATH_MAX_ADMIN_IDS,
  GLOBAL_SPAMMER_HIGH_FANOUT_MIN_CHATS,
  GLOBAL_SPAMMER_TRACK_HOT_PATH_TIMEOUT_MS,
  MODERATION_ACTION_ACCESS_LOSS_HOT_PATH_TIMEOUT_MS,
  MODERATION_ACTION_DISPATCH_TIMEOUT_MS,
  REQUIRED_SUBSCRIPTION_MEMBERSHIP_HOT_PATH_TIMEOUT_MS,
  SHARED_CHAT_EXECUTION_LOCK_AMBIGUOUS_RETRY_AFTER_MS,
  createDeferred,
  extractSqlText,
  escapeMaxMarkdown,
  userMention,
  majorExplanation,
  duplicateExplanation,
  muteNotice,
  permanentBanNotice,
  textFilterWarnNotice,
  linkWarnNotice,
  editedLinkWarnNotice,
  messageLimitsWarnNotice,
  messageLimitsBanNotice,
  expectImmediateDeleteMessage,
  expectImmediateKickMember,
  expectImmediateBanMember,
  nightModeNotice,
  nightModeOpenNotice,
  createMaxApiError,
  createRedisCounterMock,
  createModerationServiceWithManualBridge,
  createModerationServiceWithSanctionStateLock,
  createSettings,
  createUpdate,
  installImmediateTimeoutForDelay,
  createLiveNavigationEnvelopeUpdate,
  createLiveNavigationHarness,
  createNumericSenderNameUpdate,
  createNumericSenderLinkBanHarness,
  createPhotoAttachmentUpdate,
  createAdminForwardedBanUpdate,
  createAdminLinkedModerationUpdate,
  createAdminReplyModerationUpdate,
  createAdminForwardedRulesUpdate,
  createBotAuthoredUpdate,
  createOwnBotUpdateWithoutBotFlags,
  createServiceBotJoinedUpdate,
  createBotAddedUpdate,
  createServiceUserJoinedUpdate,
  createServiceUserJoinedUpdateWithSplitName,
  createServiceUserJoinedUpdateInDataEnvelope,
  createServiceUserJoinedUpdateWithoutServiceSender,
  createUserAddedUpdate,
  createUserAddedUpdateWithSuffix,
  createUserRemovedUpdate,
  createBotRemovedUpdate,
  createBotStartedPrivateUpdate,
  createBotStartedPrivateHandoffUpdate,
  createBotStartedGroupUpdate,
  createPrivateCommandUpdate,
  createPrivateCallbackUpdate,
  createGroupRulesCallbackUpdate,
  createModerationReleaseCallbackUpdate,
  createChannelSuggestionCallbackUpdate,
  createOldUpdate,
  createRequiredSubscriptionRedisCounter,
  createForwardedUpdate,
  createLinkedForwardUpdate,
  createVideoAttachmentUpdate,
  createStickerAttachmentUpdate,
  createVoiceAttachmentUpdate,
  createFileAttachmentUpdate,
  createMediaGroupMarkerUpdate,
  createForwardedVideoAttachmentUpdate,
  createForwardedVoiceAttachmentUpdate,
  createForwardedFileAttachmentUpdate,
  createImageFileAttachmentUpdate,
  createReplyToPhotoUpdate,
  type MaxUpdate,
  type LiveNavigationEnvelopeType,
};
