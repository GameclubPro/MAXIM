import { BadRequestException } from '@nestjs/common';
import {
  ADMIN_BAN_ALL_COMMAND_NAME_DEFAULT,
  ADMIN_BAN_COMMAND_NAME_DEFAULT,
  ADMIN_MUTE_COMMAND_NAME_DEFAULT,
  ADMIN_OPEN_CHAT_COMMAND_NAME_DEFAULT,
  ADMIN_PERMANENT_MUTE_COMMAND_NAME_DEFAULT,
  ADMIN_RULES_COMMAND_NAME_DEFAULT,
  ADMIN_SILENCE_COMMAND_NAME_DEFAULT,
  type MaxUpdate,
} from '@maxim/contracts';
import type { ChatSettings } from '../prisma/prisma-client';
import { extractRawMessageNode } from './moderation-update-extractors';
import {
  DEFAULT_MUTE_DURATION_HOURS,
  MAX_ACTIVE_MUTE_DURATION_HOURS,
  MAX_FORWARD_SCAN_DEPTH,
  PERMANENT_MUTE_COMMAND_DURATION_HOURS,
  type AdminForwardedModerationCommand,
  type ForwardedModerationTarget,
  type ForwardedRulesSource,
} from './moderation.service.support';

export type AdminForwardedCommandSettings = Partial<
  Pick<
    ChatSettings,
    | 'adminBanCommandName'
    | 'adminBanAllCommandName'
    | 'adminMuteCommandName'
    | 'adminPermanentMuteCommandName'
    | 'adminRulesCommandName'
    | 'adminSilenceCommandName'
    | 'adminOpenChatCommandName'
  >
>;

export type PrivateForwardedModerationCommand =
  | {
      action: 'BAN';
    }
  | {
      action: 'MUTE';
      muteDurationHours?: number;
      mutePermanent?: true;
    }
  | {
      action: 'RULES';
    };

export type PrivateForwardedModerationTarget = Omit<ForwardedModerationTarget, 'messageId'>;

export type ForwardedExtractionOptions = {
  messageNodeMode?: 'raw-fallback' | 'incoming-message';
  readPrivateForwardedFields?: boolean;
  skipPrivateDirectChats?: boolean;
};

