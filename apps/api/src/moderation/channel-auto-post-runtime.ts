import type { MaxUpdate } from '@maxim/contracts';

import { formatCommentsButtonText } from '../common/dialog-button-label.util';
import { renderMaxTextMarkupAsHtml, type MaxTextMarkup } from '../common/max-text-markup.util';
import type { MaxMessageButton, MaxSendMessageOptions } from '../max/max-client.service';
import type { ChannelSettings as PersistedChannelSettings } from '../prisma/prisma-client';
import { extractRawMessageNode } from './moderation-update-extractors';

export type ChannelAutoPostMessageText = {
  text: string | null;
  textFormat: MaxSendMessageOptions['textFormat'] | null;
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
  hasInlineKeyboard: boolean;
  senderId: string | null;
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
  processMessagesWithInlineKeyboard?: boolean;
  attach: (message: ChannelAutoPostListedMessage) => Promise<ChannelAutoPostAttachOutcome>;
};

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

function readInteger(value: unknown): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
  return Number.isInteger(parsed) ? parsed : null;
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
    type: type as MaxTextMarkup['type'],
    url: readString(row.url),
    userLink: readString(row.user_link ?? row.userLink),
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
  const textCandidates = [body?.text, message?.text, message?.caption];
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
): ChannelAutoPostMessageText {
  const source = resolveMessageTextSource(message, fallbackText);
  if (typeof source.text !== 'string' || source.text.trim().length === 0) {
    return { text: null, textFormat: null };
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
): ChannelAutoPostListedMessage | null {
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

  const attachments = Array.isArray(body?.attachments) ? body.attachments : [];
  const hasInlineKeyboard = attachments.some((attachment) => {
    const row = asRecord(attachment);
    return readLowerString(row?.type) === 'inline_keyboard';
  });
  const messageText = resolveChannelAutoPostMessageText(message, null);
  const senderId = asRecord(message.sender)?.user_id ?? message.sender_id;

  return {
    messageId: String(messageIdCandidate),
    text: messageText.text,
    textFormat: messageText.textFormat,
    linkType: readLowerString(link?.type),
    timestampMs,
    hasInlineKeyboard,
    senderId: typeof senderId === 'string' && senderId.trim() ? senderId.trim() : null,
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
  if (update.message?.entityType === 'channel') {
    return true;
  }

  const raw = asRecord(update.raw);
  const message = asRecord(raw?.message);
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
  autoPostButtonsMode: 'OFF' | 'COMMENTS' | 'SUGGEST' | 'BOTH' | null;
  postSuggestionsEnabled: boolean;
  commentsEnabled: boolean;
}): {
  includeCommentsButton: boolean;
  includeSuggestButton: boolean;
} {
  const mode = settings.autoPostButtonsMode ?? 'OFF';
  return {
    includeCommentsButton: (mode === 'COMMENTS' || mode === 'BOTH') && settings.commentsEnabled,
    includeSuggestButton:
      (mode === 'SUGGEST' || mode === 'BOTH') && settings.postSuggestionsEnabled,
  };
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
): MaxMessageButton[][] {
  const rows: MaxMessageButton[][] = [];
  if (visibility.includeCommentsButton) {
    rows.push([buildButton('comments', formatCommentsButtonText('💬 Комментарии', 0))]);
  }
  if (visibility.includeSuggestButton) {
    rows.push([
      buildButton(
        'suggest',
        settings.postSuggestionsButtonText.trim() || '📰 Предложить пост',
        settings.postSuggestionsEntryMode,
      ),
    ]);
  }
  return rows;
}

type ChannelPostSignaturePreparer = {
  preparePostText: (
    chatId: string,
    input: { text: string; textFormat?: MaxSendMessageOptions['textFormat'] },
    options: { entityType: 'channel'; trafficClass: 'background'; sourceTag: string },
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
    },
  );
}

export class ChannelAutoPostScanManager {
  private readonly now: () => number;
  private cursor = 0;
  private throttleStreak = 0;

  constructor(
    private readonly config: ChannelAutoPostScanConfig,
    readonly states = new Map<string, ChannelAutoPostScanState>(),
  ) {
    this.now = config.now ?? Date.now;
  }

