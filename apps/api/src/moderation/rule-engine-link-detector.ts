import {
  normalizeAllowlistDomain,
  normalizeAllowlistLink,
  parseStoredAllowlistEntry,
} from '@maxim/contracts/settings';
import { LinkPolicy } from '@prisma/client';
import { extractUrlsFromText as extractTextUrls } from '../common/url-text.util';

type AllowlistMatchers = {
  exactLinks: Set<string>;
  domains: Set<string>;
};

export function detectBlockedLink(
  text: string,
  policy: LinkPolicy,
  allowlist: readonly string[],
): string | null {
  if (policy === LinkPolicy.ALERT_ONLY) {
    return null;
  }

  const links = extractUrlsFromText(text);

  if (links.length === 0) {
    return null;
  }

  if (policy === LinkPolicy.BLOCKLIST_ONLY) {
    return 'Links are not allowed by policy';
  }

  const matchers = buildAllowlistMatchers(allowlist);

  for (const link of links) {
    if (policy === LinkPolicy.ALLOWLIST_ONLY && !shouldCheckExactAllowlistLink(link)) {
      continue;
    }

    const linkMatch = resolveAllowlistMatch(link);
    if (!linkMatch) {
      continue;
    }

    if (!isAllowlistedLink(matchers, linkMatch)) {
      return `Link ${linkMatch.normalizedLink} is not in allowlist`;
    }
  }

  return null;
}

export function extractUrlsFromText(value: string): string[] {
  return extractTextUrls(value);
}

function buildAllowlistMatchers(allowlist: readonly string[]): AllowlistMatchers {
  const exactLinks = new Set<string>();
  const domains = new Set<string>();

  for (const entry of allowlist) {
    const parsed = parseStoredAllowlistEntry(entry);
    if (!parsed) {
      continue;
    }

    if (parsed.matchType === 'DOMAIN') {
      domains.add(parsed.domain);
      continue;
    }

    exactLinks.add(parsed.domain);
  }

  return { exactLinks, domains };
}

function resolveAllowlistMatch(
  value: string,
): { normalizedLink: string; normalizedDomain: string | null } | null {
  const normalizedLink = normalizeAllowlistLink(value);
  if (!normalizedLink) {
    return null;
  }

  return {
    normalizedLink,
    normalizedDomain: normalizeAllowlistDomain(value),
  };
}

function isAllowlistedLink(
  matchers: AllowlistMatchers,
  match: { normalizedLink: string; normalizedDomain: string | null },
): boolean {
  if (matchers.exactLinks.has(match.normalizedLink)) {
    return true;
  }

  if (match.normalizedDomain && matchers.domains.has(match.normalizedDomain)) {
    return true;
  }

  return false;
}

function shouldCheckExactAllowlistLink(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) {
    return false;
  }

  if (/^https?:\/\//i.test(normalized)) {
    return true;
  }

  return /[/?#]/.test(normalized);
}