export function parseAdminForwardedModerationCommand(
  text: string,
  settings?: AdminForwardedCommandSettings,
): AdminForwardedModerationCommand | null {
  const normalized = readAdminCommandText(text);
  if (!normalized) {
    return null;
  }
  const normalizedLower = normalized.toLowerCase();
  const banCommandName = getAdminCommandName(
    settings?.adminBanCommandName,
    ADMIN_BAN_COMMAND_NAME_DEFAULT,
  );
  const banAllCommandName = getAdminCommandName(
    settings?.adminBanAllCommandName,
    ADMIN_BAN_ALL_COMMAND_NAME_DEFAULT,
  );
  const muteCommandName = getAdminCommandName(
    settings?.adminMuteCommandName,
    ADMIN_MUTE_COMMAND_NAME_DEFAULT,
  );
  const permanentMuteCommandName = getAdminCommandName(
    settings?.adminPermanentMuteCommandName,
    ADMIN_PERMANENT_MUTE_COMMAND_NAME_DEFAULT,
  );
  const rulesCommandName = getAdminCommandName(
    settings?.adminRulesCommandName,
    ADMIN_RULES_COMMAND_NAME_DEFAULT,
  );
  const silenceCommandName = getAdminCommandName(
    settings?.adminSilenceCommandName,
    ADMIN_SILENCE_COMMAND_NAME_DEFAULT,
  );
  const openChatCommandName = getAdminCommandName(
    settings?.adminOpenChatCommandName,
    ADMIN_OPEN_CHAT_COMMAND_NAME_DEFAULT,
  );

  const muteCommandMatch = matchAdminCommandNameWithOptionalDuration(
    normalizedLower,
    muteCommandName,
  );
  const silenceCommandMatch = matchAdminCommandNameWithOptionalDuration(
    normalizedLower,
    silenceCommandName,
  );

  if (/^(?:супер[\s-]+бан|super[\s-]+ban)[.!]?$/u.test(normalizedLower)) {
    return {
      action: 'SUPER_BAN',
    };
  }

  if (matchesAdminCommandName(normalizedLower, permanentMuteCommandName)) {
    return {
      action: 'MUTE',
      mutePermanent: true,
    };
  }

  const banDurationMatch = matchAdminCommandNameWithOptionalDuration(
    normalizedLower,
    banCommandName,
  );
  if (banDurationMatch && banDurationMatch.durationText !== null) {
    throw new BadRequestException(
      `Команда \`${banCommandName}\` теперь делает только постоянный системный бан. Используйте просто \`${banCommandName}\`.`,
    );
  }

  const banAllDurationMatch = matchAdminCommandNameWithOptionalDuration(
    normalizedLower,
    banAllCommandName,
  );
  if (banAllDurationMatch && banAllDurationMatch.durationText !== null) {
    throw new BadRequestException(
      `Команда \`${banAllCommandName}\` теперь делает только постоянный системный бан во всех чатах админа. Используйте просто \`${banAllCommandName}\`.`,
    );
  }

  if (matchesAdminCommandName(normalizedLower, rulesCommandName)) {
    return {
      action: 'RULES',
    };
  }

  if (matchesAdminCommandName(normalizedLower, openChatCommandName)) {
    return {
      action: 'OPEN_CHAT',
    };
  }

  if (silenceCommandMatch?.durationText === null) {
    return {
      action: 'SILENCE',
    };
  }

  if (silenceCommandMatch) {
    const silenceDurationHours = Number.parseInt(silenceCommandMatch.durationText, 10);
    if (
      !Number.isInteger(silenceDurationHours) ||
      silenceDurationHours < 1 ||
      silenceDurationHours > MAX_ACTIVE_MUTE_DURATION_HOURS
    ) {
      throw new BadRequestException(
        `Длительность тишины должна быть от 1 до ${MAX_ACTIVE_MUTE_DURATION_HOURS} часов.`,
      );
    }

    return {
      action: 'SILENCE',
      silenceDurationHours,
    };
  }

  if (matchesAdminCommandName(normalizedLower, banAllCommandName)) {
    return {
      action: 'BAN',
      fanoutAllChats: true,
    };
  }

  if (matchesAdminCommandName(normalizedLower, banCommandName)) {
    return {
      action: 'BAN',
    };
  }

  if (muteCommandMatch?.durationText === null) {
    return {
      action: 'MUTE',
      muteDurationHours: DEFAULT_MUTE_DURATION_HOURS,
    };
  }

  if (!muteCommandMatch) {
    return null;
  }

  const muteDurationHours = Number.parseInt(muteCommandMatch.durationText, 10);
  if (
    !Number.isInteger(muteDurationHours) ||
    muteDurationHours < 1 ||
    muteDurationHours > MAX_ACTIVE_MUTE_DURATION_HOURS
  ) {
    throw new BadRequestException(
      `Длительность мута должна быть от 1 до ${MAX_ACTIVE_MUTE_DURATION_HOURS} часов.`,
    );
  }

  return {
    action: 'MUTE',
    muteDurationHours,
  };
}

