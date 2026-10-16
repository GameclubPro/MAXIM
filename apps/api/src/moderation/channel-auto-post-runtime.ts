import type { MaxUpdate } from '@maxim/contracts';
import { BadRequestException } from '@nestjs/common';

import {
  readInternalChannelDialogButtonIdentitiesFromMessage,
  type InternalChannelDialogButtonIdentity,
} from '../common/channel-dialog-button-identity.util';
import { formatCommentsButtonText } from '../common/dialog-button-label.util';
import { buildChannelPostActionRows } from '../common/channel-post-actions';
import {
  isMaxTextMarkupType,
  normalizeMaxUserMentionLink,
  renderMaxTextMarkupAsHtml,
  type MaxTextMarkup,
} from '../common/max-text-markup.util';
import {
  MAX_API_SOURCE_TAGS,
  type MaxMessageButton,
  type MaxSendMessageOptions,
} from '../max/max-client.service';
import { readStrictEditableAttachments } from '../max/max-editable-message-preservation';
import type { ChannelSettings as PersistedChannelSettings } from '../prisma/prisma-client';
import type { BackgroundRuntimeGovernorService } from '../system/background-runtime-governor.service';
import { extractRawMessageNode } from './moderation-update-extractors';
import { extractChannelQuickButtons, type ChannelQuickButtons } from './channel-quick-buttons';

export function buildChannelAutoPostGovernorRequest(
  queueLagCeilingSec: number,
): Parameters<BackgroundRuntimeGovernorService['decide']>[0] {
  // FLAG: Recovery admission still checks fresh queue/host pressure and MAX budgets.
  return {
    component: 'moderation',
    sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_AUTO_POST,
    allowRecoveryWindowRun: true,
    allowQueueLagSlowPathBelowSec: queueLagCeilingSec,
  };
}

export type ChannelAutoPostMessageText = {
  text: string | null;
  textFormat: MaxSendMessageOptions['textFormat'] | null;
  quickButtons?: ChannelQuickButtons;
};

export type ChannelAutoPostScanState = {
  latestTimestampMs: number;
  latestMessageIdsAtTimestamp: string[];
  idleStreak: number;
  nextScanAtMs: number;
};

export type ChannelAutoPostListedMessage = ChannelAutoPostMessageText & {
  messageId: string;
  linkType: string | null;
  timestampMs: number;
  senderId: string | null;
  existingDialogButtonKinds: InternalChannelDialogButtonIdentity['kind'][];
  existingDialogThreadId: string | null;
};

export type ChannelAutoPostAttachOutcome = 'attached' | 'skipped' | 'noop' | 'in_progress';

type ChannelAutoPostMessageTextSource = {
  text: string | null;
  markup: MaxTextMarkup[];
  textFormat: MaxSendMessageOptions['textFormat'] | null;
};

type ChannelAutoPostScanConfig = {
  scanIntervalMs: number;
  scanMaxChannels: number;
  idleBackoffMaxMs: number;
  repairSweepMs: number;
  rateLimitBackoffMs: number;
  throttleBackoffMaxMs: number;
  now?: () => number;
};

type ProcessChannelAutoPostListedMessagesParams = {
  chatId: string;
  messages: readonly Record<string, unknown>[];
  adminUserIds: readonly string[];
  settingsUpdatedAtMs: number;
  maxNewMessagesPerScan: number;
  quickButtonsEnabled?: boolean;
  attach: (message: ChannelAutoPostListedMessage) => Promise<ChannelAutoPostAttachOutcome>;
};

type ScanPosition = Pick<ChannelAutoPostListedMessage, 'messageId' | 'timestampMs'>;
type MessageScanProgress = {
  lastAttempt: ScanPosition | null;
  pending: Map<string, ScanPosition & { settled: boolean }>;
  overflowAt: ScanPosition | null;
};

const MAX_RETAINED_SCAN_MESSAGES = 32;

