import { normalizeHttpButtonUrl, type ManagedEntityType } from '@maxim/contracts';
import type { AdminDialogLinkHelper } from './admin-dialog-link-helper';
import { readTrimmedString } from './admin-legacy-utils';

const PROFILE_MENTION_START_PREFIX = 'pmh-';
const PROFILE_MENTION_COMPACT_START_PREFIX = 'pm2_';

export function buildUserProfileUrl(username: string | null): string | null {
  const normalizedUsername = username?.replace(/^@+/u, '').trim() ?? '';
  if (!normalizedUsername) {
    return null;
  }

  return `https://max.ru/${encodeURIComponent(normalizedUsername)}`;
}

export function normalizeMaxProfileUrl(value: string | null): string | null {
  if (!value) {
    return null;
  }

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

export function extractLegacyMaxUserId(url: string | null | undefined): string | null {
  if (typeof url !== 'string') {
    return null;
  }

  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== 'max:' || parsed.hostname.trim().toLowerCase() !== 'user') {
      return null;
    }

    const userId = decodeURIComponent(parsed.pathname.replace(/^\/+/u, '').trim());
    return userId || null;
  } catch {
    return null;
  }
}

export function isLegacyProfileHandoffUrl(url: string | null | undefined): boolean {
  if (typeof url !== 'string') {
    return false;
  }

  try {
    const parsed = new URL(url.trim());
    const hostname = parsed.hostname.trim().toLowerCase();
    if (hostname !== 'max.ru' && hostname !== 'www.max.ru') {
      return false;
    }

    const startPayload = parsed.searchParams.get('start')?.trim() ?? '';
    return (
      startPayload.startsWith(PROFILE_MENTION_START_PREFIX) ||
      startPayload.startsWith(PROFILE_MENTION_COMPACT_START_PREFIX)
    );
  } catch {
    return false;
  }
}

export function normalizeLegacyProfileButtonUrl(url: string | null | undefined): string {
  const normalizedUrl = typeof url === 'string' ? (normalizeHttpButtonUrl(url.trim()) ?? '') : '';
  if (extractLegacyMaxUserId(normalizedUrl) || isLegacyProfileHandoffUrl(normalizedUrl)) {
    return '';
  }

  return normalizedUrl;
}

export function buildProfileMentionHandoffUrl(
  dialogLinkHelper: AdminDialogLinkHelper,
  chatId: string,
  entityType: ManagedEntityType,
  userId: string,
  displayName: string | null,
  botId?: string | null,
): string | null {
  const normalizedChatId = chatId.trim();
  const normalizedUserId = userId.trim();
  if (!normalizedChatId || !normalizedUserId) {
    return null;
  }

  const startPayload = dialogLinkHelper.buildProfileMentionStartPayload(
    {
      chatId: normalizedChatId,
      entityType,
      userId: normalizedUserId,
      displayName: displayName?.trim() || 'Пользователь',
    },
    botId,
  );
  const handoffUrl = dialogLinkHelper.buildBotStartUrl(startPayload, botId);
  const normalizedDisplayName = readTrimmedString(displayName);
  if (!handoffUrl || !normalizedDisplayName) {
    return handoffUrl;
  }

  try {
    const parsed = new URL(handoffUrl);
    parsed.searchParams.set('profile_label', normalizedDisplayName);
    return parsed.toString();
  } catch {
    return handoffUrl;
  }
}
