import type { RuleViolation } from '../rule-engine.contract';
import { createHash } from 'node:crypto';
import type { NavigationTargetEvidence } from '../navigation/navigation-evidence.types';
import { adaptMaxWebhookNavigationView } from '../navigation/max-navigation-view.adapter';
import { readStopWordsPolicy } from './stop-words.policy';
import { StopWordsMatcher } from './stop-words.matcher';

const matcher = new StopWordsMatcher();

export function fingerprintStopWordsSource(params: {
  text: string;
  textSegments?: readonly string[];
  navigationTargets?: readonly NavigationTargetEvidence[];
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        text: params.textSegments ?? [params.text],
        targets: [
          ...new Set(
            (params.navigationTargets ?? [])
              .filter((target) => target.enforceable)
              .map((target) => target.normalizedTarget),
          ),
        ].sort(),
      }),
    )
    .digest('hex');
}

export function detectStopWordsViolations(params: {
  text: string;
  settings: { stopWordsPolicy?: unknown; stopWordsRevision?: number };
  textSegments?: readonly string[];
  navigationTargets?: readonly NavigationTargetEvidence[];
  isLinkAllowlisted?: (link: string) => boolean;
}): RuleViolation[] {
  const policy = readStopWordsPolicy(params.settings);
  if (!policy) return [];
  const matches = [
    ...matcher.detect({ ...params, policy: { ...policy, domains: [] }, limit: 1 }),
    ...matcher.detect({ ...params, policy: { ...policy, rules: [] }, limit: 1 }),
  ];
  const seen = new Set<string>();
  return matches.flatMap((match): RuleViolation[] => {
    const ruleCode = match.kind === 'DOMAIN' ? 'MESSAGE_BLOCKED_DOMAIN' : 'MESSAGE_BLOCKED_WORD';
    if (seen.has(ruleCode)) return [];
    seen.add(ruleCode);
    return [
      {
        ruleCode,
        score: match.kind === 'DOMAIN' ? 0.9 : 0.89,
        reason: `Stop-list rule matched: ${match.value}`,
        metadata: {
          stopWordsRuleId: match.ruleId,
          stopWordsPolicyVersion: policy.version,
          stopWordsRevision: params.settings.stopWordsRevision ?? 0,
          stopWordsSourceSha256: fingerprintStopWordsSource(params),
          matchKind: match.matchKind,
          ...(match.kind === 'DOMAIN'
            ? { blockedDomain: match.value, matchedLink: match.fragment }
            : { blockedWord: match.value }),
        },
      },
    ];
  });
}

export function extractStopWordsTextSegments(rawUpdate: unknown, fallback: string): string[] {
  const view = adaptMaxWebhookNavigationView(rawUpdate);
  if (!view.direct) return [fallback];
  return [view.direct.text, ...(view.visibleForward ? [view.visibleForward.text] : [])];
}
