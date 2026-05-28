import {
  normalizeAllowlistDomain,
  normalizeAllowlistLink,
  parseStoredAllowlistEntry,
} from '@maxim/contracts/settings';
import { LinkPolicy } from '../prisma/prisma-client';
import { extractUrlsFromText as extractTextUrls } from '../common/url-text.util';

type AllowlistMatchers = {
  exactLinks: Set<string>;
  domains: Set<string>;
};

type ResolvedLink = {
  raw: string;
  match: {
    normalizedLink: string;
    normalizedDomain: string | null;
  };
  allowlisted: boolean;
  explicit: boolean;
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
  const resolvedLinks = resolveDetectedLinks(links, matchers);
  const allowlistedExplicitDomains = new Set(
    resolvedLinks
      .filter((link) => link.allowlisted && link.explicit && link.match.normalizedDomain)
      .map((link) => link.match.normalizedDomain as string),
  );
  const allowlistedExplicitDomainLabels = new Set(
    [...allowlistedExplicitDomains]
      .map((domain) => extractDomainBrandLabel(domain))
      .filter((label): label is string => label !== null),
  );

  for (const link of resolvedLinks) {
    if (link.allowlisted) {
      continue;
    }

    if (
      !link.explicit &&
      link.match.normalizedDomain &&
      (allowlistedExplicitDomains.has(link.match.normalizedDomain) ||
        isBareBrandMentionForAllowedLink(
          link.raw,
          link.match.normalizedDomain,
          allowlistedExplicitDomainLabels,
        ))
    ) {
      continue;
    }

    return `Link ${link.match.normalizedLink} is not in allowlist`;
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

function resolveDetectedLinks(
  links: readonly string[],
  matchers: AllowlistMatchers,
): ResolvedLink[] {
  const resolved: ResolvedLink[] = [];

  for (const raw of links) {
    const match = resolveAllowlistMatch(raw);
    if (!match) {
      continue;
    }

    resolved.push({
      raw,
      match,
      allowlisted: isAllowlistedLink(matchers, match),
      explicit: isExplicitLink(raw),
    });
  }

  return resolved;
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

  if (match.normalizedDomain) {
    for (const domain of matchers.domains) {
      if (match.normalizedDomain.endsWith(`.${domain}`)) {
        return true;
      }
    }
  }

  return false;
}

function isBareBrandMentionForAllowedLink(
  raw: string,
  normalizedDomain: string,
  allowlistedDomainLabels: ReadonlySet<string>,
): boolean {
  if (!/[A-Z]/.test(raw)) {
    return false;
  }

  const brandLabel = extractDomainBrandLabel(normalizedDomain);
  return brandLabel !== null && allowlistedDomainLabels.has(brandLabel);
}

function extractDomainBrandLabel(domain: string): string | null {
  const labels = domain
    .trim()
    .toLowerCase()
    .split('.')
    .filter((label) => label.length > 0);
  if (labels.length < 2) {
    return null;
  }

  return labels[labels.length - 2] ?? null;
}

function isExplicitLink(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) {
    return false;
  }

  if (/^https?:\/\//i.test(normalized)) {
    return true;
  }

  return /[/?#]/.test(normalized);
}
