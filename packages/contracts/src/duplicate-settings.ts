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
  .refine(
    (policy) => new Set(policy.allowedMatchKinds).size === policy.allowedMatchKinds.length,
    { path: ['allowedMatchKinds'] },
  )
  .refine(
    (policy) =>
      (policy.moderationMode !== 'DELETE_ONLY' && policy.moderationMode !== 'FULL') ||
      policy.allowedMatchKinds.some(
        (matchKind) => matchKind === 'canonical_sha256' || matchKind === 'pdq',
      ),
    { path: ['allowedMatchKinds'] },
  )
  .refine(
    (policy) =>
      policy.moderationMode !== 'FULL' || policy.actionCeiling !== 'DELETE_MESSAGE',
    { path: ['actionCeiling'] },
  );
export const duplicatePhotoPolicyMatrixSchema = z.object({
  base: duplicatePhotoEffectivePolicySchema,
  advanced: duplicatePhotoEffectivePolicySchema,
});

export type DuplicatePhotoMatchPreset = z.infer<typeof duplicatePhotoMatchPresetSchema>;
export type DuplicatePhotoScope = z.infer<typeof duplicatePhotoScopeSchema>;
export type DuplicatePhotoModerationMode = z.infer<typeof duplicatePhotoModerationModeSchema>;
export type DuplicatePhotoActionCeiling = z.infer<typeof duplicatePhotoActionCeilingSchema>;
export type DuplicatePhotoMatchKind = z.infer<typeof duplicatePhotoMatchKindSchema>;
export type DuplicatePhotoEffectivePolicy = z.infer<typeof duplicatePhotoEffectivePolicySchema>;
export type DuplicatePhotoPolicyMatrix = z.infer<typeof duplicatePhotoPolicyMatrixSchema>;
