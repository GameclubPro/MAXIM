import type {
  MaxCallbackButton,
  MaxMessageButton,
  MaxSendMessageOptions,
} from '../max/max-client.service';

const MODERATION_RELEASE_CALLBACK_PREFIX = 'moderation-release:v1';
const MAX_MODERATION_RELEASE_CHAT_ID_LENGTH = 128;
const MAX_MODERATION_RELEASE_USER_ID_LENGTH = 128;
const MAX_MODERATION_RELEASE_CALLBACK_PAYLOAD_LENGTH = 512;

export type ModerationReleaseAction = 'UNBAN' | 'UNMUTE';

export type ModerationReleaseCallback = {
  action: ModerationReleaseAction;
  chatId: string;
  targetUserId: string;
};

export function buildModerationReleaseCallbackPayload(
  action: ModerationReleaseAction,
  chatId: string,
  targetUserId: string,
): string {
  const normalizedChatId = normalizeModerationReleaseIdentifier(
    chatId,
    MAX_MODERATION_RELEASE_CHAT_ID_LENGTH,
  );
  const normalizedUserId = normalizeModerationReleaseUserId(targetUserId);
  if (!normalizedChatId || !normalizedUserId) {
    throw new Error('Moderation release chat or target user ID is invalid');
  }

  const payload = `${MODERATION_RELEASE_CALLBACK_PREFIX}:${action.toLowerCase()}:${encodeIdentifier(
    normalizedChatId,
  )}:${encodeIdentifier(normalizedUserId)}`;
  if (payload.length > MAX_MODERATION_RELEASE_CALLBACK_PAYLOAD_LENGTH) {
    throw new Error('Moderation release callback payload exceeds the MAX limit');
  }

  return payload;
}

export function parseModerationReleaseCallbackPayload(
  payload: string | null | undefined,
): ModerationReleaseCallback | null {
  const normalizedPayload = typeof payload === 'string' ? payload.trim() : '';
  if (
    !normalizedPayload ||
    normalizedPayload.length > MAX_MODERATION_RELEASE_CALLBACK_PAYLOAD_LENGTH
  ) {
    return null;
  }

  const match = normalizedPayload.match(
    /^moderation-release:v1:(unban|unmute):([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)$/u,
  );
  if (!match) {
    return null;
  }

  let decodedChatId: string;
  let decodedUserId: string;
  try {
    decodedChatId = decodeIdentifier(match[2]);
    decodedUserId = decodeIdentifier(match[3]);
  } catch {
    return null;
  }

  const chatId = normalizeModerationReleaseIdentifier(
    decodedChatId,
    MAX_MODERATION_RELEASE_CHAT_ID_LENGTH,
  );
  const targetUserId = normalizeModerationReleaseUserId(decodedUserId);
  if (!chatId || !targetUserId) {
    return null;
  }

  const canonicalPayload = buildModerationReleaseCallbackPayload(
    match[1] === 'unban' ? 'UNBAN' : 'UNMUTE',
    chatId,
    targetUserId,
  );
  if (canonicalPayload !== normalizedPayload) {
    return null;
  }

  return {
    action: match[1] === 'unban' ? 'UNBAN' : 'UNMUTE',
    chatId,
    targetUserId,
  };
}

export function withModerationReleaseButton(
  options: MaxSendMessageOptions | null | undefined,
  release: ModerationReleaseCallback,
): MaxSendMessageOptions {
  const button: MaxCallbackButton = {
    type: 'callback',
    text: release.action === 'UNBAN' ? 'Разбанить' : 'Снять мут',
    payload: buildModerationReleaseCallbackPayload(
      release.action,
      release.chatId,
      release.targetUserId,
    ),
    intent: 'positive',
  };
  const existingRows = readExistingButtonRows(options);
  const rest = { ...(options ?? {}) };
  delete rest.button;
  delete rest.buttons;

  return {
    ...rest,
    buttons: [...existingRows, [button]],
  };
}

function readExistingButtonRows(
  options: MaxSendMessageOptions | null | undefined,
): MaxMessageButton[][] {
  if (Array.isArray(options?.buttons) && options.buttons.length > 0) {
    return options.buttons.map((row) => [...row]);
  }

  return options?.button ? [[options.button]] : [];
}

function normalizeModerationReleaseUserId(value: string): string | null {
  return normalizeModerationReleaseIdentifier(value, MAX_MODERATION_RELEASE_USER_ID_LENGTH);
}

function normalizeModerationReleaseIdentifier(value: string, maxLength: number): string | null {
  const normalized = value.trim();
  const hasControlCharacters = Array.from(normalized).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (!normalized || normalized.length > maxLength || hasControlCharacters) {
    return null;
  }

  return normalized;
}

function encodeIdentifier(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decodeIdentifier(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}