function compareScanPositions(left: ScanPosition, right: ScanPosition): number {
  return (
    left.timestampMs - right.timestampMs ||
    (left.messageId < right.messageId ? -1 : left.messageId > right.messageId ? 1 : 0)
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readLowerString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim().toLowerCase() : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readIdentifier(...values: unknown[]): string | null {
  for (const value of values) {
    const stringValue = readString(value);
    if (stringValue) {
      return stringValue;
    }
    if (typeof value === 'number' && Number.isSafeInteger(value)) {
      return String(value);
    }
  }

  return null;
}

function readInteger(value: unknown): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  return Number.isInteger(parsed) ? parsed : null;
}

function hasNativeChannelParentPost(message: Record<string, unknown> | null): boolean {
  const recipient = asRecord(message?.recipient);
  return readIdentifier(recipient?.post_id, recipient?.postId) !== null;
}

function normalizeMessageMarkup(value: unknown): MaxTextMarkup | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const row = value as Record<string, unknown>;
  const type = readLowerString(row.type);
  const from = readInteger(row.from);
  const length = readInteger(row.length);

  if (
    !type ||
    from === null ||
    length === null ||
    from < 0 ||
    length <= 0 ||
    !isMaxTextMarkupType(type)
  ) {
    return null;
  }

  return {
    from,
    length,
    type,
    url: readString(row.url),
    userLink: normalizeMaxUserMentionLink(row.user_link ?? row.userLink, row.user_id ?? row.userId),
  };
}

function extractMessageMarkup(message: Record<string, unknown> | null): MaxTextMarkup[] {
  const body = asRecord(message?.body);
  const candidates = [
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
  ];

  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) {
      continue;
    }

    const markup = candidate
      .map((item) => normalizeMessageMarkup(item))
      .filter((item): item is MaxTextMarkup => item !== null);
    if (markup.length > 0) {
      return markup;
    }
  }

  return [];
}

function extractMessageTextFormat(
  message: Record<string, unknown> | null,
): MaxSendMessageOptions['textFormat'] | null {
  const body = asRecord(message?.body);
  const format = readLowerString(body?.format ?? message?.format);
  return format === 'markdown' || format === 'html' ? format : null;
}

function extractMessageTextSource(
  message: Record<string, unknown> | null,
): ChannelAutoPostMessageTextSource {
  const body = asRecord(message?.body);
  const textCandidates = [body?.text, body?.caption, message?.text, message?.caption];
  const text =
    textCandidates.find(
      (candidate): candidate is string =>
        typeof candidate === 'string' && candidate.trim().length > 0,
    ) ?? null;

  return {
    text,
    markup: extractMessageMarkup(message),
    textFormat: extractMessageTextFormat(message),
  };
}

function extractForwardedMessageTextSource(
  message: Record<string, unknown> | null,
): ChannelAutoPostMessageTextSource {
  const link = asRecord(message?.link);
  if (readLowerString(link?.type) !== 'forward') {
    return { text: null, markup: [], textFormat: null };
  }

  return extractMessageTextSource(asRecord(link?.message));
}

function resolveMessageTextSource(
  message: Record<string, unknown> | null,
  fallbackText: string | null,
): ChannelAutoPostMessageTextSource {
  const direct = extractMessageTextSource(message);
  if (typeof direct.text === 'string' && direct.text.trim().length > 0) {
    return direct;
  }

  const linked = extractForwardedMessageTextSource(message);
  if (typeof linked.text === 'string' && linked.text.trim().length > 0) {
    return linked;
  }

  return {
    text: typeof fallbackText === 'string' && fallbackText.trim().length > 0 ? fallbackText : null,
    markup: [],
    textFormat: null,
  };
}

export function resolveChannelAutoPostMessageText(
  message: Record<string, unknown> | null,
  fallbackText: string | null,
  quickButtonsEnabled = false,
): ChannelAutoPostMessageText {
  const source = resolveMessageTextSource(message, fallbackText);
  if (typeof source.text !== 'string' || source.text.trim().length === 0) {
    return { text: null, textFormat: null };
  }

  if (quickButtonsEnabled && !source.textFormat) {
    const prepared = extractChannelQuickButtons(source.text, source.markup);
    if (prepared) {
      try {
        prepared.quickButtons.sourceAttachmentTypes = readStrictEditableAttachments(message).map(
          (attachment) => readLowerString(asRecord(attachment)?.type) ?? '',
        );
        return prepared;
      } catch {
        // FLAG: An incomplete media snapshot must never authorize consuming button templates.
      }
    }
  }

  if (source.markup.length > 0) {
    const html = renderMaxTextMarkupAsHtml(source.text, source.markup);
    if (html && html !== source.text) {
      return { text: html, textFormat: 'html' };
    }
  }

  return { text: source.text, textFormat: source.textFormat };
}

