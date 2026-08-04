import type {
  MaxCallbackButton,
  MaxMessageButton,
  MaxSendMessageOptions,
} from '../max/max-client.service';

const MODERATION_RELEASE_CALLBACK_PREFIX = 'moderation-release:v2';
const MAX_MODERATION_RELEASE_EVENT_ID_LENGTH = 128;
const MAX_MODERATION_RELEASE_CALLBACK_PAYLOAD_LENGTH = 512;

export type ModerationReleaseAction = 'UNBAN' | 'UNMUTE';

export type ModerationReleaseCallback = {
  action: ModerationReleaseAction;
  sanctionEventId: string;
};

export function buildModerationReleaseCallbackPayload(
  action: ModerationReleaseAction,
  sanctionEventId: string,
): string {
  const normalizedEventId = normalizeModerationReleaseIdentifier(
    sanctionEventId,
    MAX_MODERATION_RELEASE_EVENT_ID_LENGTH,
  );
  if (!normalizedEventId) {
    throw new Error('Moderation release sanction event ID is invalid');
  }

  const payload = `${MODERATION_RELEASE_CALLBACK_PREFIX}:${action.toLowerCase()}:${encodeIdentifier(
    normalizedEventId,
  )}`;
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

  const match = normalizedPayload.match(/^moderation-release:v2:(unban|unmute):([A-Za-z0-9_-]+)$/u);
  if (!match) {
    return null;
  }

  let decodedEventId: string;
  try {
    decodedEventId = decodeIdentifier(match[2]);
  } catch {
    return null;
  }

  const sanctionEventId = normalizeModerationReleaseIdentifier(
    decodedEventId,
    MAX_MODERATION_RELEASE_EVENT_ID_LENGTH,
  );
  if (!sanctionEventId) {
    return null;
  }

  const canonicalPayload = buildModerationReleaseCallbackPayload(
    match[1] === 'unban' ? 'UNBAN' : 'UNMUTE',
    sanctionEventId,
  );
  if (canonicalPayload !== normalizedPayload) {
    return null;
  }

  return {
    action: match[1] === 'unban' ? 'UNBAN' : 'UNMUTE',
    sanctionEventId,
  };
}

export function withModerationReleaseButton(
  options: MaxSendMessageOptions | null | undefined,
  release: ModerationReleaseCallback,
): MaxSendMessageOptions {
  const button: MaxCallbackButton = {
    type: 'callback',
    text: release.action === 'UNBAN' ? 'Разбанить' : 'Снять мут',
    payload: buildModerationReleaseCallbackPayload(release.action, release.sanctionEventId),
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