export function parsePrivateForwardedModerationCommand(
  text: string,
): PrivateForwardedModerationCommand | null {
  const normalized = readLowerString(text);
  if (!normalized) {
    return null;
  }

  if (/^(?:бан|ban)[.!]?$/u.test(normalized)) {
    return {
      action: 'BAN',
    };
  }

  if (
    /^(?:бан|ban)\s+\d{1,3}(?:\s*(?:ч|час|часа|часов|h|hr|hrs|hour|hours))?[.!]?$/u.test(
      normalized,
    )
  ) {
    throw new BadRequestException(
      'Команда «бан» теперь делает только постоянный системный бан. Используйте просто «бан».',
    );
  }

  if (/^(?:правило|правила|rule|rules)[.!]?$/u.test(normalized)) {
    return {
      action: 'RULES',
    };
  }

  if (/^(?:мут|мьют|мью|mute)[.!]?$/u.test(normalized)) {
    return {
      action: 'MUTE',
      muteDurationHours: DEFAULT_MUTE_DURATION_HOURS,
    };
  }

  const muteDurationMatch = normalized.match(
    /^(?:мут|мьют|мью|mute)\s+(\d{1,3})(?:\s*(?:ч|час|часа|часов|h|hr|hrs|hour|hours))?[.!]?$/u,
  );
  if (!muteDurationMatch) {
    return null;
  }

  const muteDurationHours = Number.parseInt(muteDurationMatch[1], 10);
  if (muteDurationHours === PERMANENT_MUTE_COMMAND_DURATION_HOURS) {
    return {
      action: 'MUTE',
      mutePermanent: true,
    };
  }

  if (
    !Number.isInteger(muteDurationHours) ||
    muteDurationHours < 1 ||
    muteDurationHours > MAX_ACTIVE_MUTE_DURATION_HOURS
  ) {
    throw new BadRequestException(
      `Длительность мута должна быть от 1 до ${MAX_ACTIVE_MUTE_DURATION_HOURS} часов.`,
    );
  }

  return {
    action: 'MUTE',
    muteDurationHours,
  };
}

export function getAdminCommandName(
  commandName: string | null | undefined,
  fallback: string,
): string {
  return readLowerString(commandName)?.replace(/\s+/g, ' ') ?? fallback.toLowerCase();
}