export function parseChannelAutoPostListedMessage(
  message: Record<string, unknown>,
  expectedChatId?: string,
  quickButtonsEnabled = false,
): ChannelAutoPostListedMessage | null {
  if (hasNativeChannelParentPost(message)) {
    return null;
  }

  const body = asRecord(message.body);
  const link = asRecord(message.link);
  const messageIdCandidate =
    body?.mid ??
    body?.seq ??
    message.message_id ??
    message.messageId ??
    message.mid ??
    message.seq ??
    message.id;
  const timestampCandidate = message.timestamp ?? message.created_at ?? message.createdAt;
  if (
    (typeof messageIdCandidate !== 'string' && typeof messageIdCandidate !== 'number') ||
    (typeof timestampCandidate !== 'number' && typeof timestampCandidate !== 'string')
  ) {
    return null;
  }

  const timestampMs =
    typeof timestampCandidate === 'number' ? timestampCandidate : Number(timestampCandidate);
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
    return null;
  }

  const messageText = resolveChannelAutoPostMessageText(message, null, quickButtonsEnabled);
  const sender = asRecord(message.sender);
  const senderId = readIdentifier(
    sender?.user_id,
    sender?.userId,
    sender?.id,
    message.sender_id,
    message.senderId,
  );
  const existingDialogButtons = extractChannelAutoPostDialogButtons(message, expectedChatId);

  return {
    messageId: String(messageIdCandidate),
    ...messageText,
    linkType: readLowerString(link?.type),
    timestampMs,
    senderId,
    existingDialogButtonKinds: existingDialogButtons.kinds,
    existingDialogThreadId: existingDialogButtons.threadId,
  };
}

export function extractChannelAutoPostDialogButtons(
  message: Record<string, unknown> | null,
  expectedChatId?: string,
): {
  kinds: InternalChannelDialogButtonIdentity['kind'][];
  threadId: string | null;
} {
  const identities = readInternalChannelDialogButtonIdentitiesFromMessage(message, expectedChatId);

  return {
    kinds: [...new Set(identities.map((identity) => identity.kind))],
    threadId:
      identities.find((identity) => identity.kind === 'comments' && identity.threadId)?.threadId ??
      identities.find((identity) => identity.threadId)?.threadId ??
      null,
  };
}

export function resolveChannelAutoPostEventTimestampMs(
  update: MaxUpdate,
  fallbackNowMs = Date.now(),
): number {
  const raw = asRecord(update.raw);
  const rawMessage = asRecord(raw?.message);
  const candidates: unknown[] = [
    update.message?.createdAt,
    rawMessage?.timestamp,
    rawMessage?.created_at,
    rawMessage?.createdAt,
    raw?.timestamp,
    raw?.created_at,
    raw?.createdAt,
  ];

  for (const candidate of candidates) {
    const timestampMs =
      typeof candidate === 'number'
        ? candidate
        : typeof candidate === 'string' && candidate.trim().length > 0
          ? Date.parse(candidate)
          : Number.NaN;
    if (Number.isFinite(timestampMs) && timestampMs > 0) {
      return Math.trunc(timestampMs);
    }
  }

  return fallbackNowMs;
}

export function isChannelAutoPostMessage(update: MaxUpdate): boolean {
  if (update.message?.postId !== undefined) {
    return false;
  }

  const raw = asRecord(update.raw);
  const message = raw ? (extractRawMessageNode(raw) ?? raw) : null;
  if (hasNativeChannelParentPost(message)) {
    return false;
  }

  if (update.message?.entityType === 'channel') {
    return true;
  }

  const recipient = asRecord(message?.recipient);
  const chat = asRecord(message?.chat);
  const candidates = [
    recipient?.chat_type,
    recipient?.chatType,
    chat?.chat_type,
    chat?.chatType,
    raw?.chat_type,
    raw?.chatType,
  ];

  return candidates.some((candidate) => readLowerString(candidate) === 'channel');
}

export function extractChannelAutoPostMessageLinkType(update: MaxUpdate): string | null {
  const raw = asRecord(update.raw);
  if (!raw) {
    return null;
  }

  const message = extractRawMessageNode(raw) ?? raw;
  return readLowerString(asRecord(message.link)?.type);
}

