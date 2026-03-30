import type { ManagedEntityType } from '@maxim/contracts';
import { createHmac, timingSafeEqual } from 'node:crypto';

export const MAX_BOT_START_MAX_LENGTH = 128;
export const MAX_MINIAPP_START_MAX_LENGTH = 512;

const MAX_BOT_START_ALLOWED_PATTERN = /^[A-Za-z0-9._-]+$/u;
const MAX_MINIAPP_START_ALLOWED_PATTERN = /^[A-Za-z0-9_-]+$/u;
const COMPACT_COMPONENT_PATTERN = /^[-A-Za-z0-9]+$/u;
const COMPACT_SIGNATURE_PATTERN = /^[a-f0-9]{16}$/u;

const GIVEAWAY_CLAIM_COMPACT_PREFIX = 'ggc2';
const GIVEAWAY_HANDOFF_COMPACT_PREFIX = 'ggh2';
const PROFILE_MENTION_COMPACT_PREFIX = 'pm2';

const GIVEAWAY_CLAIM_SIGNATURE_SCOPE = 'giveaway-claim-v2';
const GIVEAWAY_HANDOFF_SIGNATURE_SCOPE = 'giveaway-handoff-v2';
const PROFILE_MENTION_SIGNATURE_SCOPE = 'profile-mention-v2';

type ManagedEntityTypeCode = 'c' | 'h';

function normalizeCompactComponent(value: string): string | null {
  const normalized = value.trim();
  if (!normalized || !COMPACT_COMPONENT_PATTERN.test(normalized)) {
    return null;
  }

  return normalized;
}

function encodeManagedEntityType(entityType: ManagedEntityType): ManagedEntityTypeCode {
  return entityType === 'channel' ? 'c' : 'h';
}

function decodeManagedEntityType(code: string): ManagedEntityType | null {
  if (code === 'c') {
    return 'channel';
  }
  if (code === 'h') {
    return 'chat';
  }

  return null;
}

function buildCompactSignature(
  scope: string,
  components: readonly string[],
  botToken: string,
): string {
  return createHmac('sha256', botToken)
    .update(`${scope}:${components.join(':')}`)
    .digest('hex')
    .slice(0, 16);
}

function isMatchingCompactSignature(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return (
    providedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(providedBuffer, expectedBuffer)
  );
}

function buildCompactPayload(
  prefix: string,
  scope: string,
  components: readonly string[],
  botToken: string,
): string | null {
  const normalizedComponents = components.map((value) => normalizeCompactComponent(value));
  if (normalizedComponents.some((value) => value === null)) {
    return null;
  }

  const signature = buildCompactSignature(
    scope,
    normalizedComponents as string[],
    botToken.trim(),
  );
  const payload = [prefix, ...(normalizedComponents as string[]), signature].join('_');

  return isValidMaxBotStartPayload(payload) ? payload : null;
}

export function isValidMaxBotStartPayload(value: string | null | undefined): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_BOT_START_MAX_LENGTH &&
    MAX_BOT_START_ALLOWED_PATTERN.test(value)
  );
}

export function isValidMaxMiniappStartPayload(value: string | null | undefined): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_MINIAPP_START_MAX_LENGTH &&
    MAX_MINIAPP_START_ALLOWED_PATTERN.test(value)
  );
}

export function buildCompactGiveawayClaimStartPayload(
  params: { giveawayId: string; winnerId: string },
  botToken: string,
): string | null {
  const normalizedBotToken = botToken.trim();
  if (!normalizedBotToken) {
    return null;
  }

  return buildCompactPayload(
    GIVEAWAY_CLAIM_COMPACT_PREFIX,
    GIVEAWAY_CLAIM_SIGNATURE_SCOPE,
    [params.giveawayId, params.winnerId],
    normalizedBotToken,
  );
}

export function parseCompactGiveawayClaimStartPayload(
  payload: string | null | undefined,
  botTokens: readonly string[],
): { giveawayId: string; winnerId: string } | null {
  if (
    !payload?.startsWith(`${GIVEAWAY_CLAIM_COMPACT_PREFIX}_`) ||
    !isValidMaxBotStartPayload(payload)
  ) {
    return null;
  }

  const [prefix, giveawayIdRaw, winnerIdRaw, signatureRaw, ...rest] = payload.split('_');
  if (prefix !== GIVEAWAY_CLAIM_COMPACT_PREFIX || rest.length > 0) {
    return null;
  }

  const giveawayId = normalizeCompactComponent(giveawayIdRaw ?? '');
  const winnerId = normalizeCompactComponent(winnerIdRaw ?? '');
  const signature = signatureRaw?.trim().toLowerCase() ?? '';
  if (!giveawayId || !winnerId || !COMPACT_SIGNATURE_PATTERN.test(signature)) {
    return null;
  }

  const components = [giveawayId, winnerId];
  const valid = botTokens.some((botToken) => {
    const normalizedBotToken = botToken.trim();
    if (!normalizedBotToken) {
      return false;
    }

    return isMatchingCompactSignature(
      signature,
      buildCompactSignature(GIVEAWAY_CLAIM_SIGNATURE_SCOPE, components, normalizedBotToken),
    );
  });
  if (!valid) {
    return null;
  }

  return { giveawayId, winnerId };
}