export function extractDirectIncomingMessageText(update: MaxUpdate): string {
  const normalizedText = readString(update.message?.text);
  if (normalizedText) {
    return normalizedText;
  }

  const raw = asRecord(update.raw);
  if (!raw) {
    return '';
  }

  const messageNode = extractRawMessageNode(raw) ?? raw;
  const body = asRecord(messageNode.body);
  const content = asRecord(messageNode.content);
  const payload = asRecord(messageNode.payload);
  const nestedMessage = asRecord(messageNode.message);
  const candidates = [
    messageNode.text,
    messageNode.caption,
    messageNode.message_text,
    messageNode.messageText,
    body?.text,
    body?.plain,
    content?.text,
    content?.caption,
    payload?.text,
    nestedMessage?.text,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return '';
}

export function extractForwardedModerationTargets(
  update: MaxUpdate,
  fallbackReplyChatId?: string | null,
  options: ForwardedExtractionOptions = {},
): ForwardedModerationTarget[] {
  const messageNode = getForwardedCommandMessageNode(update, options);
  if (!messageNode) {
    return [];
  }

  const body = asRecord(messageNode.body);
  const content = asRecord(messageNode.content);
  const payload = asRecord(messageNode.payload);
  const nestedMessage = asRecord(messageNode.message);
  const candidates = [
    messageNode.link,
    messageNode.forward,
    messageNode.forwarded_message,
    messageNode.forwardedMessage,
    body?.link,
    body?.forward,
    body?.forwarded_message,
    body?.forwardedMessage,
    content?.link,
    content?.forward,
    content?.forwarded_message,
    content?.forwardedMessage,
    payload?.link,
    payload?.forward,
    payload?.forwarded_message,
    payload?.forwardedMessage,
    nestedMessage?.link,
    nestedMessage?.forward,
    nestedMessage?.forwarded_message,
    nestedMessage?.forwardedMessage,
  ];

  const targets: ForwardedModerationTarget[] = [];
  for (const candidate of candidates) {
    collectForwardedModerationTargets(candidate, targets, 0, fallbackReplyChatId, options);
  }

  return dedupeForwardedModerationTargets(targets);
}

export function extractPrivateForwardedModerationTargets(
  update: MaxUpdate,
): PrivateForwardedModerationTarget[] {
  return extractForwardedModerationTargets(update, null, {
    messageNodeMode: 'incoming-message',
    readPrivateForwardedFields: true,
    skipPrivateDirectChats: true,
  }).map(({ messageId: _messageId, ...target }) => target);
}

export function dedupeForwardedModerationTargets(
  targets: ForwardedModerationTarget[],
): ForwardedModerationTarget[] {
  const unique = new Map<string, ForwardedModerationTarget>();
  for (const target of targets) {
    const key = `${target.chatId}:${target.userId}`;
    const existing = unique.get(key);
    if (!existing) {
      unique.set(key, target);
      continue;
    }

    if (!existing.messageId && target.messageId) {
      unique.set(key, {
        ...existing,
        messageId: target.messageId,
      });
    }
  }

  return [...unique.values()];
}

export function dedupePrivateForwardedModerationTargets<
  T extends { chatId: string; userId: string },
>(targets: readonly T[]): T[] {
  const unique = new Map<string, T>();
  for (const target of targets) {
    const key = `${target.chatId}:${target.userId}`;
    if (!unique.has(key)) {
      unique.set(key, target);
    }
  }

  return [...unique.values()];
}

export function extractForwardedRulesSources(
  update: MaxUpdate,
  options: ForwardedExtractionOptions = {},
): ForwardedRulesSource[] {
  const messageNode = getForwardedCommandMessageNode(update, options);
  if (!messageNode) {
    return [];
  }

  const body = asRecord(messageNode.body);
  const content = asRecord(messageNode.content);
  const payload = asRecord(messageNode.payload);
  const nestedMessage = asRecord(messageNode.message);
  const candidates = [
    messageNode.link,
    messageNode.forward,
    messageNode.forwarded_message,
    messageNode.forwardedMessage,
    body?.link,
    body?.forward,
    body?.forwarded_message,
    body?.forwardedMessage,
    content?.link,
    content?.forward,
    content?.forwarded_message,
    content?.forwardedMessage,
    payload?.link,
    payload?.forward,
    payload?.forwarded_message,
    payload?.forwardedMessage,
    nestedMessage?.link,
    nestedMessage?.forward,
    nestedMessage?.forwarded_message,
    nestedMessage?.forwardedMessage,
  ];

  const sources: ForwardedRulesSource[] = [];
  for (const candidate of candidates) {
    collectForwardedRulesSources(candidate, sources, 0, options);
  }

  return dedupeForwardedRulesSources(sources);
}

export function extractPrivateForwardedRulesSources(update: MaxUpdate): ForwardedRulesSource[] {
  return extractForwardedRulesSources(update, {
    messageNodeMode: 'incoming-message',
    readPrivateForwardedFields: true,
    skipPrivateDirectChats: true,
  });
}

export function dedupeForwardedRulesSources(sources: ForwardedRulesSource[]): ForwardedRulesSource[] {
  const unique = new Map<string, ForwardedRulesSource>();
  for (const source of sources) {
    const key = `${source.chatId}:${source.messageId ?? source.url ?? ''}`;
    if (!unique.has(key)) {
      unique.set(key, source);
    }
  }

  return [...unique.values()];
}

export const dedupePrivateForwardedRulesSources = dedupeForwardedRulesSources;

function matchesAdminCommandName(normalizedText: string, commandName: string): boolean {
  if (normalizedText === commandName) {
    return true;
  }

  if (/[.!]$/u.test(commandName)) {
    return false;
  }

  return normalizedText === `${commandName}!` || normalizedText === `${commandName}.`;
}

function matchAdminCommandNameWithOptionalDuration(
  normalizedText: string,
  commandName: string,
): { commandName: string; durationText: string | null } | null {
  if (matchesAdminCommandName(normalizedText, commandName)) {
    return { commandName, durationText: null };
  }

  if (!normalizedText.startsWith(`${commandName} `)) {
    return null;
  }

  const suffix = normalizedText.slice(commandName.length).trim();
  const durationMatch = suffix.match(
    /^(\d{1,3})(?:\s*(?:ч|час|часа|часов|h|hr|hrs|hour|hours))?[.!]?$/u,
  );
  if (durationMatch) {
    return { commandName, durationText: durationMatch[1] };
  }

  return null;
}

function readAdminCommandText(value: unknown): string | null {
  return readString(value)?.replace(/\s+/g, ' ') ?? null;
}

function getForwardedCommandMessageNode(
  update: MaxUpdate,
  options: ForwardedExtractionOptions,
): Record<string, unknown> | null {
  const raw = asRecord(update.raw);
  if (!raw) {
    return null;
  }

  if (options.messageNodeMode === 'incoming-message') {
    const data = asRecord(raw.data);
    const event = asRecord(raw.event);
    return (
      asRecord(raw.message) ??
      (data ? asRecord(data.message) : null) ??
      (event ? asRecord(event.message) : null) ??
      null
    );
  }

  return extractRawMessageNode(raw) ?? raw;
}

function collectForwardedModerationTargets(
  node: unknown,
  acc: ForwardedModerationTarget[],
  depth = 0,
  fallbackReplyChatId?: string | null,
  options: ForwardedExtractionOptions = {},
): void {
  if (depth > MAX_FORWARD_SCAN_DEPTH || node === null || node === undefined) {
    return;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      collectForwardedModerationTargets(item, acc, depth + 1, fallbackReplyChatId, options);
    }
    return;
  }

  const row = asRecord(node);
  if (!row) {
    return;
  }

  const target = parseForwardedModerationTarget(row, fallbackReplyChatId, options);
  if (target) {
    acc.push(target);
  }

  for (const value of Object.values(row)) {
    if (value && (typeof value === 'object' || Array.isArray(value))) {
      collectForwardedModerationTargets(value, acc, depth + 1, fallbackReplyChatId, options);
    }
  }
}