  isDue(chatId: string): boolean {
    const current = this.states.get(chatId) ?? null;
    return !current || this.now() >= current.nextScanAtMs;
  }

  selectBatch<T extends { chatId: string }>(
    channels: T[],
    maxChannels = this.config.scanMaxChannels,
  ): T[] {
    const normalizedMaxChannels = Math.max(1, Math.min(maxChannels, this.config.scanMaxChannels));
    const dueChannels = channels.filter((channel) => this.isDue(channel.chatId));
    if (dueChannels.length === 0) {
      return [];
    }
    if (dueChannels.length <= normalizedMaxChannels) {
      this.cursor = 0;
      return dueChannels;
    }

    const startIndex = this.cursor % dueChannels.length;
    const batch: T[] = [];
    for (let index = 0; index < normalizedMaxChannels; index += 1) {
      batch.push(dueChannels[(startIndex + index) % dueChannels.length]!);
    }
    this.cursor = (startIndex + batch.length) % dueChannels.length;
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

  markWebhookSeen(chatId: string, messageId: string, timestampMs: number): void {
    const current = this.states.get(chatId) ?? this.createState();
    const nextState =
      Number.isFinite(timestampMs) && timestampMs > 0
        ? this.advance(current, { messageId, timestampMs })
        : current;
    this.states.set(chatId, {
      ...nextState,
      idleStreak: 0,
      nextScanAtMs: Math.max(nextState.nextScanAtMs, this.now() + this.config.repairSweepMs),
    });
  }

  resolveBatchSize(): number {
    if (this.throttleStreak <= 0) {
      return this.config.scanMaxChannels;
    }
    const divisor = 2 ** Math.min(this.throttleStreak, 3);
    return Math.max(1, Math.ceil(this.config.scanMaxChannels / divisor));
  }

  recordTransientThrottle(chatId: string): number {
    this.throttleStreak += 1;
    const backoffMs = Math.min(
      this.config.throttleBackoffMaxMs,
      this.config.rateLimitBackoffMs * 2 ** Math.min(Math.max(0, this.throttleStreak - 1), 3),
    );
    const current = this.states.get(chatId) ?? this.createState();
    this.states.set(chatId, {
      ...current,
      idleStreak: Math.min(current.idleStreak + 1, 8),
      nextScanAtMs: Math.max(current.nextScanAtMs, this.now() + backoffMs),
    });
    return backoffMs;
  }

  resetThrottle(): void {
    this.throttleStreak = 0;
  }

  async processListedMessages(params: ProcessChannelAutoPostListedMessagesParams): Promise<void> {
    const normalizedMessages = params.messages
      .map((message) => parseChannelAutoPostListedMessage(message))
      .filter((item): item is ChannelAutoPostListedMessage => item !== null)
      .sort(
        (left, right) =>
          left.timestampMs - right.timestampMs || left.messageId.localeCompare(right.messageId),
      );
    let scanState = this.states.get(params.chatId) ?? null;
    let sawNewMessages = false;
    let autoAttachAttempts = 0;

    for (const normalized of normalizedMessages) {
      if (!this.isMessageNew(scanState, normalized)) {
        continue;
      }
      sawNewMessages = true;
      if (
        (normalized.senderId && !params.adminUserIds.includes(normalized.senderId)) ||
        normalized.timestampMs < params.settingsUpdatedAtMs ||
        (normalized.hasInlineKeyboard && !params.processMessagesWithInlineKeyboard)
      ) {
        scanState = this.advance(scanState, normalized);
        this.states.set(params.chatId, scanState);
        continue;
      }
      if (autoAttachAttempts >= Math.max(1, params.maxNewMessagesPerScan)) {
        break;
      }

      const outcome = await params.attach(normalized);
      autoAttachAttempts += 1;
      if (outcome === 'in_progress') {
        break;
      }
      scanState = this.advance(scanState, normalized);
      this.states.set(params.chatId, scanState);
    }

    this.states.set(params.chatId, this.schedule(scanState, sawNewMessages));
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