export function resolveChannelAutoPostButtonVisibility(settings: {
  postSuggestionsEnabled: boolean;
  commentsEnabled: boolean;
}): {
  includeCommentsButton: boolean;
  includeSuggestButton: boolean;
} {
  return {
    includeCommentsButton: settings.commentsEnabled,
    includeSuggestButton: settings.postSuggestionsEnabled,
  };
}

export function isChannelAutoPostKeyboardOnly(
  settings: Pick<PersistedChannelSettings, 'postSignatureEnabled' | 'postSignaturePresentation'>,
  quickButtons: ChannelQuickButtons | undefined,
): boolean {
  return (
    !quickButtons &&
    (!settings.postSignatureEnabled || settings.postSignaturePresentation === 'BUTTON')
  );
}

type ChannelDialogButtonBuilder = (
  type: 'comments' | 'suggest',
  text: string,
  suggestionEntryMode?: PersistedChannelSettings['postSuggestionsEntryMode'],
) => MaxMessageButton;

export function buildChannelAutoPostButtons(
  settings: Pick<
    PersistedChannelSettings,
    'postSuggestionsButtonText' | 'postSuggestionsEntryMode'
  >,
  visibility: ReturnType<typeof resolveChannelAutoPostButtonVisibility>,
  buildButton: ChannelDialogButtonBuilder,
  ctaButton: MaxMessageButton | null = null,
): MaxMessageButton[][] {
  const commentsButton = visibility.includeCommentsButton
    ? buildButton('comments', formatCommentsButtonText('💬 Комментарии', 0))
    : null;
  const suggestButton = visibility.includeSuggestButton
    ? buildButton(
        'suggest',
        settings.postSuggestionsButtonText.trim() || '📰 Предложить пост',
        settings.postSuggestionsEntryMode,
      )
    : null;
  return buildChannelPostActionRows({ commentsButton, suggestButton, ctaButton });
}

type ChannelPostSignaturePreparer = {
  preparePostText: (
    chatId: string,
    input: { text: string; textFormat?: MaxSendMessageOptions['textFormat'] },
    options: {
      entityType: 'channel';
      trafficClass: 'background';
      sourceTag: string;
      botId?: string;
    },
  ) => Promise<{
    text: string;
    textFormat?: MaxSendMessageOptions['textFormat'];
    signatureApplied: boolean;
  }>;
};

export async function prepareChannelAutoPostDecoration(params: {
  chatId: string;
  text: string | null;
  textFormat?: MaxSendMessageOptions['textFormat'] | null;
  postSignatureEnabled: boolean;
  signatureService?: ChannelPostSignaturePreparer;
  sourceTag: string;
  botId?: string;
}): Promise<{
  text: string | null;
  textFormat?: MaxSendMessageOptions['textFormat'];
  signatureApplied: boolean;
}> {
  if (!params.postSignatureEnabled) {
    return {
      text: params.text,
      textFormat: params.textFormat ?? undefined,
      signatureApplied: false,
    };
  }
  if (!params.signatureService) {
    throw new Error('Channel post signature service is unavailable.');
  }
  return params.signatureService.preparePostText(
    params.chatId,
    {
      text: params.text ?? '',
      ...(params.textFormat ? { textFormat: params.textFormat } : {}),
    },
    {
      entityType: 'channel',
      trafficClass: 'background',
      sourceTag: params.sourceTag,
      ...(params.botId ? { botId: params.botId } : {}),
    },
  );
}

export function buildChannelAutoPostTextMutationOptions(
  params: Parameters<typeof prepareChannelAutoPostDecoration>[0] & {
    quickButtons?: ChannelQuickButtons;
    preserveText: boolean;
    allowForwardCopy?: boolean;
    onSignatureApplied: (applied: boolean) => void;
  },
) {
  if (params.quickButtons) {
    return {
      expectedSourceText: params.quickButtons.sourceText,
      expectedSourceMarkup: params.quickButtons.sourceMarkup,
      expectedSourceAttachmentTypes: params.quickButtons.sourceAttachmentTypes,
      requireAllAttachmentsPreserved: true,
    };
  }
  return {
    prepareMessageText: async (message: Record<string, unknown> | null) => {
      if (!message) {
        throw new Error('Channel post snapshot is unavailable.');
      }
      if (!params.postSignatureEnabled || params.preserveText) {
        return null;
      }
      if (!params.allowForwardCopy && readLowerString(asRecord(message.link)?.type) === 'forward') {
        throw new BadRequestException('Cannot append a signature to a forwarded post in place.');
      }
      const current = resolveChannelAutoPostMessageText(message, null);
      // FLAG: Read both content and current settings inside the edit lock, including no-ops.
      const decorated = await prepareChannelAutoPostDecoration({
        ...params,
        text: current.text,
        textFormat: current.textFormat,
      });
      params.onSignatureApplied(decorated.signatureApplied);
      return decorated.signatureApplied ? decorated : null;
    },
  };
}