function parseForwardedModerationTarget(
  row: Record<string, unknown>,
  fallbackReplyChatId?: string | null,
  options: ForwardedExtractionOptions = {},
): ForwardedModerationTarget | null {
  const chatId =
    readChatIdFromEntity(row) ?? (isReplyLinkedMessage(row) ? readString(fallbackReplyChatId) : null);
  const userId = readUserIdFromForwardedNode(row, options);
  if (!chatId || !userId || shouldSkipForwardedChat(chatId, options)) {
    return null;
  }

  return {
    chatId,
    chatTitle: readChatTitleFromEntity(row),
    userId,
    senderName: readSenderNameFromForwardedNode(row),
    messageId: readMessageIdFromForwardedNode(row),
  };
}

function isReplyLinkedMessage(node: Record<string, unknown>): boolean {
  const type = readLowerString(node.type ?? node.link_type ?? node.linkType);
  return type === 'reply';
}

function collectForwardedRulesSources(
  node: unknown,
  acc: ForwardedRulesSource[],
  depth = 0,
  options: ForwardedExtractionOptions = {},
): void {
  if (depth > MAX_FORWARD_SCAN_DEPTH || node === null || node === undefined) {
    return;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      collectForwardedRulesSources(item, acc, depth + 1, options);
    }
    return;
  }

  const row = asRecord(node);
  if (!row) {
    return;
  }

  const source = parseForwardedRulesSource(row, options);
  if (source) {
    acc.push(source);
  }

  for (const value of Object.values(row)) {
    if (value && (typeof value === 'object' || Array.isArray(value))) {
      collectForwardedRulesSources(value, acc, depth + 1, options);
    }
  }
}

function parseForwardedRulesSource(
  row: Record<string, unknown>,
  options: ForwardedExtractionOptions = {},
): ForwardedRulesSource | null {
  const chatId = readChatIdFromEntity(row);
  if (!chatId || shouldSkipForwardedChat(chatId, options)) {
    return null;
  }

  const messageId = readMessageIdFromForwardedNode(row);
  const url = readMessageUrlFromForwardedNode(row);
  if (!messageId && !url) {
    return null;
  }

  return {
    chatId,
    chatTitle: readChatTitleFromEntity(row),
    messageId,
    url,
    text: readForwardedMessageText(row, options),
  };
}

