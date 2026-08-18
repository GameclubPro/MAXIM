import { HttpService } from '@nestjs/axios';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UnrecoverableError, type Job, type Queue } from 'bullmq';
import FormData from 'form-data';
import { createHash, randomUUID } from 'node:crypto';
import { firstValueFrom } from 'rxjs';
import Redis from 'ioredis';
import {
  internalChannelDialogButtonIdentityKey,
  readInternalChannelDialogButtonIdentity,
  readInternalChannelDialogButtonIdentitiesFromMessage,
  type InternalChannelDialogButtonIdentity,
} from '../common/channel-dialog-button-identity.util';
import { isPrivateDirectChatId } from '../common/chat-id.util';
import { resolveMaxUserDisplayName } from '../common/max-user-display-name.util';
import type { QueueJobEnvelope, QueueRetryPolicyName } from '../common/queue-job-envelope';
import { ActionHealthService, type ActionHealthLane } from '../system/action-health.service';
import { RuntimeDiagnosticsService } from '../system/runtime-diagnostics.service';
import { MaxBotContextService } from './max-bot-context.service';
import {
  MaxBotLinkService,
  type MaxBotRoute,
  type MaxBotRouteRequest,
} from './max-bot-link.service';
import { MaxBotRegistryService, type MaxBotDefinition } from './max-bot-registry.service';
import type { MaxBotLifecycleState } from './max-bot-config.util';
import { canExecuteActionsForBotState } from './max-bot-state.util';
import { normalizeMaxInlineKeyboardButtons } from './max-inline-keyboard-layout';
import {
  markMaxMemberMutationAttempted,
  markMaxMemberMutationConfirmed,
  wasMaxMemberMutationAttempted,
} from './max-member-error.util';
import { isAmbiguousMaxMutationError, isAmbiguousMaxSendError } from './max-send-ambiguity.util';
import {
  MAX_AUDIO_UPLOAD_MAX_BYTES,
  MAX_FILE_UPLOAD_MAX_BYTES,
  MAX_IMAGE_UPLOAD_MAX_BYTES,
  MAX_VIDEO_UPLOAD_MAX_BYTES,
} from './max-video-upload.constants';
import { MaxMediaUploadValidationCache } from './max-media-upload-validation-cache';
import type {
  MaxValidatedImageUpload,
  MaxValidatedMediaUpload,
  MaxValidatedVideoUpload,
} from './max-media-upload-validation';
import {
  buildMaxApiServiceBotClassMetricKey,
  buildMaxApiServiceStackClassMetricKey,
  normalizeMaxApiRateLimitServiceScope,
} from './max-api-metrics-key.util';
import {
  markMaxSendDispatchLedgerFinalized,
  MaxActionLedgerService,
} from './max-action-ledger.service';
import {
  markMaxPreDispatchGuardRejected,
  MAX_DELETE_PRE_DISPATCH_GUARD_REJECTED_CODE,
  MAX_EDIT_PRE_DISPATCH_GUARD_REJECTED_CODE,
  MAX_MEMBER_PRE_DISPATCH_GUARD_REJECTED_CODE,
  wasMaxPreDispatchGuardRejected,
} from './max-action-pre-dispatch-guard';
import {
  MAX_ACTION_BACKGROUND_QUEUE,
  MAX_ACTION_CRITICAL_QUEUE,
  MAX_ACTION_INTERACTIVE_QUEUE,
  MAX_ACTION_LEGACY_QUEUE,
  resolveMaxActionQueueName,
} from './max-action.queue';

export type MaxBotChat = {
  chatId: string;
  title: string | null;
  lastEventTime: number | null;
  entityType: 'chat' | 'channel';
  link: string | null;
  avatarUrl: string | null;
  botId?: string | null;
  botIds?: string[];
};

export type MaxChatSnapshot = {
  chatId: string;
  title: string | null;
  participantsCount: number | null;
  status: string | null;
  isPublic: boolean | null;
  link: string | null;
  lastEventAt: string | null;
  entityType: 'chat' | 'channel';
  avatarUrl: string | null;
};

export type MaxChannelMessageSnapshot = {
  chatId: string;
  messageId: string;
  publishedAt: string;
  publishedAtMs: number;
  url: string | null;
  previewUrl: string | null;
  views: number | null;
  reactionsTotal: number | null;
  reactions: MaxChannelMessageReaction[];
};

export type MaxExactMessagePresence = 'present' | 'absent';

export type MaxExactMessagePresenceRequest = {
  chatId: string;
  messageId: string;
};

export type MaxExactMessagePresenceResult =
  | (MaxExactMessagePresenceRequest & { presence: MaxExactMessagePresence })
  | (MaxExactMessagePresenceRequest & { error: unknown });

type MaxExactMessagePresenceOutcome = { presence: MaxExactMessagePresence } | { error: unknown };

export type MaxChannelMessageReaction = {
  emoji: string;
  count: number;
};

export type MaxWebhookSubscription = {
  url: string;
  updateTypes: string[];
};

export type MaxChatMemberProfile = {
  userId: string;
  displayName: string | null;
  username: string | null;
  avatarUrl: string | null;
  profileUrl: string | null;
};

export type MaxChatMemberAccess = {
  userId: string | null;
  isAdmin: boolean;
  isOwner: boolean;
  permissions: string[];
};

export type MaxChatMemberRole = 'owner' | 'admin' | 'member';
export type MaxChatRosterUnavailableReason = 'deleted' | 'blocked' | 'deactivated' | 'suspended';

export type MaxChatRosterMember = {
  userId: string;
  displayName: string | null;
  username: string | null;
  avatarUrl: string | null;
  profileUrl: string | null;
  role: MaxChatMemberRole;
  isBot: boolean;
  unavailableReason: MaxChatRosterUnavailableReason | null;
};

export type MaxChatMembersPage = {
  items: MaxChatRosterMember[];
  nextMarker: string | null;
};

export type MaxApiTrafficClass = 'critical' | 'interactive' | 'background';

type MaxMessageMutationOperation = 'send' | 'edit' | 'delete' | 'answer';

type MaxMessageMutationRateLimitScope = {
  operation: MaxMessageMutationOperation;
  entityId: string | null;
};

export type MaxPublishedMessage = {
  messageId: string;
  url: string | null;
  chatId?: string | null;
};

type MaxMessageMarkup = {
  from: number;
  length: number;
  type:
    | 'emphasized'
    | 'heading'
    | 'link'
    | 'monospaced'
    | 'strikethrough'
    | 'strong'
    | 'underline'
    | 'user_mention';
  url: string | null;
  userLink: string | null;
};

const MAX_CHAT_POST_LINK_BASE_URL = 'https://max.ru';
const DEFAULT_SUCCESS_FALSE_STATUS = 200;
const MAX_UPLOAD_BINARY_TIMEOUT_MS = 30_000;
const MAX_UPLOAD_FILENAME_MAX_LENGTH = 180;
const MAX_RESUMABLE_VIDEO_UPLOAD_CHUNK_BYTES = 4 * 1_024 * 1_024;
const MAX_RESUMABLE_VIDEO_UPLOAD_SESSION_ATTEMPTS = 2;
const MAX_LIST_BOT_CHATS_UNSUPPORTED_IN_PRODUCTION =
  'MAX API GET /chats is not supported in production; use webhook/subscription managed chat catalog instead. See https://dev.max.ru/docs-api/methods/GET/chats';
const MAX_MESSAGE_SEND_ATTEMPTED = Symbol('max-message-send-attempted');

export function wasMaxMessageSendAttempted(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    (error as { [MAX_MESSAGE_SEND_ATTEMPTED]?: unknown })[MAX_MESSAGE_SEND_ATTEMPTED] === true,
  );
}

function markMaxMessageSendAttempted(error: unknown): unknown {
  if (error && typeof error === 'object') {
    Object.defineProperty(error, MAX_MESSAGE_SEND_ATTEMPTED, {
      configurable: false,
      enumerable: false,
      value: true,
      writable: false,
    });
    return error;
  }
  const wrapped = new Error(String(error));
  Object.defineProperty(wrapped, MAX_MESSAGE_SEND_ATTEMPTED, { value: true });
  return wrapped;
}

export {
  markMaxMemberMutationAttempted,
  markMaxMemberMutationConfirmed,
  wasMaxMemberMutationAttempted,
  wasMaxMemberMutationConfirmed,
} from './max-member-error.util';

export class MaxApiRequestRejectedError extends Error {
  readonly response: {
    status: number;
    data: unknown;
  };

  constructor(status: number, payload: unknown, message: string) {
    super(message);
    this.name = 'MaxApiRequestRejectedError';
    this.response = {
      status,
      data: payload,
    };
  }
}

export class MaxApiCircuitOpenError extends Error {
  readonly code = 'MAX_API_CIRCUIT_OPEN';
  readonly preDispatch = true;

  constructor(
    readonly botId: string,
    readonly retryAfterMs: number,
  ) {
    super('MAX API circuit breaker is open');
    this.name = 'MaxApiCircuitOpenError';
  }
}

export function isMaxApiCircuitOpenError(error: unknown): error is MaxApiCircuitOpenError {
  return (
    error instanceof MaxApiCircuitOpenError ||
    (Boolean(error) &&
      typeof error === 'object' &&
      (error as { code?: unknown }).code === 'MAX_API_CIRCUIT_OPEN' &&
      (error as { preDispatch?: unknown }).preDispatch === true)
  );
}

class MaxApiInternalRateLimitError extends Error {
  readonly code = 'MAX_API_INTERNAL_RATE_LIMIT';
  readonly preDispatch = true;

  constructor(
    message: string,
    readonly retryAfterMs: number,
  ) {
    super(message);
    this.name = 'MaxApiInternalRateLimitError';
  }
}

export type MaxButtonIntent = 'default' | 'positive' | 'negative';

export type MaxLinkButton = {
  type?: 'link';
  text: string;
  url: string;
};

export type MaxCallbackButton = {
  type: 'callback';
  text: string;
  payload: string;
  intent?: MaxButtonIntent;
};

export type MaxOpenAppButton = {
  type: 'open_app';
  text: string;
  webApp?: string | null;
  contactId?: string | number | null;
};

export type MaxRequestContactButton = {
  type: 'request_contact';
  text: string;
};

export type MaxRequestGeoLocationButton = {
  type: 'request_geo_location';
  text: string;
  quick?: boolean;
};

export type MaxClipboardButton = {
  type: 'clipboard';
  text: string;
  payload: string;
};

export type MaxChatButton = {
  type: 'chat';
  text: string;
  chatTitle: string;
  chatDescription?: string | null;
  startPayload?: string | null;
  uuid?: string | null;
};

export type MaxReplyMessageLink = {
  type: 'reply';
  mid: string;
};

export type MaxTextFormat = 'markdown' | 'html';
export type MaxMediaAttachmentType = 'image' | 'video' | 'audio' | 'file';
export type MaxAttachmentPayload = {
  type: MaxMediaAttachmentType;
  payload: Record<string, unknown>;
};

export type MaxMessageButton =
  | MaxLinkButton
  | MaxCallbackButton
  | MaxOpenAppButton
  | MaxRequestContactButton
  | MaxRequestGeoLocationButton
  | MaxClipboardButton
  | MaxChatButton;

export type MaxSendMessageOptions = {
  button?: MaxLinkButton;
  buttons?: MaxMessageButton[][];
  imagePayload?: Record<string, unknown>;
  attachments?: MaxAttachmentPayload[];
  messageLink?: MaxReplyMessageLink | null;
  textFormat?: MaxTextFormat;
  debugContext?: {
    screen?: string;
    action?: string;
  };
};

type MaxEditableMessageOptions = Pick<
  MaxSendMessageOptions,
  'button' | 'buttons' | 'debugContext' | 'textFormat'
> & {
  appendNewInlineKeyboardRows?: boolean;
  mergeExistingInlineKeyboard?: boolean;
  preserveExistingInlineKeyboard?: boolean;
  replaceCallbackPayloadPrefixes?: readonly string[];
  beforeEditMutation?: () => Promise<void>;
};

type MaxImmediateSendMessageOptions = MaxSendMessageOptions & {
  beforeSend?: () => Promise<void>;
};

export type MaxCustomMessagePayload = {
  text?: string;
  attachments?: Record<string, unknown>[];
  messageLink?: MaxReplyMessageLink | null;
  textFormat?: MaxTextFormat;
};

export type MaxCallbackMessageEdit = {
  messageId?: string;
  text: string;
  options?: MaxSendMessageOptions & MaxEditableMessageOptions;
};

export type MaxActionType =
  | 'DELETE_MESSAGE'
  | 'SEND_MESSAGE'
  | 'KICK_MEMBER'
  | 'BAN_MEMBER'
  | 'UNBAN_MEMBER'
  | 'NOTIFY_MODERATORS';

export type MaxActionRoutingMetadata = {
  purpose:
    | Extract<MaxBotRouteRequest['purpose'], 'send_message' | 'moderation_action'>
    | 'channel_poll';
  primaryBotId?: string | null;
  reason?: string | null;
  action?: 'delete_message' | 'moderate_member';
  routingVersion?: number | null;
  sendRouteHalfOpenProbe?: 'publication_exact_verification';
};

export type MaxActionLedgerContextValue =
  | string
  | number
  | boolean
  | null
  | MaxActionLedgerContextValue[]
  | { [key: string]: MaxActionLedgerContextValue };

export type MaxActionLedgerContext = {
  [key: string]: MaxActionLedgerContextValue;
};

export type MaxActionJob = QueueJobEnvelope<
  {
    actionType: MaxActionType;
    chatId: string;
    botId?: string;
    candidateBotIds?: string[];
    routing?: MaxActionRoutingMetadata;
    attemptedBotIds?: string[];
    trafficClass?: MaxApiTrafficClass;
    actionHealthLane?: ActionHealthLane;
    sourceTag?: string;
    timeoutMs?: number;
    messageId?: string;
    userId?: string;
    text?: string;
    options?: MaxSendMessageOptions;
    ledgerContext?: MaxActionLedgerContext;
    autoDeleteDelayMs?: number;
    ignoreFailureMetricStatuses?: number[];
    attempt: number;
    idempotencyKey: string;
    createdAt: string;
    scheduledFor?: string;
  },
  {
    retryPolicyName?: Extract<QueueRetryPolicyName, 'max-action'>;
  }
>;

export type MaxActionDispatchOptions = {
  delayMs?: number;
  immediate?: boolean;
  /** Ephemeral guard evaluated after routing and ledger work, immediately before delete HTTP. */
  beforeImmediateDeleteMutation?: () => Promise<void>;
  /** Ephemeral guard evaluated after routing and ledger work, immediately before member HTTP. */
  beforeImmediateMemberMutation?: () => Promise<void>;
  autoDeleteDelayMs?: number;
  /**
   * Caller-provided logical dedupe key. Routed actions are scoped by action only;
   * explicitly bot-bound actions retain the legacy bot/action scope.
   */
  idempotencyKey?: string | null;
  trafficClass?: MaxApiTrafficClass;
  actionHealthLane?: ActionHealthLane;
  sourceTag?: string;
  timeoutMs?: number;
  ignoreFailureMetricStatuses?: readonly number[];
  botId?: string;
  candidateBotIds?: readonly string[];
  routing?: MaxActionRoutingMetadata;
  ledgerContext?: MaxActionLedgerContext;
};

type MaxActionExecutionOptions = {
  beforeDeleteMutation?: () => Promise<void>;
  beforeMemberMutation?: () => Promise<void>;
};

type MaxApiRequestOptions = {
  trafficClass?: MaxApiTrafficClass;
  actionHealthLane?: ActionHealthLane;
  sourceTag?: string;
  bypassCache?: boolean;
  ignoreFailureMetricStatuses?: readonly number[];
  timeoutMs?: number;
  botId?: string;
  forceUpsert?: boolean;
  rateLimitEntityId?: string;
};

export const MAX_API_SOURCE_TAGS = {
  MANAGED_REFRESH: 'managed_refresh',
  MODERATION_DELETE: 'moderation_delete',
  MODERATION_SANCTION: 'moderation_sanction',
  MODERATION_NOTICE: 'moderation_notice',
  NIGHT_MODE_TRANSITION: 'night_mode_transition',
  PARTICIPANT_SEARCH: 'participant_search',
  PARTICIPANT_CLEANUP: 'participant_cleanup',
  SETTINGS_BOT_PROFILE: 'settings_bot_profile',
  MANAGED_HANDSHAKE: 'managed_handshake',
  CHAT_RULES: 'chat_rules',
  MANAGED_POLL: 'managed_poll',
  MANAGED_GIVEAWAY: 'managed_giveaway',
  GIVEAWAY_DRAW_BACKGROUND: 'giveaway_draw_background',
  MANAGED_BROADCAST: 'managed_broadcast',
  CHANNEL_AUTO_POST: 'channel_auto_post',
  COMMENT_NOTIFICATION: 'comment_notification',
  SUGGESTION_DELIVERY: 'suggestion_delivery',
  CALLBACK_ANSWER: 'callback_answer',
  KARAVAN_STOREFRONT_RELAY: 'karavan_storefront_relay',
  VK_PARSING: 'vk_parsing',
  CHANNEL_STATS_SYNC: 'channel_stats_sync',
  WEBHOOK_SUBSCRIPTION_RECONCILE: 'webhook_subscription_reconcile',
  REQUIRED_SUBSCRIPTION_MEMBERSHIP: 'required_subscription_membership',
  REQUIRED_SUBSCRIPTION_METADATA: 'required_subscription_metadata',
  PHOTO_DUPLICATE_ADMIN_CHECK: 'photo_duplicate_admin_check',
} as const;

const MAX_ACTION_DELAY_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_ACTION_IDEMPOTENCY_KEY_PART_MAX_LENGTH = 48;
const MAX_ACTION_IDEMPOTENCY_KEY_READABLE_MAX_LENGTH = 160;

export function normalizeMaxActionIdempotencyKeyPart(value: string): string {
  const normalized = value.trim().toLowerCase();
  let readable = '';
  let separatorPending = false;

  for (const character of normalized) {
    const code = character.charCodeAt(0);
    const allowed = (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || character === '-';
    if (!allowed) {
      separatorPending = true;
      continue;
    }

    if (separatorPending && readable.length > 0) {
      readable += '_';
      if (readable.length >= MAX_ACTION_IDEMPOTENCY_KEY_PART_MAX_LENGTH) {
        break;
      }
    }
    separatorPending = false;
    readable += character;
    if (readable.length >= MAX_ACTION_IDEMPOTENCY_KEY_PART_MAX_LENGTH) {
      break;
    }
  }

  return readable;
}

const LIVE_MAX_ACTION_JOB_STATES = new Set([
  'active',
  'delayed',
  'prioritized',
  'waiting',
  'waiting-children',
]);
type MaxActionQueueJobObservation = {
  state: 'missing' | 'live' | 'final' | 'unknown';
  enqueuedAt?: Date;
};
const DEFAULT_MAX_API_GLOBAL_RPS = 30;
const DEFAULT_MAX_API_LIST_BOT_CHATS_CACHE_SEC = 15;
const DEFAULT_MAX_API_CHAT_SNAPSHOT_CACHE_SEC = 10;
const DEFAULT_MAX_API_CHAT_MEMBER_ACCESS_ADMIN_CACHE_SEC = 300;
const DEFAULT_MAX_API_CHAT_MEMBER_ACCESS_MEMBER_CACHE_SEC = 45;
const DEFAULT_MAX_API_CHAT_ADMIN_IDS_CACHE_SEC = 60;
const DEFAULT_MAX_API_CRITICAL_RATE_LIMIT_WAIT_MS = 1_000;
const DEFAULT_MAX_API_INTERACTIVE_RATE_LIMIT_WAIT_MS = 1_500;
const DEFAULT_MAX_API_BACKGROUND_RATE_LIMIT_WAIT_MS = 5_000;
const DEFAULT_MAX_API_RATE_LIMIT_RETRY_FLOOR_MS = 25;
const DEFAULT_MAX_API_MANAGED_REFRESH_RPS = 2;
const DEFAULT_MAX_API_MANAGED_REFRESH_STACK_RPS = 2;
const MAX_MESSAGE_MUTATION_RPS = 2;
const MAX_API_MESSAGE_IDS_BATCH_SIZE = 50;
const MAX_API_DIRECT_MESSAGE_LOOKUP_CONCURRENCY = 4;
const MAX_API_LIST_BOT_CHATS_PAGE_SAFETY_CAP = 10_000;
const MAX_API_CHAT_ADMIN_MEMBERS_PAGE_SAFETY_CAP = 10_000;
const MAX_API_RATE_LIMIT_SLOT_TTL_MS = 2_000;
const MAX_API_SOURCE_METRICS_TTL_SEC = 6 * 60 * 60;
const MAX_API_SERVICE_CAPACITY_METRICS_TTL_SEC = 2 * 60;
const MAX_API_RATE_LIMIT_OUTCOME_KEY_PREFIX = 'maxapi:rate-limit:v1';
const MAX_API_RATE_LIMIT_LOG_COALESCE_MS = 60_000;
const MAX_API_CIRCUIT_KEY_PREFIX = 'maxapi:circuit:v1';
const DEFAULT_MAX_API_CIRCUIT_HALF_OPEN_PROBE_SEC = 60;
const MAX_API_CRITICAL_NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPROTO',
  'ERR_NETWORK',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_TLS_HANDSHAKE_TIMEOUT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);
const DEFAULT_MAX_ACTION_FAILED_RETENTION_AGE_SEC = 7 * 24 * 60 * 60;
const DEFAULT_MAX_ACTION_FAILED_RETENTION_COUNT = 1_000;
const MAX_API_RATE_LIMIT_RESERVATION_SCRIPT = `
-- MAX_API_GCRA_RESERVE_V1
local time = redis.call('TIME')
local nowMs = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local ttlFloorMs = tonumber(ARGV[#ARGV])
local keyCount = #KEYS
local nextTats = {}
local nextTtls = {}

for index = 1, keyCount do
  local limit = tonumber(ARGV[index])
  local intervalMs = 1000 / limit
  local burstToleranceSlots = tonumber(ARGV[keyCount + index])
  local burstToleranceMs = burstToleranceSlots * intervalMs
  local storedTat = tonumber(redis.call('GET', KEYS[index]) or tostring(nowMs))
  local tat = math.max(storedTat, nowMs)
  local allowAtMs = tat - burstToleranceMs
  if nowMs < allowAtMs then
    return {0, index, math.max(1, math.ceil(allowAtMs - nowMs))}
  end
  local nextTat = tat + intervalMs
  nextTats[index] = nextTat
  nextTtls[index] = math.max(
    ttlFloorMs,
    math.ceil(nextTat - nowMs + burstToleranceMs + intervalMs)
  )
end

for index = 1, keyCount do
  redis.call('SET', KEYS[index], tostring(nextTats[index]), 'PX', nextTtls[index])
end

return {1, 0, 0}
`;

const MAX_API_CIRCUIT_ACQUIRE_SCRIPT = `
-- MAX_API_CIRCUIT_ACQUIRE_V1
local time = redis.call('TIME')
local nowMs = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local threshold = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local openMs = tonumber(ARGV[3])
local probeTtlMs = tonumber(ARGV[4])
local stateTtlMs = tonumber(ARGV[5])
local probeToken = ARGV[6]
local openUntilMs = tonumber(redis.call('GET', KEYS[2]) or '0')

if openUntilMs > nowMs then
  return {0, 0, math.max(1, math.ceil(openUntilMs - nowMs))}
end

local retained = {}
local failuresRaw = redis.call('GET', KEYS[1]) or ''
for value in string.gmatch(failuresRaw, '[^,]+') do
  local observedAtMs = tonumber(value)
  if observedAtMs ~= nil and observedAtMs >= nowMs - windowMs then
    table.insert(retained, observedAtMs)
  end
end

if #retained > 0 then
  redis.call('SET', KEYS[1], table.concat(retained, ','), 'PX', stateTtlMs)
else
  redis.call('DEL', KEYS[1])
end

if openUntilMs > 0 then
  local acquired = redis.call('SET', KEYS[3], probeToken, 'NX', 'PX', probeTtlMs)
  if acquired then
    return {1, 1, 0}
  end
  local probeTtl = redis.call('PTTL', KEYS[3])
  return {0, 0, math.max(1, probeTtl)}
end

if #retained >= threshold then
  local nextOpenUntilMs = nowMs + openMs
  redis.call('SET', KEYS[2], tostring(nextOpenUntilMs), 'PX', stateTtlMs)
  redis.call('DEL', KEYS[3])
  return {0, 0, openMs}
end

return {1, 0, 0}
`;

const MAX_API_CIRCUIT_FAILURE_SCRIPT = `
-- MAX_API_CIRCUIT_FAILURE_V1
local time = redis.call('TIME')
local nowMs = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local threshold = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local openMs = tonumber(ARGV[3])
local stateTtlMs = tonumber(ARGV[4])
local forceOpen = tonumber(ARGV[5]) == 1
local retained = {}
local failuresRaw = redis.call('GET', KEYS[1]) or ''

for value in string.gmatch(failuresRaw, '[^,]+') do
  local observedAtMs = tonumber(value)
  if observedAtMs ~= nil and observedAtMs >= nowMs - windowMs then
    table.insert(retained, observedAtMs)
  end
end
table.insert(retained, nowMs)
redis.call('SET', KEYS[1], table.concat(retained, ','), 'PX', stateTtlMs)

local openUntilMs = tonumber(redis.call('GET', KEYS[2]) or '0')
if forceOpen or #retained >= threshold then
  openUntilMs = nowMs + openMs
  redis.call('SET', KEYS[2], tostring(openUntilMs), 'PX', stateTtlMs)
  redis.call('DEL', KEYS[3])
end

return {#retained, openUntilMs}
`;

const MAX_API_CIRCUIT_CLOSE_SCRIPT = `
-- MAX_API_CIRCUIT_CLOSE_V1
if redis.call('GET', KEYS[3]) == ARGV[1] then
  redis.call('DEL', KEYS[1], KEYS[2], KEYS[3])
  return 1
end
return 0
`;

const MAX_API_CIRCUIT_RELEASE_PROBE_SCRIPT = `
-- MAX_API_CIRCUIT_RELEASE_PROBE_V1
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

const MAX_MESSAGE_EDIT_LOCK_TTL_MS = 60_000;
const MAX_MESSAGE_EDIT_LOCK_WAIT_MS = 30_000;
const MAX_MESSAGE_EDIT_LOCK_RETRY_MS = 25;
const MAX_MESSAGE_EDIT_LOCK_RENEW_MS = 20_000;
const MAX_MESSAGE_EDIT_LOCK_ACQUIRE_SCRIPT = `
-- MAX_MESSAGE_EDIT_LOCK_ACQUIRE_V1
local acquired = redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2])
if acquired then
  return {1, tonumber(ARGV[2])}
