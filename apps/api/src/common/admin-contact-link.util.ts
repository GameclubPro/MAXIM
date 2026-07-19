import { normalizeHttpButtonUrl } from '@maxim/contracts';
import { parseCompactProfileMentionStartPayload } from '../max/max-deep-link.util';

export const ADMIN_CONTACT_LINK_TEXT = 'Связь с админом';

const PROFILE_MENTION_START_PREFIX = 'pmh-';
const PROFILE_MENTION_COMPACT_PREFIX = 'pm2_';

type LegacyProfileMentionPayload = {
  v?: unknown;
  k?: unknown;
  u?: unknown;
  n?: unknown;
};

type ProfileMentionTarget = {
  userId: string;
  displayName: string | null;
};

function normalizeProfileMentionDisplayName(value: string | null | undefined): string | null {
  const normalized = typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
  return normalized || null;
}

function escapeMaxMarkdownText(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/([*_`[\]()~+])/gu, '\\$1');
}

function normalizeUserMentionUrl(userId: string | null | undefined): string | null {
  const normalizedUserId = typeof userId === 'string' ? userId.trim() : '';
  return normalizedUserId ? `max://user/${encodeURIComponent(normalizedUserId)}` : null;
}

function parseLegacyProfileMentionStartPayload(startPayload: string): ProfileMentionTarget | null {
  if (!startPayload.startsWith(PROFILE_MENTION_START_PREFIX)) {
    return null;
  }

  const encodedPayload = startPayload.slice(PROFILE_MENTION_START_PREFIX.length);
  if (!encodedPayload) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(encodedPayload, 'base64url').toString('utf8'),
    ) as LegacyProfileMentionPayload;
    if (parsed.v !== 1 || parsed.k !== 'profile-mention') {
      return null;
    }

    const userId = typeof parsed.u === 'string' ? parsed.u.trim() : '';
    if (!userId) {
      return null;
    }

    return {
      userId,
      displayName: normalizeProfileMentionDisplayName(
        typeof parsed.n === 'string' ? parsed.n : null,
      ),
    };
  } catch {
    return null;
  }
}

function parseProfileMentionStartPayload(
  startPayload: string,
  botTokens: readonly string[],
): ProfileMentionTarget | null {
  const compactPayload = parseCompactProfileMentionStartPayload(startPayload, botTokens);
  if (compactPayload) {
    return {
      userId: compactPayload.userId,
      displayName: null,
    };
  }

  return parseLegacyProfileMentionStartPayload(startPayload);
}

function parseProfileMentionUrl(
  url: string | null | undefined,
  botTokens: readonly string[],
): {
  url: string;
  target: ProfileMentionTarget | null;
} | null {
  const normalizedUrl = typeof url === 'string' ? normalizeHttpButtonUrl(url) : null;
  if (!normalizedUrl) {
    return null;
  }

  try {
    const parsed = new URL(normalizedUrl);
    const startPayload = parsed.searchParams.get('start')?.trim() ?? '';
    if (startPayload) {
      const target = parseProfileMentionStartPayload(startPayload, botTokens);
      if (target) {
        parsed.hash = '';
        return {
          url: parsed.toString(),
          target: {
            ...target,
            displayName:
              normalizeProfileMentionDisplayName(parsed.searchParams.get('profile_label')) ??
              target.displayName,
          },
        };
      }

      if (
        startPayload.startsWith(PROFILE_MENTION_START_PREFIX) ||
        startPayload.startsWith(PROFILE_MENTION_COMPACT_PREFIX)
      ) {
        return null;
      }
    }

    parsed.hash = '';
    return {
      url: parsed.toString(),
      target: null,
    };
  } catch {
    return null;
  }
}

export function resolveAdminContactMarkdownUrl(
  url: string | null | undefined,
  botTokens: readonly string[] = [],
): string | null {
  return parseProfileMentionUrl(url, botTokens)?.url ?? null;
}

export function resolveAdminContactMentionTarget(
  url: string | null | undefined,
  botTokens: readonly string[] = [],
): ProfileMentionTarget | null {
  return parseProfileMentionUrl(url, botTokens)?.target ?? null;
}

export function buildAdminContactMarkdownLink(params: {
  enabled: boolean;
  url: string | null | undefined;
  botTokens?: readonly string[];
  fallbackDisplayName?: string | null;
}): string | null {
  if (!params.enabled) {
    return null;
  }

  const resolved = parseProfileMentionUrl(params.url, params.botTokens ?? []);
  if (!resolved) {
    return null;
  }

  const userMentionUrl = normalizeUserMentionUrl(resolved.target?.userId);
  const displayName =
    resolved.target?.displayName ?? normalizeProfileMentionDisplayName(params.fallbackDisplayName);
  if (userMentionUrl && displayName) {
    return `${ADMIN_CONTACT_LINK_TEXT}: [${escapeMaxMarkdownText(displayName)}](${userMentionUrl})`;
  }

  return `[${ADMIN_CONTACT_LINK_TEXT}](${resolved.url.replace(/\)/gu, '%29')})`;
}

export function appendAdminContactMarkdownLink(
  text: string,
  params: {
    enabled: boolean;
    url: string | null | undefined;
    botTokens?: readonly string[];
    fallbackDisplayName?: string | null;
  },
): string {
  const link = buildAdminContactMarkdownLink(params);
  if (!link) {
    return text;
  }

  return text.length > 0 ? `${text}\n\n${link}` : link;
}