function readUserIdFromForwardedNode(
  node: Record<string, unknown>,
  options: ForwardedExtractionOptions,
): string | null {
  if (options.readPrivateForwardedFields) {
    const directUserId = readPrivateUserIdFromEntity(node);
    if (directUserId) {
      return directUserId;
    }
  }

  const sender = asRecord(node.sender);
  const from = asRecord(node.from);
  const user = asRecord(node.user);
  const actor = asRecord(node.actor);
  const payloadSender = asRecord(asRecord(node.payload)?.sender);
  const candidates = [sender, from, user, actor, payloadSender].filter(
    (item): item is Record<string, unknown> => item !== null,
  );

  for (const candidate of candidates) {
    const userId = options.readPrivateForwardedFields
      ? readPrivateUserIdFromEntity(candidate)
      : readUserIdFromEntity(candidate);
    if (userId) {
      return userId;
    }
  }

  return options.readPrivateForwardedFields
    ? readPrivateUserIdFromEntity(node)
    : readUserIdFromEntity(node);
}

function readSenderNameFromForwardedNode(node: Record<string, unknown>): string | null {
  const sender = asRecord(node.sender);
  const from = asRecord(node.from);
  const user = asRecord(node.user);
  const actor = asRecord(node.actor);
  const payloadSender = asRecord(asRecord(node.payload)?.sender);
  const candidates = [sender, from, user, actor, payloadSender, node].filter(
    (item): item is Record<string, unknown> => item !== null,
  );

  for (const candidate of candidates) {
    const displayName = readDisplayNameFromEntity(candidate);
    if (displayName) {
      return displayName;
    }
  }

  return null;
}

function readChatIdFromEntity(node: Record<string, unknown>): string | null {
  const chat = asRecord(node.chat);
  const recipient = asRecord(node.recipient);
  const conversation = asRecord(node.conversation);
  const payloadChat = asRecord(asRecord(node.payload)?.chat);
  const candidates = [
    node.chatId,
    node.chat_id,
    chat?.chatId,
    chat?.chat_id,
    chat?.id,
    recipient?.chatId,
    recipient?.chat_id,
    recipient?.id,
    conversation?.chatId,
    conversation?.chat_id,
    conversation?.id,
    payloadChat?.chatId,
    payloadChat?.chat_id,
    payloadChat?.id,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' || typeof candidate === 'number') {
      const normalized = String(candidate).trim();
      if (normalized.length > 0) {
        return normalized;
      }
    }
  }

  return null;
}

function readChatTitleFromEntity(node: Record<string, unknown>): string | null {
  const chat = asRecord(node.chat);
  const recipient = asRecord(node.recipient);
  const candidates = [
    node.chatTitle,
    node.chat_title,
    node.chatName,
    node.chat_name,
    chat?.title,
    chat?.name,
    recipient?.title,
    recipient?.chat_title,
    recipient?.chatTitle,
    recipient?.name,
    recipient?.display_name,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return null;
}

function readMessageIdFromForwardedNode(node: Record<string, unknown>): string | null {
  const body = asRecord(node.body);
  const content = asRecord(node.content);
  const payload = asRecord(node.payload);
  const nestedMessage = asRecord(node.message);
  const candidates = [
    body?.mid,
    body?.message_id,
    body?.messageId,
    content?.mid,
    content?.message_id,
    content?.messageId,
    payload?.mid,
    payload?.message_id,
    payload?.messageId,
    nestedMessage?.mid,
    nestedMessage?.message_id,
    nestedMessage?.messageId,
    node.message_id,
    node.messageId,
    node.mid,
    node.id,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' || typeof candidate === 'number') {
      const normalized = String(candidate).trim();
      if (normalized.length > 0) {
        return normalized;
      }
    }
  }

  return null;
}