export async function resolveChannelAutoPostMutationBotRoute(params: {
  actionCandidateBotIds: readonly (string | null)[];
  requiredAuthorUserId?: string | null;
  resolveExecutableBotIdentity: (
    botId: string,
  ) => { botId: string; contactId: string | null } | null;
}): Promise<{ botId: string | null; requiredAuthorVerified: boolean }> {
  const requiredAuthorUserId = params.requiredAuthorUserId?.trim() || null;
  if (params.requiredAuthorUserId !== undefined && !requiredAuthorUserId) {
    return { botId: null, requiredAuthorVerified: false };
  }
  for (const botId of params.actionCandidateBotIds) {
    if (typeof botId !== 'string' || botId.trim().length === 0) {
      continue;
    }
    const candidateBotId = botId.trim();
    const identity = params.resolveExecutableBotIdentity(candidateBotId);
    const executableBotId = identity?.botId.trim() || null;
    if (!identity || executableBotId !== candidateBotId) {
      continue;
    }
    if (
      requiredAuthorUserId &&
      !isMatchingBotIdentity(requiredAuthorUserId, executableBotId, identity.contactId)
    ) {
      continue;
    }
    return { botId: candidateBotId, requiredAuthorVerified: true };
  }
  return { botId: null, requiredAuthorVerified: false };
}

function isMatchingBotIdentity(userId: string, botId: string, contactId: string | null): boolean {
  const senderVariants = buildStrictBotIdentityVariants(userId);
  return [botId, contactId].some((identity) => {
    if (!identity) {
      return false;
    }
    const identityVariants = buildStrictBotIdentityVariants(identity);
    return [...senderVariants].some((variant) => identityVariants.has(variant));
  });
}

function buildStrictBotIdentityVariants(value: string): Set<string> {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return new Set();
  }
  const variants = new Set([normalized]);
  if (normalized.startsWith('id') && normalized.length > 2) {
    variants.add(normalized.slice(2));
  }
  if (normalized.endsWith('_bot') && normalized.length > 4) {
    variants.add(normalized.slice(0, -4));
  }
  if (normalized.startsWith('id') && normalized.endsWith('_bot') && normalized.length > 6) {
    variants.add(normalized.slice(2, -4));
  }
  return variants;
}

export class ChannelAutoPostScanManager {
  private readonly now: () => number;
  private lastSelectedChatId: string | null = null;
  private readonly messageProgress = new Map<string, MessageScanProgress>();
  private throttleStreak = 0;
  private readonly scopedThrottles = new Map<string, { streak: number; untilMs: number }>();

  constructor(
    private readonly config: ChannelAutoPostScanConfig,
    readonly states = new Map<string, ChannelAutoPostScanState>(),
  ) {
    this.now = config.now ?? Date.now;
  }

  isDue(chatId: string): boolean {
    const current = this.states.get(chatId) ?? null;
    return (
      this.now() >=
      Math.max(current?.nextScanAtMs ?? 0, this.scopedThrottles.get(chatId)?.untilMs ?? 0)
    );
  }

  isDemandDue(chatId: string): boolean {
    // FLAG: A new post may bypass idle polling, never an exact source/token cooldown.
    // Role-wide backoff remains at the scheduler entry boundary.
    return this.now() >= (this.scopedThrottles.get(chatId)?.untilMs ?? 0);
  }

