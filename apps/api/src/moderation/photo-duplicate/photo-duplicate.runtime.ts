import type { ConfigService } from '@nestjs/config';

export const PHOTO_DUPLICATE_ROLLOUT_MODES = ['off', 'shadow', 'delete_only', 'full'] as const;

export type PhotoDuplicateRolloutMode = (typeof PHOTO_DUPLICATE_ROLLOUT_MODES)[number];
export type PhotoDuplicateMatchPreset = 'SAME_IMAGE' | 'MINOR_EDITS';
export type PhotoDuplicateScope = 'SAME_AUTHOR' | 'CHAT';

export type PhotoDuplicateRuntimePolicy = {
  mode: PhotoDuplicateRolloutMode;
  enforce: boolean;
  advancedCanary: boolean;
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
  if (mode === 'off' || mode === 'shadow') {
    return { mode, enforce: false, advancedCanary: false };
  }

  const enforcementChatIds = parseIdSet(
    params.configService?.get<string>('PHOTO_DUPLICATE_ENFORCEMENT_CHAT_IDS'),
  );
  if (!enforcementChatIds.has('*') && !enforcementChatIds.has(params.chatId)) {
    return { mode: 'shadow', enforce: false, advancedCanary: false };
  }

  const advancedCanaryChatIds = parseIdSet(
    params.configService?.get<string>('PHOTO_DUPLICATE_ADVANCED_CANARY_CHAT_IDS'),
  );
  const advancedCanary = advancedCanaryChatIds.has(params.chatId);
  if ((params.preset === 'MINOR_EDITS' || params.scope === 'CHAT') && !advancedCanary) {
    return { mode: 'shadow', enforce: false, advancedCanary: false };
  }

  return { mode, enforce: true, advancedCanary };
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