export function buildCompactGiveawayHandoffStartPayload(
  params: { chatId: string; entityType: ManagedEntityType; giveawayId: string | null },
  botToken: string,
): string | null {
  const normalizedBotToken = botToken.trim();
  if (!normalizedBotToken) {
    return null;
  }

  return buildCompactPayload(
    GIVEAWAY_HANDOFF_COMPACT_PREFIX,
    GIVEAWAY_HANDOFF_SIGNATURE_SCOPE,
    [
      params.chatId,
      encodeManagedEntityType(params.entityType),
      params.giveawayId?.trim() || '0',
    ],
    normalizedBotToken,
  );
}

export function parseCompactGiveawayHandoffStartPayload(
  payload: string | null | undefined,
  botTokens: readonly string[],
): { chatId: string; entityType: ManagedEntityType; giveawayId: string | null } | null {
  if (
    !payload?.startsWith(`${GIVEAWAY_HANDOFF_COMPACT_PREFIX}_`) ||
    !isValidMaxBotStartPayload(payload)
  ) {
    return null;
  }

  const [prefix, chatIdRaw, entityTypeCodeRaw, giveawayIdRaw, signatureRaw, ...rest] =
    payload.split('_');
  if (prefix !== GIVEAWAY_HANDOFF_COMPACT_PREFIX || rest.length > 0) {
    return null;
  }

  const chatId = normalizeCompactComponent(chatIdRaw ?? '');
  const entityType = decodeManagedEntityType(entityTypeCodeRaw?.trim() ?? '');
  const giveawayIdMarker = normalizeCompactComponent(giveawayIdRaw ?? '');
  const signature = signatureRaw?.trim().toLowerCase() ?? '';
  if (!chatId || !entityType || !giveawayIdMarker || !COMPACT_SIGNATURE_PATTERN.test(signature)) {
    return null;
  }

  const components = [chatId, encodeManagedEntityType(entityType), giveawayIdMarker];
  const valid = botTokens.some((botToken) => {
    const normalizedBotToken = botToken.trim();
    if (!normalizedBotToken) {
      return false;
    }

    return isMatchingCompactSignature(
      signature,
      buildCompactSignature(GIVEAWAY_HANDOFF_SIGNATURE_SCOPE, components, normalizedBotToken),
    );
  });
  if (!valid) {
    return null;
  }

  return {
    chatId,
    entityType,
    giveawayId: giveawayIdMarker === '0' ? null : giveawayIdMarker,
  };
}

export function buildCompactProfileMentionStartPayload(
  params: { chatId: string; entityType: ManagedEntityType; userId: string },
  botToken: string,
): string | null {
  const normalizedBotToken = botToken.trim();
  if (!normalizedBotToken) {
    return null;
  }

  return buildCompactPayload(
    PROFILE_MENTION_COMPACT_PREFIX,
    PROFILE_MENTION_SIGNATURE_SCOPE,
    [params.chatId, encodeManagedEntityType(params.entityType), params.userId],
    normalizedBotToken,
  );
}

export function parseCompactProfileMentionStartPayload(
  payload: string | null | undefined,
  botTokens: readonly string[],
): { chatId: string; entityType: ManagedEntityType; userId: string } | null {
  if (
    !payload?.startsWith(`${PROFILE_MENTION_COMPACT_PREFIX}_`) ||
    !isValidMaxBotStartPayload(payload)
  ) {
    return null;
  }

  const [prefix, chatIdRaw, entityTypeCodeRaw, userIdRaw, signatureRaw, ...rest] = payload.split(
    '_',
  );
  if (prefix !== PROFILE_MENTION_COMPACT_PREFIX || rest.length > 0) {
    return null;
  }

  const chatId = normalizeCompactComponent(chatIdRaw ?? '');
  const entityType = decodeManagedEntityType(entityTypeCodeRaw?.trim() ?? '');
  const userId = normalizeCompactComponent(userIdRaw ?? '');
  const signature = signatureRaw?.trim().toLowerCase() ?? '';
  if (!chatId || !entityType || !userId || !COMPACT_SIGNATURE_PATTERN.test(signature)) {
    return null;
  }

  const components = [chatId, encodeManagedEntityType(entityType), userId];
  const valid = botTokens.some((botToken) => {
    const normalizedBotToken = botToken.trim();
    if (!normalizedBotToken) {
      return false;
    }

    return isMatchingCompactSignature(
      signature,
      buildCompactSignature(PROFILE_MENTION_SIGNATURE_SCOPE, components, normalizedBotToken),
    );
  });
  if (!valid) {
    return null;
  }

  return { chatId, entityType, userId };
}
