import { extractClientClickableTextEvidence } from './client-clickable-text.extractor';
import { adaptMaxWebhookNavigationView } from './max-navigation-view.adapter';
import { extractNavigationEvidence } from './navigation-evidence.extractor';
import type {
  MaxNavigationMessageView,
  NavigationTargetEvidence,
} from './navigation-evidence.types';

export type EnabledNavigationTargetOptions = {
  structuredTargetsEnabled: boolean;
  profileMentionsEnabled: boolean;
  forwardedTargetsEnabled: boolean;
  textClickabilityEnabled: boolean;
};

type NavigationConfigReader = {
  get<T = unknown>(key: string): T | undefined;
};

export function resolveEnabledNavigationTargetOptions(
  config?: NavigationConfigReader,
): EnabledNavigationTargetOptions {
  return {
    structuredTargetsEnabled: readBoolean(
      config?.get('MODERATION_LINK_STRUCTURED_TARGETS_ENABLED'),
      true,
    ),
    profileMentionsEnabled: readBoolean(
      config?.get('MODERATION_LINK_PROFILE_MENTIONS_ENABLED'),
      true,
    ),
    forwardedTargetsEnabled: readBoolean(
      config?.get('MODERATION_LINK_FORWARDED_TARGETS_ENABLED'),
      true,
    ),
    textClickabilityEnabled: readBoolean(
      config?.get('MODERATION_LINK_TEXT_CLICKABILITY_ENABLED'),
      false,
    ),
  };
}

export function extractEnabledWebhookNavigationTargets(
  rawUpdate: unknown,
  options: EnabledNavigationTargetOptions,
): NavigationTargetEvidence[] | undefined {
  return rawUpdate
    ? extractEnabledNavigationTargets(adaptMaxWebhookNavigationView(rawUpdate), options)
    : undefined;
}

export function extractEnabledNavigationTargets(
  view: MaxNavigationMessageView,
  options: EnabledNavigationTargetOptions,
): NavigationTargetEvidence[] {
  const extracted = extractNavigationEvidence(view, {
    plainTextCandidates: extractClientClickableTextEvidence(view),
  });

  return extracted.targets.flatMap((target) => {
    if (target.kind === 'profile_mention' && !options.profileMentionsEnabled) {
      return [];
    }

    const origins = target.origins.flatMap((origin) => {
      if (origin.provenance === 'visible_forward' && !options.forwardedTargetsEnabled) {
        return [];
      }
      if (origin.carrier === 'plain_text') {
        const explicitHttpTarget = /^https?:\/\//iu.test(origin.range.visibleText?.trim() ?? '');
        return [
          explicitHttpTarget ||
          options.textClickabilityEnabled ||
          origin.enforcement === 'shadow_only'
            ? origin
            : { ...origin, enforcement: 'shadow_only' as const },
        ];
      }
      return options.structuredTargetsEnabled ? [origin] : [];
    });
    if (origins.length === 0) {
      return [];
    }

    return [
      {
        ...target,
        origins,
        enforceable: origins.some((origin) => origin.enforcement === 'eligible'),
      },
    ];
  });
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    if (['0', 'false', 'no', 'off'].includes(normalized)) {
      return false;
    }
  }
  return fallback;
}
