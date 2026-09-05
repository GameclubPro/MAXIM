import { z } from 'zod';

export const duplicateDetectionPresetSchema = z.enum(['STANDARD', 'STRICT', 'CUSTOM']);
export const duplicatePhotoMatchPresetSchema = z.enum(['SAME_IMAGE', 'MINOR_EDITS']);
export const duplicatePhotoScopeSchema = z.enum(['SAME_AUTHOR', 'CHAT']);
export const duplicatePhotoModerationModeSchema = z.enum(['OFF', 'OBSERVE', 'DELETE_ONLY', 'FULL']);
export const duplicatePhotoActionCeilingSchema = z.enum(['DELETE_MESSAGE', 'WARN', 'MUTE', 'BAN']);
export const duplicatePhotoMatchKindSchema = z.enum(['platform_id', 'canonical_sha256', 'pdq']);
export const duplicatePhotoEffectivePolicySchema = z
  .object({
    moderationMode: duplicatePhotoModerationModeSchema,
    actionCeiling: duplicatePhotoActionCeilingSchema,
    allowedMatchKinds: z.array(duplicatePhotoMatchKindSchema).max(3),
  })
  .refine((policy) => new Set(policy.allowedMatchKinds).size === policy.allowedMatchKinds.length, {
    path: ['allowedMatchKinds'],
  })
  .refine(
    (policy) =>
      (policy.moderationMode !== 'DELETE_ONLY' && policy.moderationMode !== 'FULL') ||
      policy.allowedMatchKinds.some(
        (matchKind) => matchKind === 'canonical_sha256' || matchKind === 'pdq',
      ),
    { path: ['allowedMatchKinds'] },
  )
  .refine(
    (policy) => policy.moderationMode !== 'FULL' || policy.actionCeiling !== 'DELETE_MESSAGE',
    { path: ['actionCeiling'] },
  );
export const duplicatePhotoPolicyMatrixSchema = z.object({
  base: duplicatePhotoEffectivePolicySchema,
  advanced: duplicatePhotoEffectivePolicySchema,
});

export const DUPLICATE_ALLOWED_COUNT_MIN = 0;
export const DUPLICATE_THRESHOLD_MAX = 20;

export type DuplicateFlowStageSettings = {
  duplicateBotMessageEnabled: boolean;
  duplicateWarnEnabled: boolean;
  duplicateMuteEnabled: boolean;
  duplicateBanEnabled: boolean;
};

export type DuplicateFlowThresholdSettings = {
  duplicateWarnMaxCount: number;
  duplicateMuteMaxCount: number;
  duplicateBanMaxCount: number;
};

function resolveDuplicateFlowBaseOffset(settings: DuplicateFlowStageSettings): number {
  return settings.duplicateBotMessageEnabled ? 2 : 1;
}

export function resolveDuplicateFlowAllowedCountMax(settings: DuplicateFlowStageSettings): number {
  const enabledActionCount =
    Number(settings.duplicateWarnEnabled) +
    Number(settings.duplicateMuteEnabled) +
    Number(settings.duplicateBanEnabled);
  return Math.max(
    DUPLICATE_ALLOWED_COUNT_MIN,
    DUPLICATE_THRESHOLD_MAX -
      resolveDuplicateFlowBaseOffset(settings) -
      Math.max(0, enabledActionCount - 1),
  );
}

export function resolveDuplicateFlowAllowedCount(
  settings: DuplicateFlowStageSettings & DuplicateFlowThresholdSettings,
): number {
  const firstThreshold = settings.duplicateWarnEnabled
    ? settings.duplicateWarnMaxCount
    : settings.duplicateMuteEnabled
      ? settings.duplicateMuteMaxCount
      : settings.duplicateBanEnabled
        ? settings.duplicateBanMaxCount
        : settings.duplicateWarnMaxCount;
  return Math.max(
    DUPLICATE_ALLOWED_COUNT_MIN,
    Math.min(
      resolveDuplicateFlowAllowedCountMax(settings),
      firstThreshold - resolveDuplicateFlowBaseOffset(settings),
    ),
  );
}

export function buildDuplicateFlowThresholds(
  settings: DuplicateFlowStageSettings & { allowedCount: number },
): DuplicateFlowThresholdSettings {
  const allowedCount = Math.max(
    DUPLICATE_ALLOWED_COUNT_MIN,
    Math.min(resolveDuplicateFlowAllowedCountMax(settings), Math.round(settings.allowedCount)),
  );
  let nextThreshold = allowedCount + resolveDuplicateFlowBaseOffset(settings);
  const duplicateWarnMaxCount = Math.min(DUPLICATE_THRESHOLD_MAX, nextThreshold);
  if (settings.duplicateWarnEnabled) {
    nextThreshold += 1;
  }
  const duplicateMuteMaxCount = Math.min(DUPLICATE_THRESHOLD_MAX, nextThreshold);
  if (settings.duplicateMuteEnabled) {
    nextThreshold += 1;
  }
  const duplicateBanMaxCount = Math.min(DUPLICATE_THRESHOLD_MAX, nextThreshold);

  return {
    duplicateWarnMaxCount,
    duplicateMuteMaxCount,
    duplicateBanMaxCount,
  };
}

export function resolveDuplicateTextRuleSubjects(settings: {
  duplicateDetectionPreset: z.infer<typeof duplicateDetectionPresetSchema>;
  duplicateIgnoreLinksEnabled: boolean;
  duplicateIgnorePhonesEnabled: boolean;
  duplicateNearMatchEnabled: boolean;
}): string[] {
  const custom = settings.duplicateDetectionPreset === 'CUSTOM';
  return [
    settings.duplicateDetectionPreset === 'STRICT' || (custom && settings.duplicateNearMatchEnabled)
      ? 'одинаковые и похожие сообщения'
      : 'одинаковые сообщения',
    custom && settings.duplicateIgnoreLinksEnabled ? 'одни и те же ссылки' : '',
    custom && settings.duplicateIgnorePhonesEnabled ? 'одни и те же номера телефонов' : '',
  ].filter(Boolean);
}

export type DuplicatePhotoMatchPreset = z.infer<typeof duplicatePhotoMatchPresetSchema>;
export type DuplicatePhotoScope = z.infer<typeof duplicatePhotoScopeSchema>;
export type DuplicatePhotoModerationMode = z.infer<typeof duplicatePhotoModerationModeSchema>;
export type DuplicatePhotoActionCeiling = z.infer<typeof duplicatePhotoActionCeilingSchema>;
export type DuplicatePhotoMatchKind = z.infer<typeof duplicatePhotoMatchKindSchema>;
export type DuplicatePhotoEffectivePolicy = z.infer<typeof duplicatePhotoEffectivePolicySchema>;
export type DuplicatePhotoPolicyMatrix = z.infer<typeof duplicatePhotoPolicyMatrixSchema>;
