import {
  buildNavigationAllowlistPolicyKeys,
  normalizeAllowlistDomain,
  normalizeAllowlistLink,
  parseStoredAllowlistEntry,
  type NavigationAllowlistPolicyKey,
} from '@maxim/contracts/settings';
import { LinkPolicy } from '../prisma/prisma-client';
import { extractUrlsFromText as extractTextUrls } from '../common/url-text.util';
import type { NavigationTargetEvidence } from './navigation/navigation-evidence.types';

type AllowlistMatchers = {
  exactLinks: Set<string>;
  domains: Set<string>;
  typedTargets: Set<string>;
};

export type AllowlistLinkMatcher = (value: string) => boolean;
export type NavigationAllowlistMatcher = (value: NavigationTargetEvidence) => boolean;

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
  allowlistMatcher?: AllowlistLinkMatcher,
  navigationTargets?: readonly NavigationTargetEvidence[],
): string | null {
  if (policy === LinkPolicy.ALERT_ONLY) {
    return null;
  }

  if (navigationTargets) {
    const enforceableTargets = navigationTargets.filter((target) => target.enforceable);
    if (enforceableTargets.length === 0) {
      return null;
    }
    if (policy === LinkPolicy.BLOCKLIST_ONLY) {
      return 'Links are not allowed by policy';
    }

    const isAllowlisted = createNavigationAllowlistMatcher(allowlist);
    const blockedTarget = enforceableTargets.find((target) => !isAllowlisted(target));
    return blockedTarget ? `Link ${blockedTarget.normalizedTarget} is not in allowlist` : null;
  }

  const links = extractUrlsFromText(text);

  if (links.length === 0) {
    return null;
  }

  if (policy === LinkPolicy.BLOCKLIST_ONLY) {
    return 'Links are not allowed by policy';
  }

  const resolvedLinks = resolveDetectedLinks(
    links,
    allowlistMatcher ?? createAllowlistLinkMatcher(allowlist),
  );
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

export function createAllowlistLinkMatcher(allowlist: readonly string[]): AllowlistLinkMatcher {
  const matchers = buildAllowlistMatchers(allowlist);
  return (value: string) => {
    const match = resolveAllowlistMatch(value);
    return match ? isAllowlistedLink(matchers, match) : false;
  };
}

export function createNavigationAllowlistMatcher(
  allowlist: readonly string[],
): NavigationAllowlistMatcher {
  const matchers = buildAllowlistMatchers(allowlist);
  return (value) =>
    buildNavigationTargetAllowlistPolicyKeys(value).some((key) =>
      isAllowlistedNavigationPolicyKey(matchers, key),
    );
}

export function buildNavigationTargetAllowlistPolicyKeys(
  value: NavigationTargetEvidence,
): NavigationAllowlistPolicyKey[] {
  const keys = [
    ...buildNavigationAllowlistPolicyKeys(value.target, value.kind),
    ...(value.allowlistAliases ?? []).flatMap((alias) =>
      buildNavigationAllowlistPolicyKeys(alias.target, alias.kind),
    ),
  ];
  const seen = new Set<string>();
  return keys.filter((key) => {
    const serialized = serializeNavigationPolicyKey(key);
    if (seen.has(serialized)) {
      return false;
    }
    seen.add(serialized);
    return true;
  });
}

function buildAllowlistMatchers(allowlist: readonly string[]): AllowlistMatchers {
  const exactLinks = new Set<string>();
  const domains = new Set<string>();
  const typedTargets = new Set<string>();

  for (const entry of allowlist) {
    const parsed = parseStoredAllowlistEntry(entry);
    if (!parsed) {
      continue;
    }

    typedTargets.add(serializeNavigationPolicyKey(parsed));

    if (parsed.matchType === 'DOMAIN') {
      domains.add(parsed.domain);
      continue;
    }

    exactLinks.add(parsed.domain);
  }

  return { exactLinks, domains, typedTargets };
}

function isAllowlistedNavigationPolicyKey(
  matchers: AllowlistMatchers,
  key: NavigationAllowlistPolicyKey,
): boolean {
  if (matchers.typedTargets.has(serializeNavigationPolicyKey(key))) {
    return true;
  }
  if (key.kind !== 'WEB_DOMAIN') {
    return false;
  }
  if (matchers.domains.has(key.target)) {
    return true;
  }
  for (const domain of matchers.domains) {
    if (key.target.endsWith(`.${domain}`)) {
      return true;
    }
  }
  return false;
}

function serializeNavigationPolicyKey(key: NavigationAllowlistPolicyKey): string {
  return `${key.kind}\0${key.target}`;
}

function resolveDetectedLinks(
  links: readonly string[],
  allowlistMatcher: AllowlistLinkMatcher,
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
      allowlisted: allowlistMatcher(raw),
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
