import { normalizeMessageLimitsBlockedDomainCandidate } from '@maxim/contracts/settings';
import { extractUrlsFromText } from '../common/url-text.util';

export type BlockedDomainDetection = {
  blockedDomain: string;
  matchedDomain: string;
  matchedLink: string;
};

type ResolvedBlockedDomainIndex = {
  domains: readonly string[];
};

const BLOCKED_DOMAIN_LIST_CACHE_MAX_ENTRIES = 512;

export class MessageLimitsBlockedDomainDetector {
  private readonly blockedDomainListCache = new Map<string, ResolvedBlockedDomainIndex>();

  detect(
    text: string,
    blockedDomains: readonly string[],
    options: { isLinkAllowlisted?: (link: string) => boolean } = {},
  ): BlockedDomainDetection | null {
    if (!text || !Array.isArray(blockedDomains) || blockedDomains.length === 0) {
      return null;
    }

    const blockedDomainIndex = this.resolveMessageLimitsBlockedDomainList(blockedDomains);
    if (blockedDomainIndex.domains.length === 0) {
      return null;
    }

    const links = extractUrlsFromText(text);
    if (links.length === 0) {
      return null;
    }

    for (const link of links) {
      const matchedDomain = normalizeMessageLimitsBlockedDomainCandidate(link);
      if (!matchedDomain) {
        continue;
      }

      const blockedDomain = this.findBlockedDomainMatch(
        matchedDomain,
        blockedDomainIndex.domains,
      );
      if (blockedDomain) {
        if (options.isLinkAllowlisted?.(link)) {
          continue;
        }

        return {
          blockedDomain,
          matchedDomain,
          matchedLink: link,
        };
      }
    }

    return null;
  }

  private resolveMessageLimitsBlockedDomainList(
    blockedDomains: readonly string[],
  ): ResolvedBlockedDomainIndex {
    const cacheKey = this.buildBlockedDomainListCacheKey(blockedDomains);
    const cached = this.blockedDomainListCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const domains = [
      ...new Set(
        blockedDomains
          .map((item) => normalizeMessageLimitsBlockedDomainCandidate(item))
          .filter((item): item is string => Boolean(item)),
      ),
    ].sort((left, right) => right.length - left.length);
    const resolved = { domains };

    this.blockedDomainListCache.set(cacheKey, resolved);
    if (this.blockedDomainListCache.size > BLOCKED_DOMAIN_LIST_CACHE_MAX_ENTRIES) {
      const oldestKey = this.blockedDomainListCache.keys().next().value;
      if (typeof oldestKey === 'string') {
        this.blockedDomainListCache.delete(oldestKey);
      }
    }

    return resolved;
  }

  private findBlockedDomainMatch(
    matchedDomain: string,
    blockedDomains: readonly string[],
  ): string | null {
    for (const blockedDomain of blockedDomains) {
      if (matchedDomain === blockedDomain || matchedDomain.endsWith(`.${blockedDomain}`)) {
        return blockedDomain;
      }
    }

    return null;
  }

  private buildBlockedDomainListCacheKey(blockedDomains: readonly string[]): string {
    return blockedDomains.join('\u001f');
  }
}