end
return {0, math.max(1, redis.call('PTTL', KEYS[1]))}
`;
const MAX_MESSAGE_EDIT_LOCK_RENEW_SCRIPT = `
-- MAX_MESSAGE_EDIT_LOCK_RENEW_V1
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;
const MAX_MESSAGE_EDIT_LOCK_RELEASE_SCRIPT = `
-- MAX_MESSAGE_EDIT_LOCK_RELEASE_V1
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

type MaxApiCircuitPermit = {
  halfOpenProbeToken: string | null;
};

@Injectable()
export class MaxClientService implements OnModuleDestroy {
  private readonly logger = new Logger(MaxClientService.name);
  private readonly baseUrl: string;
  private readonly dispatchEnabled: boolean;
  private readonly globalRpsLimit: number;
  private readonly criticalGlobalRpsLimit: number;
  private readonly interactiveGlobalRpsLimit: number;
  private readonly backgroundGlobalRpsLimit: number;
  private readonly managedRefreshRpsLimit: number;
  private readonly managedRefreshStackRpsLimit: number;
  private readonly rateLimitServiceScope: string;
  private readonly chatRpsLimit: number;
  private readonly chatMemberAccessAdminCacheTtlSec: number;
  private readonly chatMemberAccessMemberCacheTtlSec: number;
  private readonly chatAdminIdsCacheTtlSec: number;
  private readonly criticalRateLimitWaitMs: number;
  private readonly interactiveRateLimitWaitMs: number;
  private readonly backgroundRateLimitWaitMs: number;
  private readonly rateLimitRetryFloorMs: number;
  private readonly listBotChatsCacheTtlSec: number;
  private readonly chatSnapshotCacheTtlSec: number;
  private readonly actionFailedJobRetention: { age: number; count: number };
  private readonly isProduction: boolean;
  private readonly circuitFailureThreshold: number;
  private readonly circuitWindowSec: number;
  private readonly circuitOpenSec: number;
  private readonly circuitHalfOpenProbeSec: number;
  private readonly resumableVideoUploadEnabled: boolean;
  private readonly limiterRedis: Redis;
  private readonly pendingTimeouts = new Set<NodeJS.Timeout>();
  private readonly keyedActionTimeouts = new Map<string, NodeJS.Timeout>();
  private readonly rateLimitLogAtMsByKey = new Map<string, number>();
  private readonly listBotChatsInFlight = new Map<string, Promise<MaxBotChat[]>>();
  private readonly currentChatMemberAccessInFlight = new Map<
    string,
    Promise<MaxChatMemberAccess>
  >();
  private readonly chatMembersAccessInFlight = new Map<
    string,
    Promise<Map<string, MaxChatMemberAccess>>
  >();
  private readonly chatAdminIdsInFlight = new Map<string, Promise<string[]>>();
  private readonly mediaUploadValidationCache = new MaxMediaUploadValidationCache();

  constructor(
    private readonly httpService: HttpService,
    configService: ConfigService,
    private readonly actionHealthService: ActionHealthService,
    private readonly botRegistry: MaxBotRegistryService,
    private readonly botContext: MaxBotContextService,
    @Optional()
    @InjectQueue(MAX_ACTION_LEGACY_QUEUE)
    private readonly actionQueue?: Queue<MaxActionJob>,
    @Optional()
    private readonly runtimeDiagnosticsService?: RuntimeDiagnosticsService,
    @Optional()
    private readonly actionLedgerService?: MaxActionLedgerService,
    @Optional()
    private readonly maxBotLinkService?: MaxBotLinkService,
    @Optional()
    @InjectQueue(MAX_ACTION_CRITICAL_QUEUE)
    private readonly criticalActionQueue?: Queue<MaxActionJob>,
    @Optional()
    @InjectQueue(MAX_ACTION_INTERACTIVE_QUEUE)
    private readonly interactiveActionQueue?: Queue<MaxActionJob>,
    @Optional()
    @InjectQueue(MAX_ACTION_BACKGROUND_QUEUE)
    private readonly backgroundActionQueue?: Queue<MaxActionJob>,
  ) {
    this.baseUrl = configService.getOrThrow<string>('MAX_API_BASE_URL');
    this.isProduction =
      String(configService.get<string>('NODE_ENV', process.env.NODE_ENV ?? 'development') ?? '')
        .trim()
        .toLowerCase() === 'production';
    this.dispatchEnabled = configService.get<boolean>('MAX_ACTION_DISPATCH_ENABLED', true);
    this.resumableVideoUploadEnabled = configService.get<boolean>(
      'MAX_RESUMABLE_VIDEO_UPLOAD_ENABLED',
      true,
    );
    this.globalRpsLimit = this.readConfigInt(
      configService.get('MAX_API_GLOBAL_RPS'),
      DEFAULT_MAX_API_GLOBAL_RPS,
    );
    this.criticalGlobalRpsLimit = this.readConfigInt(
      configService.get('MAX_API_GLOBAL_RPS_CRITICAL'),
      Math.max(1, Math.floor(this.globalRpsLimit * 0.45)),
    );
    this.interactiveGlobalRpsLimit = this.readConfigInt(
      configService.get('MAX_API_GLOBAL_RPS_INTERACTIVE'),
      Math.max(1, Math.floor(this.globalRpsLimit * 0.35)),
    );
    this.backgroundGlobalRpsLimit = this.readConfigInt(
      configService.get('MAX_API_GLOBAL_RPS_BACKGROUND'),
      Math.max(
        1,
        this.globalRpsLimit - this.criticalGlobalRpsLimit - this.interactiveGlobalRpsLimit,
      ),
    );
    this.managedRefreshRpsLimit = this.readConfigInt(
      configService.get('MAX_API_MANAGED_REFRESH_RPS'),
      DEFAULT_MAX_API_MANAGED_REFRESH_RPS,
      0,
    );
    this.managedRefreshStackRpsLimit = this.readConfigInt(
      configService.get('MAX_API_MANAGED_REFRESH_STACK_RPS'),
      DEFAULT_MAX_API_MANAGED_REFRESH_STACK_RPS,
      0,
    );
    this.rateLimitServiceScope = normalizeMaxApiRateLimitServiceScope(
      configService.get('APP_SERVICE_NAME', process.env.APP_SERVICE_NAME ?? 'api'),
    );
    this.chatRpsLimit = this.readConfigInt(configService.get('MAX_API_CHAT_RPS'), 10);
    this.chatMemberAccessAdminCacheTtlSec = this.readConfigInt(
      configService.get('MAX_API_CHAT_MEMBER_ACCESS_ADMIN_CACHE_SEC'),
      DEFAULT_MAX_API_CHAT_MEMBER_ACCESS_ADMIN_CACHE_SEC,
      0,
    );
    this.chatMemberAccessMemberCacheTtlSec = this.readConfigInt(
      configService.get('MAX_API_CHAT_MEMBER_ACCESS_MEMBER_CACHE_SEC'),
      DEFAULT_MAX_API_CHAT_MEMBER_ACCESS_MEMBER_CACHE_SEC,
      0,
    );
    this.chatAdminIdsCacheTtlSec = this.readConfigInt(
      configService.get('MAX_API_CHAT_ADMIN_IDS_CACHE_SEC'),
      DEFAULT_MAX_API_CHAT_ADMIN_IDS_CACHE_SEC,
      0,
    );
    this.criticalRateLimitWaitMs = this.readConfigInt(
      configService.get('MAX_API_RATE_LIMIT_WAIT_MS_CRITICAL'),
      DEFAULT_MAX_API_CRITICAL_RATE_LIMIT_WAIT_MS,
      0,
    );
    this.interactiveRateLimitWaitMs = this.readConfigInt(
      configService.get('MAX_API_RATE_LIMIT_WAIT_MS_INTERACTIVE'),
      DEFAULT_MAX_API_INTERACTIVE_RATE_LIMIT_WAIT_MS,
      0,
    );
    this.backgroundRateLimitWaitMs = this.readConfigInt(
      configService.get('MAX_API_RATE_LIMIT_WAIT_MS_BACKGROUND'),
      DEFAULT_MAX_API_BACKGROUND_RATE_LIMIT_WAIT_MS,
      0,
    );
    this.rateLimitRetryFloorMs = this.readConfigInt(
      configService.get('MAX_API_RATE_LIMIT_RETRY_FLOOR_MS'),
      DEFAULT_MAX_API_RATE_LIMIT_RETRY_FLOOR_MS,
      1,
    );
    this.listBotChatsCacheTtlSec = this.readConfigInt(
      configService.get('MAX_API_LIST_BOT_CHATS_CACHE_SEC'),
      DEFAULT_MAX_API_LIST_BOT_CHATS_CACHE_SEC,
      0,
    );
    this.chatSnapshotCacheTtlSec = this.readConfigInt(
      configService.get('MAX_API_CHAT_SNAPSHOT_CACHE_SEC'),
      DEFAULT_MAX_API_CHAT_SNAPSHOT_CACHE_SEC,
      0,
    );
    this.actionFailedJobRetention = {
      age: this.readConfigInt(
        configService.get('MAX_ACTION_FAILED_RETENTION_AGE_SEC'),
        DEFAULT_MAX_ACTION_FAILED_RETENTION_AGE_SEC,
      ),
      count: this.readConfigInt(
        configService.get('MAX_ACTION_FAILED_RETENTION_COUNT'),
        DEFAULT_MAX_ACTION_FAILED_RETENTION_COUNT,
      ),
    };
    this.circuitFailureThreshold = this.readConfigInt(
      configService.get('MAX_API_CIRCUIT_FAILURE_THRESHOLD'),
      30,
    );
    this.circuitWindowSec = this.readConfigInt(configService.get('MAX_API_CIRCUIT_WINDOW_SEC'), 30);
    this.circuitOpenSec = this.readConfigInt(configService.get('MAX_API_CIRCUIT_OPEN_SEC'), 20);
    this.circuitHalfOpenProbeSec = this.readConfigInt(
      configService.get('MAX_API_CIRCUIT_HALF_OPEN_PROBE_SEC'),
      DEFAULT_MAX_API_CIRCUIT_HALF_OPEN_PROBE_SEC,
    );
    this.limiterRedis = new Redis(configService.getOrThrow<string>('REDIS_URL'));
  }

  async onModuleDestroy() {
    this.mediaUploadValidationCache.clear();
    for (const timeout of new Set([
      ...this.pendingTimeouts,
      ...this.keyedActionTimeouts.values(),
    ])) {
      clearTimeout(timeout);
    }
    this.pendingTimeouts.clear();
    this.keyedActionTimeouts.clear();
    await this.limiterRedis.quit();
  }

  async deleteMessage(chatId: string, messageId: string, options?: MaxActionDispatchOptions) {
    await this.dispatchAction(
      {
        actionType: 'DELETE_MESSAGE',
        chatId,
        messageId,
      },
      options,
    );
  }

  async pinMessage(chatId: string, messageId: string, notify = false): Promise<void> {
    await this.executeMutation(chatId, async () => {
      await this.request('put', `/chats/${chatId}/pin`, {
        data: {
          message_id: messageId,
          notify,
        },
      });
    });
  }

  async sendMessage(
    chatId: string,
    text: string,
    options?: MaxSendMessageOptions,
    dispatchOptions?: MaxActionDispatchOptions,
  ) {
    await this.dispatchAction(
      {
        actionType: 'SEND_MESSAGE',
        chatId,
        text,
        options,
      },
      dispatchOptions,
    );
  }

  async sendMessageImmediateWithId(
    chatId: string,
    text: string,
    options?: MaxImmediateSendMessageOptions,
    requestOptions: MaxApiRequestOptions = {},
  ): Promise<MaxPublishedMessage> {
    const attachments = this.buildMessageAttachments(options);
    const messageLink = this.buildMessageLinkData(options?.messageLink);
    const hasText = text.length > 0;
    const timeoutMs = this.normalizeTimeoutMs(requestOptions.timeoutMs);
    const sendResponse = await this.executeMessageMutation(
      'send',
      chatId,
      async () => {
        await options?.beforeSend?.();
        return this.request<Record<string, unknown>>('post', '/messages', {
          params: {
            chat_id: chatId,
          },
          data: {
            text: hasText ? text : null,
            ...(hasText && options?.textFormat ? { format: options.textFormat } : {}),
            ...(messageLink ? { link: messageLink } : {}),
            ...(attachments.length > 0 ? { attachments } : {}),
          },
          ...(timeoutMs ? { timeout: timeoutMs } : {}),
        });
      },
      requestOptions,
    );

    const messageId = this.extractMessageIdFromSendResponse(sendResponse);
    if (!messageId) {
      throw markMaxMessageSendAttempted(
        new Error('Ambiguous MAX send response is missing message id'),
      );
    }

    const resolvedChatId = this.extractChatIdFromSendResponse(sendResponse);
    return {
      messageId,
      url: this.parseChatLink(sendResponse),
      ...(resolvedChatId ? { chatId: resolvedChatId } : {}),
    };
  }

  async sendMessageImmediateToUser(
    userId: string,
    text: string,
    options?: MaxImmediateSendMessageOptions,
    requestOptions: MaxApiRequestOptions = {},
  ): Promise<MaxPublishedMessage> {
    const attachments = this.buildMessageAttachments(options);
    const messageLink = this.buildMessageLinkData(options?.messageLink);
    const timeoutMs = this.normalizeTimeoutMs(requestOptions.timeoutMs);
    const sendResponse = await this.executeMessageMutation(
      'send',
      `user:${userId}`,
      async () => {
        await options?.beforeSend?.();
        return this.request<Record<string, unknown>>('post', '/messages', {
          params: {
            user_id: userId,
          },
          data: {
            text,
            ...(options?.textFormat ? { format: options.textFormat } : {}),
            ...(messageLink ? { link: messageLink } : {}),
            ...(attachments.length > 0 ? { attachments } : {}),
          },
          ...(timeoutMs ? { timeout: timeoutMs } : {}),
        });
      },
      requestOptions,
    );

    const messageId = this.extractMessageIdFromSendResponse(sendResponse);
    if (!messageId) {
      throw markMaxMessageSendAttempted(
        new Error('Ambiguous MAX send response is missing message id'),
      );
    }

    const resolvedChatId = this.extractChatIdFromSendResponse(sendResponse);
    return {
      messageId,
      url: this.parseChatLink(sendResponse),
      ...(resolvedChatId ? { chatId: resolvedChatId } : {}),
    };
  }

  async sendMessageImmediateWithResolvedLink(
    chatId: string,
    text: string,
    options?: MaxImmediateSendMessageOptions,
    requestOptions: MaxApiRequestOptions = {},
  ): Promise<MaxPublishedMessage> {
    const {
      messageId,
      url: directUrl,
      chatId: resolvedChatId,
    } = await this.sendMessageImmediateWithId(chatId, text, options, requestOptions);
    if (directUrl) {
      return {
        messageId,
        url: directUrl,
        ...(resolvedChatId ? { chatId: resolvedChatId } : {}),
      };
    }

    const resolvedUrl = await this.resolveMessageLinkSafely(messageId, requestOptions);
    return {
      messageId,
      url: resolvedUrl ?? null,
      ...(resolvedChatId ? { chatId: resolvedChatId } : {}),
    };
  }

  async sendCustomMessageImmediate(
    chatId: string,
    payload: MaxCustomMessagePayload,
    requestOptions: MaxApiRequestOptions | MaxApiTrafficClass = {},
    beforeSend?: () => Promise<void>,
  ): Promise<Record<string, unknown>> {
    const normalizedRequestOptions = this.normalizeReadRequestOptions(requestOptions);
    const attachments = Array.isArray(payload.attachments)
      ? payload.attachments
          .map((attachment) => this.normalizeCustomMessageAttachment(attachment))
          .filter((attachment): attachment is Record<string, unknown> => attachment !== null)
      : [];
    const messageLink = this.buildMessageLinkData(payload.messageLink);
    const hasText = typeof payload.text === 'string';
    const timeoutMs = this.normalizeTimeoutMs(normalizedRequestOptions.timeoutMs);

    if (!hasText && attachments.length === 0) {
      throw new Error('MAX custom message payload is empty');
    }

    return this.executeMessageMutation(
      'send',
      chatId,
      async () => {
        await beforeSend?.();
        return this.request<Record<string, unknown>>('post', '/messages', {
          params: {
            chat_id: chatId,
          },
          data: {
            text: hasText ? payload.text : null,
            ...(payload.textFormat ? { format: payload.textFormat } : {}),
            ...(messageLink ? { link: messageLink } : {}),
            ...(attachments.length > 0 ? { attachments } : {}),
          },
          ...(timeoutMs ? { timeout: timeoutMs } : {}),
        });
      },
      normalizedRequestOptions,
    );
  }

  private normalizeCustomMessageAttachment(attachment: unknown): Record<string, unknown> | null {
    if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) {
      return null;
    }

    const row = attachment as Record<string, unknown>;
    if (this.readLowerString(row.type) !== 'inline_keyboard') {
      return row;
    }

    const payload = this.asRecord(row.payload);
    const buttons = Array.isArray(payload?.buttons)
      ? normalizeMaxInlineKeyboardButtons(payload.buttons)
      : null;
    if (!payload || !buttons) {
      return null;
    }

    return {
      ...row,
      type: 'inline_keyboard',
      payload: {
        ...payload,
        buttons,
      },
    };
  }

  async sendCustomMessageImmediateWithResolvedLink(
    chatId: string,
    payload: MaxCustomMessagePayload,
    requestOptions: MaxApiRequestOptions | MaxApiTrafficClass = {},
  ): Promise<MaxPublishedMessage> {
    const sendResponse = await this.sendCustomMessageImmediate(chatId, payload, requestOptions);
    const messageId = this.extractMessageIdFromSendResponse(sendResponse);
    if (!messageId) {
      throw markMaxMessageSendAttempted(
        new Error('Ambiguous MAX send response is missing message id'),
      );
    }

    const directUrl = this.parseChatLink(sendResponse);
    const resolvedChatId = this.extractChatIdFromSendResponse(sendResponse);
    if (directUrl) {
      return {
        messageId,
        url: directUrl,
        ...(resolvedChatId ? { chatId: resolvedChatId } : {}),
      };
    }

    const resolvedUrl = await this.resolveMessageLinkSafely(messageId, requestOptions);
    return {
      messageId,
      url: resolvedUrl ?? null,
      ...(resolvedChatId ? { chatId: resolvedChatId } : {}),
    };
  }

  async sendMessageCopyWithInlineKeyboard(
    chatId: string,
    sourceMessageId: string,
    fallbackText: string | null,
    options?: MaxEditableMessageOptions & {
      beforeSend?: () => Promise<void>;
    },
    requestOptions: MaxApiRequestOptions | MaxApiTrafficClass = {},
  ): Promise<MaxPublishedMessage> {
    const sourceMessage = await this.getMessageById(sourceMessageId, requestOptions);
    const attachments = this.buildEditableMessageAttachments(sourceMessage, options);
    const replyLink = this.extractReplyMessageLink(sourceMessage);
    const messageTextPayload = this.buildOutgoingMessageTextPayload(
      sourceMessage,
      fallbackText,
      options?.textFormat ?? null,
    );
    let sendResponse: Record<string, unknown>;
    let sendAttempted = false;
    try {
      sendResponse = await this.sendCustomMessageImmediate(
        chatId,
        {
          ...(typeof messageTextPayload.text === 'string' && messageTextPayload.text.length > 0
            ? { text: messageTextPayload.text }
            : {}),
          ...(messageTextPayload.textFormat ? { textFormat: messageTextPayload.textFormat } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(replyLink ? { messageLink: replyLink } : {}),
        },
        requestOptions,
        async () => {
          await options?.beforeSend?.();
          sendAttempted = true;
        },
      );
    } catch (error: unknown) {
      throw sendAttempted ? markMaxMessageSendAttempted(error) : error;
    }

    const messageId = this.extractMessageIdFromSendResponse(sendResponse);
    if (!messageId) {
      throw markMaxMessageSendAttempted(
        new Error('Ambiguous MAX send response is missing message id'),
      );
    }

    const resolvedChatId = this.extractChatIdFromSendResponse(sendResponse);
    return {
      messageId,
      url: this.parseChatLink(sendResponse),
      ...(resolvedChatId ? { chatId: resolvedChatId } : {}),
    };
  }

  async getMessageTextAsMarkdown(
    messageId: string,
    requestOptions: MaxApiRequestOptions | MaxApiTrafficClass = 'critical',
  ): Promise<string | null> {
    const message = await this.getMessageById(messageId, requestOptions);
    const body = this.asRecord(message?.body);
    const sourceText =
      typeof body?.text === 'string'
        ? body.text
        : typeof message?.text === 'string'
          ? message.text
          : null;
    if (!sourceText) {
      return null;
    }

    const markdown = this.renderMessageMarkupAsMarkdown(
      sourceText,
      this.extractMessageMarkup(message),
    );
    return markdown || sourceText;
  }

  async resolveMessageLink(
    messageId: string,
    requestOptions: MaxApiRequestOptions | MaxApiTrafficClass = 'critical',
  ): Promise<string | null> {
    const sentMessage = await this.getMessageById(messageId, requestOptions);
    const batchLink = sentMessage ? this.parseChatLink(sentMessage) : null;
    if (batchLink) {
      return batchLink;
    }

    const detailedMessage = await this.getMessageByPath(messageId, requestOptions);
    return detailedMessage ? this.parseChatLink(detailedMessage) : null;
  }

  private async resolveMessageLinkSafely(
    messageId: string,
    requestOptions: MaxApiRequestOptions | MaxApiTrafficClass = 'critical',
  ): Promise<string | null> {
    try {
      return await this.resolveMessageLink(messageId, requestOptions);
    } catch (error: unknown) {
      this.logger.warn(
        {
          messageId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve MAX message link after successful send',
      );
      return null;
    }
  }

  async editMessageInlineKeyboard(
    chatId: string,
    messageId: string,
    text: string | null,
    options?: MaxEditableMessageOptions,
    requestOptions: MaxApiRequestOptions | MaxApiTrafficClass = {},
  ) {
    return this.runWithMessageKeyboardEditLock(messageId, async (assertOwnership) => {
      const message = await this.getMessageById(messageId, requestOptions);
      const attachments = this.buildEditableMessageAttachments(message, options);
      const sourceBody = this.asRecord(message?.body);
      const sourceText = typeof sourceBody?.text === 'string' ? sourceBody.text : null;
      const shouldForceReplacementText =
        typeof text === 'string' &&
        text !== sourceText &&
        !this.shouldSkipTextUpdateForInlineKeyboardEdit(message);
      const messageTextPayload =
        typeof text === 'string' && !this.shouldSkipTextUpdateForInlineKeyboardEdit(message)
          ? shouldForceReplacementText
            ? {
                text,
                textFormat: options?.textFormat ?? null,
              }
            : this.buildOutgoingMessageTextPayload(message, text, options?.textFormat ?? null)
          : null;

      await assertOwnership();

      await this.executeMessageMutation(
        'edit',
        chatId,
        async () => {
          await assertOwnership();
          await this.runPreDispatchMutationGuard(
            options?.beforeEditMutation,
            MAX_EDIT_PRE_DISPATCH_GUARD_REJECTED_CODE,
          );
          await assertOwnership();
          await this.request('put', '/messages', {
            params: {
              message_id: messageId,
            },
            data: {
              ...(messageTextPayload && typeof messageTextPayload.text === 'string'
                ? {
                    text: messageTextPayload.text,
                    ...(messageTextPayload.textFormat
                      ? { format: messageTextPayload.textFormat }
                      : {}),
                  }
                : {}),
              attachments,
            },
          });
        },
        requestOptions,
      );
    });
  }

  async sendMessageReplyWithInlineKeyboard(
    chatId: string,
    messageId: string,
    text: string,
    options?: Pick<MaxSendMessageOptions, 'button' | 'buttons' | 'debugContext'>,
    requestOptions: MaxApiRequestOptions | MaxApiTrafficClass = {},
  ): Promise<MaxPublishedMessage | null> {
    const normalizedRequestOptions = this.normalizeReadRequestOptions(requestOptions);
    const attachments = this.buildMessageAttachments(options);
    const messageLink = this.buildMessageLinkData({
      type: 'reply',
      mid: messageId,
    });
    if (attachments.length === 0 || !messageLink) {
      return null;
    }

    const timeoutMs = this.normalizeTimeoutMs(normalizedRequestOptions.timeoutMs);
    const sendResponse = await this.executeMessageMutation(
      'send',
      chatId,
      async () => {
        return this.request<Record<string, unknown>>('post', '/messages', {
          params: {
            chat_id: chatId,
          },
          data: {
            text,
            link: messageLink,
            attachments,
          },
          ...(timeoutMs ? { timeout: timeoutMs } : {}),
        });
      },
      normalizedRequestOptions,
    );

    const replyMessageId = this.extractMessageIdFromSendResponse(sendResponse);
    if (!replyMessageId) {
      throw markMaxMessageSendAttempted(
        new Error('Ambiguous MAX send response is missing message id'),
      );
    }

    const resolvedChatId = this.extractChatIdFromSendResponse(sendResponse);
    return {
      messageId: replyMessageId,
      url: this.parseChatLink(sendResponse),
      ...(resolvedChatId ? { chatId: resolvedChatId } : {}),
    };
  }

  async listMessages(
    chatId: string,
    countOrOptions:
      | number
      | {
          count?: number;
          from?: number | string | Date | null;
          to?: number | string | Date | null;
          trafficClass?: MaxApiTrafficClass;
          sourceTag?: string;
          ignoreFailureMetricStatuses?: readonly number[];
          botId?: string;
        } = 10,
  ): Promise<Record<string, unknown>[]> {
    const options =
      typeof countOrOptions === 'number'
        ? { count: countOrOptions, trafficClass: undefined }
        : {
            count: countOrOptions.count ?? 10,
            from: countOrOptions.from ?? null,
            to: countOrOptions.to ?? null,
            trafficClass: countOrOptions.trafficClass,
            sourceTag: countOrOptions.sourceTag,
            ignoreFailureMetricStatuses: countOrOptions.ignoreFailureMetricStatuses,
            botId: countOrOptions.botId,
          };
    const data = await this.executeChatRequest(
      chatId,
      async () =>
        this.request<Record<string, unknown>>('get', '/messages', {
          params: {
            chat_id: chatId,
            count: options.count,
            ...(options.from !== null && options.from !== undefined
              ? { from: this.normalizeMessageQueryBoundary(options.from) }
              : {}),
            ...(options.to !== null && options.to !== undefined
              ? { to: this.normalizeMessageQueryBoundary(options.to) }
              : {}),
          },
        }),
      {
        trafficClass: options.trafficClass,
        sourceTag: options.sourceTag,
        ignoreFailureMetricStatuses: options.ignoreFailureMetricStatuses,
        botId: options.botId,
      },
    );
    return this.normalizeMessageRows(data);
  }

  async listMessageSnapshots(
    chatId: string,
    options: {
      from?: Date | number | string | null;
      to?: Date | number | string | null;
      count?: number;
      maxPages?: number;
      trafficClass?: MaxApiTrafficClass;
      sourceTag?: string;
      ignoreFailureMetricStatuses?: readonly number[];
      botId?: string;
    } = {},
  ): Promise<MaxChannelMessageSnapshot[]> {
    const fromMs = this.normalizeMessageTimestamp(options.from ?? null);
    const toMs = this.normalizeMessageTimestamp(options.to ?? null) ?? Date.now();
    const count = Math.min(Math.max(options.count ?? 100, 1), 100);
    const maxPages = Math.min(Math.max(options.maxPages ?? 60, 1), 200);
    const snapshots = new Map<string, MaxChannelMessageSnapshot>();
    let cursorFrom = toMs;
    let previousSignature = '';

    for (let page = 0; page < maxPages; page += 1) {
      const rows = await this.listMessages(chatId, {
        count,
        from: cursorFrom,
        ...(fromMs !== null ? { to: fromMs } : {}),
        trafficClass: options.trafficClass,
        sourceTag: options.sourceTag,
        ignoreFailureMetricStatuses: options.ignoreFailureMetricStatuses,
        botId: options.botId,
      });
      if (rows.length === 0) {
        break;
      }

      const pageItems = rows
        .map((row) => this.parseMessageSnapshot(chatId, row))
        .filter((item): item is MaxChannelMessageSnapshot => item !== null)
        .sort((left, right) => right.publishedAtMs - left.publishedAtMs);

      if (pageItems.length === 0) {
        break;
      }

      for (const item of pageItems) {
        if (fromMs !== null && item.publishedAtMs < fromMs) {
          continue;
        }
        if (item.publishedAtMs > toMs) {
          continue;
        }
        snapshots.set(
          item.messageId,
          this.mergeMessageSnapshots(snapshots.get(item.messageId) ?? null, item),
        );
      }

      const signature = `${pageItems[0]?.messageId ?? ''}:${pageItems.at(-1)?.messageId ?? ''}`;
      if (signature && signature === previousSignature) {
        break;
      }
      previousSignature = signature;

      const oldest = pageItems.at(-1);
      if (!oldest) {
        break;
      }

      if (fromMs !== null && oldest.publishedAtMs <= fromMs) {
        break;
      }

      const nextCursor = oldest.publishedAtMs - 1;
      if (nextCursor >= cursorFrom) {
        break;
      }

      cursorFrom = nextCursor;

      if (rows.length < count) {
        break;
      }
    }

    return Array.from(snapshots.values()).sort(
      (left, right) => right.publishedAtMs - left.publishedAtMs,
    );
  }

  async getMessageSnapshot(
    chatId: string,
    messageId: string,
    options: MaxApiRequestOptions | MaxApiTrafficClass = {},
  ): Promise<MaxChannelMessageSnapshot | null> {
    const normalizedChatId = chatId.trim();
    const normalizedMessageId = messageId.trim();
    if (!normalizedChatId || !normalizedMessageId) {
      return null;
    }

    const message = await this.getMessageById(normalizedMessageId, options);
    if (!message) {
      return null;
    }

    return this.parseMessageSnapshot(normalizedChatId, message);
  }

  async getExactMessageRow(
    chatId: string,
    messageId: string,
    options: MaxApiRequestOptions | MaxApiTrafficClass = {},
  ): Promise<Record<string, unknown> | null> {
    const normalizedChatId = chatId.trim();
    const normalizedMessageId = messageId.trim();
    if (!normalizedChatId || !normalizedMessageId) {
      throw new Error('chatId and messageId are required for exact MAX message lookup');
    }

    let message: Record<string, unknown> | null;
    try {
      message = await this.getMessageById(normalizedMessageId, options);
    } catch (error: unknown) {
      if (this.isExactMessageNotFoundError(error, normalizedMessageId)) {
        return null;
      }
      throw error;
    }
    if (!message) {
      return null;
    }

    const responseChatId = this.extractChatIdFromSendResponse(message);
    if (!responseChatId) {
      throw new Error(`MAX exact message lookup returned ${normalizedMessageId} without a chat id`);
    }
    if (responseChatId !== normalizedChatId) {
      throw this.createExactMessageTargetMismatchError(
        normalizedChatId,
        responseChatId,
        normalizedMessageId,
      );
    }
    return message;
  }

  async getExactChannelDialogButtonIdentities(
    chatId: string,
    messageId: string,
    options: MaxApiRequestOptions | MaxApiTrafficClass = 'background',
  ): Promise<InternalChannelDialogButtonIdentity[] | null> {
    const normalizedChatId = chatId.trim();
    const normalizedMessageId = messageId.trim();
    if (!normalizedChatId || !normalizedMessageId) {
      throw new Error('chatId and messageId are required for channel dialog button lookup');
    }

    let message: Record<string, unknown> | null;
    try {
      message = await this.getMessageById(normalizedMessageId, options);
    } catch (error: unknown) {
      if (this.isExactMessageNotFoundError(error, normalizedMessageId)) {
        return null;
      }
      throw error;
    }
    const nestedMessage = this.asRecord(message?.message);
    const exactMessage = [message, nestedMessage].find(
      (candidate) =>
        candidate && this.extractMessageIdFromSendResponse(candidate) === normalizedMessageId,
    );
    if (!exactMessage) {
      throw new Error(
        'MAX exact channel dialog lookup returned a response without the requested id',
      );
    }
    const responseChatId = this.extractChatIdFromSendResponse(exactMessage);
    if (responseChatId && responseChatId !== normalizedChatId) {
      throw this.createExactMessageTargetMismatchError(
        normalizedChatId,
        responseChatId,
        normalizedMessageId,
      );
    }
    return readInternalChannelDialogButtonIdentitiesFromMessage(exactMessage, normalizedChatId);
  }

  async getExactMessagePresence(
    chatId: string,
    messageId: string,
    options: MaxApiRequestOptions | MaxApiTrafficClass = {},
  ): Promise<MaxExactMessagePresence> {
    const normalizedChatId = chatId.trim();
    const normalizedMessageId = messageId.trim();
    if (!normalizedChatId || !normalizedMessageId) {
      throw new Error('chatId and messageId are required for exact MAX message presence');
    }

    const [result] = await this.getExactMessagePresences(
      [{ chatId: normalizedChatId, messageId: normalizedMessageId }],
      options,
    );
    if (result && 'presence' in result) {
      return result.presence;
    }
    throw result?.error ?? new Error('MAX exact message lookup returned no result');
  }

  async getExactMessagePresences(
    requests: readonly MaxExactMessagePresenceRequest[],
    options: MaxApiRequestOptions | MaxApiTrafficClass = {},
  ): Promise<MaxExactMessagePresenceResult[]> {
    if (requests.length === 0) {
      return [];
    }

    const normalizedRequests = requests.map((request) => ({
      chatId: request.chatId.trim(),
      messageId: request.messageId.trim(),
    }));
    if (normalizedRequests.some((request) => !request.chatId || !request.messageId)) {
      throw new Error('chatId and messageId are required for exact MAX message presence');
    }

    const requestsByMessageId = new Map<string, MaxExactMessagePresenceRequest[]>();
    for (const request of normalizedRequests) {
      const groupedRequests = requestsByMessageId.get(request.messageId) ?? [];
      groupedRequests.push(request);
      requestsByMessageId.set(request.messageId, groupedRequests);
    }
    const uniqueMessageIds = Array.from(requestsByMessageId.keys());
    const resultsByRequest = new Map<string, MaxExactMessagePresenceOutcome>();

    // MAX documents 50 as the default message-list response size. Keeping the same bound also
    // prevents comma-separated message IDs from producing oversized request URLs.
    for (let index = 0; index < uniqueMessageIds.length; index += MAX_API_MESSAGE_IDS_BATCH_SIZE) {
      const batchMessageIds = uniqueMessageIds.slice(index, index + MAX_API_MESSAGE_IDS_BATCH_SIZE);
      const requestedIds = new Set(batchMessageIds);
      const batch = batchMessageIds.flatMap(
        (messageId) => requestsByMessageId.get(messageId) ?? [],
      );
      const listedChatIdsByMessageId = new Map<string, Set<string>>();
      const unscopedListedMessageIds = new Set<string>();
      let listError: unknown = null;

      try {
        const data = await this.executeGlobalRequest(
          () =>
            this.request<Record<string, unknown>>('get', '/messages', {
              params: { message_ids: batchMessageIds.join(',') },
            }),
          options,
        );
        const messages = Array.isArray(data.messages) ? data.messages : [];
        for (const message of messages) {
          if (message === null || typeof message !== 'object' || Array.isArray(message)) {
            continue;
          }
          const listedId = this.extractMessageIdFromSendResponse(message);
          if (listedId && requestedIds.has(listedId)) {
            const responseChatId = this.extractChatIdFromSendResponse(message);
            if (responseChatId) {
              const listedChatIds = listedChatIdsByMessageId.get(listedId) ?? new Set<string>();
              listedChatIds.add(responseChatId);
              listedChatIdsByMessageId.set(listedId, listedChatIds);
            } else {
              unscopedListedMessageIds.add(listedId);
            }
          }
        }

        for (const messageId of batchMessageIds) {
          const groupedRequests = requestsByMessageId.get(messageId) ?? [];
          const requestedChatIds = new Set(groupedRequests.map((request) => request.chatId));
          const listedChatIds = listedChatIdsByMessageId.get(messageId) ?? new Set<string>();
          for (const request of groupedRequests) {
            const requestKey = this.buildExactMessagePresenceRequestKey(request);
            if (listedChatIds.has(request.chatId)) {
              resultsByRequest.set(requestKey, { presence: 'present' });
            } else if (listedChatIds.size > 0) {
              resultsByRequest.set(requestKey, {
                error: this.createExactMessageTargetMismatchError(
                  request.chatId,
                  listedChatIds.values().next().value ?? 'unknown',
                  request.messageId,
                ),
              });
            } else if (unscopedListedMessageIds.has(messageId)) {
              resultsByRequest.set(
                requestKey,
                requestedChatIds.size === 1
                  ? { presence: 'present' }
                  : { error: this.createUnscopedExactMessageTargetError(request.messageId) },
              );
            }
          }
        }
      } catch (error: unknown) {
        if (this.extractStatusCode(error) === 404) {
          // A list-route 404 is not proof that any specific message is absent.
          listError = null;
        } else {
          listError = error;
        }
      }

      if (listError) {
        for (const request of batch) {
          resultsByRequest.set(this.buildExactMessagePresenceRequestKey(request), {
            error: listError,
          });
        }
        continue;
      }

      const directRequests = batch.filter(
        (request) => !resultsByRequest.has(this.buildExactMessagePresenceRequestKey(request)),
      );
      let directIndex = 0;
      const workers = Array.from(
        {
          length: Math.min(MAX_API_DIRECT_MESSAGE_LOOKUP_CONCURRENCY, directRequests.length),
        },
        async () => {
          while (directIndex < directRequests.length) {
            const request = directRequests[directIndex];
            directIndex += 1;
            if (!request) {
              continue;
            }

            try {
              const data = await this.executeChatRequest(
                request.chatId,
                () =>
                  this.request<Record<string, unknown>>(
                    'get',
                    `/messages/${encodeURIComponent(request.messageId)}`,
                  ),
                options,
              );
              const nestedMessage =
                data.message && typeof data.message === 'object' && !Array.isArray(data.message)
                  ? data.message
                  : null;
              const exactDirectMatch = [data, nestedMessage].find(
                (message) =>
                  message !== null &&
                  this.extractMessageIdFromSendResponse(message) === request.messageId,
              );
              if (!exactDirectMatch) {
                throw new Error(
                  'MAX exact message lookup returned a response without the requested id',
                );
              }
              const responseChatId = this.extractChatIdFromSendResponse(exactDirectMatch);
              if (responseChatId && responseChatId !== request.chatId) {
                throw this.createExactMessageTargetMismatchError(
                  request.chatId,
                  responseChatId,
                  request.messageId,
                );
              }
              if (
                !responseChatId &&
                new Set(
                  (requestsByMessageId.get(request.messageId) ?? []).map(
                    (groupedRequest) => groupedRequest.chatId,
                  ),
                ).size > 1
              ) {
                throw this.createUnscopedExactMessageTargetError(request.messageId);
              }
              resultsByRequest.set(this.buildExactMessagePresenceRequestKey(request), {
                presence: 'present',
              });
            } catch (error: unknown) {
              resultsByRequest.set(
                this.buildExactMessagePresenceRequestKey(request),
                this.isExactMessageNotFoundError(error, request.messageId)
                  ? { presence: 'absent' }
                  : { error },
              );
            }
          }
        },
      );
      await Promise.all(workers);
    }

    return normalizedRequests.map((request) => ({
      ...request,
      ...(resultsByRequest.get(this.buildExactMessagePresenceRequestKey(request)) ?? {
        error: new Error('MAX exact message lookup returned no result'),
      }),
    })) as MaxExactMessagePresenceResult[];
  }

  async listWebhookSubscriptions(
    options: MaxApiRequestOptions = {},
  ): Promise<MaxWebhookSubscription[]> {
    const data = await this.executeGlobalRequest(
      () => this.request<Record<string, unknown> | unknown[]>('get', '/subscriptions'),
      options,
    );
    const rows = Array.isArray(data)
      ? data
      : Array.isArray((data as { subscriptions?: unknown }).subscriptions)
        ? ((data as { subscriptions?: unknown[] }).subscriptions ?? [])
        : [];

    return rows
      .map((row) => this.parseWebhookSubscription(row))
      .filter((item): item is MaxWebhookSubscription => item !== null);
  }

  getConfiguredWebhookSubscriptionTarget(botId?: string | null): {
    url: string | null;
    maskedUrl: string | null;
  } {
    return this.botRegistry.getConfiguredWebhookSubscriptionTarget(this.resolveBot(botId).id);
  }

  matchesConfiguredWebhookUrl(url: string, botId?: string | null): boolean {
    const target = this.getConfiguredWebhookSubscriptionTarget(botId);
    if (!target.url) {
      return false;
    }

    return url === target.url || this.normalizeUrl(url) === this.normalizeUrl(target.url);
  }

  maskWebhookUrl(url: string | null, botId?: string | null): string | null {
    if (!url) {
      return null;
    }

    const normalizedSecretPath = this.resolveBot(botId).webhookSecretPath;
    if (!normalizedSecretPath) {
      return url;
    }

    try {
      const parsed = new URL(url);
      const pathSegments = parsed.pathname.split('/');
      const lastSegment = pathSegments[pathSegments.length - 1] ?? '';
      if (lastSegment === normalizedSecretPath) {
        pathSegments[pathSegments.length - 1] = '***';
        parsed.pathname = pathSegments.join('/');
        return parsed.toString();
      }
    } catch {
      // Fall through to the string replacement fallback.
    }

    const suffix = `/${normalizedSecretPath}`;
    return url.endsWith(suffix) ? `${url.slice(0, -suffix.length)}/***` : url;
  }

  async ensureWebhookSubscription(
    requiredUpdateTypes: string[],
    options: MaxApiRequestOptions = {},
  ): Promise<MaxWebhookSubscription | null> {
    const normalizedRequired = Array.from(
      new Set(
        requiredUpdateTypes
          .map((value) => this.readLowerString(value))
          .filter((value): value is string => Boolean(value)),
      ),
    );
    const bot = this.resolveBot(options.botId);
    if (normalizedRequired.length === 0 || !bot.webhookUrl || !bot.webhookHeaderSecret) {
      return null;
    }

    const trafficClass = options.trafficClass ?? 'background';
    const sourceTag = this.normalizeMetricSourceTag(options.sourceTag) ?? undefined;
    const existing = await this.listWebhookSubscriptions({
      trafficClass,
      botId: bot.id,
      ...(sourceTag ? { sourceTag } : {}),
    });
    const current =
      existing.find((item) => item.url === bot.webhookUrl) ??
      existing.find((item) => this.normalizeUrl(item.url) === this.normalizeUrl(bot.webhookUrl!));
    const mergedUpdateTypes = Array.from(
      new Set([...(current?.updateTypes ?? []), ...normalizedRequired]),
    ).sort();

    if (
      current &&
      options.forceUpsert !== true &&
      current.updateTypes.length === mergedUpdateTypes.length &&
      current.updateTypes.every((value, index) => value === mergedUpdateTypes[index])
    ) {
      return current;
    }

    await this.executeMutation(
      null,
      () =>
        this.request('post', '/subscriptions', {
          data: {
            url: bot.webhookUrl,
            update_types: mergedUpdateTypes,
            secret: bot.webhookHeaderSecret,
          },
        }),
      {
        trafficClass,
        botId: bot.id,
        ...(sourceTag ? { sourceTag } : {}),
      },
      { requireExecutableBot: false },
    );

    return {
      url: bot.webhookUrl,
      updateTypes: mergedUpdateTypes,
    };
  }

  async deleteWebhookSubscription(url: string, options: MaxApiRequestOptions = {}): Promise<void> {
    const normalizedUrl = this.readTrimmedString(url);
    if (!normalizedUrl) {
      return;
    }

    await this.executeMutation(
      null,
      () =>
        this.request('delete', '/subscriptions', {
          params: {
            url: normalizedUrl,
          },
        }),
      {
        trafficClass: options.trafficClass ?? 'background',
        botId: options.botId,
        ...(options.sourceTag ? { sourceTag: options.sourceTag } : {}),
      },
      { requireExecutableBot: false },
    );
  }

  async uploadImage(
    data: Buffer,
    fileName = 'broadcast-image.jpg',
    mimeType = 'image/jpeg',
    requestOptions: MaxApiRequestOptions = {},
  ): Promise<Record<string, unknown>> {
    return this.uploadBinary('image', data, fileName, mimeType, requestOptions);
  }

  validateMediaUploadPayload(uploadType: 'image', data: Buffer): Promise<MaxValidatedImageUpload>;
  validateMediaUploadPayload(uploadType: 'video', data: Buffer): Promise<MaxValidatedVideoUpload>;
  validateMediaUploadPayload(
    uploadType: 'image' | 'video',
    data: Buffer,
  ): Promise<MaxValidatedMediaUpload> {
    return uploadType === 'image'
      ? this.mediaUploadValidationCache.validate('image', data)
      : this.mediaUploadValidationCache.validate('video', data);
  }

  async uploadVideo(
    data: Buffer,
    fileName = 'video.mp4',
    mimeType = 'video/mp4',
    requestOptions: MaxApiRequestOptions = {},
  ): Promise<Record<string, unknown>> {
    return this.uploadBinary('video', data, fileName, mimeType, requestOptions);
  }

  async uploadFile(
    data: Buffer,
    fileName = 'asset.bin',
    mimeType = 'application/octet-stream',
    requestOptions: MaxApiRequestOptions = {},
  ): Promise<Record<string, unknown>> {
    return this.uploadBinary('file', data, fileName, mimeType, requestOptions);
  }

  private async uploadBinary(
    uploadType: MaxMediaAttachmentType,
    data: Buffer,
    fileName: string,
    mimeType: string,
    requestOptions: MaxApiRequestOptions = {},
  ): Promise<Record<string, unknown>> {
    this.assertUploadPayloadSize(uploadType, data);
    const validatedMedia =
      uploadType === 'image'
        ? await this.validateMediaUploadPayload('image', data)
        : uploadType === 'video'
          ? await this.validateMediaUploadPayload('video', data)
          : null;
    const safeFileName = validatedMedia
      ? this.normalizeValidatedMediaUploadFileName(
          fileName,
          validatedMedia.uploadType,
          validatedMedia.extension,
        )
      : this.normalizeUploadFileName(fileName, uploadType);
    const effectiveMimeType = validatedMedia?.mimeType ?? mimeType;
    const bot = this.resolveExecutableBot(requestOptions.botId, {
      explicit: Boolean(requestOptions.botId?.trim()),
    });
    return this.botContext.runWithBot(bot.id, async () => {
      if (uploadType === 'video' && this.resumableVideoUploadEnabled && data.length > 0) {
        return this.uploadVideoWithContentRange(
          data,
          safeFileName,
          effectiveMimeType,
          requestOptions,
          bot.id,
        );
      }

      const uploadMeta = await this.createUploadSession(uploadType, requestOptions, bot.id);
      return this.uploadMultipartToSession(
        uploadType,
        uploadMeta,
        data,
        safeFileName,
        effectiveMimeType,
        requestOptions,
      );
    });
  }

  private assertUploadPayloadSize(uploadType: MaxMediaAttachmentType, data: Buffer): void {
    if (data.length === 0) {
      throw new Error(`MAX ${uploadType} upload payload is empty`);
    }

    const limits: Record<MaxMediaAttachmentType, { maxBytes: number; label: string }> = {
      image: { maxBytes: MAX_IMAGE_UPLOAD_MAX_BYTES, label: '50 MB' },
      video: { maxBytes: MAX_VIDEO_UPLOAD_MAX_BYTES, label: '250 MB' },
      audio: { maxBytes: MAX_AUDIO_UPLOAD_MAX_BYTES, label: '256 MB' },
      file: { maxBytes: MAX_FILE_UPLOAD_MAX_BYTES, label: '4 GB' },
    };
    const limit = limits[uploadType];
    if (data.length > limit.maxBytes) {
      throw new Error(`MAX ${uploadType} upload exceeds the documented ${limit.label} limit`);
    }
  }

  private async createUploadSession(
    uploadType: MaxMediaAttachmentType,
    requestOptions: MaxApiRequestOptions,
    botId: string,
    deadlineAtMs?: number,
  ): Promise<{ token: string; url: string }> {
    const timeoutMs =
      deadlineAtMs === undefined
        ? this.normalizeTimeoutMs(requestOptions.timeoutMs)
        : this.resolveRemainingUploadTimeoutMs(deadlineAtMs);
    const uploadMeta = await this.executeMutation(
      null,
      () => {
        const requestTimeoutMs =
          deadlineAtMs === undefined
            ? timeoutMs
            : this.resolveRemainingUploadTimeoutMs(deadlineAtMs);
        return this.request<Record<string, unknown>>('post', '/uploads', {
          params: {
            type: uploadType,
          },
          ...(requestTimeoutMs ? { timeout: requestTimeoutMs } : {}),
        });
      },
      {
        trafficClass: requestOptions.trafficClass ?? 'critical',
        actionHealthLane: requestOptions.actionHealthLane,
        sourceTag: requestOptions.sourceTag,
        timeoutMs: requestOptions.timeoutMs,
        botId,
      },
    );
    const url = typeof uploadMeta.url === 'string' ? uploadMeta.url.trim() : '';
    const token = typeof uploadMeta.token === 'string' ? uploadMeta.token.trim() : '';
    if (!url) {
      throw new Error('MAX upload URL is missing');
    }

    return { token, url };
  }

  private async uploadVideoWithContentRange(
    data: Buffer,
    fileName: string,
    mimeType: string,
    requestOptions: MaxApiRequestOptions,
    botId: string,
  ): Promise<Record<string, unknown>> {
    const deadlineAtMs =
      Date.now() +
      (this.normalizeTimeoutMs(requestOptions.timeoutMs) ?? MAX_UPLOAD_BINARY_TIMEOUT_MS);
    let lastError: unknown = null;
    for (
      let sessionAttempt = 1;
      sessionAttempt <= MAX_RESUMABLE_VIDEO_UPLOAD_SESSION_ATTEMPTS;
      sessionAttempt += 1
    ) {
      try {
        const uploadMeta = await this.createUploadSession(
          'video',
          this.withUploadDeadline(requestOptions, deadlineAtMs),
          botId,
          deadlineAtMs,
        );
        if (!uploadMeta.token) {
          return await this.uploadMultipartToSession(
            'video',
            uploadMeta,
            data,
            fileName,
            mimeType,
            this.withUploadDeadline(requestOptions, deadlineAtMs),
          );
        }

        await this.uploadVideoContentRangeChunks(uploadMeta.url, data, fileName, deadlineAtMs);
        return { token: uploadMeta.token };
      } catch (error: unknown) {
        const sanitizedError = this.sanitizeUploadError(error, 'video');
        lastError = sanitizedError;
        // FLAG: This client does not assume remote offsets; ambiguous chunks restart in a fresh session.
        if (
          sessionAttempt >= MAX_RESUMABLE_VIDEO_UPLOAD_SESSION_ATTEMPTS ||
          Date.now() >= deadlineAtMs ||
          !this.isAmbiguousUploadTransportError(error)
        ) {
          throw sanitizedError;
        }
      }
    }

    throw lastError ?? new Error('MAX video upload failed');
  }

  private async uploadVideoContentRangeChunks(
    uploadUrl: string,
    data: Buffer,
    fileName: string,
    deadlineAtMs: number,
  ): Promise<void> {
    const headerFileName = this.normalizeUploadHeaderFileName(fileName);
    for (
      let startByte = 0;
      startByte < data.length;
      startByte += MAX_RESUMABLE_VIDEO_UPLOAD_CHUNK_BYTES
    ) {
      const endExclusive = Math.min(
        data.length,
        startByte + MAX_RESUMABLE_VIDEO_UPLOAD_CHUNK_BYTES,
      );
      const endByte = endExclusive - 1;
      const chunk = data.subarray(startByte, endExclusive);
      await this.requestAbsolute<unknown>('post', uploadUrl, {
        data: chunk,
        headers: {
          'Content-Disposition': `attachment; filename="${headerFileName}"`,
          'Content-Length': String(chunk.length),
          'Content-Range': `bytes ${startByte}-${endByte}/${data.length}`,
          'Content-Type': 'application/x-binary; charset=x-user-defined',
          'X-File-Name': headerFileName,
          'X-Uploading-Mode': 'parallel',
          Connection: 'keep-alive',
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: this.resolveRemainingUploadTimeoutMs(deadlineAtMs),
        skipAuthorization: true,
      });
    }
  }

  private async uploadMultipartToSession(
    uploadType: MaxMediaAttachmentType,
    uploadMeta: { token: string; url: string },
    data: Buffer,
    fileName: string,
    mimeType: string,
    requestOptions: MaxApiRequestOptions,
  ): Promise<Record<string, unknown>> {
    const form = new FormData();
    form.append('data', data, {
      filename: fileName,
      contentType: mimeType,
    });
    let uploadResult: unknown;
    try {
      uploadResult = await this.requestAbsolute<unknown>('post', uploadMeta.url, {
        data: form,
        headers: form.getHeaders(),
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: requestOptions.timeoutMs ?? MAX_UPLOAD_BINARY_TIMEOUT_MS,
        skipAuthorization: true,
      });
    } catch (error: unknown) {
      throw this.sanitizeUploadError(error, uploadType);
    }

    // MAX returns a plain retval (or no payload) after successful video/audio upload.
    // Their attachment token belongs to the upload session response, not this response.
    if ((uploadType === 'video' || uploadType === 'audio') && uploadMeta.token) {
      return { token: uploadMeta.token };
    }

    if (!uploadResult || typeof uploadResult !== 'object') {
      throw new Error('MAX upload payload is missing');
    }

    const uploadPayload = uploadResult as Record<string, unknown>;
    if (Object.keys(uploadPayload).length > 0) {
      return uploadPayload;
    }

    if (uploadMeta.token) {
      return { token: uploadMeta.token };
    }

    throw new Error('MAX upload payload is missing');
  }

  private isAmbiguousUploadTransportError(error: unknown): boolean {
    const status = this.extractStatusCode(error);
    return (
      (status !== null && status >= 500 && status <= 599) || isAmbiguousMaxMutationError(error)
    );
  }

  private sanitizeUploadError(error: unknown, uploadType: MaxMediaAttachmentType): Error {
    const status = this.extractStatusCode(error);
    const rawCode = (error as { code?: unknown })?.code;
    const code =
      typeof rawCode === 'string' && rawCode.trim() ? rawCode.trim().toUpperCase() : null;
    const ambiguous = this.isAmbiguousUploadTransportError(error);
    const message = status
      ? `MAX ${uploadType} upload failed with HTTP ${status}${ambiguous ? ' after an ambiguous transport failure' : ''}`
      : `MAX ${uploadType} upload failed${
          ambiguous ? ' after an ambiguous transport timeout or connection failure' : ''
        }${code ? ` (${code})` : ''}`;
    const sanitized = new Error(message) as Error & {
      code?: string;
      response?: { status: number };
    };
    sanitized.name = 'MaxMediaUploadError';
    if (code) {
      sanitized.code = code;
    }
    if (status !== null) {
      sanitized.response = { status };
    }
    return sanitized;
  }

  private withUploadDeadline(
    requestOptions: MaxApiRequestOptions,
    deadlineAtMs: number,
  ): MaxApiRequestOptions {
    return {
      ...requestOptions,
      timeoutMs: this.resolveRemainingUploadTimeoutMs(deadlineAtMs),
    };
  }

  private resolveRemainingUploadTimeoutMs(deadlineAtMs: number): number {
    const remainingMs = deadlineAtMs - Date.now();
    if (remainingMs <= 0) {
      throw Object.assign(new Error('MAX video upload deadline exceeded'), {
        code: 'ETIMEDOUT',
      });
    }
    return Math.max(1, Math.trunc(remainingMs));
  }

  private normalizeUploadHeaderFileName(fileName: string): string {
    const extensionMatch = fileName.match(/\.[A-Za-z0-9]{1,10}$/u);
    const extension = extensionMatch?.[0] ?? '';
    const stem = extension ? fileName.slice(0, -extension.length) : fileName;
    const asciiStem = stem
      .replace(/[^\x20-\x7E]+/gu, '_')
      .replace(/[^A-Za-z0-9._ -]+/gu, '_')
      .replace(/_+/gu, '_')
      .replace(/\s+/gu, ' ')
      .replace(/[. ]+$/u, '')
      .trim();
    const safeStem = /[A-Za-z0-9]/u.test(asciiStem) ? asciiStem : 'upload';
    return `${safeStem.slice(0, MAX_UPLOAD_FILENAME_MAX_LENGTH - extension.length)}${extension}`;
  }

  private normalizeUploadFileName(
    fileName: string | null | undefined,
    uploadType: MaxMediaAttachmentType,
  ): string {
    const fallback =
      uploadType === 'image' ? 'upload.jpg' : uploadType === 'video' ? 'upload.mp4' : 'upload.bin';
    const raw = typeof fileName === 'string' ? fileName.normalize('NFC').trim() : '';
    if (!raw) {
      return fallback;
    }

    const withoutPath =
      raw
        .split(/[\\/]+/u)
        .pop()
        ?.trim() ?? '';
    const sanitized = withoutPath
      .replace(/[^\p{L}\p{N}._ -]+/gu, '_')
      .replace(/_+/gu, '_')
      .replace(/\s+/gu, ' ')
      .replace(/[. ]+$/u, '')
      .slice(0, MAX_UPLOAD_FILENAME_MAX_LENGTH)
      .trim();

    if (!sanitized || sanitized === '.' || sanitized === '..') {
      return fallback;
    }

    return sanitized;
  }

  private normalizeValidatedMediaUploadFileName(
    fileName: string | null | undefined,
    uploadType: 'image' | 'video',
    extension: string,
  ): string {
    const normalized = this.normalizeUploadFileName(fileName, uploadType);
    const rawStem = normalized.replace(/\.[^./\\]+$/u, '');
    const maxStemLength = Math.max(1, MAX_UPLOAD_FILENAME_MAX_LENGTH - extension.length - 1);
    const stem =
      rawStem
        .slice(0, maxStemLength)
        .replace(/[. ]+$/u, '')
        .trim() || 'upload';
    return `${stem}.${extension}`;
  }

  async kickMember(chatId: string, userId: string, options?: MaxActionDispatchOptions) {
    this.assertMemberActionTargetIsNotRuntimeBot('KICK_MEMBER', chatId, userId);
    await this.dispatchAction(
      {
        actionType: 'KICK_MEMBER',
        chatId,
        userId,
      },
      options,
    );
  }

  async banMember(chatId: string, userId: string, options?: MaxActionDispatchOptions) {
    this.assertMemberActionTargetIsNotRuntimeBot('BAN_MEMBER', chatId, userId);
    await this.dispatchAction(
      {
        actionType: 'BAN_MEMBER',
        chatId,
        userId,
      },
      options,
    );
  }

  async unbanMember(chatId: string, userId: string, options?: MaxActionDispatchOptions) {
    await this.dispatchAction(
      {
        actionType: 'UNBAN_MEMBER',
        chatId,
        userId,
      },
      options,
    );
  }

  async leaveCurrentChat(chatId: string, options: MaxApiRequestOptions = {}): Promise<void> {
    try {
      await this.executeMutation(
        chatId,
        async () => {
          await this.request('delete', `/chats/${chatId}/members/me`);
        },
        options,
      );
    } catch (error: unknown) {
      if (this.isAlreadyOutsideChatError(error)) {
        return;
      }
      throw error;
    }
  }

  async cancelScheduledUnban(chatId: string, userId: string, options?: { botId?: string }) {
    const botId = this.resolveBot(options?.botId).id;
    const jobIds = [
      this.buildScheduledMemberActionJobId('UNBAN_MEMBER', chatId, userId, botId),
      this.buildScheduledMemberActionJobId('UNBAN_MEMBER', chatId, userId, botId, true),
    ].filter((jobId): jobId is string => Boolean(jobId));
    if (jobIds.length === 0) {
      return;
    }

    for (const jobId of jobIds) {
      const timeout = this.keyedActionTimeouts.get(jobId);
      if (timeout) {
        clearTimeout(timeout);
        this.pendingTimeouts.delete(timeout);
        this.keyedActionTimeouts.delete(jobId);
      }

      if (this.dispatchEnabled && this.getActionQueues().length > 0) {
        await this.removeQueuedActionJob(jobId);
      }
    }
  }

  async notifyModerators(chatId: string, text: string) {
    await this.dispatchAction({
      actionType: 'NOTIFY_MODERATORS',
      chatId,
      text,
    });
  }

  async executeActionJob(
    job: MaxActionJob,
    executionOptions: MaxActionExecutionOptions = {},
  ): Promise<MaxPublishedMessage | void> {
    const action = {
      ...job,
      attempt: Number.isInteger(job.attempt) && job.attempt > 0 ? job.attempt : 1,
    };
    const completedSendMessageId =
      await this.actionLedgerService?.getCompletedSendDispatch?.(action);
    if (completedSendMessageId) {
      return {
        messageId: completedSendMessageId,
        url: null,
      };
    }
    const bot = this.resolveExecutableBot(action.botId, {
      explicit: Boolean(action.botId?.trim()),
    });
    const mutationOptions = this.buildQueuedActionMutationOptions(action, bot.id);

    return this.botContext.runWithBot(bot.id, async () => {
      switch (action.actionType) {
        case 'DELETE_MESSAGE':
          if (!action.messageId) {
            throw new Error('messageId is required for DELETE_MESSAGE');
          }
          await this.executeMessageMutation(
            'delete',
            action.chatId,
            async () => {
              await this.runPreDispatchMutationGuard(
                executionOptions.beforeDeleteMutation,
                MAX_DELETE_PRE_DISPATCH_GUARD_REJECTED_CODE,
              );
              const response = await this.request<Record<string, unknown>>('delete', '/messages', {
                params: {
                  message_id: action.messageId,
                },
                ...(mutationOptions.timeoutMs ? { timeout: mutationOptions.timeoutMs } : {}),
              });
              this.assertSuccessfulDeleteMessageResponse(response);
            },
            mutationOptions,
          );
          return;

        case 'SEND_MESSAGE': {
          if (typeof action.text !== 'string') {
            throw new Error('text is required for SEND_MESSAGE');
          }
          const attachments = this.buildMessageAttachments(action.options);
          const sendResponse = await this.executeQueuedSendMessage(
            action,
            attachments,
            mutationOptions,
          );
          const sentMessageId = this.extractMessageIdFromSendResponse(sendResponse);
          if (!sentMessageId) {
            throw new Error('MAX SEND_MESSAGE response has no remote message id');
          }
          const autoDeleteDelayMs = this.normalizeDelayMs(action.autoDeleteDelayMs);
          if (autoDeleteDelayMs > 0) {
            try {
              await this.dispatchAction(
                {
                  actionType: 'DELETE_MESSAGE',
                  chatId: action.chatId,
                  messageId: sentMessageId,
                },
                this.buildAutoDeleteDispatchOptions(action, bot.id, autoDeleteDelayMs),
              );
            } catch (error: unknown) {
              this.logger.warn(
                {
                  chatId: action.chatId,
                  messageId: sentMessageId,
                  autoDeleteDelayMs,
                  error: error instanceof Error ? error.message : 'Unknown error',
                },
                'Failed to enqueue auto-delete for sent bot message',
              );
            }
          }
          const resolvedChatId = this.extractChatIdFromSendResponse(sendResponse);
          return {
            messageId: sentMessageId,
            url: this.parseChatLink(sendResponse),
            ...(resolvedChatId ? { chatId: resolvedChatId } : {}),
          };
        }

        case 'KICK_MEMBER':
          if (!action.userId) {
            throw new Error('userId is required for KICK_MEMBER');
          }
          if (
            this.skipQueuedMemberActionForRuntimeBot(
              action.actionType,
              action.chatId,
              action.userId,
            )
          ) {
            return;
          }
          await this.executeQueuedMemberModerationAction(action, mutationOptions, {
            block: false,
            beforeMutation: executionOptions.beforeMemberMutation,
          });
          return;

        case 'BAN_MEMBER':
          if (!action.userId) {
            throw new Error('userId is required for BAN_MEMBER');
          }
          if (
            this.skipQueuedMemberActionForRuntimeBot(
              action.actionType,
              action.chatId,
              action.userId,
            )
          ) {
            return;
          }
          await this.executeQueuedMemberModerationAction(action, mutationOptions, {
            block: true,
            beforeMutation: executionOptions.beforeMemberMutation,
          });
          return;

        case 'UNBAN_MEMBER': {
          if (!action.userId) {
            throw new Error('userId is required for UNBAN_MEMBER');
          }
          let memberMutationAttempted = false;
          try {
            await this.executeMutation(
              action.chatId,
              async () => {
                await this.runPreDispatchMutationGuard(
                  executionOptions.beforeMemberMutation,
                  MAX_MEMBER_PRE_DISPATCH_GUARD_REJECTED_CODE,
                );
                memberMutationAttempted = true;
                await this.request('post', `/chats/${action.chatId}/members`, {
                  data: {
                    user_ids: [action.userId],
                  },
                });
              },
              mutationOptions,
            );
          } catch (error: unknown) {
            if (!this.isAlreadyPresentChatMemberError(error)) {
              throw memberMutationAttempted ? markMaxMemberMutationAttempted(error) : error;
            }
          }
          try {
            await this.actionLedgerService?.clearTerminalBanStateAfterUnban(
              action.chatId,
              action.userId,
            );
          } catch (error: unknown) {
            throw memberMutationAttempted ? markMaxMemberMutationConfirmed(error) : error;
          }
          return;
        }

        case 'NOTIFY_MODERATORS':
          this.logger.warn({ chatId: action.chatId, text: action.text ?? '' }, 'Moderator alert');
          this.actionHealthService.recordSuccess(bot.id);
          return;
      }
    });
  }

  async getChatTitle(chatId: string, options: MaxApiRequestOptions = {}): Promise<string | null> {
    const data = await this.executeChatRequest(
      chatId,
      async () => this.request<Record<string, unknown>>('get', `/chats/${chatId}`),
      options,
    );
    return this.readTrimmedString(data.title ?? data.name);
  }

  async getChatSnapshot(
    chatId: string,
    options: MaxApiRequestOptions = {},
  ): Promise<MaxChatSnapshot> {
    const normalizedChatId = chatId.trim();
    const botId = this.resolveBot(options.botId).id;
    const timeoutMs =
      typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
        ? Math.max(1, Math.trunc(options.timeoutMs))
        : undefined;
    if (!options.bypassCache) {
      const cachedSnapshot = await this.readJsonCache(
        this.buildChatSnapshotCacheKey(botId, normalizedChatId),
        this.isMaxChatSnapshot.bind(this),
      );
      if (cachedSnapshot) {
        return { ...cachedSnapshot };
      }
    }

    const data = await this.executeChatRequest(
      normalizedChatId,
      async () =>
        this.request<Record<string, unknown>>('get', `/chats/${normalizedChatId}`, {
          ...(timeoutMs ? { timeout: timeoutMs } : {}),
        }),
      options,
    );
    const link = this.parseChatLink(data);
    const isPublic = this.readBoolean(data.is_public ?? data.isPublic ?? data.public);

    const snapshot: MaxChatSnapshot = {
      chatId: normalizedChatId,
      title: this.readTrimmedString(data.title ?? data.name),
      participantsCount: this.readNullableInteger(
        data.participants_count ??
          data.participantsCount ??
          data.members_count ??
          data.membersCount,
      ),
      status: this.readLowerString(data.status),
      isPublic: isPublic ?? (link ? true : null),
      link,
      lastEventAt: this.readIsoDateTime(
        data.last_event_time ?? data.lastEventTime ?? data.updated_at ?? data.updatedAt,
      ),
      entityType: this.parseChatEntityType(data),
      avatarUrl: this.parseChatAvatarUrl(data),
    };

    if (!options.bypassCache) {
      await this.writeJsonCache(
        this.buildChatSnapshotCacheKey(botId, normalizedChatId),
        snapshot,
        this.chatSnapshotCacheTtlSec,
      );
    }

    return snapshot;
  }

  async getChannelSnapshotByLink(
    chatLink: string,
    options: MaxApiRequestOptions = {},
  ): Promise<MaxChatSnapshot> {
    const normalizedChatLink = chatLink.trim().replace(/^\/+/u, '');
    const botId = this.resolveBot(options.botId).id;
    const timeoutMs =
      typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
        ? Math.max(1, Math.trunc(options.timeoutMs))
        : undefined;
    if (!normalizedChatLink) {
      throw new Error('MAX chat link is required');
    }

    const data = await this.executeGlobalRequest(
      () =>
        this.request<Record<string, unknown>>(
          'get',
          `/chats/${encodeURIComponent(normalizedChatLink)}`,
          {
            ...(timeoutMs ? { timeout: timeoutMs } : {}),
          },
        ),
      options,
    );
    const chatId = data.chat_id ?? data.chatId ?? data.id;
    const normalizedChatId =
      typeof chatId === 'string' || typeof chatId === 'number'
        ? String(chatId).trim()
        : normalizedChatLink;
    const link = this.parseChatLink(data);
    const isPublic = this.readBoolean(data.is_public ?? data.isPublic ?? data.public);
    const snapshot: MaxChatSnapshot = {
      chatId: normalizedChatId,
      title: this.readTrimmedString(data.title ?? data.name),
      participantsCount: this.readNullableInteger(
        data.participants_count ??
          data.participantsCount ??
          data.members_count ??
          data.membersCount,
      ),
      status: this.readLowerString(data.status),
      isPublic: isPublic ?? (link ? true : null),
      link,
      lastEventAt: this.readIsoDateTime(
        data.last_event_time ?? data.lastEventTime ?? data.updated_at ?? data.updatedAt,
      ),
      entityType: this.parseChatEntityType(data),
      avatarUrl: this.parseChatAvatarUrl(data),
    };

    if (!options.bypassCache && normalizedChatId) {
      await this.writeJsonCache(
        this.buildChatSnapshotCacheKey(botId, normalizedChatId),
        snapshot,
        this.chatSnapshotCacheTtlSec,
      );
    }

    return snapshot;
  }

  async getChatAdminIds(chatId: string, options: MaxApiRequestOptions = {}): Promise<string[]> {
    const normalizedChatId = chatId.trim();
    const botId = this.resolveBot(options.botId).id;
    const cacheKey = this.buildChatAdminIdsCacheKey(botId, normalizedChatId);
    if (!options.bypassCache) {
      const cachedAdminIds = await this.readJsonCache(cacheKey, (value): value is string[] =>
        this.isStringArray(value),
      );
      if (cachedAdminIds) {
        return [...cachedAdminIds];
      }

      const existingInFlight = this.chatAdminIdsInFlight.get(cacheKey);
      if (existingInFlight) {
        return [...(await existingInFlight)];
      }
    }

    const pending = this.fetchChatAdminIdsUncached(normalizedChatId, botId, options).finally(() => {
      if (this.chatAdminIdsInFlight.get(cacheKey) === pending) {
        this.chatAdminIdsInFlight.delete(cacheKey);
      }
    });
    if (!options.bypassCache) {
      this.chatAdminIdsInFlight.set(cacheKey, pending);
    }

    return [...(await pending)];
  }

  private async fetchChatAdminIdsUncached(
    chatId: string,
    botId: string,
    options: MaxApiRequestOptions,
  ): Promise<string[]> {
    const members = await this.listChatAdminMembers(chatId, options);

    const adminIds = members
      .map((member) => {
        if (!member || typeof member !== 'object') {
          return null;
        }

        const row = member as Record<string, unknown>;
        if (!this.isChatAdminMemberRow(row)) {
          return null;
        }

        const value = row.user_id ?? row.userId ?? row.id;
        if (typeof value === 'number' || typeof value === 'string') {
          return String(value);
        }
        return null;
      })
      .filter((value): value is string => value !== null);

    if (!options.bypassCache) {
      await this.writeJsonCache(
        this.buildChatAdminIdsCacheKey(botId, chatId),
        adminIds,
        this.chatAdminIdsCacheTtlSec,
      );
    }

    return adminIds;
  }

  async getCurrentChatMemberAccess(
    chatId: string,
    options: MaxApiRequestOptions = {},
  ): Promise<MaxChatMemberAccess> {
    const normalizedChatId = chatId.trim();
    const botId = this.resolveBot(options.botId).id;
    const cacheKey = this.buildCurrentChatMemberAccessCacheKey(botId, normalizedChatId);
    if (!options.bypassCache) {
      const cachedAccess = await this.readJsonCache(
        cacheKey,
        (value): value is MaxChatMemberAccess => this.isMaxChatMemberAccess(value),
      );
      if (cachedAccess) {
        return { ...cachedAccess, permissions: [...cachedAccess.permissions] };
      }

      const existingInFlight = this.currentChatMemberAccessInFlight.get(cacheKey);
      if (existingInFlight) {
        const access = await existingInFlight;
        return { ...access, permissions: [...access.permissions] };
      }
    }

    const pending = this.fetchCurrentChatMemberAccessUncached(normalizedChatId, botId, options)
      .then(async (access) => {
        if (!options.bypassCache) {
          await this.writeJsonCache(
            cacheKey,
            access,
            this.resolveChatMemberAccessCacheTtlSec(access),
          );
        }
        return access;
      })
      .finally(() => {
        if (this.currentChatMemberAccessInFlight.get(cacheKey) === pending) {
          this.currentChatMemberAccessInFlight.delete(cacheKey);
        }
      });
    if (!options.bypassCache) {
      this.currentChatMemberAccessInFlight.set(cacheKey, pending);
    }

    const access = await pending;
    return { ...access, permissions: [...access.permissions] };
  }

  private async fetchCurrentChatMemberAccessUncached(
    chatId: string,
    _botId: string,
    options: MaxApiRequestOptions,
  ): Promise<MaxChatMemberAccess> {
    const timeoutMs =
      typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
        ? Math.max(1, Math.trunc(options.timeoutMs))
        : undefined;
    const data = await this.executeChatRequest(
      chatId,
      async () =>
        this.request<Record<string, unknown>>('get', `/chats/${chatId}/members/me`, {
          ...(timeoutMs ? { timeout: timeoutMs } : {}),
        }),
      options,
    );
    return this.parseChatMemberAccess(data);
  }

  async getChatMemberAccess(
    chatId: string,
    userId: string,
    options: MaxApiRequestOptions = {},
  ): Promise<MaxChatMemberAccess | null> {
    const normalizedUserId = userId.trim();
    if (!normalizedUserId) {
      return null;
    }
    const accessByUserId = await this.getChatMembersAccess(chatId, [normalizedUserId], options);
    return accessByUserId.get(normalizedUserId) ?? null;
  }

  async getChatMembersAccess(
    chatId: string,
    userIds: readonly string[],
    options: MaxApiRequestOptions = {},
  ): Promise<Map<string, MaxChatMemberAccess>> {
    const normalizedChatId = chatId.trim();
    const botId = this.resolveBot(options.botId).id;
    const timeoutMs =
      typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
        ? Math.max(1, Math.trunc(options.timeoutMs))
        : undefined;
    const normalizedUserIds = Array.from(
      new Set(
        userIds.map((value) => value.trim()).filter((value): value is string => value.length > 0),
      ),
    );
    if (normalizedUserIds.length === 0) {
      return new Map();
    }

    const accessByUserId = new Map<string, MaxChatMemberAccess>();
    const missingUserIds: string[] = [];

    if (!options.bypassCache) {
      const cachedRows = await Promise.all(
        normalizedUserIds.map(async (userId) => ({
          userId,
          access: await this.readJsonCache(
            this.buildChatMemberAccessCacheKey(botId, normalizedChatId, userId),
            (value): value is MaxChatMemberAccess => this.isMaxChatMemberAccess(value),
          ),
        })),
      );
      for (const row of cachedRows) {
        if (row.access) {
          accessByUserId.set(row.userId, {
            ...row.access,
            permissions: [...row.access.permissions],
          });
        } else {
          missingUserIds.push(row.userId);
        }
      }
    } else {
      missingUserIds.push(...normalizedUserIds);
    }

    for (let index = 0; index < missingUserIds.length; index += 100) {
      const chunk = missingUserIds.slice(index, index + 100);
      const inFlightKey = this.buildChatMembersAccessInFlightKey(botId, normalizedChatId, chunk);
      let fetchedAccess: Map<string, MaxChatMemberAccess>;
      if (!options.bypassCache && this.chatMembersAccessInFlight.has(inFlightKey)) {
        fetchedAccess = await this.chatMembersAccessInFlight.get(inFlightKey)!;
      } else {
        const pending = this.fetchChatMembersAccessChunkUncached(
          normalizedChatId,
          chunk,
          options,
          timeoutMs,
        ).finally(() => {
          if (this.chatMembersAccessInFlight.get(inFlightKey) === pending) {
            this.chatMembersAccessInFlight.delete(inFlightKey);
          }
        });
        if (!options.bypassCache) {
          this.chatMembersAccessInFlight.set(inFlightKey, pending);
        }
        fetchedAccess = await pending;
      }

      for (const [userId, access] of fetchedAccess.entries()) {
        accessByUserId.set(userId, {
          ...access,
          permissions: [...access.permissions],
        });
        if (!options.bypassCache) {
          await this.writeJsonCache(
            this.buildChatMemberAccessCacheKey(botId, normalizedChatId, userId),
            access,
            this.resolveChatMemberAccessCacheTtlSec(access),
          );
        }
      }
    }

    return accessByUserId;
  }

  private async fetchChatMembersAccessChunkUncached(
    chatId: string,
    userIds: readonly string[],
    options: MaxApiRequestOptions,
    timeoutMs?: number,
  ): Promise<Map<string, MaxChatMemberAccess>> {
    const accessByUserId = new Map<string, MaxChatMemberAccess>();
    if (userIds.length === 0) {
      return accessByUserId;
    }

    for (let index = 0; index < userIds.length; index += 100) {
      const chunk = userIds.slice(index, index + 100);
      const query = new URLSearchParams({ user_ids: chunk.join(',') });

      const data = await this.executeChatRequest(
        chatId,
        async () =>
          this.request<Record<string, unknown>>(
            'get',
            `/chats/${chatId}/members?${query.toString()}`,
            {
              ...(timeoutMs ? { timeout: timeoutMs } : {}),
            },
          ),
        options,
      );
      const members = Array.isArray(data.members)
        ? data.members
        : Array.isArray(data.users)
          ? data.users
          : [];

      for (const member of members) {
        const access = this.parseChatMemberAccess(member);
        if (!access.userId) {
          continue;
        }

        accessByUserId.set(access.userId, access);
      }
    }

    return accessByUserId;
  }

  async hasChatMember(
    chatId: string,
    userId: string,
    options: MaxApiRequestOptions = {},
  ): Promise<boolean> {
    const normalizedUserId = userId.trim();
    if (!normalizedUserId) {
      return false;
    }
    const timeoutMs =
      typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
        ? Math.max(1, Math.trunc(options.timeoutMs))
        : undefined;

    const data = await this.executeChatRequest(
      chatId,
      async () =>
        this.request<Record<string, unknown>>('get', `/chats/${chatId}/members`, {
          ...(timeoutMs ? { timeout: timeoutMs } : {}),
          params: {
            user_ids: normalizedUserId,
          },
        }),
      options,
    );
    const members = Array.isArray(data.members)
      ? data.members
      : Array.isArray(data.users)
        ? data.users
        : [];

    return members.some((member) => this.readMemberUserId(member) === normalizedUserId);
  }

  async getChatMemberProfiles(
    chatId: string,
    userIds: readonly string[],
    options: MaxApiRequestOptions = {},
  ): Promise<Map<string, MaxChatMemberProfile>> {
    const timeoutMs =
      typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
        ? Math.max(1, Math.trunc(options.timeoutMs))
        : undefined;
    const normalizedUserIds = Array.from(
      new Set(
        userIds.map((value) => value.trim()).filter((value): value is string => value.length > 0),
      ),
    );
    if (normalizedUserIds.length === 0) {
      return new Map();
    }

    const profiles = new Map<string, MaxChatMemberProfile>();

    for (let index = 0; index < normalizedUserIds.length; index += 100) {
      const chunk = normalizedUserIds.slice(index, index + 100);
      const query = new URLSearchParams({ user_ids: chunk.join(',') });

      const data = await this.executeChatRequest(
        chatId,
        async () =>
          this.request<Record<string, unknown>>(
            'get',
            `/chats/${chatId}/members?${query.toString()}`,
            {
              ...(timeoutMs ? { timeout: timeoutMs } : {}),
            },
          ),
        options,
      );
      const members = Array.isArray(data.members)
        ? data.members
        : Array.isArray(data.users)
          ? data.users
          : [];

      for (const member of members) {
        const profile = this.parseChatMemberProfile(member);
        if (!profile) {
          continue;
        }

        profiles.set(profile.userId, profile);
      }
    }

    return profiles;
  }

  async getChatMembersPage(
    chatId: string,
    query: {
      limit?: number;
      marker?: string | null;
    } = {},
    options: MaxApiRequestOptions = {},
  ): Promise<MaxChatMembersPage> {
    const timeoutMs =
      typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
        ? Math.max(1, Math.trunc(options.timeoutMs))
        : undefined;
    const limit =
      typeof query.limit === 'number' && Number.isFinite(query.limit)
        ? Math.max(1, Math.min(100, Math.trunc(query.limit)))
        : 100;
    const marker = query.marker?.trim() ?? '';
    const params: Record<string, string | number> = {
      count: limit,
    };
    if (marker) {
      params.marker = marker;
    }

    const data = await this.executeChatRequest(
      chatId,
      async () =>
        this.request<Record<string, unknown>>('get', `/chats/${chatId}/members`, {
          params,
          ...(timeoutMs ? { timeout: timeoutMs } : {}),
        }),
      options,
    );
    const members = Array.isArray(data.members)
      ? data.members
      : Array.isArray(data.users)
        ? data.users
        : [];

    return {
      items: members
        .map((member) => {
          const profile = this.parseChatMemberProfile(member);
          if (!profile?.userId) {
            return null;
          }

          return {
            userId: profile.userId,
            displayName: profile.displayName,
            username: profile.username,
            avatarUrl: profile.avatarUrl,
            profileUrl: profile.profileUrl,
            role: this.parseChatMemberRole(member),
            isBot: this.parseChatMemberBot(member, profile),
            unavailableReason: this.parseChatMemberUnavailableReason(member),
          };
        })
        .filter((member): member is MaxChatRosterMember => member !== null),
      nextMarker:
        typeof data.marker === 'string' || typeof data.marker === 'number'
          ? String(data.marker).trim() || null
          : null,
    };
  }

  async getOwnProfile(options: MaxApiRequestOptions = {}): Promise<MaxChatMemberProfile> {
    const bot = this.resolveBot(options.botId);
    const timeoutMs =
      typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
        ? Math.max(1, Math.trunc(options.timeoutMs))
        : undefined;
    const data = await this.executeGlobalRequest(
      async () =>
        this.request<Record<string, unknown>>('get', '/me', {
          ...(timeoutMs ? { timeout: timeoutMs } : {}),
        }),
      options,
    );

    return {
      userId:
        this.readTrimmedString(data.user_id ?? data.userId ?? data.id) ?? bot.contactId ?? bot.id,
      displayName: resolveMaxUserDisplayName(data),
      username: this.readTrimmedString(data.username),
      avatarUrl: this.readTrimmedString(
        data.full_avatar_url ?? data.fullAvatarUrl ?? data.avatar_url ?? data.avatarUrl,
      ),
      profileUrl: this.readProfileUrl(
        data.profile_url,
        data.profileUrl,
        data.url,
        data.link,
        data.username ? `https://max.ru/${String(data.username).trim()}` : null,
      ),
    };
  }

  async listBotChats(options: MaxApiRequestOptions = {}): Promise<MaxBotChat[]> {
    if (this.isProduction) {
      throw new Error(MAX_LIST_BOT_CHATS_UNSUPPORTED_IN_PRODUCTION);
    }

    const botId = this.resolveBot(options.botId).id;
    if (!options.bypassCache) {
      const cachedChats = await this.readJsonCache(
        this.buildListBotChatsCacheKey(botId),
        this.isMaxBotChatList.bind(this),
      );
      if (cachedChats) {
        return cachedChats.map((chat) => ({ ...chat }));
      }
    }

    const inFlightKey = `${botId}:${options.bypassCache === true ? 'bypass' : 'cache'}`;
    const existingInFlight = this.listBotChatsInFlight.get(inFlightKey);
    if (existingInFlight) {
      const chats = await existingInFlight;
      return chats.map((chat) => ({ ...chat }));
    }

    const pending = this.fetchBotChatsUncached(botId, options).finally(() => {
      if (this.listBotChatsInFlight.get(inFlightKey) === pending) {
        this.listBotChatsInFlight.delete(inFlightKey);
      }
    });
    this.listBotChatsInFlight.set(inFlightKey, pending);

    const chats = await pending;
    return chats.map((chat) => ({ ...chat }));
  }

  private async fetchBotChatsUncached(
    botId: string,
    options: MaxApiRequestOptions,
  ): Promise<MaxBotChat[]> {
    const results: MaxBotChat[] = [];
    const seenMarkers = new Set<string>();
    let marker: string | number | null = null;

    let pagesFetched = 0;
    while (pagesFetched < MAX_API_LIST_BOT_CHATS_PAGE_SAFETY_CAP) {
      pagesFetched += 1;
      const pageData: Record<string, unknown> = await this.executeGlobalRequest(
        () =>
          this.request('get', '/chats', {
            params: {
              count: 100,
              ...(marker !== null ? { marker } : {}),
            },
          }),
        options,
      );

      const pageChats = Array.isArray(pageData.chats) ? pageData.chats : [];
      for (const item of pageChats) {
        if (!item || typeof item !== 'object') {
          continue;
        }

        const row = item as Record<string, unknown>;
        const chatId = row.chat_id ?? row.chatId ?? row.id;
        if (typeof chatId !== 'string' && typeof chatId !== 'number') {
          continue;
        }

        const title = row.title ?? row.name;
        const lastEventTime = row.last_event_time ?? row.lastEventTime;
        const entityType = this.parseChatEntityType(row);
        const link = this.parseChatLink(row);
        results.push({
          chatId: String(chatId),
          title: typeof title === 'string' ? title : null,
          lastEventTime:
            typeof lastEventTime === 'number'
              ? lastEventTime
              : typeof lastEventTime === 'string' && lastEventTime.trim() !== ''
                ? Number(lastEventTime)
                : null,
          entityType,
          link,
          avatarUrl: this.parseChatAvatarUrl(row),
          botId,
          botIds: [botId],
        });
      }

      const nextMarker: unknown = pageData.marker;
      if (
        nextMarker === null ||
        nextMarker === undefined ||
        (typeof nextMarker !== 'string' && typeof nextMarker !== 'number')
      ) {
        break;
      }

      const markerKey = String(nextMarker);
      if (seenMarkers.has(markerKey)) {
        break;
      }
      seenMarkers.add(markerKey);
      marker = nextMarker;
    }

    if (pagesFetched >= MAX_API_LIST_BOT_CHATS_PAGE_SAFETY_CAP && marker !== null) {
      this.logger.warn(
        {
          botId,
          pagesFetched,
          marker,
        },
        'Stopped MAX bot chat discovery after reaching pagination safety cap',
      );
    }

    if (!options.bypassCache) {
      await this.writeJsonCache(
        this.buildListBotChatsCacheKey(botId),
        results,
        this.listBotChatsCacheTtlSec,
      );
    }

    return results;
  }

  private buildListBotChatsCacheKey(botId: string): string {
    return `maxapi:cache:v1:list-bot-chats:${botId}`;
  }

  private buildChatSnapshotCacheKey(botId: string, chatId: string): string {
    return `maxapi:cache:v1:chat-snapshot:${botId}:${chatId}`;
  }

  private buildCurrentChatMemberAccessCacheKey(botId: string, chatId: string): string {
    return `maxapi:cache:v1:chat-member-access:${botId}:${chatId}:__self`;
  }

  private buildChatMemberAccessCacheKey(botId: string, chatId: string, userId: string): string {
    return `maxapi:cache:v1:chat-member-access:${botId}:${chatId}:${userId}`;
  }

  private buildChatMembersAccessInFlightKey(
    botId: string,
    chatId: string,
    userIds: readonly string[],
  ): string {
    return `${botId}:${chatId}:${userIds.join(',')}`;
  }

  private buildChatAdminIdsCacheKey(botId: string, chatId: string): string {
    return `maxapi:cache:v1:chat-admin-ids:${botId}:${chatId}`;
  }

  private async readJsonCache<T>(
    key: string,
    guard: (value: unknown) => value is T,
  ): Promise<T | null> {
    const rawValue = await this.limiterRedis.get(key);
    if (!rawValue) {
      return null;
    }

    try {
      const parsed = JSON.parse(rawValue) as unknown;
      if (guard(parsed)) {
        return parsed;
      }
    } catch {
      // Ignore malformed cache entries and refresh them from MAX.
    }

    await this.limiterRedis.del(key);
    return null;
  }

  private async writeJsonCache(key: string, value: unknown, ttlSec: number): Promise<void> {
    if (!Number.isFinite(ttlSec) || ttlSec <= 0) {
      return;
    }

    await this.limiterRedis.set(key, JSON.stringify(value), 'EX', Math.trunc(ttlSec));
  }

  private isMaxBotChatList(value: unknown): value is MaxBotChat[] {
    return Array.isArray(value) && value.every((item) => this.isMaxBotChat(item));
  }

  private isMaxBotChat(value: unknown): value is MaxBotChat {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }

    const row = value as Record<string, unknown>;
    return (
      typeof row.chatId === 'string' &&
      (typeof row.title === 'string' || row.title === null) &&
      (typeof row.lastEventTime === 'number' || row.lastEventTime === null) &&
      (row.entityType === 'chat' || row.entityType === 'channel') &&
      (typeof row.link === 'string' || row.link === null) &&
      (typeof row.avatarUrl === 'string' || row.avatarUrl === null)
    );
  }

  private isMaxChatSnapshot(value: unknown): value is MaxChatSnapshot {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }

    const row = value as Record<string, unknown>;
    return (
      typeof row.chatId === 'string' &&
      (typeof row.title === 'string' || row.title === null) &&
      (typeof row.participantsCount === 'number' || row.participantsCount === null) &&
      (typeof row.status === 'string' || row.status === null) &&
      (typeof row.isPublic === 'boolean' || row.isPublic === null) &&
      (typeof row.link === 'string' || row.link === null) &&
      (typeof row.lastEventAt === 'string' || row.lastEventAt === null) &&
      (row.entityType === 'chat' || row.entityType === 'channel') &&
      (typeof row.avatarUrl === 'string' || row.avatarUrl === null)
    );
  }

  private isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
  }

  private isMaxChatMemberAccess(value: unknown): value is MaxChatMemberAccess {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }

    const row = value as Record<string, unknown>;
    return (
      (typeof row.userId === 'string' || row.userId === null) &&
      typeof row.isAdmin === 'boolean' &&
      typeof row.isOwner === 'boolean' &&
      Array.isArray(row.permissions) &&
      row.permissions.every((permission) => typeof permission === 'string')
    );
  }

  private resolveChatMemberAccessCacheTtlSec(access: MaxChatMemberAccess): number {
    return access.isAdmin || access.isOwner
      ? this.chatMemberAccessAdminCacheTtlSec
      : this.chatMemberAccessMemberCacheTtlSec;
  }

  private async getMessageById(
    messageId: string,
    requestOptions: MaxApiRequestOptions | MaxApiTrafficClass = 'critical',
  ): Promise<Record<string, unknown> | null> {
    const normalizedMessageId = messageId.trim();
    if (!normalizedMessageId) {
      return null;
    }

    const data = await this.executeGlobalRequest(
      () =>
        this.request<Record<string, unknown>>('get', '/messages', {
          params: {
            message_ids: normalizedMessageId,
          },
        }),
      requestOptions,
    );
    const messages = Array.isArray(data.messages) ? data.messages : [];
    const matchedMessage = messages.find((message) => {
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        return false;
      }

      return this.extractMessageIdFromSendResponse(message) === normalizedMessageId;
    });
    if (matchedMessage && typeof matchedMessage === 'object' && !Array.isArray(matchedMessage)) {
      return matchedMessage as Record<string, unknown>;
    }

    // Some MAX installations ignore `message_ids` filtering and return recent messages instead.
    // Fall back to the direct message path so edits target the intended post.
    return this.getMessageByPath(normalizedMessageId, requestOptions);
  }

  private async getMessageByPath(
    messageId: string,
    requestOptions: MaxApiRequestOptions | MaxApiTrafficClass = 'critical',
  ): Promise<Record<string, unknown> | null> {
    const normalizedMessageId = messageId.trim();
    if (!normalizedMessageId) {
      return null;
    }

    const data = await this.executeGlobalRequest(
      () =>
        this.request<Record<string, unknown>>(
          'get',
          `/messages/${encodeURIComponent(normalizedMessageId)}`,
        ),
      requestOptions,
    );
    const nestedMessage = this.asRecord(data?.message);
    const exactMessage = [nestedMessage, data].find(
      (candidate) =>
        candidate && this.extractMessageIdFromSendResponse(candidate) === normalizedMessageId,
    );
    if (!exactMessage) {
      throw new Error('MAX direct message lookup returned a response without the requested id');
    }
    return exactMessage;
  }

  private parseChatEntityType(row: Record<string, unknown>): 'chat' | 'channel' {
    const rawType = row.type ?? row.chat_type ?? row.chatType;
    const isChannel = this.readBoolean(row.is_channel ?? row.isChannel);
    if (typeof rawType === 'string') {
      const normalized = rawType.trim().toLowerCase();
      if (normalized === 'channel') {
        return 'channel';
      }
      if (
        normalized === 'chat' ||
        normalized === 'group' ||
        normalized === 'supergroup' ||
        normalized === 'dialog'
      ) {
        if (isChannel === true) {
          return 'channel';
        }
        return 'chat';
      }
    }

    if (isChannel === true) {
      return 'channel';
    }
    if (isChannel === false) {
      return 'chat';
    }

    const link = this.parseChatLink(row);
    if (link && /\/channels?\//iu.test(link)) {
      return 'channel';
    }

    return 'chat';
  }

  private readMemberUserId(value: unknown): string | null {
    if (!value || typeof value !== 'object') {
      return null;
    }

    const row = value as Record<string, unknown>;
    const nestedUser =
      row.user && typeof row.user === 'object' && !Array.isArray(row.user)
        ? (row.user as Record<string, unknown>)
        : null;
    const candidate =
      row.user_id ??
      row.userId ??
      row.id ??
      nestedUser?.user_id ??
      nestedUser?.userId ??
      nestedUser?.id;

    if (typeof candidate !== 'string' && typeof candidate !== 'number') {
      return null;
    }

    const normalized = String(candidate).trim();
    return normalized.length > 0 ? normalized : null;
  }

  private parseChatMemberAccess(value: unknown): MaxChatMemberAccess {
    const row = this.asRecord(value);
    const roleValue = this.readLowerString(
      row?.role ??
        row?.member_role ??
        row?.memberRole ??
        row?.chat_role ??
        row?.chatRole ??
        row?.status ??
        row?.member_status ??
        row?.memberStatus,
    );
    const isOwner =
      roleValue?.includes('owner') === true ||
      roleValue?.includes('creator') === true ||
      row?.is_owner === true ||
      row?.isOwner === true ||
      row?.owner === true ||
      row?.is_creator === true ||
      row?.isCreator === true ||
      row?.creator === true;

    return {
      userId: this.readMemberUserId(value),
      isAdmin: isOwner || (row ? this.isChatAdminMemberRow(row) : false),
      isOwner,
      permissions: row ? this.readChatAdminPermissions(row) : [],
    };
  }

  private parseChatMemberRole(value: unknown): MaxChatMemberRole {
    const access = this.parseChatMemberAccess(value);
    if (access.isOwner) {
      return 'owner';
    }

    if (access.isAdmin) {
      return 'admin';
    }

    return 'member';
  }

  private async listChatAdminMembers(
    chatId: string,
    options: MaxApiRequestOptions = {},
  ): Promise<unknown[]> {
    const timeoutMs =
      typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
        ? Math.max(1, Math.trunc(options.timeoutMs))
        : undefined;
    const members: unknown[] = [];
    const seenMarkers = new Set<string>();
    let marker: string | number | null = null;

    let pagesFetched = 0;
    while (pagesFetched < MAX_API_CHAT_ADMIN_MEMBERS_PAGE_SAFETY_CAP) {
      pagesFetched += 1;
      const data = await this.executeChatRequest(
        chatId,
        async () =>
          this.request<Record<string, unknown>>('get', `/chats/${chatId}/members/admins`, {
            params: {
              ...(marker !== null ? { marker } : {}),
            },
            ...(timeoutMs ? { timeout: timeoutMs } : {}),
          }),
        options,
      );
      const pageMembers = Array.isArray(data.members) ? data.members : [];
      members.push(...pageMembers);

      const nextMarker = data.marker;
      if (
        nextMarker === null ||
        nextMarker === undefined ||
        (typeof nextMarker !== 'string' && typeof nextMarker !== 'number')
      ) {
        break;
      }

      const markerKey = String(nextMarker);
      if (seenMarkers.has(markerKey)) {
        break;
      }

      seenMarkers.add(markerKey);
      marker = nextMarker;
    }

    if (pagesFetched >= MAX_API_CHAT_ADMIN_MEMBERS_PAGE_SAFETY_CAP && marker !== null) {
      this.logger.warn(
        {
          chatId,
          pagesFetched,
          marker,
        },
        'Stopped MAX chat admin member discovery after reaching pagination safety cap',
      );
    }

    return members;
  }

  private parseChatMemberProfile(value: unknown): MaxChatMemberProfile | null {
    if (!value || typeof value !== 'object') {
      return null;
    }

    const userId = this.readMemberUserId(value);
    if (!userId) {
      return null;
    }

    const row = value as Record<string, unknown>;
    const nestedUser =
      row.user && typeof row.user === 'object' && !Array.isArray(row.user)
        ? (row.user as Record<string, unknown>)
        : null;
    return {
      userId,
      displayName: resolveMaxUserDisplayName(row, nestedUser),
      username: this.readTrimmedString(row.username ?? nestedUser?.username),
      avatarUrl: this.readTrimmedString(
        row.full_avatar_url ??
          row.fullAvatarUrl ??
          row.avatar_url ??
          row.avatarUrl ??
          nestedUser?.full_avatar_url ??
          nestedUser?.fullAvatarUrl ??
          nestedUser?.avatar_url ??
          nestedUser?.avatarUrl,
      ),
      profileUrl: this.readProfileUrl(
        row.profile_url,
        row.profileUrl,
        row.url,
        row.link,
        nestedUser?.profile_url,
        nestedUser?.profileUrl,
        nestedUser?.url,
        nestedUser?.link,
      ),
    };
  }

  private parseChatMemberBot(
    value: unknown,
    profile: Pick<MaxChatMemberProfile, 'userId' | 'username'>,
  ): boolean {
    if (!value || typeof value !== 'object') {
      return false;
    }

    const row = value as Record<string, unknown>;
    const nestedUser =
      row.user && typeof row.user === 'object' && !Array.isArray(row.user)
        ? (row.user as Record<string, unknown>)
        : null;
    if (
      row.is_bot === true ||
      row.isBot === true ||
      row.bot === true ||
      row.is_service === true ||
      row.isService === true ||
      nestedUser?.is_bot === true ||
      nestedUser?.isBot === true ||
      nestedUser?.bot === true ||
      nestedUser?.is_service === true ||
      nestedUser?.isService === true
    ) {
      return true;
    }

    const username = this.readTrimmedString(profile.username);
    if (username?.toLowerCase().endsWith('_bot')) {
      return true;
    }

    return profile.userId.toLowerCase().endsWith('_bot');
  }

  private parseChatMemberUnavailableReason(value: unknown): MaxChatRosterUnavailableReason | null {
    if (!value || typeof value !== 'object') {
      return null;
    }

    const row = value as Record<string, unknown>;
    const nestedUser =
      row.user && typeof row.user === 'object' && !Array.isArray(row.user)
        ? (row.user as Record<string, unknown>)
        : null;

    for (const candidate of [row, nestedUser].filter(
      (item): item is Record<string, unknown> => item !== null,
    )) {
      if (
        candidate.is_deleted === true ||
        candidate.isDeleted === true ||
        candidate.deleted === true ||
        candidate.deleted_account === true ||
        candidate.deletedAccount === true
      ) {
        return 'deleted';
      }

      if (
        candidate.is_blocked === true ||
        candidate.isBlocked === true ||
        candidate.blocked === true ||
        candidate.blocked_by_platform === true ||
        candidate.blockedByPlatform === true
      ) {
        return 'blocked';
      }

      if (
        candidate.is_deactivated === true ||
        candidate.isDeactivated === true ||
        candidate.deactivated === true
      ) {
        return 'deactivated';
      }

      if (candidate.is_suspended === true || candidate.isSuspended === true) {
        return 'suspended';
      }

      const explicitStatus = this.readLowerString(
        candidate.account_status ??
          candidate.accountStatus ??
          candidate.user_status ??
          candidate.userStatus ??
          candidate.profile_status ??
          candidate.profileStatus,
      );
      if (explicitStatus === 'deleted' || explicitStatus === 'removed') {
        return 'deleted';
      }
      if (explicitStatus === 'blocked' || explicitStatus === 'banned') {
        return 'blocked';
      }
      if (explicitStatus === 'deactivated' || explicitStatus === 'disabled') {
        return 'deactivated';
      }
      if (explicitStatus === 'suspended') {
        return 'suspended';
      }

      if (this.isMaxDeletedUserPlaceholder(candidate)) {
        return 'deleted';
      }
    }

    return null;
  }

  private isMaxDeletedUserPlaceholder(candidate: Record<string, unknown>): boolean {
    const name = this.readLowerString(candidate.name);
    const firstName = this.readLowerString(candidate.first_name ?? candidate.firstName);
    const lastName = this.readLowerString(candidate.last_name ?? candidate.lastName);
    if (name !== 'deleted user' || firstName !== 'deleted' || lastName !== 'user') {
      return false;
    }

    if (
      candidate.is_bot === true ||
      candidate.isBot === true ||
      candidate.bot === true ||
      candidate.is_service === true ||
      candidate.isService === true
    ) {
      return false;
    }

    const publicProfileFields = [
      candidate.username,
      candidate.avatar_url,
      candidate.avatarUrl,
      candidate.full_avatar_url,
      candidate.fullAvatarUrl,
      candidate.description,
      candidate.profile_url,
      candidate.profileUrl,
      candidate.url,
      candidate.link,
    ];
    return publicProfileFields.every((value) => this.readTrimmedString(value) === null);
  }

  private readProfileUrl(...candidates: unknown[]): string | null {
    for (const candidate of candidates) {
      const value = this.readTrimmedString(candidate);
      if (!value) {
        continue;
      }

      const normalized = this.normalizeMaxProfileUrl(value);
      if (normalized) {
        return normalized;
      }
    }

    return null;
  }

  private normalizeMaxProfileUrl(value: string): string | null {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return null;
      }

      const hostname = parsed.hostname.toLowerCase();
      if (hostname !== 'max.ru' && hostname !== 'www.max.ru') {
        return null;
      }

      parsed.hash = '';
      return parsed.toString();
    } catch {
      return null;
    }
  }

  private parseChatLink(row: Record<string, unknown>): string | null {
    const rawLink = row.link ?? row.url ?? row.message_url ?? row.messageUrl;
    if (typeof rawLink === 'string') {
      const normalizedLink = rawLink.trim();
      if (!normalizedLink) {
        return null;
      }

      if (normalizedLink.startsWith('http://') || normalizedLink.startsWith('https://')) {
        return normalizedLink;
      }
    }

    const inferredChatPostLink = this.inferChatPostLink(row);
    if (!inferredChatPostLink) {
      return null;
    }

    return inferredChatPostLink;
  }

  private parseChatAvatarUrl(row: Record<string, unknown>): string | null {
    const icon =
      row.icon && typeof row.icon === 'object' && !Array.isArray(row.icon)
        ? (row.icon as Record<string, unknown>)
        : null;

    for (const candidate of [
      row.full_icon_url,
      row.fullIconUrl,
      row.icon_url,
      row.iconUrl,
      row.avatar_url,
      row.avatarUrl,
      icon?.url,
      icon?.icon_url,
      icon?.iconUrl,
      icon?.full_url,
      icon?.fullUrl,
      icon?.full_icon_url,
      icon?.fullIconUrl,
    ]) {
      const value = this.readTrimmedString(candidate);
      if (value) {
        return value;
      }
    }

    return null;
  }

  private normalizeMessageRows(payload: Record<string, unknown>): Record<string, unknown>[] {
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    return messages.filter(
      (message): message is Record<string, unknown> =>
        Boolean(message) && typeof message === 'object' && !Array.isArray(message),
    );
  }

  private normalizeMessageTimestamp(value: unknown): number | null {
    if (value === null) {
      return null;
    }
    if (value instanceof Date) {
      const millis = value.getTime();
      return Number.isFinite(millis) ? millis : null;
    }
    if (typeof value === 'number') {
      return Number.isFinite(value) ? Math.trunc(value) : null;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) {
        return null;
      }
      if (/^\d+$/u.test(trimmed)) {
        return Number(trimmed);
      }
      const parsed = Date.parse(trimmed);
      return Number.isFinite(parsed) ? parsed : null;
    }

    return null;
  }

  private normalizeMessageQueryBoundary(value: unknown): number | null {
    const timestampMs = this.normalizeMessageTimestamp(value);
    if (timestampMs === null) {
      return null;
    }

    return Math.trunc(timestampMs);
  }

  private parseMessageSnapshot(
    chatId: string,
    row: Record<string, unknown>,
  ): MaxChannelMessageSnapshot | null {
    const body = this.asRecord(row.body);
    const messageId = this.readTrimmedString(
      body?.mid ?? row.message_id ?? row.messageId ?? row.id,
    );
    const timestampMs = this.normalizeMessageTimestamp(
      row.timestamp ?? row.created_at ?? row.createdAt ?? body?.timestamp,
    );
    if (!messageId || timestampMs === null) {
      return null;
    }

    const publishedAt = new Date(timestampMs);
    if (!Number.isFinite(publishedAt.getTime())) {
      return null;
    }

    const stat = this.asRecord(row.stat);
    return {
      chatId,
      messageId,
      publishedAt: publishedAt.toISOString(),
      publishedAtMs: timestampMs,
      url: this.parseChatLink(row),
      previewUrl: this.extractMessageImagePreviewUrl(row),
      views: this.readNullableInteger(stat?.views),
      reactionsTotal: this.parseMessageReactionsTotal(row),
      reactions: this.parseMessageReactions(row),
    };
  }

  private parseMessageReactionsTotal(row: Record<string, unknown>): number | null {
    const body = this.asRecord(row.body);
    const stat = this.asRecord(row.stat);
    const candidates = [
      stat?.reactions_total,
      stat?.reactionsTotal,
      stat?.reaction_count,
      stat?.reactionCount,
      stat?.reactions_count,
      stat?.reactionsCount,
      stat?.reactions,
      stat?.reaction_counts,
      stat?.emoji_reactions,
      row.reactions_total,
      row.reactionsTotal,
      row.reaction_count,
      row.reactionCount,
      row.reactions_count,
      row.reactionsCount,
      row.reactions,
      body?.reactions,
    ];

    for (const candidate of candidates) {
      const total = this.readMessageReactionTotal(candidate);
      if (total !== null) {
        return total;
      }
    }

    return null;
  }

  private parseMessageReactions(row: Record<string, unknown>): MaxChannelMessageReaction[] {
    const body = this.asRecord(row.body);
    const stat = this.asRecord(row.stat);
    const candidates = [
      stat?.reactions,
      stat?.reaction_counts,
      stat?.emoji_reactions,
      row.reactions,
      body?.reactions,
    ];

    for (const candidate of candidates) {
      const normalized = this.normalizeMessageReactionSource(candidate);
      if (normalized.length > 0) {
        return normalized;
      }
    }

    return [];
  }

  private readMessageReactionTotal(value: unknown): number | null {
    const count = this.readNullableInteger(value);
    if (count !== null) {
      return count;
    }

    const row = this.asRecord(value);
    const directCount = row
      ? this.readNullableInteger(
          row.count ??
            row.total ??
            row.value_count ??
            row.votes ??
            row.times ??
            row.reactions_total ??
            row.reactionsTotal,
        )
      : null;
    if (directCount !== null) {
      return directCount;
    }

    const normalized = this.normalizeMessageReactionSource(value);
    if (normalized.length === 0) {
      return null;
    }

    return normalized.reduce((total, item) => total + item.count, 0);
  }

  private normalizeMessageReactionSource(value: unknown): MaxChannelMessageReaction[] {
    if (Array.isArray(value)) {
      const normalized = value
        .map((item) => this.parseMessageReaction(item))
        .filter((item): item is MaxChannelMessageReaction => item !== null);

      return this.mergeMessageReactions(normalized);
    }

    const row = this.asRecord(value);
    if (!row) {
      return [];
    }

    const singleReaction = this.parseMessageReaction(row);
    if (singleReaction) {
      return [singleReaction];
    }

    return this.mergeMessageReactions(
      Object.entries(row)
        .filter(([emoji]) => this.isMessageReactionEmojiKey(emoji))
        .map(([emoji, count]) => this.parseMessageReaction(count, emoji))
        .filter((item): item is MaxChannelMessageReaction => item !== null),
    );
  }

  private isMessageReactionEmojiKey(value: string): boolean {
    const normalized = value.trim();
    if (!normalized) {
      return false;
    }

    return ![
      'count',
      'total',
      'value_count',
      'votes',
      'times',
      'value',
      'reactions',
      'reactions_total',
      'reactions_count',
      'reaction_count',
    ].includes(normalized.toLowerCase());
  }

  private parseMessageReaction(
    value: unknown,
    fallbackEmoji?: string,
  ): MaxChannelMessageReaction | null {
    if (typeof value === 'number' || typeof value === 'string' || typeof value === 'bigint') {
      const count = this.readNullableInteger(value);
      const emoji = this.readTrimmedString(fallbackEmoji);
      if (!emoji || count === null || count <= 0) {
        return null;
      }

      return {
        emoji,
        count,
      };
    }

    const row = this.asRecord(value);
    if (!row) {
      return null;
    }

    const emoji = this.readTrimmedString(
      row.emoji ??
        row.reaction ??
        row.code ??
        row.value ??
        row.text ??
        row.label ??
        row.name ??
        fallbackEmoji,
    );
    const count = this.readNullableInteger(
      row.count ?? row.total ?? row.value_count ?? row.votes ?? row.times ?? row.value,
    );
    if (!emoji || count === null || count <= 0) {
      return null;
    }

    return {
      emoji,
      count,
    };
  }

  private extractMessageImagePreviewUrl(row: Record<string, unknown>): string | null {
    const body = this.asRecord(row.body);
    const attachments = Array.isArray(body?.attachments) ? body.attachments : [];

    for (const attachment of attachments) {
      const previewUrl = this.extractAttachmentImageUrl(attachment);
      if (previewUrl) {
        return previewUrl;
      }
    }

    return null;
  }

  private extractAttachmentImageUrl(value: unknown): string | null {
    const attachment = this.asRecord(value);
    if (!attachment) {
      return null;
    }

    const type = this.readLowerString(attachment.type);
    if (type && type !== 'image' && type !== 'photo') {
      return null;
    }

    const payload =
      this.asRecord(attachment.payload) ??
      this.asRecord(attachment.photo) ??
      this.asRecord(attachment.image) ??
      attachment;
    const directUrl = this.readHttpUrl(
      payload.url ??
        payload.preview_url ??
        payload.previewUrl ??
        payload.thumbnail_url ??
        payload.thumbnailUrl ??
        payload.src ??
        payload.href,
    );
    if (directUrl) {
      return directUrl;
    }

    const photos = this.asRecord(payload.photos);
    if (photos) {
      const photoUrl = this.pickLargestPhotoUrl(photos);
      if (photoUrl) {
        return photoUrl;
      }
    }

    const sizes = Array.isArray(payload.sizes) ? payload.sizes : [];
    return this.pickLargestImageSizeUrl(sizes);
  }

  private pickLargestPhotoUrl(photos: Record<string, unknown>): string | null {
    const candidates = Object.entries(photos)
      .map(([key, value]) => {
        const row = this.asRecord(value);
        const width =
          this.readNullableInteger(row?.width ?? row?.w) ?? this.readNullableInteger(key) ?? 0;
        const height = this.readNullableInteger(row?.height ?? row?.h) ?? 0;
        const url = row
          ? this.readHttpUrl(row.url ?? row.preview_url ?? row.previewUrl ?? row.src)
          : this.readHttpUrl(value);
        return url ? { url, score: width * Math.max(1, height) || width } : null;
      })
      .filter((item): item is { url: string; score: number } => item !== null);

    candidates.sort((left, right) => right.score - left.score);
    return candidates[0]?.url ?? null;
  }

  private pickLargestImageSizeUrl(values: unknown[]): string | null {
    const candidates = values
      .map((value) => {
        const row = this.asRecord(value);
        if (!row) {
          return null;
        }
        const width = this.readNullableInteger(row.width ?? row.w) ?? 0;
        const height = this.readNullableInteger(row.height ?? row.h) ?? 0;
        const url = this.readHttpUrl(row.url ?? row.src ?? row.href);
        return url ? { url, area: width * height } : null;
      })
      .filter((item): item is { url: string; area: number } => item !== null);

    candidates.sort((left, right) => right.area - left.area);
    return candidates[0]?.url ?? null;
  }

  private mergeMessageReactions(
    reactions: MaxChannelMessageReaction[],
  ): MaxChannelMessageReaction[] {
    const grouped = new Map<string, number>();

    for (const reaction of reactions) {
      grouped.set(reaction.emoji, (grouped.get(reaction.emoji) ?? 0) + reaction.count);
    }

    return Array.from(grouped.entries())
      .map(([emoji, count]) => ({ emoji, count }))
      .sort((left, right) => right.count - left.count || left.emoji.localeCompare(right.emoji));
  }

  private mergeMessageSnapshots(
    current: MaxChannelMessageSnapshot | null,
    incoming: MaxChannelMessageSnapshot,
  ): MaxChannelMessageSnapshot {
    if (!current) {
      return incoming;
    }

    return {
      ...incoming,
      url: incoming.url ?? current.url,
      previewUrl: incoming.previewUrl ?? current.previewUrl,
      views:
        current.views === null
          ? incoming.views
          : incoming.views === null
            ? current.views
            : Math.max(current.views, incoming.views),
      reactionsTotal: Math.max(current.reactionsTotal ?? 0, incoming.reactionsTotal ?? 0),
      reactions: this.mergeMessageReactions([...current.reactions, ...incoming.reactions]),
    };
  }

  private parseWebhookSubscription(value: unknown): MaxWebhookSubscription | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    const row = value as Record<string, unknown>;
    const url = this.readTrimmedString(row.url);
    if (!url) {
      return null;
    }

    const updateTypesSource = Array.isArray(row.update_types)
      ? row.update_types
      : Array.isArray(row.updateTypes)
        ? row.updateTypes
        : [];
    const updateTypes = Array.from(
      new Set(
        updateTypesSource
          .map((item) => this.readLowerString(item))
          .filter((item): item is string => Boolean(item)),
      ),
    ).sort();

    return {
      url,
      updateTypes,
    };
  }

  private normalizeUrl(value: string): string {
    return value.trim().replace(/\/+$/u, '');
  }

  async answerCallback(
    callbackId: string,
    notification?: string,
    messageEdit?: MaxCallbackMessageEdit,
    requestOptions: MaxApiRequestOptions = {},
  ): Promise<void> {
    const normalizedCallbackId = callbackId.trim();
    if (!normalizedCallbackId) {
      throw new Error('callbackId is required');
    }

    const normalizedNotification = typeof notification === 'string' ? notification.trim() : '';
    const hasMessageEdit =
      Boolean(messageEdit) &&
      typeof messageEdit?.text === 'string' &&
      messageEdit.text.trim().length > 0;
    const messageId = hasMessageEdit ? this.readTrimmedString(messageEdit?.messageId) : null;
    const rateLimitEntityId = this.readTrimmedString(requestOptions.rateLimitEntityId);
    const executeAnswer = async (assertOwnership?: () => Promise<void>) => {
      const callbackData: Record<string, unknown> = {};
      if (normalizedNotification) {
        callbackData.notification = normalizedNotification;
      }
      if (hasMessageEdit) {
        const attachments = messageId
          ? this.buildEditableMessageAttachments(
              await this.getMessageById(messageId, requestOptions),
              messageEdit?.options,
            )
          : this.buildMessageAttachments(messageEdit?.options);
        callbackData.message = {
          text: messageEdit!.text.trim(),
          ...(messageEdit?.options?.textFormat ? { format: messageEdit.options.textFormat } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
        };
        await assertOwnership?.();
      }

      await this.executeMutation(
        rateLimitEntityId,
        async () => {
          await assertOwnership?.();
          await this.request('post', '/answers', {
            params: {
              callback_id: normalizedCallbackId,
            },
            data: callbackData,
          });
        },
        {
          trafficClass: 'critical',
          actionHealthLane: requestOptions.actionHealthLane,
          sourceTag:
            this.normalizeMetricSourceTag(requestOptions.sourceTag) ??
            MAX_API_SOURCE_TAGS.CALLBACK_ANSWER,
          ignoreFailureMetricStatuses: requestOptions.ignoreFailureMetricStatuses,
          timeoutMs: requestOptions.timeoutMs,
          botId: requestOptions.botId,
        },
        {
          messageMutation: {
            operation: 'answer',
            entityId: rateLimitEntityId,
          },
        },
      );
    };

    if (messageId) {
      await this.runWithMessageKeyboardEditLock(messageId, executeAnswer);
      return;
    }
    await executeAnswer();
  }

  private async dispatchAction(
    payload: Omit<MaxActionJob, 'attempt' | 'idempotencyKey' | 'createdAt' | 'scheduledFor'>,
    options?: MaxActionDispatchOptions,
  ) {
    const beforeImmediateDeleteMutation = options?.beforeImmediateDeleteMutation;
    const beforeImmediateMemberMutation = options?.beforeImmediateMemberMutation;
    if (beforeImmediateDeleteMutation && options?.immediate !== true) {
      throw new Error('Delete mutation guard requires immediate dispatch');
    }
    if (beforeImmediateDeleteMutation && payload.actionType !== 'DELETE_MESSAGE') {
      throw new Error('Delete mutation guard requires a message delete action');
    }
    if (beforeImmediateMemberMutation && options?.immediate !== true) {
      throw new Error('Member mutation guard requires immediate dispatch');
    }
    if (
      beforeImmediateMemberMutation &&
      payload.actionType !== 'KICK_MEMBER' &&
      payload.actionType !== 'BAN_MEMBER' &&
      payload.actionType !== 'UNBAN_MEMBER'
    ) {
      throw new Error('Member mutation guard requires a member moderation action');
    }

    if (
      (payload.actionType === 'KICK_MEMBER' || payload.actionType === 'BAN_MEMBER') &&
      payload.userId
    ) {
      this.assertMemberActionTargetIsNotRuntimeBot(
        payload.actionType,
        payload.chatId,
        payload.userId,
      );
    }

    const explicitBotId = options?.botId ?? payload.botId;
    const resolvedRoute =
      !explicitBotId && !options?.candidateBotIds?.length
        ? await this.resolveQueuedActionRoute(payload)
        : null;
    if (resolvedRoute && resolvedRoute.candidateBotIds.length === 0) {
      throw new UnrecoverableError(
        `MAX ${payload.actionType} has no eligible routed bot candidate for chat ${payload.chatId}`,
      );
    }
    const explicitCandidateBotIds = this.normalizeActionCandidateBotIds(
      options?.candidateBotIds ?? [],
    );
    const requestedCandidateBotIds = this.normalizeActionCandidateBotIds([
      ...explicitCandidateBotIds,
      ...(resolvedRoute?.candidateBotIds ?? []),
    ]);
    const selectedBotId =
      this.readTrimmedString(explicitBotId) ??
      explicitCandidateBotIds.find((botId) => {
        const candidate = this.botRegistry.getBotById(botId);
        return Boolean(candidate && this.canExecuteActionsForBot(candidate));
      });
    const bot = this.resolveExecutableBot(selectedBotId, {
      explicit: Boolean(selectedBotId?.trim()),
    });
    const candidateBotIds = this.normalizeActionCandidateBotIds([
      bot.id,
      ...requestedCandidateBotIds,
    ]);
    const isRoutedAction =
      Boolean(options?.routing) ||
      Boolean(resolvedRoute) ||
      Boolean(options?.candidateBotIds?.length);
    const routing =
      options?.routing ??
      (resolvedRoute ? this.buildActionRoutingMetadata(resolvedRoute) : undefined);
    const autoDeleteDelayMs = this.normalizeDelayMs(options?.autoDeleteDelayMs);
    const delayMs = this.normalizeDelayMs(options?.delayMs);
    const immediate = options?.immediate === true;
    const ignoreFailureMetricStatuses = this.normalizeFailureMetricStatuses(
      options?.ignoreFailureMetricStatuses,
    );
    const sourceTag = this.normalizeMetricSourceTag(options?.sourceTag ?? payload.sourceTag);
    const timeoutMs = this.normalizeTimeoutMs(options?.timeoutMs);
    const scheduledJobId =
      delayMs > 0
        ? this.buildScheduledMemberActionJobId(
            payload.actionType,
            payload.chatId,
            payload.userId,
            bot.id,
            isRoutedAction,
          )
        : null;
    const explicitIdempotencyKey = this.buildExplicitActionIdempotencyKey(
      options?.idempotencyKey,
      payload.actionType,
      isRoutedAction ? null : bot.id,
    );
    const logicalIdempotencyKey =
      scheduledJobId ??
      explicitIdempotencyKey ??
      this.buildDefaultActionIdempotencyKey(payload, isRoutedAction ? null : bot.id);
    const createdAt = new Date();
    const job: MaxActionJob = {
      ...payload,
      botId: bot.id,
      ...(isRoutedAction ? { candidateBotIds } : {}),
      ...(routing ? { routing } : {}),
      ...(options?.trafficClass ? { trafficClass: options.trafficClass } : {}),
      ...(options?.actionHealthLane ? { actionHealthLane: options.actionHealthLane } : {}),
      ...(sourceTag ? { sourceTag } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
      ...(payload.actionType === 'SEND_MESSAGE' && autoDeleteDelayMs > 0
        ? { autoDeleteDelayMs }
        : {}),
      ...(ignoreFailureMetricStatuses ? { ignoreFailureMetricStatuses } : {}),
      ...(options?.ledgerContext ? { ledgerContext: options.ledgerContext } : {}),
      attempt: 1,
      idempotencyKey: logicalIdempotencyKey ?? randomUUID(),
      createdAt: createdAt.toISOString(),
      ...(delayMs > 0
        ? { scheduledFor: new Date(createdAt.getTime() + delayMs).toISOString() }
        : {}),
    };

    if (immediate && delayMs > 0) {
      throw new Error('Immediate dispatch cannot be combined with delay');
    }

    if (immediate) {
      await this.executeImmediateActionJob(
        job,
        beforeImmediateDeleteMutation,
        beforeImmediateMemberMutation,
      );
      return;
    }

    let actionQueue = this.resolveActionQueue(job);
    if (this.dispatchEnabled && actionQueue) {
      await this.actionLedgerService?.assertCanEnqueue(job);

      if (scheduledJobId) {
        await this.removeQueuedActionJob(scheduledJobId);
      } else if (logicalIdempotencyKey) {
        const retainedQueue = await this.removeRetainedFailedActionJob(
          logicalIdempotencyKey,
          payload.actionType,
        );
        if (retainedQueue) {
          actionQueue = retainedQueue;
        }
      }

      const queueJobOptions = {
        jobId: job.idempotencyKey,
        attempts: 5,
        removeOnComplete: true,
        removeOnFail: this.actionFailedJobRetention,
        ...(delayMs > 0 ? { delay: delayMs } : {}),
        backoff: {
          type: 'exponential' as const,
          delay: 1_000,
        },
      };
      const targetActionQueue = actionQueue;
      const addActionJob = () => targetActionQueue.add('execute-max-action', job, queueJobOptions);
      const enqueueAttemptStartedAt = new Date();
      let bullMqEnqueuedAt: Date | undefined;
      try {
        const addedJob = await addActionJob();
        bullMqEnqueuedAt = this.readBullMqJobEnqueuedAt(addedJob);
      } catch (error: unknown) {
        const queueObservation = await this.observeActionQueueJob(
          targetActionQueue,
          job.idempotencyKey,
        );
        let executionObserved =
          queueObservation.state === 'live'
            ? false
            : (await this.actionLedgerService
                ?.hasExecutionEvidenceSince(job.idempotencyKey, enqueueAttemptStartedAt)
                .catch(() => false)) === true;
        let queueAccepted = queueObservation.state === 'live' || executionObserved;
        let recoveryEvidence =
          queueObservation.state === 'live' ? 'bullmq_job' : 'ledger_execution';
        if (queueObservation.state === 'live') {
          bullMqEnqueuedAt = queueObservation.enqueuedAt;
        }

        if (!queueAccepted && queueObservation.state === 'unknown') {
          try {
            const addedJob = await addActionJob();
            bullMqEnqueuedAt = this.readBullMqJobEnqueuedAt(addedJob);
            queueAccepted = true;
            recoveryEvidence = 'bullmq_retry';
          } catch (retryError: unknown) {
            executionObserved =
              (await this.actionLedgerService
                ?.hasExecutionEvidenceSince(job.idempotencyKey, enqueueAttemptStartedAt)
                .catch(() => false)) === true;
            if (!executionObserved && job.actionType === 'SEND_MESSAGE') {
              const ambiguousError = new UnrecoverableError(
                `Ambiguous BullMQ ownership for MAX SEND_MESSAGE ${job.idempotencyKey}; manual review is required before retry`,
              );
              await this.actionLedgerService
                ?.recordEnqueueAmbiguousIfAbsent(job, ambiguousError)
                .catch((ledgerError: unknown) => {
                  this.logger.warn(
                    {
                      actionType: job.actionType,
                      chatId: job.chatId,
                      botId: job.botId,
                      error: this.extractErrorMessage(ledgerError),
                    },
                    'Failed to quarantine ambiguous MAX SEND_MESSAGE queue ownership',
                  );
                });
              throw ambiguousError;
            }
            if (!executionObserved) {
              await this.actionLedgerService
                ?.recordEnqueueFailedIfAbsent(job, retryError)
                .catch((ledgerError: unknown) => {
                  this.logger.warn(
                    {
                      actionType: job.actionType,
                      chatId: job.chatId,
                      botId: job.botId,
                      error: this.extractErrorMessage(ledgerError),
                    },
                    'Failed to record MAX action enqueue failure',
                  );
                });
              throw retryError;
            }
            queueAccepted = true;
          }
        }

        if (!queueAccepted) {
          await this.actionLedgerService
            ?.recordEnqueueFailedIfAbsent(job, error)
            .catch((ledgerError: unknown) => {
              this.logger.warn(
                {
                  actionType: job.actionType,
                  chatId: job.chatId,
                  botId: job.botId,
                  error: this.extractErrorMessage(ledgerError),
                },
                'Failed to record MAX action enqueue failure',
              );
            });
          throw error;
        }

        this.logger.warn(
          {
            actionType: job.actionType,
            chatId: job.chatId,
            botId: job.botId,
            evidence: recoveryEvidence,
            error: this.extractErrorMessage(error),
          },
          'Recovered MAX action after an ambiguous BullMQ add failure',
        );
      }

      // FLAG: BullMQ must own the action before best-effort ledger bookkeeping.
      await this.actionLedgerService
        ?.recordEnqueuedIfAbsent(job, bullMqEnqueuedAt)
        .catch((ledgerError: unknown) => {
          this.logger.warn(
            {
              actionType: job.actionType,
              chatId: job.chatId,
              botId: job.botId,
              error: this.extractErrorMessage(ledgerError),
            },
            'Failed to record queued MAX action after BullMQ accepted it',
          );
        });
      return;
    }

    if (delayMs > 0) {
      if (scheduledJobId) {
        const existingTimeout = this.keyedActionTimeouts.get(scheduledJobId);
        if (existingTimeout) {
          clearTimeout(existingTimeout);
          this.pendingTimeouts.delete(existingTimeout);
        }
      }

      const timeout = setTimeout(() => {
        this.pendingTimeouts.delete(timeout);
        if (scheduledJobId) {
          this.keyedActionTimeouts.delete(scheduledJobId);
        }
        void this.executeActionJob(job).catch((error: unknown) => {
          this.logger.warn(
            {
              actionType: job.actionType,
              chatId: job.chatId,
              messageId: job.messageId,
              userId: job.userId,
              error: error instanceof Error ? error.message : 'Unknown error',
            },
            'Failed delayed max action',
          );
        });
      }, delayMs);
      this.pendingTimeouts.add(timeout);
      if (scheduledJobId) {
        this.keyedActionTimeouts.set(scheduledJobId, timeout);
      }
      return;
    }

    await this.executeActionJob(job);
  }

  private async resolveQueuedActionRoute(
    payload: Omit<MaxActionJob, 'attempt' | 'idempotencyKey' | 'createdAt' | 'scheduledFor'>,
  ): Promise<MaxBotRoute | null> {
    if (
      !this.maxBotLinkService ||
      !this.readTrimmedString(payload.chatId) ||
      isPrivateDirectChatId(payload.chatId)
    ) {
      return null;
    }

    const request: MaxBotRouteRequest =
      payload.actionType === 'SEND_MESSAGE' || payload.actionType === 'NOTIFY_MODERATORS'
        ? {
            purpose: 'send_message',
            chatId: payload.chatId,
            fallbackToPrimary: true,
          }
        : {
            purpose: 'moderation_action',
            chatId: payload.chatId,
            action: payload.actionType === 'DELETE_MESSAGE' ? 'delete_message' : 'moderate_member',
            fallbackToPrimary: true,
          };

    try {
      return await this.maxBotLinkService.resolveBotRoute(request);
    } catch (error: unknown) {
      this.logger.warn(
        {
          actionType: payload.actionType,
          chatId: payload.chatId,
          error: this.extractErrorMessage(error),
        },
        'Failed to resolve routed MAX action candidates before enqueue',
      );
      throw error;
    }
  }

  private buildActionRoutingMetadata(route: MaxBotRoute): MaxActionRoutingMetadata | undefined {
    if (route.purpose !== 'send_message' && route.purpose !== 'moderation_action') {
      return undefined;
    }

    return {
      purpose: route.purpose,
      primaryBotId: route.primaryBotId,
      reason: route.reason,
      routingVersion: route.routingVersion ?? null,
      ...(route.purpose === 'moderation_action'
        ? {
            action:
              route.action === 'delete_message' || route.action === 'edit_message'
                ? 'delete_message'
                : 'moderate_member',
          }
        : {}),
    };
  }

  private normalizeActionCandidateBotIds(values: readonly unknown[]): string[] {
    return Array.from(
      new Set(
        values
          .map((value) => (typeof value === 'string' ? value.trim() : ''))
          .filter((value) => value.length > 0),
      ),
    );
  }

  private async executeImmediateActionJob(
    job: MaxActionJob,
    beforeDeleteMutation?: () => Promise<void>,
    beforeMemberMutation?: () => Promise<void>,
  ): Promise<void> {
    if (!this.actionLedgerService?.isIrreversibleAction(job.actionType)) {
      await this.executeActionJob(job, { beforeDeleteMutation, beforeMemberMutation });
      return;
    }

    await this.actionLedgerService.assertCanEnqueue(job);
    await this.actionLedgerService.recordStarted(job, new Date(job.createdAt));
    try {
      await this.executeActionJob(job, { beforeDeleteMutation, beforeMemberMutation });
    } catch (error: unknown) {
      await this.actionLedgerService.recordFailed(job, error).catch((ledgerError: unknown) => {
        this.logger.warn(
          {
            actionType: job.actionType,
            chatId: job.chatId,
            botId: job.botId,
            error: this.extractErrorMessage(ledgerError),
            originalError: this.extractErrorMessage(error),
          },
          'Failed to record immediate MAX action failure in durable ledger',
        );
      });
      throw error;
    }

    await this.actionLedgerService.recordSucceeded(job).catch((ledgerError: unknown) => {
      this.logger.warn(
        {
          actionType: job.actionType,
          chatId: job.chatId,
          botId: job.botId,
          error: this.extractErrorMessage(ledgerError),
        },
        'Failed to record immediate MAX action success in durable ledger',
      );
    });
  }

  private buildScheduledMemberActionJobId(
    actionType: MaxActionType,
    chatId: string,
    userId: string | undefined,
    botId: string | null = null,
    logical = false,
  ): string | null {
    if (actionType !== 'UNBAN_MEMBER' || !userId) {
      return null;
    }

    return `member-action__${logical ? 'logical' : (botId ?? this.botRegistry.getDefaultBot().id)}__${actionType}__${chatId}__${userId}`;
  }

  private buildExplicitActionIdempotencyKey(
    value: string | null | undefined,
    actionType: MaxActionType,
    botId: string | null,
  ): string | null {
    const normalized = this.readTrimmedString(value);
    if (!normalized) {
      return null;
    }

    return this.buildActionIdempotencyKey(
      'explicit',
      [botId, actionType, normalized].filter(Boolean) as string[],
    );
  }

  private buildDefaultActionIdempotencyKey(
    payload: Omit<MaxActionJob, 'attempt' | 'idempotencyKey' | 'createdAt' | 'scheduledFor'>,
    botId: string | null,
  ): string | null {
    const chatId = this.readTrimmedString(payload.chatId);
    if (!chatId) {
      return null;
    }

    if (payload.actionType === 'DELETE_MESSAGE') {
      const messageId = this.readTrimmedString(payload.messageId);
      return messageId
        ? this.buildActionIdempotencyKey(
            'logical',
            [botId, payload.actionType, chatId, messageId].filter(Boolean) as string[],
          )
        : null;
    }

    if (payload.actionType === 'BAN_MEMBER') {
      const userId = this.readTrimmedString(payload.userId);
      return userId
        ? this.buildActionIdempotencyKey(
            'logical',
            [botId, payload.actionType, chatId, userId].filter(Boolean) as string[],
          )
        : null;
    }

    return null;
  }

  private buildActionIdempotencyKey(namespace: string, parts: readonly string[]): string {
    const normalizedParts = [namespace, ...parts].map((part) => part.trim()).filter(Boolean);
    const canonical = normalizedParts.join('\u001f');
    const digest = createHash('sha256').update(canonical).digest('base64url').slice(0, 24);
    const readable = normalizedParts
      .map(normalizeMaxActionIdempotencyKeyPart)
      .filter(Boolean)
      .join('__')
      .slice(0, MAX_ACTION_IDEMPOTENCY_KEY_READABLE_MAX_LENGTH)
      .replace(/_+$/u, '');

    return readable ? `max-action__${readable}__${digest}` : `max-action__${digest}`;
  }

  private async removeQueuedActionJob(jobId: string) {
    const existingJobs = await this.findActionJobs(jobId);
    await Promise.all(existingJobs.map((job) => job.remove()));
  }

  private async observeActionQueueJob(
    queue: Queue<MaxActionJob>,
    jobId: string,
  ): Promise<MaxActionQueueJobObservation> {
    try {
      const retainedJob = await queue.getJob(jobId);
      if (!retainedJob) {
        return { state: 'missing' };
      }
      const state = await retainedJob.getState();
      return {
        state: LIVE_MAX_ACTION_JOB_STATES.has(state) ? 'live' : 'final',
        enqueuedAt: this.readBullMqJobEnqueuedAt(retainedJob),
      };
    } catch {
      return { state: 'unknown' };
    }
  }

  private readBullMqJobEnqueuedAt(
    job: Pick<Job<MaxActionJob>, 'timestamp'> | null | undefined,
  ): Date | undefined {
    const timestamp = job?.timestamp;
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) {
      return undefined;
    }
    const enqueuedAt = new Date(timestamp);
    return Number.isFinite(enqueuedAt.getTime()) ? enqueuedAt : undefined;
  }

  private async removeRetainedFailedActionJob(
    jobId: string,
    replacementActionType: MaxActionType,
  ): Promise<Queue<MaxActionJob> | undefined> {
    const existingEntries = await this.findActionJobEntries(jobId);
    const failedJobs: Array<Job<MaxActionJob>> = [];
    const retainedQueues: Array<Queue<MaxActionJob>> = [];
    for (const entry of existingEntries) {
      if ((await entry.job.getState()) === 'failed') {
        failedJobs.push(entry.job);
      } else {
        retainedQueues.push(entry.queue);
      }
    }

    if (
      failedJobs.some((job) => this.isRetainedAmbiguousActionFailure(job, replacementActionType))
    ) {
      throw new UnrecoverableError(
        `Retained ambiguous MAX ${replacementActionType} job ${jobId} requires manual review before retry`,
      );
    }

    await Promise.all(failedJobs.map((job) => job.remove()));
    return retainedQueues[0];
  }

  private resolveActionQueue(job: Pick<MaxActionJob, 'actionType' | 'trafficClass'>) {
    const queueName = resolveMaxActionQueueName(job);
    const laneQueue = (() => {
      switch (queueName) {
        case MAX_ACTION_CRITICAL_QUEUE:
          return this.criticalActionQueue;
        case MAX_ACTION_BACKGROUND_QUEUE:
          return this.backgroundActionQueue;
        case MAX_ACTION_INTERACTIVE_QUEUE:
        default:
          return this.interactiveActionQueue;
      }
    })();

    return laneQueue ?? this.actionQueue;
  }

  private getActionQueues(): Array<Queue<MaxActionJob>> {
    return Array.from(
      new Set(
        [
          this.criticalActionQueue,
          this.interactiveActionQueue,
          this.backgroundActionQueue,
          this.actionQueue,
        ].filter((queue): queue is Queue<MaxActionJob> => Boolean(queue)),
      ),
    );
  }

  private async findActionJobs(jobId: string): Promise<Array<Job<MaxActionJob>>> {
    return (await this.findActionJobEntries(jobId)).map((entry) => entry.job);
  }

  private async findActionJobEntries(
    jobId: string,
  ): Promise<Array<{ queue: Queue<MaxActionJob>; job: Job<MaxActionJob> }>> {
    const entries = await Promise.all(
      this.getActionQueues().map(async (queue) => ({
        queue,
        job: await queue.getJob(jobId),
      })),
    );
    return entries.filter(
      (entry): entry is { queue: Queue<MaxActionJob>; job: Job<MaxActionJob> } =>
        Boolean(entry.job),
    );
  }

  private isRetainedAmbiguousActionFailure(
    job: unknown,
    replacementActionType: MaxActionType,
  ): boolean {
    const actionType = this.readRetainedJobActionType(job) ?? replacementActionType;
    if (!this.isIrreversibleQueuedActionType(actionType)) {
      return false;
    }

    const failureText = this.readRetainedJobFailureText(job);
    return failureText.includes('ambiguous max');
  }

  private isIrreversibleQueuedActionType(actionType: MaxActionType): boolean {
    return (
      actionType === 'SEND_MESSAGE' || actionType === 'KICK_MEMBER' || actionType === 'BAN_MEMBER'
    );
  }

  private readRetainedJobActionType(job: unknown): MaxActionType | null {
    const value = (job as { data?: { actionType?: unknown } })?.data?.actionType;
    if (
      value === 'DELETE_MESSAGE' ||
      value === 'SEND_MESSAGE' ||
      value === 'KICK_MEMBER' ||
      value === 'BAN_MEMBER' ||
      value === 'UNBAN_MEMBER' ||
      value === 'NOTIFY_MODERATORS'
    ) {
      return value;
    }

    return null;
  }

  private readRetainedJobFailureText(job: unknown): string {
    const values: string[] = [];
    const failedReason = (job as { failedReason?: unknown })?.failedReason;
    if (typeof failedReason === 'string') {
      values.push(failedReason);
    }

    const stacktrace = (job as { stacktrace?: unknown })?.stacktrace;
    if (Array.isArray(stacktrace)) {
      for (const entry of stacktrace) {
        if (typeof entry === 'string') {
          values.push(entry);
        }
      }
    }

    return values.join('\n').toLowerCase();
  }

  private normalizeDelayMs(value: number | undefined): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return 0;
    }

    const normalized = Math.trunc(value);
    if (normalized <= 0) {
      return 0;
    }

    return Math.min(normalized, MAX_ACTION_DELAY_MS);
  }

  private buildMessageAttachments(options?: MaxSendMessageOptions): Record<string, unknown>[] {
    const attachments: Record<string, unknown>[] = [];
    const imageAttachment = this.buildImageAttachment(options?.imagePayload);
    if (imageAttachment) {
      attachments.push(imageAttachment);
    }
    if (Array.isArray(options?.attachments) && options.attachments.length > 0) {
      attachments.push(...this.buildMediaAttachments(options.attachments));
    }
    const keyboardAttachment = this.buildInlineKeyboardAttachment(options);
    if (keyboardAttachment) {
      attachments.push(keyboardAttachment);
    }
    return attachments;
  }

  private buildEditableMessageAttachments(
    message: Record<string, unknown> | null,
    options?: MaxEditableMessageOptions,
  ): Record<string, unknown>[] {
    const editableAttachments = this.extractEditableAttachments(message);
    const existingAttachmentsWithoutKeyboard = editableAttachments.filter(
      (attachment) => this.readLowerString(attachment.type) !== 'inline_keyboard',
    );
    const keyboardAttachment = this.buildInlineKeyboardAttachment(options);
    const replaceCallbackPayloadPrefixes = this.normalizeCallbackPayloadPrefixes(
      options?.replaceCallbackPayloadPrefixes,
    );
    if (replaceCallbackPayloadPrefixes.length > 0) {
      const replacedKeyboard = this.replaceEditableInlineKeyboardCallbacks(
        keyboardAttachment,
        editableAttachments,
        replaceCallbackPayloadPrefixes,
        options?.appendNewInlineKeyboardRows === true,
      );
      return replacedKeyboard
        ? [...existingAttachmentsWithoutKeyboard, replacedKeyboard]
        : existingAttachmentsWithoutKeyboard;
    }
    if (keyboardAttachment) {
      if (options?.mergeExistingInlineKeyboard) {
        return [
          ...existingAttachmentsWithoutKeyboard,
          this.mergeEditableInlineKeyboardAttachment(
            keyboardAttachment,
            editableAttachments,
            options.appendNewInlineKeyboardRows === true,
          ),
        ];
      }
      return [...existingAttachmentsWithoutKeyboard, keyboardAttachment];
    }
    return options?.preserveExistingInlineKeyboard
      ? editableAttachments
      : existingAttachmentsWithoutKeyboard;
  }

  private replaceEditableInlineKeyboardCallbacks(
    primaryKeyboard: Record<string, unknown> | null,
    editableAttachments: readonly Record<string, unknown>[],
    callbackPayloadPrefixes: readonly string[],
    appendNewRows: boolean,
  ): Record<string, unknown> | null {
    const existingKeyboard = editableAttachments.find(
      (attachment) => this.readLowerString(attachment.type) === 'inline_keyboard',
    );
    const existingPayload = this.asRecord(existingKeyboard?.payload);
    const primaryPayload = this.asRecord(primaryKeyboard?.payload);
    const existingRows = Array.isArray(existingPayload?.buttons) ? existingPayload.buttons : [];
    const primaryRows = Array.isArray(primaryPayload?.buttons)
      ? primaryPayload.buttons.filter((row): row is unknown[] => Array.isArray(row))
      : [];
    const preservedRows: unknown[][] = [];
    let insertionIndex: number | null = null;

    for (const row of existingRows) {
      if (!Array.isArray(row)) {
        continue;
      }
      const preservedButtons = row.filter(
        (button) => !this.hasCallbackPayloadPrefix(button, callbackPayloadPrefixes),
      );
      if (preservedButtons.length !== row.length && insertionIndex === null) {
        insertionIndex = preservedRows.length;
      }
      if (preservedButtons.length > 0) {
        preservedRows.push(preservedButtons);
      }
    }

    const existingDialogButtonKeys = new Set(
      preservedRows.flatMap((row) =>
        row.flatMap((button) => {
          const identity = readInternalChannelDialogButtonIdentity(button);
          return identity ? [internalChannelDialogButtonIdentityKey(identity)] : [];
        }),
      ),
    );
    const insertedDialogButtonKeys = new Set<string>();
    const resolvedPrimaryRows = primaryRows
      .map((row) =>
        row.filter((button) => {
          const identity = readInternalChannelDialogButtonIdentity(button);
          if (!identity) {
            return true;
          }
          const key = internalChannelDialogButtonIdentityKey(identity);
          if (existingDialogButtonKeys.has(key) || insertedDialogButtonKeys.has(key)) {
            return false;
          }
          insertedDialogButtonKeys.add(key);
          return true;
        }),
      )
      .filter((row) => row.length > 0);
    const resolvedInsertionIndex = insertionIndex ?? (appendNewRows ? preservedRows.length : 0);
    const buttons = normalizeMaxInlineKeyboardButtons([
      ...preservedRows.slice(0, resolvedInsertionIndex),
      ...resolvedPrimaryRows,
      ...preservedRows.slice(resolvedInsertionIndex),
    ]);
    if (!buttons) {
      return null;
    }

    return {
      type: 'inline_keyboard',
      payload: {
        ...existingPayload,
        ...primaryPayload,
        buttons,
      },
    };
  }

  private normalizeCallbackPayloadPrefixes(value: readonly string[] | undefined): string[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return Array.from(
      new Set(
        value
          .map((prefix) => (typeof prefix === 'string' ? prefix.trim() : ''))
          .filter((prefix) => prefix.length > 0),
      ),
    );
  }

  private hasCallbackPayloadPrefix(value: unknown, prefixes: readonly string[]): boolean {
    const button = this.asRecord(value);
    if (this.readLowerString(button?.type) !== 'callback') {
      return false;
    }
    const payload = this.readTrimmedString(button?.payload);
    return Boolean(payload && prefixes.some((prefix) => payload.startsWith(prefix)));
  }

  private mergeEditableInlineKeyboardAttachment(
    primaryKeyboard: Record<string, unknown>,
    editableAttachments: readonly Record<string, unknown>[],
    appendNewRows: boolean,
  ): Record<string, unknown> {
    const existingKeyboard = editableAttachments.find(
      (attachment) => this.readLowerString(attachment.type) === 'inline_keyboard',
    );
    const primaryPayload = this.asRecord(primaryKeyboard.payload);
    const existingPayload = this.asRecord(existingKeyboard?.payload);
    const primaryRows = Array.isArray(primaryPayload?.buttons) ? primaryPayload.buttons : [];
    const existingRows = Array.isArray(existingPayload?.buttons) ? existingPayload.buttons : [];
    const existingDialogButtons = new Map<
      string,
      { button: unknown; identity: InternalChannelDialogButtonIdentity }
    >();
    for (const row of existingRows) {
      if (!Array.isArray(row)) {
        continue;
      }
      for (const button of row) {
        const identity = readInternalChannelDialogButtonIdentity(button);
        if (identity) {
          const key = internalChannelDialogButtonIdentityKey(identity);
          if (!existingDialogButtons.has(key)) {
            existingDialogButtons.set(key, { button, identity });
          }
        }
      }
    }
    const representedDialogButtons = new Set<string>();
    const resolvedPrimaryRows = primaryRows
      .filter((row): row is unknown[] => Array.isArray(row))
      .map((row) =>
        row.flatMap((button) => {
          const identity = readInternalChannelDialogButtonIdentity(button);
          if (!identity) {
            return [button];
          }
          const key = internalChannelDialogButtonIdentityKey(identity);
          if (representedDialogButtons.has(key)) {
            return [];
          }
          representedDialogButtons.add(key);
          const existing = existingDialogButtons.get(key);
          if (!existing) {
            return [button];
          }
          const primaryTarget = this.readInlineKeyboardButtonIdentity(button);
          const existingTarget = this.readInlineKeyboardButtonIdentity(existing.button);
          const sameTarget =
            (primaryTarget !== null && primaryTarget === existingTarget) ||
            (identity.threadId !== null && identity.threadId === existing.identity.threadId);
          return [sameTarget ? button : existing.button];
        }),
      )
      .filter((row) => row.length > 0);
    const primaryButtonIdentities = new Set(
      resolvedPrimaryRows.flatMap((row) =>
        Array.isArray(row)
          ? row
              .map((button) => this.readInlineKeyboardButtonIdentity(button))
              .filter((identity): identity is string => identity !== null)
          : [],
      ),
    );
    const preservedExistingRows = existingRows
      .filter((row): row is unknown[] => Array.isArray(row))
      .map((row) =>
        row.filter((button) => {
          const dialogIdentity = readInternalChannelDialogButtonIdentity(button);
          if (
            dialogIdentity &&
            representedDialogButtons.has(internalChannelDialogButtonIdentityKey(dialogIdentity))
          ) {
            return false;
          }
          const identity = this.readInlineKeyboardButtonIdentity(button);
          return identity === null || !primaryButtonIdentities.has(identity);
        }),
      )
      .filter((row) => row.length > 0);
    const mergedButtons = normalizeMaxInlineKeyboardButtons(
      appendNewRows
        ? [...preservedExistingRows, ...resolvedPrimaryRows]
        : [...resolvedPrimaryRows, ...preservedExistingRows],
    );

    return {
      type: 'inline_keyboard',
      payload: {
        ...existingPayload,
        ...primaryPayload,
        buttons: mergedButtons ?? resolvedPrimaryRows,
      },
    };
  }

  private readInlineKeyboardButtonIdentity(value: unknown): string | null {
    const button = this.asRecord(value);
    const type = this.readLowerString(button?.type);
    if (type !== 'link') {
      return null;
    }

    const url = this.readTrimmedString(button?.url);
    return url ? `${type}:${url}` : null;
  }

  private extractReplyMessageLink(
    message: Record<string, unknown> | null,
  ): MaxReplyMessageLink | null {
    const link = this.asRecord(message?.link);
    if (this.readLowerString(link?.type) !== 'reply') {
      return null;
    }

    const linkedMessage = this.asRecord(link?.message);
    const mid = this.readTrimmedString(linkedMessage?.mid ?? link?.mid);
    return mid
      ? {
          type: 'reply',
          mid,
        }
      : null;
  }

  private shouldSkipTextUpdateForInlineKeyboardEdit(
    message: Record<string, unknown> | null,
  ): boolean {
    const body = this.asRecord(message?.body);
    const link = this.asRecord(message?.link);
    const bodyText = typeof body?.text === 'string' ? body.text : null;

    return bodyText === '' && this.readLowerString(link?.type) === 'forward';
  }

  private extractMessageTextFormat(message: Record<string, unknown> | null): MaxTextFormat | null {
    const body = this.asRecord(message?.body);
    const format = this.readLowerString(body?.format ?? message?.format);

    return format === 'markdown' || format === 'html' ? format : null;
  }

  private buildOutgoingMessageTextPayload(
    message: Record<string, unknown> | null,
    fallbackText: string | null,
    fallbackTextFormat: MaxTextFormat | null = null,
  ): { text: string | null; textFormat: MaxTextFormat | null } {
    const source = this.resolveOutgoingMessageTextSource(message, fallbackText);
    const sourceText = source.text;
    const preferFallbackText = source.fromFallback;
    const text = preferFallbackText ? fallbackText : (sourceText ?? fallbackText);

    if (fallbackTextFormat && typeof fallbackText === 'string') {
      return {
        text: fallbackText,
        textFormat: fallbackTextFormat,
      };
    }

    if (typeof sourceText === 'string' && typeof text === 'string' && text === sourceText) {
      const markdown = this.renderMessageMarkupAsMarkdown(sourceText, source.markup);
      if (markdown && markdown !== sourceText) {
        return {
          text: markdown,
          textFormat: 'markdown',
        };
      }

      const textFormat = source.textFormat;
      if (textFormat) {
        return {
          text,
          textFormat,
        };
      }
    }

    return {
      text,
      textFormat: null,
    };
  }

  private resolveOutgoingMessageTextSource(
    message: Record<string, unknown> | null,
    fallbackText: string | null,
  ): {
    text: string | null;
    markup: MaxMessageMarkup[];
    textFormat: MaxTextFormat | null;
    fromFallback: boolean;
  } {
    const direct = this.extractMessageTextSource(message);
    if (typeof direct.text === 'string' && direct.text.length > 0) {
      return {
        ...direct,
        fromFallback: false,
      };
    }

    const linked = this.extractForwardedMessageTextSource(message);
    if (typeof linked.text === 'string' && linked.text.length > 0) {
      return {
        ...linked,
        fromFallback: false,
      };
    }

    return {
      text: direct.text,
      markup: direct.markup,
      textFormat: direct.textFormat,
      fromFallback:
        direct.text === '' &&
        typeof fallbackText === 'string' &&
        fallbackText.length > 0 &&
        this.isForwardedMessage(message),
    };
  }

  private extractForwardedMessageTextSource(message: Record<string, unknown> | null): {
    text: string | null;
    markup: MaxMessageMarkup[];
    textFormat: MaxTextFormat | null;
  } {
    if (!this.isForwardedMessage(message)) {
      return {
        text: null,
        markup: [],
        textFormat: null,
      };
    }

    const link = this.asRecord(message?.link);
    const linkedMessage = this.asRecord(link?.message);
    return this.extractMessageTextSource(linkedMessage ?? null);
  }

  private extractMessageTextSource(message: Record<string, unknown> | null): {
    text: string | null;
    markup: MaxMessageMarkup[];
    textFormat: MaxTextFormat | null;
  } {
    const body = this.asRecord(message?.body);
    const text =
      typeof body?.text === 'string'
        ? body.text
        : typeof message?.text === 'string'
          ? message.text
          : null;

    return {
      text,
      markup: this.extractMessageMarkup(message),
      textFormat: this.extractMessageTextFormat(message),
    };
  }

  private isForwardedMessage(message: Record<string, unknown> | null): boolean {
    const link = this.asRecord(message?.link);
    return this.readLowerString(link?.type) === 'forward';
  }

  private extractMessageMarkup(message: Record<string, unknown> | null): MaxMessageMarkup[] {
    const body = this.asRecord(message?.body);
    const rawMarkupCandidate =
      [
        body?.markup,
        body?.text_markup,
        body?.textMarkup,
        body?.caption_markup,
        body?.captionMarkup,
        message?.markup,
        message?.text_markup,
        message?.textMarkup,
        message?.caption_markup,
        message?.captionMarkup,
      ].find((candidate) => Array.isArray(candidate) && candidate.length > 0) ?? [];
    const rawMarkup: unknown[] = Array.isArray(rawMarkupCandidate) ? rawMarkupCandidate : [];

    return rawMarkup
      .map((item: unknown) => this.normalizeMessageMarkup(item))
      .filter((item: MaxMessageMarkup | null): item is MaxMessageMarkup => item !== null);
  }

  private normalizeMessageMarkup(value: unknown): MaxMessageMarkup | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    const row = value as Record<string, unknown>;
    const type = this.readLowerString(row.type);
    const from = this.readNullableInteger(row.from);
    const length = this.readNullableInteger(row.length);

    if (
      !type ||
      from === null ||
      length === null ||
      from < 0 ||
      length <= 0 ||
      ![
        'emphasized',
        'heading',
        'link',
        'monospaced',
        'strikethrough',
        'strong',
        'underline',
        'user_mention',
      ].includes(type)
    ) {
      return null;
    }

    return {
      from,
      length,
      type: type as MaxMessageMarkup['type'],
      url: this.readTrimmedString(row.url),
      userLink: this.readTrimmedString(row.user_link ?? row.userLink),
    };
  }

  private renderMessageMarkupAsHtml(text: string, markup: MaxMessageMarkup[]): string | null {
    if (markup.length === 0) {
      return null;
    }

    const openTags = new Map<
      number,
      Array<{ open: string; close: string; end: number; priority: number }>
    >();
    const closeTags = new Map<
      number,
      Array<{ close: string; start: number; end: number; priority: number }>
    >();
    const boundaries = new Set<number>([0, text.length]);

    for (const item of markup) {
      const start = item.from;
      const end = item.from + item.length;

      if (start < 0 || end <= start || end > text.length) {
        continue;
      }

      const tag = this.resolveMarkupHtmlTags(item, text.slice(start, end));
      if (!tag) {
        continue;
      }

      const openBucket = openTags.get(start) ?? [];
      openBucket.push({
        open: tag.open,
        close: tag.close,
        end,
        priority: tag.priority,
      });
      openTags.set(start, openBucket);

      const closeBucket = closeTags.get(end) ?? [];
      closeBucket.push({
        close: tag.close,
        start,
        end,
        priority: tag.priority,
      });
      closeTags.set(end, closeBucket);
      boundaries.add(start);
      boundaries.add(end);
    }

    if (openTags.size === 0 && closeTags.size === 0) {
      return null;
    }

    let html = '';
    let previousBoundary = 0;
    const sortedBoundaries = Array.from(boundaries).sort((left, right) => left - right);

    for (const boundary of sortedBoundaries) {
      if (boundary > previousBoundary) {
        html += this.escapeHtml(text.slice(previousBoundary, boundary));
      }

      const closing = closeTags.get(boundary);
      if (closing) {
        closing
          .slice()
          .sort(
            (left, right) =>
              right.start - left.start || left.end - right.end || right.priority - left.priority,
          )
          .forEach((tag) => {
            html += tag.close;
          });
      }

      const opening = openTags.get(boundary);
      if (opening) {
        opening
          .slice()
          .sort((left, right) => right.end - left.end || left.priority - right.priority)
          .forEach((tag) => {
            html += tag.open;
          });
      }
      previousBoundary = boundary;
    }

    return html;
  }

  private renderMessageMarkupAsMarkdown(text: string, markup: MaxMessageMarkup[]): string | null {
    if (markup.length === 0) {
      return null;
    }

    const openTags = new Map<
      number,
      Array<{ open: string; close: string; end: number; priority: number }>
    >();
    const closeTags = new Map<
      number,
      Array<{ close: string; start: number; end: number; priority: number }>
    >();
    const boundaries = new Set<number>([0, text.length]);

    for (const item of markup) {
      const start = item.from;
      const end = item.from + item.length;
      if (start < 0 || end <= start || end > text.length) {
        continue;
      }

      for (const segment of this.splitMarkupRangeByLines(text, start, end)) {
        const delimiters = this.resolveMarkupMarkdownDelimiters(
          item,
          text.slice(segment.start, segment.end),
        );
        if (!delimiters) {
          continue;
        }

        const openBucket = openTags.get(segment.start) ?? [];
        openBucket.push({
          open: delimiters.open,
          close: delimiters.close,
          end: segment.end,
          priority: delimiters.priority,
        });
        openTags.set(segment.start, openBucket);

        const closeBucket = closeTags.get(segment.end) ?? [];
        closeBucket.push({
          close: delimiters.close,
          start: segment.start,
          end: segment.end,
          priority: delimiters.priority,
        });
        closeTags.set(segment.end, closeBucket);
        boundaries.add(segment.start);
        boundaries.add(segment.end);
      }
    }

    if (openTags.size === 0 && closeTags.size === 0) {
      return null;
    }

    let markdown = '';
    let previousBoundary = 0;
    const sortedBoundaries = Array.from(boundaries).sort((left, right) => left - right);

    for (const boundary of sortedBoundaries) {
      if (boundary > previousBoundary) {
        markdown += this.escapeMarkdownText(text.slice(previousBoundary, boundary));
      }

      const closing = closeTags.get(boundary);
      if (closing) {
        closing
          .slice()
          .sort(
            (left, right) =>
              right.start - left.start || left.end - right.end || right.priority - left.priority,
          )
          .forEach((tag) => {
            markdown += tag.close;
          });
      }

      const opening = openTags.get(boundary);
      if (opening) {
        opening
          .slice()
          .sort((left, right) => right.end - left.end || left.priority - right.priority)
          .forEach((tag) => {
            markdown += tag.open;
          });
      }

      previousBoundary = boundary;
    }

    return markdown;
  }

  private splitMarkupRangeByLines(
    text: string,
    start: number,
    end: number,
  ): Array<{ start: number; end: number }> {
    const segments: Array<{ start: number; end: number }> = [];
    let segmentStart = start;

    for (let index = start; index < end; index += 1) {
      const char = text[index];
      if (char !== '\n' && char !== '\r') {
        continue;
      }

      if (segmentStart < index && text.slice(segmentStart, index).trim().length > 0) {
        segments.push({ start: segmentStart, end: index });
      }

      if (char === '\r' && text[index + 1] === '\n' && index + 1 < end) {
        index += 1;
      }
      segmentStart = index + 1;
    }

    if (segmentStart < end && text.slice(segmentStart, end).trim().length > 0) {
      segments.push({ start: segmentStart, end });
    }

    return segments;
  }

  private resolveMarkupMarkdownDelimiters(
    markup: MaxMessageMarkup,
    visibleText: string,
  ): { open: string; close: string; priority: number } | null {
    switch (markup.type) {
      case 'strong':
        return { open: '**', close: '**', priority: 20 };
      case 'heading':
        return { open: '# ', close: '', priority: 5 };
      case 'emphasized':
        return { open: '_', close: '_', priority: 30 };
      case 'underline':
        return { open: '++', close: '++', priority: 40 };
      case 'strikethrough':
        return { open: '~~', close: '~~', priority: 50 };
      case 'monospaced':
        return visibleText.includes('\n') ? null : { open: '`', close: '`', priority: 60 };
      case 'link':
        return markup.url && !this.isRedundantMarkupAutoLink(visibleText, markup.url)
          ? {
              open: '[',
              close: `](${markup.url})`,
              priority: 10,
            }
          : null;
      case 'user_mention': {
        const mentionTarget = this.resolveMentionMarkupHref(markup.userLink);
        return mentionTarget
          ? {
              open: '[',
              close: `](${mentionTarget})`,
              priority: 10,
            }
          : null;
      }
      default:
        return null;
    }
  }

  private isRedundantMarkupAutoLink(visibleText: string, targetUrl: string): boolean {
    const normalizedVisibleText = visibleText.trim();
    const normalizedTargetUrl = targetUrl.trim();
    if (!normalizedVisibleText || !normalizedTargetUrl) {
      return false;
    }

    if (!/^(https?:\/\/|max:\/\/)\S+$/iu.test(normalizedVisibleText)) {
      return false;
    }

    return (
      this.normalizeComparableMarkupUrl(normalizedVisibleText) ===
      this.normalizeComparableMarkupUrl(normalizedTargetUrl)
    );
  }

  private normalizeComparableMarkupUrl(value: string): string {
    return value.trim().replace(/\/+$/u, '').toLowerCase();
  }

  private escapeMarkdownText(value: string): string {
    return value.replace(/([\\#_*[\]()`~+])/g, '\\$1');
  }

  private resolveMarkupHtmlTags(
    markup: MaxMessageMarkup,
    visibleText: string,
  ): { open: string; close: string; priority: number } | null {
    switch (markup.type) {
      case 'strong':
      case 'heading':
        return {
          open: '<strong>',
          close: '</strong>',
          priority: markup.type === 'heading' ? 5 : 20,
        };
      case 'emphasized':
        return { open: '<em>', close: '</em>', priority: 30 };
      case 'underline':
        return { open: '<u>', close: '</u>', priority: 40 };
      case 'strikethrough':
        return { open: '<del>', close: '</del>', priority: 50 };
      case 'monospaced':
        return visibleText.includes('\n')
          ? { open: '<pre>', close: '</pre>', priority: 60 }
          : { open: '<code>', close: '</code>', priority: 60 };
      case 'link':
        return markup.url
          ? {
              open: `<a href="${this.escapeHtmlAttribute(markup.url)}">`,
              close: '</a>',
              priority: 10,
            }
          : null;
      case 'user_mention': {
        const mentionTarget = this.resolveMentionMarkupHref(markup.userLink);
        return mentionTarget
          ? {
              open: `<a href="${this.escapeHtmlAttribute(mentionTarget)}">`,
              close: '</a>',
              priority: 10,
            }
          : null;
      }
      default:
        return null;
    }
  }

  private escapeHtml(value: string): string {
    return value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  }

  private escapeHtmlAttribute(value: string): string {
    return this.escapeHtml(value).replaceAll("'", '&#39;');
  }

  private resolveMentionMarkupHref(value: string | null): string | null {
    if (!value) {
      return null;
    }

    const normalized = value.trim();
    if (!normalized) {
      return null;
    }

    if (/^(?:max:\/\/|https?:\/\/)/iu.test(normalized)) {
      return normalized;
    }

    const trimmed = normalized.replace(/^\/+/u, '');
    return trimmed.startsWith('user/') ? `max://${trimmed}` : `https://max.ru/${trimmed}`;
  }

  private extractEditableAttachments(
    message: Record<string, unknown> | null,
  ): Record<string, unknown>[] {
    const body = this.asRecord(message?.body);
    const link = this.asRecord(message?.link);
    const linkedMessage = this.asRecord(link?.message);
    const bodyAttachments = Array.isArray(body?.attachments) ? body.attachments : [];
    const linkedAttachments = Array.isArray(linkedMessage?.attachments)
      ? linkedMessage.attachments
      : [];
    const attachments =
      bodyAttachments.length > 0 ||
      this.readLowerString(link?.type) !== 'forward' ||
      linkedAttachments.length === 0
        ? bodyAttachments
        : linkedAttachments;
    return attachments
      .map((attachment) => this.normalizeEditableAttachment(attachment))
      .filter((attachment): attachment is Record<string, unknown> => attachment !== null);
  }

  private normalizeEditableAttachment(attachment: unknown): Record<string, unknown> | null {
    if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) {
      return null;
    }

    const row = attachment as Record<string, unknown>;
    const type = this.readLowerString(row.type);
    const payload = row.payload;
    if (!type || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return null;
    }

    return {
      type,
      payload,
    };
  }

  private buildImageAttachment(
    imagePayload?: Record<string, unknown>,
  ): Record<string, unknown> | null {
    if (
      !imagePayload ||
      typeof imagePayload !== 'object' ||
      Object.keys(imagePayload).length === 0
    ) {
      return null;
    }

    return {
      type: 'image',
      payload: imagePayload,
    };
  }

  private buildMediaAttachments(attachments: MaxAttachmentPayload[]): Record<string, unknown>[] {
    const normalizedAttachments: Record<string, unknown>[] = [];

    for (const attachment of attachments) {
      if (!attachment || typeof attachment !== 'object') {
        continue;
      }

      const type = this.readLowerString(attachment.type);
      if (type !== 'image' && type !== 'video' && type !== 'audio' && type !== 'file') {
        continue;
      }

      const payload =
        attachment.payload &&
        typeof attachment.payload === 'object' &&
        !Array.isArray(attachment.payload)
          ? attachment.payload
          : null;
      if (!payload || Object.keys(payload).length === 0) {
        continue;
      }

      normalizedAttachments.push({
        type,
        payload,
      });
    }

    return normalizedAttachments;
  }

  private buildMessageLinkData(link?: MaxReplyMessageLink | null): Record<string, unknown> | null {
    if (!link || link.type !== 'reply') {
      return null;
    }

    const mid = typeof link.mid === 'string' ? link.mid.trim() : '';
    if (!mid) {
      return null;
    }

    return {
      type: 'reply',
      mid,
    };
  }

  private buildInlineKeyboardAttachment(
    options?: MaxSendMessageOptions,
  ): Record<string, unknown> | null {
    const buttons = this.normalizeInlineKeyboardButtons(options);
    if (!buttons) {
      return null;
    }

    return {
      type: 'inline_keyboard',
      payload: {
        buttons,
      },
    };
  }

  private normalizeInlineKeyboardButtons(
    options?: MaxSendMessageOptions,
  ): Array<Array<Record<string, unknown>>> | null {
    if (!options) {
      return null;
    }

    const sourceButtons: MaxMessageButton[][] =
      Array.isArray(options.buttons) && options.buttons.length > 0
        ? options.buttons
        : options.button
          ? [[options.button]]
          : [];

    if (sourceButtons.length === 0) {
      return null;
    }

    return normalizeMaxInlineKeyboardButtons(sourceButtons, {
      onTrimmed: (details) => {
        this.logger.warn(
          {
            requestedButtons: details.requestedButtons,
            deliveredButtons: details.deliveredButtons,
            limit: details.buttonLimit,
            requestedRows: details.requestedRows,
            deliveredRows: details.deliveredRows,
            rowLimit: details.rowLimit,
            screen: options.debugContext?.screen ?? null,
            action: options.debugContext?.action ?? null,
          },
          'Inline keyboard exceeds MAX limit; tail buttons were trimmed',
        );
      },
    });
  }

  private async executeReadRequest<T>(
    operation: () => Promise<T>,
    options: {
      chatId?: string | null;
      trafficClass?: MaxApiTrafficClass;
      actionHealthLane?: ActionHealthLane;
      sourceTag?: string;
      ignoreFailureMetricStatuses?: readonly number[];
      timeoutMs?: number;
      botId?: string;
      messageMutation?: MaxMessageMutationRateLimitScope;
    } = {},
  ): Promise<T> {
    const bot = this.resolveBot(options.botId);
    const trafficClass = options.trafficClass ?? 'interactive';
    const actionHealthLane = options.actionHealthLane ?? trafficClass;
    const sourceTag = this.normalizeMetricSourceTag(options.sourceTag);
    const circuitPermit = await this.acquireCircuitPermit(bot.id);
    try {
      await this.reserveRateLimitSlot(
        bot.id,
        options.chatId ?? null,
        trafficClass,
        sourceTag,
        options.timeoutMs,
        options.messageMutation,
      );
    } catch (error: unknown) {
      await this.releaseUnusedHalfOpenProbe(bot.id, circuitPermit);
      if (trafficClass === 'critical' && error instanceof MaxApiInternalRateLimitError) {
        this.actionHealthService.recordFailureForLane(actionHealthLane, true, bot.id);
      }
      throw error;
    }

    try {
      const result = await this.botContext.runWithBot(bot.id, () => operation());
      await this.closeCircuitAfterSuccessfulProbe(bot.id, circuitPermit);
      this.actionHealthService.recordSuccessForLane(actionHealthLane, bot.id);
      return result;
    } catch (error: unknown) {
      if (this.shouldIgnoreActionHealthFailure(error, options)) {
        await this.closeCircuitAfterSuccessfulProbe(bot.id, circuitPermit);
        throw error;
      }

      const status = this.extractStatusCode(error);
      const ignoreFailureMetrics =
        typeof status === 'number' &&
        Boolean(options.ignoreFailureMetricStatuses?.includes(status));
      if (ignoreFailureMetrics) {
        await this.closeCircuitAfterSuccessfulProbe(bot.id, circuitPermit);
        throw error;
      }
      const isCritical =
        status === 429 ||
        (typeof status === 'number' && status >= 500) ||
        this.isCriticalNetworkFailure(error);
      this.actionHealthService.recordFailureForLane(actionHealthLane, isCritical, bot.id);
      if (isCritical) {
        await this.registerCriticalFailure(bot.id, circuitPermit);
      } else {
        await this.closeCircuitAfterSuccessfulProbe(bot.id, circuitPermit);
      }
      if (status === 429) {
        await this.recordRateLimitOutcome({
          origin: 'external_429',
          botId: bot.id,
          chatId: options.chatId ?? null,
          trafficClass,
          sourceTag,
          statusCode: status,
          reason: this.extractErrorMessage(error) || 'MAX API 429 rate limit',
        });
      }
      throw error;
    }
  }

  private async executeChatRequest<T>(
    chatId: string,
    operation: () => Promise<T>,
    options: MaxApiRequestOptions | MaxApiTrafficClass = {},
  ): Promise<T> {
    const normalizedOptions = this.normalizeReadRequestOptions(options);
    return this.executeReadRequest(operation, { chatId, ...normalizedOptions });
  }

  private async executeGlobalRequest<T>(
    operation: () => Promise<T>,
    options: MaxApiRequestOptions | MaxApiTrafficClass = {},
  ): Promise<T> {
    const normalizedOptions = this.normalizeReadRequestOptions(options);
    return this.executeReadRequest(operation, normalizedOptions);
  }

  private async executeMutation<T>(
    chatId: string | null,
    operation: () => Promise<T>,
    options: MaxApiRequestOptions | MaxApiTrafficClass = 'critical',
    executionOptions: {
      requireExecutableBot?: boolean;
      messageMutation?: MaxMessageMutationRateLimitScope;
    } = {},
  ): Promise<T> {
    const normalizedOptions = this.normalizeReadRequestOptions(options);
    const executableBot =
      executionOptions.requireExecutableBot === false
        ? null
        : this.resolveExecutableBot(normalizedOptions.botId, {
            explicit: Boolean(normalizedOptions.botId),
          });
    return this.executeReadRequest(operation, {
      chatId,
      trafficClass: normalizedOptions.trafficClass ?? 'critical',
      actionHealthLane: normalizedOptions.actionHealthLane,
      sourceTag: normalizedOptions.sourceTag,
      ignoreFailureMetricStatuses: normalizedOptions.ignoreFailureMetricStatuses,
      timeoutMs: normalizedOptions.timeoutMs,
      botId: executableBot?.id ?? normalizedOptions.botId,
      messageMutation: executionOptions.messageMutation,
    });
  }

  private async executeMessageMutation<T>(
    operationType: MaxMessageMutationOperation,
    entityId: string | null,
    operation: () => Promise<T>,
    options: MaxApiRequestOptions | MaxApiTrafficClass = 'critical',
  ): Promise<T> {
    return this.executeMutation(entityId, operation, options, {
      messageMutation: {
        operation: operationType,
        entityId,
      },
    });
  }

  private normalizeReadRequestOptions(options: MaxApiRequestOptions | MaxApiTrafficClass): {
    trafficClass?: MaxApiTrafficClass;
    actionHealthLane?: ActionHealthLane;
    sourceTag?: string;
    ignoreFailureMetricStatuses?: readonly number[];
    timeoutMs?: number;
    botId?: string;
  } {
    if (typeof options === 'string') {
      return { trafficClass: options };
    }

    return {
      trafficClass: options.trafficClass,
      actionHealthLane: options.actionHealthLane,
      sourceTag: this.normalizeMetricSourceTag(options.sourceTag) ?? undefined,
      ignoreFailureMetricStatuses: this.normalizeFailureMetricStatuses(
        options.ignoreFailureMetricStatuses,
      ),
      timeoutMs: this.normalizeTimeoutMs(options.timeoutMs),
      botId: this.readTrimmedString(options.botId) ?? undefined,
    };
  }

  private normalizeTimeoutMs(value: number | null | undefined): number | undefined {
    return typeof value === 'number' && Number.isFinite(value)
      ? Math.max(1, Math.trunc(value))
      : undefined;
  }

  private shouldIgnoreActionHealthFailure(
    error: unknown,
    options: {
      trafficClass?: MaxApiTrafficClass;
      actionHealthLane?: ActionHealthLane;
      ignoreFailureMetricStatuses?: readonly number[];
    },
  ): boolean {
    if (wasMaxPreDispatchGuardRejected(error)) {
      return true;
    }
    const status = this.extractStatusCode(error);
    if (
      typeof status === 'number' &&
      Boolean(options.ignoreFailureMetricStatuses?.includes(status))
    ) {
      return true;
    }

    if (options.trafficClass === 'critical') {
      return false;
    }

    if (typeof status === 'number') {
      return false;
    }

    const message = this.extractErrorMessage(error);
    return message.includes('rate limit exceeded') || message.includes('circuit breaker');
  }

  private buildQueuedActionMutationOptions(
    action: MaxActionJob,
    botId: string,
  ): MaxApiRequestOptions {
    return {
      botId,
      trafficClass: action.trafficClass,
      actionHealthLane: action.actionHealthLane,
      sourceTag: this.normalizeMetricSourceTag(action.sourceTag) ?? undefined,
      timeoutMs: this.normalizeTimeoutMs(action.timeoutMs),
      ignoreFailureMetricStatuses: this.normalizeFailureMetricStatuses(
        action.ignoreFailureMetricStatuses,
      ),
    };
  }

  private buildAutoDeleteDispatchOptions(
    action: MaxActionJob,
    botId: string,
    delayMs: number,
  ): MaxActionDispatchOptions {
    const sourceTag = this.normalizeMetricSourceTag(action.sourceTag);
    const timeoutMs = this.normalizeTimeoutMs(action.timeoutMs);
    const ignoreFailureMetricStatuses = this.normalizeFailureMetricStatuses(
      action.ignoreFailureMetricStatuses,
    );

    return {
      delayMs,
      botId,
      ...(action.trafficClass ? { trafficClass: action.trafficClass } : {}),
      ...(action.actionHealthLane ? { actionHealthLane: action.actionHealthLane } : {}),
      ...(sourceTag ? { sourceTag } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
      ...(ignoreFailureMetricStatuses ? { ignoreFailureMetricStatuses } : {}),
    };
  }

  private async executeQueuedSendMessage(
    action: MaxActionJob,
    attachments: Record<string, unknown>[],
    mutationOptions: MaxApiRequestOptions,
  ): Promise<Record<string, unknown>> {
    const messageLink = this.buildMessageLinkData(action.options?.messageLink);
    const sendRequest = () =>
      this.request<Record<string, unknown>>('post', '/messages', {
        params: {
          chat_id: action.chatId,
        },
        data: {
          text: action.text,
          ...(action.options?.textFormat ? { format: action.options.textFormat } : {}),
          ...(messageLink ? { link: messageLink } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
        },
        ...(mutationOptions.timeoutMs ? { timeout: mutationOptions.timeoutMs } : {}),
      });

    if (!this.actionLedgerService) {
      try {
        return await this.executeMessageMutation(
          'send',
          action.chatId,
          sendRequest,
          mutationOptions,
        );
      } catch (error: unknown) {
        if (isAmbiguousMaxSendError(error)) {
          throw this.createAmbiguousQueuedMutationError(
            `Ambiguous MAX SEND_MESSAGE transport failure for chat ${action.chatId}: ${this.extractErrorMessage(error) || 'no HTTP status'}`,
            error,
          );
        }
        throw error;
      }
    }

    let dispatchToken: string | null = null;
    try {
      return await this.executeMessageMutation(
        'send',
        action.chatId,
        async () => {
          const botId = this.readTrimmedString(mutationOptions.botId) ?? this.getCurrentBot().id;
          const claim = await this.actionLedgerService!.claimSendDispatch(action, botId);
          if (claim.kind === 'recovered') {
            return {
              message_id: claim.remoteMessageId,
            };
          }

          dispatchToken = claim.dispatchToken;
          const response = await sendRequest();
          const remoteMessageId = this.extractMessageIdFromSendResponse(response);
          if (!remoteMessageId) {
            throw new Error('MAX SEND_MESSAGE response has no remote message id');
          }
          await this.actionLedgerService!.completeSendDispatch(
            action,
            claim.dispatchToken,
            remoteMessageId,
          );
          return response;
        },
        mutationOptions,
      );
    } catch (error: unknown) {
      if (!dispatchToken) {
        throw error;
      }

      if (this.isDefinitiveQueuedSendRejection(error)) {
        try {
          await this.actionLedgerService.releaseSendDispatch(action, dispatchToken);
        } catch (releaseError: unknown) {
          return this.throwAmbiguousQueuedSend(
            action,
            dispatchToken,
            releaseError,
            `Ambiguous MAX SEND_MESSAGE fence release after definitive rejection for chat ${action.chatId}`,
          );
        }
        if (
          this.extractStatusCode(error) !== 429 &&
          !this.isRetryableDefinitiveQueuedSendRejection(error)
        ) {
          throw this.createUnrecoverableQueuedMutationError(
            `MAX SEND_MESSAGE received definitive HTTP ${this.extractStatusCode(error) ?? '4xx'} for chat ${action.chatId}`,
            error,
          );
        }
        throw error;
      }

      return this.throwAmbiguousQueuedSend(
        action,
        dispatchToken,
        error,
        `Ambiguous MAX SEND_MESSAGE transport failure for chat ${action.chatId}: ${this.extractErrorMessage(error) || 'no HTTP status'}`,
      );
    }
  }

  private isDefinitiveQueuedSendRejection(error: unknown): boolean {
    const status = this.extractStatusCode(error);
    return typeof status === 'number' && status >= 400 && status < 500 && status !== 408;
  }

  private isRetryableDefinitiveQueuedSendRejection(error: unknown): boolean {
    if (this.extractStatusCode(error) !== 400) {
      return false;
    }

    const payload = (error as { response?: { data?: unknown } })?.response?.data;
    const normalized = JSON.stringify(payload ?? '').toLowerCase();
    return normalized.includes('attachment.not.ready') || normalized.includes('not ready');
  }

  private async throwAmbiguousQueuedSend(
    action: MaxActionJob,
    dispatchToken: string,
    cause: unknown,
    message: string,
  ): Promise<Record<string, unknown>> {
    const error = this.createAmbiguousQueuedMutationError(message, cause);
    let finalized = false;
    try {
      const quarantined = await this.actionLedgerService?.recordAmbiguousSendDispatch(
        action,
        dispatchToken,
        error,
      );
      if (quarantined) {
        markMaxSendDispatchLedgerFinalized(error);
        finalized = true;
      }
    } catch (ledgerError: unknown) {
      this.logger.warn(
        {
          actionType: action.actionType,
          chatId: action.chatId,
          botId: action.botId ?? null,
          error: this.extractErrorMessage(ledgerError),
        },
        'Failed to quarantine ambiguous MAX SEND_MESSAGE dispatch fence',
      );
    }

    if (!finalized) {
      const recoveredRemoteMessageId = await this.actionLedgerService
        ?.getCompletedSendDispatch?.(action)
        ?.catch(() => null);
      if (recoveredRemoteMessageId) {
        return {
          message_id: recoveredRemoteMessageId,
        };
      }
    }
    throw error;
  }

  private async executeQueuedMemberModerationAction(
    action: MaxActionJob,
    mutationOptions: MaxApiRequestOptions,
    options: { block: boolean; beforeMutation?: () => Promise<void> },
  ): Promise<void> {
    let memberMutationAttempted = false;
    try {
      await this.executeMutation(
        action.chatId,
        async () => {
          await this.runPreDispatchMutationGuard(
            options.beforeMutation,
            MAX_MEMBER_PRE_DISPATCH_GUARD_REJECTED_CODE,
          );
          memberMutationAttempted = true;
          await this.request('delete', `/chats/${action.chatId}/members`, {
            params: {
              user_id: action.userId,
              ...(options.block ? { block: true } : {}),
            },
          });
        },
        mutationOptions,
      );
    } catch (error: unknown) {
      const dispatchedError = memberMutationAttempted
        ? markMaxMemberMutationAttempted(error)
        : error;
      if (this.isAmbiguousQueuedMutationTransportError(dispatchedError)) {
        throw this.createAmbiguousQueuedMutationError(
          `Ambiguous MAX ${action.actionType} transport failure for chat ${action.chatId} user ${action.userId}: ${this.extractErrorMessage(dispatchedError) || 'no HTTP status'}`,
          dispatchedError,
        );
      }
      throw dispatchedError;
    }
  }

  private async runPreDispatchMutationGuard(
    guard: (() => Promise<void>) | undefined,
    fallbackCode: string,
  ): Promise<void> {
    if (!guard) {
      return;
    }
    try {
      await guard();
    } catch (error: unknown) {
      throw markMaxPreDispatchGuardRejected(error, fallbackCode);
    }
  }

  private normalizeFailureMetricStatuses(
    statuses: readonly number[] | undefined,
  ): number[] | undefined {
    if (!Array.isArray(statuses)) {
      return undefined;
    }

    const normalized = Array.from(
      new Set(
        statuses.filter((status): status is number => Number.isInteger(status) && status > 0),
      ),
    );
    return normalized.length > 0 ? normalized : undefined;
  }

  private extractMessageIdFromSendResponse(payload: unknown): string | null {
    const queue: Array<{ node: unknown; depth: number }> = [{ node: payload, depth: 0 }];
    const visited = new Set<unknown>();

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || current.depth > 4) {
        continue;
      }

      const { node, depth } = current;
      if (!node || typeof node !== 'object') {
        continue;
      }

      if (visited.has(node)) {
        continue;
      }
      visited.add(node);

      if (Array.isArray(node)) {
        for (const item of node) {
          queue.push({ node: item, depth: depth + 1 });
        }
        continue;
      }

      const row = node as Record<string, unknown>;
      const directCandidates = [row.message_id, row.messageId, row.mid];
      for (const value of directCandidates) {
        if (typeof value === 'string' || typeof value === 'number') {
          return String(value);
        }
      }

      if (typeof row.id === 'string' || typeof row.id === 'number') {
        return String(row.id);
      }

      for (const value of Object.values(row)) {
        if (value && (typeof value === 'object' || Array.isArray(value))) {
          queue.push({ node: value, depth: depth + 1 });
        }
      }
    }

    return null;
  }

  private buildExactMessagePresenceRequestKey(request: MaxExactMessagePresenceRequest): string {
    return JSON.stringify([request.chatId, request.messageId]);
  }

  private createExactMessageTargetMismatchError(
    expectedChatId: string,
    responseChatId: string,
    messageId: string,
  ): Error {
    return new Error(
      `MAX exact message lookup returned ${messageId} for chat ${responseChatId} instead of ${expectedChatId}`,
    );
  }

  private createUnscopedExactMessageTargetError(messageId: string): Error {
    return new Error(
      `MAX exact message lookup returned ${messageId} without a chat id for multiple targets`,
    );
  }

  private extractChatIdFromSendResponse(payload: unknown): string | null {
    const queue: Array<{ node: unknown; depth: number }> = [{ node: payload, depth: 0 }];
    const visited = new Set<unknown>();

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || current.depth > 4) {
        continue;
      }

      const { node, depth } = current;
      if (!node || typeof node !== 'object') {
        continue;
      }

      if (visited.has(node)) {
        continue;
      }
      visited.add(node);

      if (Array.isArray(node)) {
        for (const item of node) {
          queue.push({ node: item, depth: depth + 1 });
        }
        continue;
      }

      const row = node as Record<string, unknown>;
      const recipient = this.asRecord(row.recipient);
      const chatIdValue = recipient?.chat_id ?? recipient?.chatId ?? row.chat_id ?? row.chatId;
      if (typeof chatIdValue === 'number' || typeof chatIdValue === 'string') {
        const normalized = String(chatIdValue).trim();
        if (normalized) {
          return normalized;
        }
      }

      for (const value of Object.values(row)) {
        queue.push({ node: value, depth: depth + 1 });
      }
    }

    return null;
  }

  private readConfigInt(value: unknown, fallback: number, min = 1): number {
    const numericValue =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim().length > 0
          ? Number(value)
          : Number.NaN;
    if (Number.isFinite(numericValue) && numericValue >= min) {
      return Math.trunc(numericValue);
    }

    return fallback;
  }

  private async reserveRateLimitSlot(
    botId: string,
    chatId: string | null,
    trafficClass: MaxApiTrafficClass,
    sourceTag?: string | null,
    maxWaitMsOverride?: number,
    messageMutation?: MaxMessageMutationRateLimitScope,
  ) {
    const configuredMaxWaitMs = this.resolveTrafficClassRateLimitWaitMs(trafficClass);
    const maxWaitMs =
      typeof maxWaitMsOverride === 'number' && Number.isFinite(maxWaitMsOverride)
        ? Math.max(0, Math.min(configuredMaxWaitMs, Math.trunc(maxWaitMsOverride)))
        : configuredMaxWaitMs;
    const startedAtMs = Date.now();

    while (true) {
      const reservation = await this.tryReserveRateLimitSlot(
        botId,
        chatId,
        trafficClass,
        sourceTag,
        messageMutation,
      );
      if (reservation.ok) {
        await this.recordRateLimitUsage(botId, trafficClass, sourceTag);
        return;
      }

      const elapsedMs = Date.now() - startedAtMs;
      const remainingWaitMs = maxWaitMs - elapsedMs;
      if (remainingWaitMs <= 0) {
        await this.recordRateLimitOutcome({
          origin: 'internal_limiter',
          botId,
          chatId,
          trafficClass,
          sourceTag,
          reason: reservation.reason,
          retryAfterMs: reservation.retryAfterMs,
        });
        throw new MaxApiInternalRateLimitError(reservation.reason, reservation.retryAfterMs);
      }

      await this.sleep(
        Math.max(this.rateLimitRetryFloorMs, Math.min(reservation.retryAfterMs, remainingWaitMs)),
      );
    }
  }

  private shouldApplyManagedRefreshSourceLimit(
    trafficClass: MaxApiTrafficClass,
    sourceTag?: string | null,
  ): boolean {
    return (
      trafficClass !== 'critical' &&
      this.normalizeMetricSourceTag(sourceTag) === MAX_API_SOURCE_TAGS.MANAGED_REFRESH &&
      (this.managedRefreshRpsLimit > 0 || this.managedRefreshStackRpsLimit > 0)
    );
  }

  private async tryReserveRateLimitSlot(
    botId: string,
    chatId: string | null,
    trafficClass: MaxApiTrafficClass,
    sourceTag?: string | null,
    messageMutation?: MaxMessageMutationRateLimitScope,
  ): Promise<
    | { ok: true }
    | {
        ok: false;
        retryAfterMs: number;
        reason: string;
      }
  > {
    const messageMutationScope = messageMutation
      ? messageMutation.entityId
        ? `target:${encodeURIComponent(messageMutation.entityId)}`
        : `unknown-target:bot:${encodeURIComponent(botId)}`
      : null;
    const dimensions = [
      {
        key: `maxapi:gcra:v1:bot:${botId}:all`,
        limit: this.globalRpsLimit,
        reason: `MAX API global rate limit exceeded for bot ${botId}`,
      },
      {
        key: `maxapi:gcra:v1:service:${this.rateLimitServiceScope}:bot:${botId}:class:${trafficClass}`,
        limit: this.resolveTrafficClassEffectiveRpsLimit(trafficClass),
        reason: `MAX API ${trafficClass} rate limit exceeded for bot ${botId}`,
      },
      ...(chatId
        ? [
            {
              key: `maxapi:gcra:v1:chat:${botId}:${chatId}`,
              limit: this.chatRpsLimit,
              reason: `MAX API per-chat rate limit exceeded for bot ${botId} chat ${chatId}`,
            },
          ]
        : []),
      {
        key: 'maxapi:gcra:v1:stack:all',
        limit: Math.min(this.globalRpsLimit, DEFAULT_MAX_API_GLOBAL_RPS),
        reason: 'MAX API global rate limit exceeded across all bots',
      },
      {
        key: `maxapi:gcra:v1:service:${this.rateLimitServiceScope}:stack:class:${trafficClass}`,
        limit: this.resolveTrafficClassEffectiveRpsLimit(trafficClass),
        reason: `MAX API ${trafficClass} rate limit exceeded across all bots`,
      },
      ...(messageMutation
        ? [
            {
              key: `maxapi:gcra:v1:message-mutation:operation:${messageMutation.operation}:scope:${messageMutationScope}`,
              limit: MAX_MESSAGE_MUTATION_RPS,
              burstToleranceSlots: 0,
              reason: messageMutation.entityId
                ? `MAX API ${messageMutation.operation} message rate limit exceeded for target ${messageMutation.entityId}`
                : `MAX API ${messageMutation.operation} message rate limit exceeded for unknown target on bot ${botId}`,
            },
          ]
        : []),
    ];
    if (this.shouldApplyManagedRefreshSourceLimit(trafficClass, sourceTag)) {
      if (this.managedRefreshRpsLimit > 0) {
        dimensions.push({
          key: `maxapi:gcra:v1:service:${this.rateLimitServiceScope}:source:${botId}:${MAX_API_SOURCE_TAGS.MANAGED_REFRESH}`,
          limit: this.managedRefreshRpsLimit,
          reason: `MAX API managed_refresh source limit exceeded for bot ${botId}`,
        });
      }
      if (this.managedRefreshStackRpsLimit > 0) {
        dimensions.push({
          key: `maxapi:gcra:v1:service:${this.rateLimitServiceScope}:source:stack:${MAX_API_SOURCE_TAGS.MANAGED_REFRESH}`,
          limit: this.managedRefreshStackRpsLimit,
          reason: 'MAX API managed_refresh source limit exceeded across all bots',
        });
      }
    }

    const raw = await this.limiterRedis.eval(
      MAX_API_RATE_LIMIT_RESERVATION_SCRIPT,
      dimensions.length,
      ...dimensions.map((dimension) => dimension.key),
      ...dimensions.map((dimension) => String(dimension.limit)),
      ...dimensions.map((dimension) =>
        String(
          'burstToleranceSlots' in dimension
            ? dimension.burstToleranceSlots
            : Math.max(0, dimension.limit - 1),
        ),
      ),
      String(MAX_API_RATE_LIMIT_SLOT_TTL_MS),
    );
    const result = Array.isArray(raw) ? raw : null;
    const ok = typeof result?.[0] === 'number' ? result[0] : Number.NaN;
    const rejectedKeyIndex = typeof result?.[1] === 'number' ? result[1] : Number.NaN;
    const retryAfterMs = typeof result?.[2] === 'number' ? result[2] : Number.NaN;

    if (ok === 1) {
      return { ok: true };
    }

    if (ok !== 0 || !Number.isFinite(rejectedKeyIndex)) {
      throw new Error('Failed to execute MAX API rate limit reservation script');
    }

    const normalizedRetryAfterMs = Number.isFinite(retryAfterMs)
      ? Math.max(1, Math.trunc(retryAfterMs))
      : MAX_API_RATE_LIMIT_SLOT_TTL_MS;
    return {
      ok: false,
      retryAfterMs: normalizedRetryAfterMs,
      reason:
        dimensions[Math.trunc(rejectedKeyIndex) - 1]?.reason ??
        `MAX API ${trafficClass} rate limit exceeded for bot ${botId}`,
    };
  }

  private async recordRateLimitOutcome(params: {
    origin: 'internal_limiter' | 'external_429';
    botId: string;
    chatId: string | null;
    trafficClass: MaxApiTrafficClass;
    sourceTag?: string | null;
    reason: string;
    statusCode?: number | null;
    retryAfterMs?: number | null;
  }): Promise<void> {
    const nowSec = Math.floor(Date.now() / 1_000);
    const metricKeys = [
      `${MAX_API_RATE_LIMIT_OUTCOME_KEY_PREFIX}:${params.origin}:${params.botId}:${params.trafficClass}:${nowSec}`,
      `${MAX_API_RATE_LIMIT_OUTCOME_KEY_PREFIX}:${params.origin}:stack:${params.trafficClass}:${nowSec}`,
    ];
    try {
      const pipeline = this.limiterRedis.multi();
      for (const key of metricKeys) {
        pipeline.incr(key).expire(key, MAX_API_SOURCE_METRICS_TTL_SEC);
      }
      await pipeline.exec();
    } catch (error: unknown) {
      this.logger.debug(
        {
          botId: params.botId,
          trafficClass: params.trafficClass,
          origin: params.origin,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to record MAX API rate-limit outcome metric',
      );
    }

    const logKey = `${params.origin}:${params.botId}:${params.trafficClass}`;
    const nowMs = Date.now();
    const lastLoggedAtMs = this.rateLimitLogAtMsByKey.get(logKey) ?? 0;
    if (nowMs - lastLoggedAtMs >= MAX_API_RATE_LIMIT_LOG_COALESCE_MS) {
      this.rateLimitLogAtMsByKey.set(logKey, nowMs);
      this.logger.warn(
        {
          botId: params.botId,
          chatId: params.chatId,
          trafficClass: params.trafficClass,
          sourceTag: this.normalizeMetricSourceTag(params.sourceTag),
          origin: params.origin,
          statusCode: params.statusCode ?? null,
          retryAfterMs: params.retryAfterMs ?? null,
        },
        params.origin === 'external_429'
          ? 'MAX API returned external HTTP 429'
          : 'MAX API internal limiter rejected request before dispatch',
      );
    }

    const chatId = this.readTrimmedString(params.chatId);
    if (!chatId) {
      return;
    }

    try {
      await this.runtimeDiagnosticsService?.recordProblemChat({
        chatId,
        botId: params.botId,
        category:
          params.origin === 'external_429' ? 'max_api_external_429' : 'max_api_internal_limiter',
        severity: params.trafficClass === 'critical' ? 'critical' : 'warning',
        action: this.normalizeMetricSourceTag(params.sourceTag) ?? params.trafficClass,
        statusCode: params.statusCode ?? null,
        reason: params.reason,
      });
    } catch (error: unknown) {
      this.logger.debug(
        {
          botId: params.botId,
          chatId,
          origin: params.origin,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to record MAX API rate-limit problem chat',
      );
    }
  }

  private async recordRateLimitUsage(
    botId: string,
    trafficClass: MaxApiTrafficClass,
    sourceTag?: string | null,
  ): Promise<void> {
    const normalizedSourceTag = this.normalizeMetricSourceTag(sourceTag);
    const nowSec = Math.floor(Date.now() / 1_000);
    const metrics = [
      { key: `maxapi:rps:global:${botId}:${nowSec}`, ttlSec: MAX_API_SOURCE_METRICS_TTL_SEC },
      {
        key: `maxapi:rps:global:${botId}:${trafficClass}:${nowSec}`,
        ttlSec: MAX_API_SOURCE_METRICS_TTL_SEC,
      },
      { key: `maxapi:rps:stack:${nowSec}`, ttlSec: MAX_API_SOURCE_METRICS_TTL_SEC },
      {
        key: `maxapi:rps:stack:${trafficClass}:${nowSec}`,
        ttlSec: MAX_API_SOURCE_METRICS_TTL_SEC,
      },
      {
        key: buildMaxApiServiceBotClassMetricKey({
          serviceScope: this.rateLimitServiceScope,
          botId,
          trafficClass,
          sec: nowSec,
        }),
        ttlSec: MAX_API_SERVICE_CAPACITY_METRICS_TTL_SEC,
      },
      {
        key: buildMaxApiServiceStackClassMetricKey({
          serviceScope: this.rateLimitServiceScope,
          trafficClass,
          sec: nowSec,
        }),
        ttlSec: MAX_API_SERVICE_CAPACITY_METRICS_TTL_SEC,
      },
      ...(normalizedSourceTag
        ? [
            {
              key: `maxapi:rps:source:v1:${botId}:${trafficClass}:${normalizedSourceTag}:${nowSec}`,
              ttlSec: MAX_API_SOURCE_METRICS_TTL_SEC,
            },
          ]
        : []),
    ];

    try {
      const pipeline = this.limiterRedis.multi();
      for (const metric of metrics) {
        pipeline.incr(metric.key).expire(metric.key, metric.ttlSec);
      }
      await pipeline.exec();
    } catch (error: unknown) {
      this.logger.debug(
        {
          botId,
          trafficClass,
          sourceTag: normalizedSourceTag,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to record MAX API usage metric',
      );
    }
  }

  private resolveTrafficClassGlobalRpsLimit(trafficClass: MaxApiTrafficClass): number {
    switch (trafficClass) {
      case 'critical':
        return this.criticalGlobalRpsLimit;
      case 'background':
        return this.backgroundGlobalRpsLimit;
      case 'interactive':
      default:
        return this.interactiveGlobalRpsLimit;
    }
  }

  private resolveTrafficClassEffectiveRpsLimit(trafficClass: MaxApiTrafficClass): number {
    const configuredLimit = this.resolveTrafficClassGlobalRpsLimit(trafficClass);
    if (trafficClass === 'background') {
      return configuredLimit;
    }

    const reservedForOtherClasses = (() => {
      switch (trafficClass) {
        case 'critical':
          return this.interactiveGlobalRpsLimit + this.backgroundGlobalRpsLimit;
        case 'interactive':
        default:
          return this.criticalGlobalRpsLimit + this.backgroundGlobalRpsLimit;
      }
    })();

    return Math.max(configuredLimit, Math.max(1, this.globalRpsLimit - reservedForOtherClasses));
  }

  private resolveTrafficClassRateLimitWaitMs(trafficClass: MaxApiTrafficClass): number {
    switch (trafficClass) {
      case 'critical':
        return this.criticalRateLimitWaitMs;
      case 'background':
        return this.backgroundRateLimitWaitMs;
      case 'interactive':
      default:
        return this.interactiveRateLimitWaitMs;
    }
  }

  private async runWithMessageKeyboardEditLock<T>(
    messageId: string,
    operation: (assertOwnership: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    const normalizedMessageId = messageId.trim();
    if (!normalizedMessageId) {
      throw new Error('messageId is required for a keyboard edit lock');
    }
    const lockKey = `max:message-keyboard-edit:v1:${createHash('sha256')
      .update(normalizedMessageId)
      .digest('hex')}`;
    const lockToken = randomUUID();
    const deadlineMs = Date.now() + MAX_MESSAGE_EDIT_LOCK_WAIT_MS;
    let acquired = false;

    while (!acquired) {
      const result = await this.limiterRedis.eval(
        MAX_MESSAGE_EDIT_LOCK_ACQUIRE_SCRIPT,
        1,
        lockKey,
        lockToken,
        String(MAX_MESSAGE_EDIT_LOCK_TTL_MS),
      );
      acquired = Array.isArray(result) && Number(result[0]) === 1;
      if (acquired) {
        break;
      }
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) {
        throw new Error('Timed out waiting for the MAX message keyboard edit lock');
      }
      await this.sleep(Math.min(MAX_MESSAGE_EDIT_LOCK_RETRY_MS, remainingMs));
    }

    let lockActive = true;
    let ownershipLost = false;
    let renewalChain = Promise.resolve();
    const lostOwnershipError = () =>
      new Error('Lost ownership of the MAX message keyboard edit lock');
    const renewOwnership = (): Promise<void> => {
      const attempt = renewalChain.then(async () => {
        if (!lockActive || ownershipLost) {
          throw lostOwnershipError();
        }
        try {
          const result = await this.limiterRedis.eval(
            MAX_MESSAGE_EDIT_LOCK_RENEW_SCRIPT,
            1,
            lockKey,
            lockToken,
            String(MAX_MESSAGE_EDIT_LOCK_TTL_MS),
          );
          if (Number(result) !== 1) {
            ownershipLost = true;
            throw lostOwnershipError();
          }
        } catch (error: unknown) {
          ownershipLost = true;
          throw error;
        }
      });
      renewalChain = attempt.catch(() => undefined);
      return attempt;
    };
    const assertOwnership = async () => {
      if (!lockActive || ownershipLost) {
        throw lostOwnershipError();
      }
      try {
        await renewOwnership();
      } catch (error: unknown) {
        if (error instanceof Error && error.message === lostOwnershipError().message) {
          throw error;
        }
        throw new Error('Failed to confirm the MAX message keyboard edit lock', {
          cause: error,
        });
      }
    };
    const renewal = setInterval(() => {
      if (!lockActive || ownershipLost) {
        return;
      }
      void renewOwnership().catch((error: unknown) => {
        if (lockActive) {
          this.logger.warn(
            {
              messageId: normalizedMessageId,
              err: error instanceof Error ? error.message : String(error),
            },
            'Lost the MAX message keyboard edit lock during renewal',
          );
        }
      });
    }, MAX_MESSAGE_EDIT_LOCK_RENEW_MS);
    renewal.unref?.();
    this.pendingTimeouts.add(renewal);

    try {
      return await operation(assertOwnership);
    } finally {
      lockActive = false;
      clearInterval(renewal);
      this.pendingTimeouts.delete(renewal);
      await renewalChain.catch(() => undefined);
      try {
        await this.limiterRedis.eval(MAX_MESSAGE_EDIT_LOCK_RELEASE_SCRIPT, 1, lockKey, lockToken);
      } catch (error: unknown) {
        this.logger.warn(
          {
            messageId: normalizedMessageId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to release the MAX message keyboard edit lock',
        );
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingTimeouts.delete(timeout);
        resolve();
      }, ms);
      timeout.unref?.();
      this.pendingTimeouts.add(timeout);
    });
  }

  private async acquireCircuitPermit(botId: string): Promise<MaxApiCircuitPermit> {
    const keys = this.buildCircuitKeys(botId);
    const probeToken = randomUUID();
    const raw = await this.limiterRedis.eval(
      MAX_API_CIRCUIT_ACQUIRE_SCRIPT,
      keys.length,
      ...keys,
      String(this.circuitFailureThreshold),
      String(this.circuitWindowSec * 1_000),
      String(this.circuitOpenSec * 1_000),
      String(this.circuitHalfOpenProbeSec * 1_000),
      String(this.resolveCircuitStateTtlMs()),
      probeToken,
    );
    const result = Array.isArray(raw) ? raw : null;
    const allowed = Number(result?.[0]);
    const halfOpen = Number(result?.[1]);
    const retryAfterMs = Number(result?.[2]);

    if (allowed === 1) {
      return {
        halfOpenProbeToken: halfOpen === 1 ? probeToken : null,
      };
    }
    if (allowed === 0) {
      throw new MaxApiCircuitOpenError(
        botId,
        Number.isFinite(retryAfterMs) ? Math.max(1, Math.trunc(retryAfterMs)) : 1_000,
      );
    }

    throw new Error('Failed to execute MAX API circuit acquire script');
  }

  private async registerCriticalFailure(botId: string, permit: MaxApiCircuitPermit): Promise<void> {
    const keys = this.buildCircuitKeys(botId);
    try {
      await this.limiterRedis.eval(
        MAX_API_CIRCUIT_FAILURE_SCRIPT,
        keys.length,
        ...keys,
        String(this.circuitFailureThreshold),
        String(this.circuitWindowSec * 1_000),
        String(this.circuitOpenSec * 1_000),
        String(this.resolveCircuitStateTtlMs()),
        permit.halfOpenProbeToken ? '1' : '0',
      );
    } catch (error: unknown) {
      this.logger.warn(
        {
          botId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to update shared MAX API circuit after critical failure',
      );
    }
  }

  private async closeCircuitAfterSuccessfulProbe(
    botId: string,
    permit: MaxApiCircuitPermit,
  ): Promise<void> {
    if (!permit.halfOpenProbeToken) {
      return;
    }

    const keys = this.buildCircuitKeys(botId);
    try {
      await this.limiterRedis.eval(
        MAX_API_CIRCUIT_CLOSE_SCRIPT,
        keys.length,
        ...keys,
        permit.halfOpenProbeToken,
      );
    } catch (error: unknown) {
      this.logger.warn(
        {
          botId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to close shared MAX API circuit after successful half-open probe',
      );
    }
  }

  private async releaseUnusedHalfOpenProbe(
    botId: string,
    permit: MaxApiCircuitPermit,
  ): Promise<void> {
    if (!permit.halfOpenProbeToken) {
      return;
    }

    const [, , probeKey] = this.buildCircuitKeys(botId);
    try {
      await this.limiterRedis.eval(
        MAX_API_CIRCUIT_RELEASE_PROBE_SCRIPT,
        1,
        probeKey,
        permit.halfOpenProbeToken,
      );
    } catch (error: unknown) {
      this.logger.warn(
        {
          botId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to release unused shared MAX API half-open probe',
      );
    }
  }

  private buildCircuitKeys(botId: string): [string, string, string] {
    const prefix = `${MAX_API_CIRCUIT_KEY_PREFIX}:${botId}`;
    return [`${prefix}:failures`, `${prefix}:open-until`, `${prefix}:half-open-probe`];
  }

  private resolveCircuitStateTtlMs(): number {
    return (
      (this.circuitOpenSec + Math.max(this.circuitWindowSec, this.circuitHalfOpenProbeSec) + 5) *
      1_000
    );
  }

  private resolveBot(botId?: string | null): MaxBotDefinition {
    const explicitBotId = this.readTrimmedString(botId);
    return (
      (explicitBotId ? this.botRegistry.getBotById(explicitBotId) : null) ??
      this.botRegistry.getBotById(this.botContext.getActiveBotId()) ??
      this.botRegistry.getDefaultBot()
    );
  }

  private resolveExecutableBot(
    botId?: string | null,
    options: { explicit?: boolean } = {},
  ): MaxBotDefinition {
    const explicitBotId = this.readTrimmedString(botId);
    if (options.explicit === true && explicitBotId && !this.botRegistry.getBotById(explicitBotId)) {
      throw new UnrecoverableError(`MAX bot ${explicitBotId} is not configured for execution`);
    }

    const bot = this.resolveBot(botId);
    if (this.canExecuteActionsForBot(bot)) {
      return bot;
    }

    throw new UnrecoverableError(`MAX bot ${bot.id} is not executable in state ${bot.state}`);
  }

  private canExecuteActionsForBot(bot: MaxBotDefinition): boolean {
    const state = (bot as MaxBotDefinition & { state?: MaxBotLifecycleState }).state ?? 'active';
    return canExecuteActionsForBotState(state);
  }

  private isAmbiguousQueuedMutationTransportError(error: unknown): boolean {
    const status = this.extractStatusCode(error);
    return (
      (status !== null && status >= 500 && status <= 599) || isAmbiguousMaxMutationError(error)
    );
  }

  private isCriticalNetworkFailure(error: unknown): boolean {
    if (isAmbiguousMaxMutationError(error)) {
      return true;
    }

    const code = (error as { code?: unknown })?.code;
    return (
      typeof code === 'string' &&
      MAX_API_CRITICAL_NETWORK_ERROR_CODES.has(code.trim().toUpperCase())
    );
  }

  private createAmbiguousQueuedMutationError(message: string, cause: unknown): UnrecoverableError {
    const error = this.createUnrecoverableQueuedMutationError(message, cause);
    return wasMaxMemberMutationAttempted(cause)
      ? (markMaxMemberMutationAttempted(error) as UnrecoverableError)
      : error;
  }

  private createUnrecoverableQueuedMutationError(
    message: string,
    cause: unknown,
  ): UnrecoverableError {
    const error = new UnrecoverableError(message);
    const response = (cause as { response?: unknown })?.response;
    if (response !== undefined) {
      (error as UnrecoverableError & { response?: unknown }).response = response;
    }
    const code = (cause as { code?: unknown })?.code;
    if (code !== undefined) {
      (error as UnrecoverableError & { code?: unknown }).code = code;
    }
    return error;
  }

  private getCurrentBot(): MaxBotDefinition {
    return this.resolveBot(this.botContext.getActiveBotId());
  }

  private assertMemberActionTargetIsNotRuntimeBot(
    actionType: Extract<MaxActionType, 'KICK_MEMBER' | 'BAN_MEMBER'>,
    chatId: string,
    userId: string,
  ): void {
    if (!this.isKnownRuntimeBotUserId(userId)) {
      return;
    }

    throw new Error(
      `Refusing to ${actionType === 'BAN_MEMBER' ? 'ban' : 'kick'} configured MAX bot user ${userId} in chat ${chatId}`,
    );
  }

  private skipQueuedMemberActionForRuntimeBot(
    actionType: Extract<MaxActionType, 'KICK_MEMBER' | 'BAN_MEMBER'>,
    chatId: string,
    userId: string,
  ): boolean {
    if (!this.isKnownRuntimeBotUserId(userId)) {
      return false;
    }

    this.logger.warn(
      {
        chatId,
        userId,
        actionType,
      },
      'Skipped queued member moderation action for configured MAX bot user',
    );
    return true;
  }

  private isKnownRuntimeBotUserId(userId: string | null | undefined): boolean {
    const botRegistry = this.botRegistry as MaxBotRegistryService & {
      isKnownBotUserId?: (value: string | null | undefined) => boolean;
    };
    return botRegistry.isKnownBotUserId?.(userId) === true;
  }

  private extractStatusCode(error: unknown): number | null {
    const maybeStatus = (error as { response?: { status?: number } })?.response?.status;
    return typeof maybeStatus === 'number' ? maybeStatus : null;
  }

  private async request<T = unknown>(
    method: 'delete' | 'post' | 'get' | 'put',
    path: string,
    config: Record<string, unknown> = {},
  ): Promise<T> {
    const bot = this.getCurrentBot();
    const url = `${this.baseUrl}${path}`;
    const response = await firstValueFrom(
      this.httpService.request<T>({
        method,
        url,
        ...config,
        headers: {
          Authorization: bot.token,
          ...(config.headers as Record<string, string> | undefined),
        },
      }),
    );
    this.assertSuccessfulMutationResponse(method, response.status, response.data);

    return response.data;
  }

  private async requestAbsolute<T = unknown>(
    method: 'delete' | 'post' | 'get' | 'put',
    url: string,
    config: Record<string, unknown> & { skipAuthorization?: boolean } = {},
  ): Promise<T> {
    const bot = this.getCurrentBot();
    const { skipAuthorization, ...requestConfig } = config;
    const headers = requestConfig.headers as Record<string, string> | undefined;
    const response = await firstValueFrom(
      this.httpService.request<T>({
        method,
        url,
        ...requestConfig,
        headers: {
          ...(skipAuthorization ? {} : { Authorization: bot.token }),
          ...(headers ?? {}),
        },
      }),
    );

    return response.data;
  }

  private assertSuccessfulMutationResponse(
    method: 'delete' | 'post' | 'get' | 'put',
    status: number | undefined,
    payload: unknown,
  ) {
    if (method === 'get') {
      return;
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return;
    }

    const row = payload as Record<string, unknown>;
    if (row.success !== false) {
      return;
    }

    const message =
      typeof row.message === 'string' && row.message.trim().length > 0
        ? row.message.trim()
        : `MAX API ${method.toUpperCase()} request returned success=false`;

    throw new MaxApiRequestRejectedError(
      typeof status === 'number' ? status : DEFAULT_SUCCESS_FALSE_STATUS,
      payload,
      message,
    );
  }

  private assertSuccessfulDeleteMessageResponse(payload: unknown): void {
    if (
      payload &&
      typeof payload === 'object' &&
      !Array.isArray(payload) &&
      (payload as Record<string, unknown>).success === true
    ) {
      return;
    }

    throw new MaxApiRequestRejectedError(
      DEFAULT_SUCCESS_FALSE_STATUS,
      payload,
      'MAX API DELETE /messages response must contain success=true',
    );
  }

  private isAlreadyOutsideChatError(error: unknown): boolean {
    const status = this.extractStatusCode(error);
    const message = this.extractErrorMessage(error);
    const code = this.extractErrorCode(error);

    if (
      error instanceof MaxApiRequestRejectedError &&
      status === DEFAULT_SUCCESS_FALSE_STATUS &&
      message.includes('not active chat member')
    ) {
      return true;
    }

    if (code === 'chat.denied' || code === 'chat.not.found') {
      return true;
    }

    if (status !== 403 && status !== 404) {
      return false;
    }

    return (
      message.includes('not a chat member') ||
      message.includes('not active chat member') ||
      message.includes('not found')
    );
  }

  private isAlreadyPresentChatMemberError(error: unknown): boolean {
    const status = this.extractStatusCode(error);
    const isDocumentedMutationRejection =
      error instanceof MaxApiRequestRejectedError && status === DEFAULT_SUCCESS_FALSE_STATUS;
    if (!isDocumentedMutationRejection && status !== 400 && status !== 409) {
      return false;
    }

    const message = this.extractErrorMessage(error).trim().toLowerCase();
    return (
      message.includes('already a member') ||
      message.includes('already a chat member') ||
      message.includes('already member') ||
      message.includes('already participant') ||
      message.includes('member already exists') ||
      message.includes('participant already exists') ||
      message.includes('already in the chat') ||
      message.includes('уже состоит')
    );
  }

  private isExactMessageNotFoundError(error: unknown, requestedMessageId: string): boolean {
    if (this.extractStatusCode(error) !== 404) {
      return false;
    }

    const code = this.extractErrorCode(error);
    if (code === 'message.not.found') {
      return true;
    }
    if (code !== 'not.found') {
      return false;
    }

    const responseMessage = (error as { response?: { data?: { message?: unknown } } })?.response
      ?.data?.message;
    if (typeof responseMessage !== 'string' || !requestedMessageId) {
      return false;
    }

    const isMessageIdCharacter = (value: string | undefined) =>
      value !== undefined && /[A-Za-z0-9._-]/u.test(value);
    let matchIndex = responseMessage.indexOf(requestedMessageId);
    while (matchIndex >= 0) {
      const precedingCharacter = responseMessage[matchIndex - 1];
      const followingCharacter = responseMessage[matchIndex + requestedMessageId.length];
      if (!isMessageIdCharacter(precedingCharacter) && !isMessageIdCharacter(followingCharacter)) {
        return true;
      }
      matchIndex = responseMessage.indexOf(requestedMessageId, matchIndex + 1);
    }

    return false;
  }

  private extractErrorCode(error: unknown): string | null {
    const value = (error as { response?: { data?: { code?: unknown } } })?.response?.data?.code;
    return typeof value === 'string' && value.trim().length > 0 ? value.trim().toLowerCase() : null;
  }

  private extractErrorMessage(error: unknown): string {
    const responseMessage = (error as { response?: { data?: { message?: unknown } } })?.response
      ?.data?.message;
    if (typeof responseMessage === 'string' && responseMessage.trim().length > 0) {
      return responseMessage.trim().toLowerCase();
    }

    if (error instanceof Error && error.message.trim().length > 0) {
      return error.message.trim().toLowerCase();
    }

    return String(error).trim().toLowerCase();
  }

  private isChatAdminMemberRow(row: Record<string, unknown>): boolean {
    const roleValue = this.readLowerString(
      row.role ??
        row.member_role ??
        row.memberRole ??
        row.chat_role ??
        row.chatRole ??
        row.status ??
        row.member_status ??
        row.memberStatus,
    );

    if (roleValue) {
      if (
        roleValue.includes('admin') ||
        roleValue.includes('owner') ||
        roleValue.includes('creator') ||
        roleValue.includes('moderator')
      ) {
        return true;
      }

      if (
        roleValue.includes('member') ||
        roleValue.includes('user') ||
        roleValue.includes('participant') ||
        roleValue.includes('guest')
      ) {
        return false;
      }
    }

    const positiveFlags = [
      row.is_admin,
      row.isAdmin,
      row.admin,
      row.is_owner,
      row.isOwner,
      row.owner,
      row.is_creator,
      row.isCreator,
      row.creator,
      row.is_moderator,
      row.isModerator,
      row.moderator,
      row.can_manage_chat,
      row.canManageChat,
      row.can_delete_messages,
      row.canDeleteMessages,
    ];
    if (positiveFlags.some((value) => value === true)) {
      return true;
    }

    const explicitNegativeFlags = [
      row.is_admin,
      row.isAdmin,
      row.admin,
      row.is_owner,
      row.isOwner,
      row.owner,
      row.is_creator,
      row.isCreator,
      row.creator,
      row.is_moderator,
      row.isModerator,
      row.moderator,
    ];
    if (explicitNegativeFlags.some((value) => value === false)) {
      return false;
    }

    // Backward compatibility: keep old behavior when API does not expose roles/flags.
    return true;
  }

  private readChatAdminPermissions(row: Record<string, unknown>): string[] {
    const sources = [
      row.permissions,
      row.rights,
      row.admin_permissions,
      row.adminPermissions,
      row.chat_permissions,
      row.chatPermissions,
    ];

    const normalized = new Set<string>();
    for (const source of sources) {
      const list = this.readPermissionList(source);
      for (const item of list) {
        normalized.add(item);
      }
    }

    return [...normalized];
  }

  private readPermissionList(source: unknown): string[] {
    if (Array.isArray(source)) {
      return source
        .map((item) => this.readLowerString(item))
        .filter((item): item is string => item !== null)
        .map((item) => item.replace(/[-\s]+/gu, '_'));
    }

    if (!source || typeof source !== 'object') {
      return [];
    }

    const row = source as Record<string, unknown>;
    return Object.entries(row)
      .map(([key, value]) => ({ key, value: this.readBoolean(value) }))
      .filter((item) => item.value === true)
      .map((item) => item.key.toLowerCase().replace(/[-\s]+/gu, '_'));
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private readTrimmedString(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }

  private readHttpUrl(value: unknown): string | null {
    const normalized = this.readTrimmedString(value);
    if (!normalized) {
      return null;
    }

    return /^https?:\/\//iu.test(normalized) ? normalized : null;
  }

  private readBoolean(value: unknown): boolean | null {
    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'number') {
      if (value === 1) {
        return true;
      }
      if (value === 0) {
        return false;
      }
      return null;
    }

    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
      return true;
    }
    if (normalized === 'false' || normalized === '0' || normalized === 'no') {
      return false;
    }

    return null;
  }

  private readNullableInteger(value: unknown): number | null {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : null;
    }

    if (typeof value === 'bigint') {
      return value >= 0n ? Number(value) : null;
    }

    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim();
    if (!normalized) {
      return null;
    }

    const parsed = Number.parseInt(normalized, 10);
    return Number.isNaN(parsed) ? null : Math.max(0, parsed);
  }

  private readBigInt(value: unknown): bigint | null {
    if (typeof value === 'bigint') {
      return value >= 0n ? value : null;
    }

    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value) || value < 0) {
        return null;
      }
      return BigInt(value);
    }

    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim();
    if (!/^\d+$/u.test(normalized)) {
      return null;
    }

    try {
      return BigInt(normalized);
    } catch {
      return null;
    }
  }

  private inferChatPostLink(row: Record<string, unknown>): string | null {
    const recipient = this.asRecord(row.recipient);
    const chatType = this.readLowerString(
      recipient?.chat_type ?? recipient?.chatType ?? row.chat_type ?? row.chatType,
    );
    if (chatType === 'channel') {
      return null;
    }

    const chatIdValue = recipient?.chat_id ?? recipient?.chatId ?? row.chat_id ?? row.chatId;
    const chatId =
      typeof chatIdValue === 'number' || typeof chatIdValue === 'string'
        ? String(chatIdValue).trim()
        : '';
    if (!chatId) {
      return null;
    }

    const body = this.asRecord(row.body);
    const messageId = this.readTrimmedString(
      body?.mid ?? row.message_id ?? row.messageId ?? row.mid ?? row.id,
    );
    const tokenFromMessageId = this.buildChatPostLinkTokenFromMessageId(messageId);
    if (tokenFromMessageId) {
      return `${MAX_CHAT_POST_LINK_BASE_URL}/c/${chatId}/${tokenFromMessageId}`;
    }

    const tokenFromSequence = this.buildChatPostLinkTokenFromSequence(
      this.readBigInt(body?.seq ?? row.seq ?? row.sequence),
    );
    return tokenFromSequence
      ? `${MAX_CHAT_POST_LINK_BASE_URL}/c/${chatId}/${tokenFromSequence}`
      : null;
  }

  private buildChatPostLinkTokenFromMessageId(messageId: string | null): string | null {
    if (!messageId) {
      return null;
    }

    const hexTail = messageId.split('.').pop()?.trim().toLowerCase() ?? '';
    if (!/^[0-9a-f]{16,}$/u.test(hexTail)) {
      return null;
    }

    return Buffer.from(hexTail.slice(-16), 'hex').toString('base64url');
  }

  private buildChatPostLinkTokenFromSequence(sequence: bigint | null): string | null {
    if (sequence === null || sequence < 0n || sequence > 0xffff_ffff_ffff_ffffn) {
      return null;
    }

    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64BE(sequence);
    return buffer.toString('base64url');
  }

  private readIsoDateTime(value: unknown): string | null {
    if (value instanceof Date) {
      return Number.isFinite(value.getTime()) ? value.toISOString() : null;
    }

    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        return null;
      }

      const timestampMs = value >= 100_000_000_000 ? value : value * 1_000;
      const parsed = new Date(timestampMs);
      return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
    }

    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim();
    if (!normalized) {
      return null;
    }

    if (/^\d+$/u.test(normalized)) {
      return this.readIsoDateTime(Number.parseInt(normalized, 10));
    }

    const parsed = new Date(normalized);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
  }

  private readLowerString(value: unknown): string | null {
    const normalized = this.readTrimmedString(value);
    return normalized ? normalized.toLowerCase() : null;
  }

  private normalizeMetricSourceTag(value: string | null | undefined): string | null {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (!normalized) {
      return null;
    }

    const sanitized = normalized
      .replace(/[^a-z0-9_-]+/g, '_')
      .replace(/_+/g, '_')
      .slice(0, 64);
    return sanitized.length > 0 ? sanitized : null;
  }
}
