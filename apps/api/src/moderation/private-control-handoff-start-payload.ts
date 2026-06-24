import type { ManagedEntityType } from '@maxim/contracts';
import {
  buildCompactGiveawayHandoffStartPayload,
  buildCompactProfileMentionStartPayload,
  parseCompactGiveawayHandoffStartPayload,
  parseCompactProfileMentionStartPayload,
} from '../max/max-deep-link.util';
import {
  GIVEAWAY_HANDOFF_START_PAYLOAD,
  GIVEAWAY_HANDOFF_START_PREFIX,
  PROFILE_MENTION_START_PREFIX,
} from './private-control.constants';
import type {
  GiveawayHandoffStartPayload,
  ProfileMentionStartPayload,
} from './private-control.types';

export type PrivateGiveawayHandoffStart = {
  chatId: string;
  entityType: ManagedEntityType;
  giveawayId: string | null;
};

export type PrivateProfileMentionStart = {
  chatId: string;
  entityType: ManagedEntityType;
  userId: string;
  displayName: string;
};

export function buildPrivateGiveawayHandoffStartPayload(
  params: PrivateGiveawayHandoffStart,
  botToken: string,
): string {
  const compactPayload = buildCompactGiveawayHandoffStartPayload(params, botToken);
  if (compactPayload) {
    return compactPayload;
  }

  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      k: 'giveaway-handoff',
      c: params.chatId,
      e: params.entityType,
      g: params.giveawayId,
    } satisfies GiveawayHandoffStartPayload),
    'utf8',
  ).toString('base64url');

  return `${GIVEAWAY_HANDOFF_START_PREFIX}${payload}`;
}

export function buildPrivateProfileMentionStartPayload(
  params: PrivateProfileMentionStart,
  botToken: string,
): string {
  const compactPayload = buildCompactProfileMentionStartPayload(
    {
      chatId: params.chatId,
      entityType: params.entityType,
      userId: params.userId,
    },
    botToken,
  );
  if (compactPayload) {
    return compactPayload;
  }

  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      k: 'profile-mention',
      c: params.chatId,
      e: params.entityType,
      u: params.userId,
      n: params.displayName.trim() || 'Пользователь',
    } satisfies ProfileMentionStartPayload),
    'utf8',
  ).toString('base64url');

  return `${PROFILE_MENTION_START_PREFIX}${payload}`;
}

export function parsePrivateGiveawayHandoffStartPayload(
  startPayload: string | null,
  botTokens: readonly string[],
): PrivateGiveawayHandoffStart | null {
  const compactPayload = parseCompactGiveawayHandoffStartPayload(startPayload, botTokens);
  if (compactPayload) {
    return compactPayload;
  }

  if (!startPayload || startPayload === GIVEAWAY_HANDOFF_START_PAYLOAD) {
    return null;
  }

  if (!startPayload.startsWith(GIVEAWAY_HANDOFF_START_PREFIX)) {
    return null;
  }

  const encodedPayload = startPayload.slice(GIVEAWAY_HANDOFF_START_PREFIX.length);
  if (!encodedPayload) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(encodedPayload, 'base64url').toString('utf8'),
    ) as Partial<GiveawayHandoffStartPayload>;
    const chatId = typeof parsed.c === 'string' ? parsed.c.trim() : '';
    const entityType = parsed.e === 'channel' ? 'channel' : parsed.e === 'chat' ? 'chat' : null;
    const giveawayId =
      typeof parsed.g === 'string' && parsed.g.trim().length > 0 ? parsed.g.trim() : null;

    if (parsed.v !== 1 || parsed.k !== 'giveaway-handoff' || !chatId || !entityType) {
      return null;
    }

    return {
      chatId,
      entityType,
      giveawayId,
    };
  } catch {
    return null;
  }
}

export function parsePrivateProfileMentionStartPayload(
  startPayload: string | null,
  botTokens: readonly string[],
): PrivateProfileMentionStart | null {
  const compactPayload = parseCompactProfileMentionStartPayload(startPayload, botTokens);
  if (compactPayload) {
    return {
      ...compactPayload,
      displayName: 'Пользователь',
    };
  }

  if (!startPayload || !startPayload.startsWith(PROFILE_MENTION_START_PREFIX)) {
    return null;
  }

  const encodedPayload = startPayload.slice(PROFILE_MENTION_START_PREFIX.length);
  if (!encodedPayload) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(encodedPayload, 'base64url').toString('utf8'),
    ) as Partial<ProfileMentionStartPayload>;
    const chatId = typeof parsed.c === 'string' ? parsed.c.trim() : '';
    const entityType = parsed.e === 'channel' ? 'channel' : parsed.e === 'chat' ? 'chat' : null;
    const userId = typeof parsed.u === 'string' ? parsed.u.trim() : '';
    const displayName = typeof parsed.n === 'string' ? parsed.n.trim() : '';

    if (parsed.v !== 1 || parsed.k !== 'profile-mention' || !chatId || !entityType || !userId) {
      return null;
    }

    return {
      chatId,
      entityType,
      userId,
      displayName: displayName || 'Пользователь',
    };
  } catch {
    return null;
  }
}