function readMessageUrlFromForwardedNode(node: Record<string, unknown>): string | null {
  const body = asRecord(node.body);
  const content = asRecord(node.content);
  const payload = asRecord(node.payload);
  const nestedMessage = asRecord(node.message);
  const candidates = [
    node.url,
    node.message_url,
    node.messageUrl,
    body?.url,
    body?.message_url,
    body?.messageUrl,
    content?.url,
    content?.message_url,
    content?.messageUrl,
    payload?.url,
    payload?.message_url,
    payload?.messageUrl,
    nestedMessage?.url,
    nestedMessage?.message_url,
    nestedMessage?.messageUrl,
  ];

  for (const candidate of candidates) {
    const normalized = readString(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function readForwardedMessageText(
  node: Record<string, unknown>,
  options: ForwardedExtractionOptions,
): string | null {
  const body = asRecord(node.body);
  const content = asRecord(node.content);
  const payload = asRecord(node.payload);
  const nestedMessage = asRecord(node.message);
  const candidates = [
    node.text,
    node.caption,
    node.message_text,
    node.messageText,
    body?.text,
    body?.plain,
    content?.text,
    content?.caption,
    payload?.text,
    nestedMessage?.text,
  ];
  if (options.readPrivateForwardedFields) {
    candidates.splice(6, 0, body?.caption);
    candidates.push(payload?.caption, nestedMessage?.caption);
  }

  for (const candidate of candidates) {
    const normalized = readString(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function readDisplayNameFromEntity(node: Record<string, unknown>): string | null {
  const directCandidates = [
    node.display_name,
    node.displayName,
    node.full_name,
    node.fullName,
    node.name,
    node.nickname,
  ];

  for (const candidate of directCandidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  const firstName = readString(
    node.first_name ?? node.firstName ?? node.given_name ?? node.givenName,
  );
  const lastName = readString(node.last_name ?? node.lastName ?? node.family_name ?? node.familyName);
  const fullName = [firstName, lastName].filter(Boolean).join(' ').trim();
  if (fullName.length > 0) {
    return fullName;
  }

  const username = readString(node.username);
  if (username) {
    return username;
  }

  return null;
}

function readExplicitUserIdFromEntity(node: Record<string, unknown>): string | null {
  const explicitCandidates = [node.user_id, node.userId, node.member_id, node.memberId];
  for (const value of explicitCandidates) {
    if (typeof value === 'string' || typeof value === 'number') {
      return String(value);
    }
  }

  return null;
}

function readPrivateUserIdFromEntity(node: Record<string, unknown>): string | null {
  const explicit = readExplicitUserIdFromEntity(node);
  if (explicit) {
    return explicit;
  }

  const senderIdCandidates = [node.sender_id, node.senderId];
  for (const value of senderIdCandidates) {
    if (typeof value === 'string' || typeof value === 'number') {
      return String(value);
    }
  }

  const idCandidate = node.id;
  if (typeof idCandidate === 'string' || typeof idCandidate === 'number') {
    return String(idCandidate);
  }

  return null;
}

function readUserIdFromEntity(node: Record<string, unknown>): string | null {
  const explicit = readExplicitUserIdFromEntity(node);
  if (explicit) {
    return explicit;
  }

  const idCandidate = node.id;
  if (
    (typeof idCandidate === 'string' || typeof idCandidate === 'number') &&
    looksLikeUserEntity(node)
  ) {
    return String(idCandidate);
  }

  return null;
}

function shouldSkipForwardedChat(chatId: string, options: ForwardedExtractionOptions): boolean {
  return Boolean(options.skipPrivateDirectChats && isPrivateDirectChat(chatId));
}

function isPrivateDirectChat(chatId: string): boolean {
  return /^[1-9]\d*$/u.test(chatId);
}

function looksLikeUserEntity(node: Record<string, unknown>): boolean {
  return (
    node.type !== undefined ||
    node.kind !== undefined ||
    node.username !== undefined ||
    node.display_name !== undefined ||
    node.displayName !== undefined ||
    node.name !== undefined ||
    node.is_bot !== undefined ||
    node.isBot !== undefined ||
    node.bot !== undefined
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
