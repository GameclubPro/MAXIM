import type { ConfigService } from '@nestjs/config';
import type { DuplicateAction } from '../rule-engine.contract';

export const PHOTO_DUPLICATE_ROLLOUT_MODES = ['off', 'shadow', 'delete_only', 'full'] as const;
export const PHOTO_DUPLICATE_MATCH_KINDS = ['platform_id', 'canonical_sha256', 'pdq'] as const;
export const PHOTO_DUPLICATE_ENFORCEABLE_MATCH_KINDS = ['canonical_sha256', 'pdq'] as const;
export const PHOTO_DUPLICATE_MAX_ACTIONS = ['DELETE_MESSAGE', 'WARN', 'MUTE', 'BAN'] as const;

export type PhotoDuplicateRolloutMode = (typeof PHOTO_DUPLICATE_ROLLOUT_MODES)[number];
export type PhotoDuplicateMatchPreset = 'SAME_IMAGE' | 'MINOR_EDITS';
export type PhotoDuplicateScope = 'SAME_AUTHOR' | 'CHAT';
export type PhotoDuplicateMatchKind = (typeof PHOTO_DUPLICATE_MATCH_KINDS)[number];
export type PhotoDuplicateMaxAction = (typeof PHOTO_DUPLICATE_MAX_ACTIONS)[number];

export type PhotoDuplicateRuntimePolicy = {
  mode: PhotoDuplicateRolloutMode;
  enforce: boolean;
  advancedCanary: boolean;
  allowedMatchKinds: readonly PhotoDuplicateMatchKind[];
  maxAction: PhotoDuplicateMaxAction;
};

const PHOTO_DUPLICATE_MAX_ACTION_RANK: Record<PhotoDuplicateMaxAction, number> = {
  DELETE_MESSAGE: 0,
  WARN: 1,
  MUTE: 2,
  BAN: 3,
};

export function resolvePhotoDuplicateRolloutMode(
  configService?: Pick<ConfigService, 'get'>,
): PhotoDuplicateRolloutMode {
  const value = configService?.get<string>('PHOTO_DUPLICATE_ROLLOUT_MODE');
  return PHOTO_DUPLICATE_ROLLOUT_MODES.includes(value as PhotoDuplicateRolloutMode)
    ? (value as PhotoDuplicateRolloutMode)
    : 'shadow';
}

export function resolvePhotoDuplicateRuntimePolicy(params: {
  chatId: string;
  preset: PhotoDuplicateMatchPreset;
  scope: PhotoDuplicateScope;
  configService?: Pick<ConfigService, 'get'>;
}): PhotoDuplicateRuntimePolicy {
  const mode = resolvePhotoDuplicateRolloutMode(params.configService);
  const ceilings = {
    allowedMatchKinds: resolvePhotoDuplicateAllowedMatchKinds(params.configService),
    maxAction: resolvePhotoDuplicateMaxAction(params.configService),
  };
  if (mode === 'off' || mode === 'shadow') {
    return { mode, enforce: false, advancedCanary: false, ...ceilings };
  }

  const enforcementChatIds = parseIdSet(
    params.configService?.get<string>('PHOTO_DUPLICATE_ENFORCEMENT_CHAT_IDS'),
  );
  // FLAG: Photo enforcement is canary-only. Wildcards must never turn a rollout mode into a
  // global mutation switch; every enforced chat id must be listed explicitly.
  if (!enforcementChatIds.has(params.chatId)) {
    return { mode: 'shadow', enforce: false, advancedCanary: false, ...ceilings };
  }

  const advancedCanaryChatIds = parseIdSet(
    params.configService?.get<string>('PHOTO_DUPLICATE_ADVANCED_CANARY_CHAT_IDS'),
  );
  const advancedCanary = advancedCanaryChatIds.has(params.chatId);
  if ((params.preset === 'MINOR_EDITS' || params.scope === 'CHAT') && !advancedCanary) {
    return { mode: 'shadow', enforce: false, advancedCanary: false, ...ceilings };
  }

  return { mode, enforce: true, advancedCanary, ...ceilings };
}

export function resolvePhotoDuplicateAllowedMatchKinds(
  configService?: Pick<ConfigService, 'get'>,
): readonly PhotoDuplicateMatchKind[] {
  const configured = configService?.get<string>('PHOTO_DUPLICATE_ALLOWED_MATCH_KINDS');
  if (configured === undefined) {
    return ['canonical_sha256'];
  }
  if (typeof configured !== 'string') {
    return [];
  }
  const requested = new Set(
    configured
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
  return PHOTO_DUPLICATE_ENFORCEABLE_MATCH_KINDS.filter((kind) => requested.has(kind));
}

export function resolvePhotoDuplicateMaxAction(
  configService?: Pick<ConfigService, 'get'>,
): PhotoDuplicateMaxAction {
  const configured = configService?.get<string>('PHOTO_DUPLICATE_MAX_ACTION');
  return PHOTO_DUPLICATE_MAX_ACTIONS.includes(configured as PhotoDuplicateMaxAction)
    ? (configured as PhotoDuplicateMaxAction)
    : 'DELETE_MESSAGE';
}

export function isPhotoDuplicateMatchKindAllowed(
  policy: Pick<PhotoDuplicateRuntimePolicy, 'allowedMatchKinds'>,
  matchKind: PhotoDuplicateMatchKind | null,
): boolean {
  return matchKind !== null && policy.allowedMatchKinds.includes(matchKind);
}

export function capPhotoDuplicateAction(
  action: DuplicateAction,
  maxAction: PhotoDuplicateMaxAction,
): DuplicateAction | null {
  if (maxAction === 'DELETE_MESSAGE') {
    return null;
  }
  return PHOTO_DUPLICATE_MAX_ACTION_RANK[action] <= PHOTO_DUPLICATE_MAX_ACTION_RANK[maxAction]
    ? action
    : maxAction;
}

export function restrictPhotoDuplicateMaxAction(
  first: PhotoDuplicateMaxAction,
  ...rest: PhotoDuplicateMaxAction[]
): PhotoDuplicateMaxAction {
  return rest.reduce(
    (mostRestrictive, action) =>
      PHOTO_DUPLICATE_MAX_ACTION_RANK[action] < PHOTO_DUPLICATE_MAX_ACTION_RANK[mostRestrictive]
        ? action
        : mostRestrictive,
    first,
  );
}

function parseIdSet(value: unknown): Set<string> {
  if (typeof value !== 'string') {
    return new Set();
  }
  return new Set(
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
}