  selectBatch<T extends { chatId: string }>(
    channels: T[],
    maxChannels = this.config.scanMaxChannels,
  ): T[] {
    const normalizedMaxChannels = Math.max(1, Math.min(maxChannels, this.config.scanMaxChannels));
    const dueChannels = channels
      .filter((channel) => this.isDue(channel.chatId))
      .sort((left, right) =>
        left.chatId < right.chatId ? -1 : left.chatId > right.chatId ? 1 : 0,
      );
    if (dueChannels.length === 0) {
      return [];
    }
    if (dueChannels.length <= normalizedMaxChannels) {
      this.lastSelectedChatId = dueChannels.at(-1)!.chatId;
      return dueChannels;
    }

    // FLAG: An offset into a changing due subset can starve continuously due channels.
    const nextIndex = dueChannels.findIndex(
      (channel) => this.lastSelectedChatId === null || channel.chatId > this.lastSelectedChatId,
    );
    const startIndex = Math.max(0, nextIndex);
    const batch: T[] = [];
    for (let index = 0; index < normalizedMaxChannels; index += 1) {
      batch.push(dueChannels[(startIndex + index) % dueChannels.length]!);
    }
    this.lastSelectedChatId = batch.at(-1)!.chatId;
    return batch;
  }

  isMessageNew(
    scanState: ChannelAutoPostScanState | null,
    message: Pick<ChannelAutoPostListedMessage, 'messageId' | 'timestampMs'>,
  ): boolean {
    if (!scanState || scanState.latestTimestampMs <= 0) {
      return true;
    }
    if (message.timestampMs > scanState.latestTimestampMs) {
      return true;
    }
    if (message.timestampMs < scanState.latestTimestampMs) {
      return false;
    }
    return !scanState.latestMessageIdsAtTimestamp.includes(message.messageId);
  }

  advance(
    scanState: ChannelAutoPostScanState | null,
    message: Pick<ChannelAutoPostListedMessage, 'messageId' | 'timestampMs'>,
  ): ChannelAutoPostScanState {
    const current = scanState ?? this.createState();
    if (message.timestampMs > current.latestTimestampMs) {
      return {
        ...current,
        latestTimestampMs: message.timestampMs,
        latestMessageIdsAtTimestamp: [message.messageId],
      };
    }
    if (
      message.timestampMs < current.latestTimestampMs ||
      current.latestMessageIdsAtTimestamp.includes(message.messageId)
    ) {
      return current;
    }
    return {
      ...current,
      latestMessageIdsAtTimestamp: [
        ...current.latestMessageIdsAtTimestamp,
        message.messageId,
      ].slice(-10),
    };
  }

  schedule(
    scanState: ChannelAutoPostScanState | null,
    sawNewMessages: boolean,
  ): ChannelAutoPostScanState {
    const current = scanState ?? this.createState();
    const idleStreak = sawNewMessages ? 0 : current.idleStreak + 1;
    const nextDelayMs = sawNewMessages
      ? this.config.scanIntervalMs
      : Math.max(
          this.config.scanIntervalMs,
          Math.min(
            this.config.idleBackoffMaxMs,
            this.config.scanIntervalMs * 2 ** Math.min(idleStreak, 8),
          ),
        );
    return { ...current, idleStreak, nextScanAtMs: this.now() + nextDelayMs };
  }

  markWebhookSeen(chatId: string, _messageId: string, _timestampMs: number): void {
    const current = this.states.get(chatId) ?? this.createState();
    const repairAtMs = this.now() + this.config.repairSweepMs;
    // FLAG: A single webhook does not prove earlier posts were handled. Only scans advance
    // the contiguous cursor; sustained webhook traffic must not postpone repair indefinitely.
    this.states.set(chatId, {
      ...current,
      idleStreak: 0,
      nextScanAtMs:
        current.nextScanAtMs > 0 ? Math.min(current.nextScanAtMs, repairAtMs) : repairAtMs,
    });
  }

  resolveBatchSize(): number {
    if (this.throttleStreak <= 0) {
      return this.config.scanMaxChannels;
    }
    const divisor = 2 ** Math.min(this.throttleStreak, 3);
    return Math.max(1, Math.ceil(this.config.scanMaxChannels / divisor));
  }

