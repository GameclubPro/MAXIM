import { parseCompactProfileMentionStartPayload } from '../max/max-deep-link.util';

export const ADMIN_CONTACT_LINK_TEXT = 'Связь с админом';

const PROFILE_MENTION_START_PREFIX = 'pmh-';
const PROFILE_MENTION_COMPACT_PREFIX = 'pm2_';

type LegacyProfileMentionPayload = {
  v?: unknown;
  k?: unknown;
  u?: unknown;
};

function normalizeUserMentionUrl(userId: string | null | undefined): string | null {
  const normalizedUserId = typeof userId === 'string' ? userId.trim() : '';
  return normalizedUserId ? `max://user/${encodeURIComponent(normalizedUserId)}` : null;
}

function parseLegacyProfileMentionStartPayload(startPayload: string): string | null {
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

    return normalizeUserMentionUrl(typeof parsed.u === 'string' ? parsed.u : null);
  } catch {
    return null;
  }
}

function resolveProfileMentionStartUrl(
  startPayload: string,
  botTokens: readonly string[],
): string | null {
  const compactPayload = parseCompactProfileMentionStartPayload(startPayload, botTokens);
  if (compactPayload) {
    return normalizeUserMentionUrl(compactPayload.userId);
  }

  return parseLegacyProfileMentionStartPayload(startPayload);
}

export function resolveAdminContactMarkdownUrl(
  url: string | null | undefined,
  botTokens: readonly string[] = [],
): string | null {
  const normalizedUrl = typeof url === 'string' ? url.trim() : '';
  if (!normalizedUrl) {
    return null;
  }

  try {
    const parsed = new URL(normalizedUrl);
    if (parsed.protocol === 'max:' && parsed.hostname.trim().toLowerCase() === 'user') {
      return normalizeUserMentionUrl(decodeURIComponent(parsed.pathname.replace(/^\/+/u, '')));
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }

    const startPayload = parsed.searchParams.get('start')?.trim() ?? '';
    if (startPayload) {
      const mentionUrl = resolveProfileMentionStartUrl(startPayload, botTokens);
      if (mentionUrl) {
        return mentionUrl;
      }

      if (
        startPayload.startsWith(PROFILE_MENTION_START_PREFIX) ||
        startPayload.startsWith(PROFILE_MENTION_COMPACT_PREFIX)
      ) {
        return null;
      }
    }

    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

export function buildAdminContactMarkdownLink(params: {
  enabled: boolean;
  url: string | null | undefined;
  botTokens?: readonly string[];
}): string | null {
  if (!params.enabled) {
    return null;
  }

  const markdownUrl = resolveAdminContactMarkdownUrl(params.url, params.botTokens ?? []);
  if (!markdownUrl) {
    return null;
  }

  return `[${ADMIN_CONTACT_LINK_TEXT}](${markdownUrl.replace(/\)/g, '%29')})`;
}

export function appendAdminContactMarkdownLink(
  text: string,
  params: {
    enabled: boolean;
    url: string | null | undefined;
    botTokens?: readonly string[];
  },
): string {
  const link = buildAdminContactMarkdownLink(params);
  if (!link) {
    return text;
  }

  const normalizedText = text.trimEnd();
  return normalizedText ? `${normalizedText}\n\n${link}` : link;
}
