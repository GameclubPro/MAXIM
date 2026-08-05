import { z } from 'zod';

export const duplicateDetectionPresetSchema = z.enum(['STANDARD', 'STRICT', 'CUSTOM']);
export const duplicatePhotoMatchPresetSchema = z.enum(['SAME_IMAGE', 'MINOR_EDITS']);
export const duplicatePhotoScopeSchema = z.enum(['SAME_AUTHOR', 'CHAT']);
export const duplicatePhotoModerationModeSchema = z.enum(['OFF', 'OBSERVE', 'DELETE_ONLY', 'FULL']);

export type DuplicatePhotoMatchPreset = z.infer<typeof duplicatePhotoMatchPresetSchema>;
export type DuplicatePhotoScope = z.infer<typeof duplicatePhotoScopeSchema>;
export type DuplicatePhotoModerationMode = z.infer<typeof duplicatePhotoModerationModeSchema>;