  recordTransientThrottle(chatId: string, scoped = false, retryAfterMs = 0): number {
    const streak = scoped
      ? (this.scopedThrottles.get(chatId)?.streak ?? 0) + 1
      : this.throttleStreak + 1;
    if (!scoped) this.throttleStreak = streak;
    const backoffMs = Math.min(
      this.config.throttleBackoffMaxMs,
      this.config.rateLimitBackoffMs * 2 ** Math.min(Math.max(0, streak - 1), 3),
    );
    const delayMs = Math.max(backoffMs, Number.isFinite(retryAfterMs) ? retryAfterMs : 0);
    if (scoped)
      this.scopedThrottles.set(chatId, {
        streak,
        untilMs: Math.max(this.scopedThrottles.get(chatId)?.untilMs ?? 0, this.now() + delayMs),
      });
    const current = this.states.get(chatId) ?? this.createState();
    this.states.set(chatId, {
      ...current,
      idleStreak: Math.min(current.idleStreak + 1, 8),
      nextScanAtMs: Math.max(current.nextScanAtMs, this.now() + delayMs),
    });
    return delayMs;
  }

  resetScopedThrottle(chatId: string): void {
    this.scopedThrottles.delete(chatId);
  }

  resetThrottle(): void {
    this.throttleStreak = 0;
  }

  async processListedMessages(params: ProcessChannelAutoPostListedMessagesParams): Promise<void> {
    const normalizedMessages = params.messages
      .map((message) =>
        parseChannelAutoPostListedMessage(message, params.chatId, params.quickButtonsEnabled),
      )
      .filter((item): item is ChannelAutoPostListedMessage => item !== null)
      .sort(compareScanPositions);
    let scanState = this.states.get(params.chatId) ?? null;
    const messages = normalizedMessages.filter((message) => this.isMessageNew(scanState, message));
    const progress: MessageScanProgress = this.messageProgress.get(params.chatId) ?? {
      lastAttempt: null,
      pending: new Map(),
      overflowAt: null,
    };
    this.messageProgress.set(params.chatId, progress);

    // FLAG: Retain unvisited and unfinished positions even if MAX drops them from its latest
    // page. On overflow freeze the advisory completion cursor conservatively; bounded fair
    // attempts continue through the unchanged durable markers, source holds and final guards.
    for (const message of messages) {
      if (progress.pending.has(message.messageId)) continue;
      const position = { messageId: message.messageId, timestampMs: message.timestampMs };
      if (progress.pending.size < MAX_RETAINED_SCAN_MESSAGES) {
        progress.pending.set(message.messageId, {
          ...position,
          settled: message.timestampMs < params.settingsUpdatedAtMs,
        });
      } else if (!progress.overflowAt || compareScanPositions(position, progress.overflowAt) < 0) {
        progress.overflowAt = position;
      }
    }

    const advanceSettledPrefix = () => {
      for (const entry of [...progress.pending.values()].sort(compareScanPositions)) {
        if (
          !entry.settled ||
          (progress.overflowAt && compareScanPositions(entry, progress.overflowAt) >= 0)
        )
          break;
        scanState = this.advance(scanState, entry);
        this.states.set(params.chatId, scanState);
        progress.pending.delete(entry.messageId);
      }
    };
    advanceSettledPrefix();
    const candidates = messages.filter(
      (message) =>
        this.isMessageNew(scanState, message) &&
        message.timestampMs >= params.settingsUpdatedAtMs &&
        !progress.pending.get(message.messageId)?.settled,
    );
    const nextIndex = candidates.findIndex(
      (message) => !progress.lastAttempt || compareScanPositions(message, progress.lastAttempt) > 0,
    );
    const startIndex = Math.max(0, nextIndex);
    const attempts = Math.min(candidates.length, Math.max(1, params.maxNewMessagesPerScan));
    for (let index = 0; index < attempts; index += 1) {
      const message = candidates[(startIndex + index) % candidates.length]!;
      progress.lastAttempt = { messageId: message.messageId, timestampMs: message.timestampMs };
      // FLAG: This cursor allocates attempts, never execution authority. A thrown transport
      // error still escapes to the existing scoped/global cooldown; an unknown result stays pending.
      const outcome = await params.attach(message);
      if (outcome === 'attached' || outcome === 'skipped' || outcome === 'noop') {
        const entry = progress.pending.get(message.messageId);
        if (entry) entry.settled = true;
        advanceSettledPrefix();
      }
    }

    this.states.set(params.chatId, this.schedule(scanState, messages.length > 0));
  }

  private createState(): ChannelAutoPostScanState {
    return {
      latestTimestampMs: 0,
      latestMessageIdsAtTimestamp: [],
      idleStreak: 0,
      nextScanAtMs: 0,
    };
  }
}
