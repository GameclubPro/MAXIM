import { z } from 'zod';
import type { ChatSettings } from '../../prisma/prisma-client';
import { resolveDuplicateFlowConfig } from '../duplicate-flow-policy';
import { digestDuplicateContent } from './message-duplicate-content';
import { PHOTO_FINGERPRINT_ALGORITHM_VERSION } from '../photo-duplicate/photo-fingerprint-version';

export const MESSAGE_DUPLICATE_SOURCE = 'message_v1';
export const MESSAGE_DUPLICATE_MEDIA_VERSION = `sha256-v1:${PHOTO_FINGERPRINT_ALGORITHM_VERSION}`;
export const MESSAGE_DUPLICATE_CLAIM_PREFIX = 'message-duplicate-action:v1:';
export const messageDuplicateOriginalSchema = z
  .object({
    member: z.string().regex(/^[a-f0-9]{64}$/),
    author: z.string().regex(/^[a-f0-9]{64}$/),
    messageId: z.string().min(1).max(512),
    senderId: z.string().min(1).max(160),
    publishedAtMs: z.number().int().positive(),
    observedAtMs: z.number().int().positive(),
    expiresAtMs: z.number().int().positive(),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
    contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
    mediaHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(10),
    epoch: z.number().int().nonnegative(),
  })
  .strict();

export const messageDuplicateBindingSchema = z
  .object({
    version: z.union([z.literal(1), z.literal(2)]),
    original: messageDuplicateOriginalSchema.optional(),
    sanction: z
      .object({
        action: z.enum(['WARN', 'MUTE', 'BAN']),
        repeatCount: z.number().int().min(1).max(20),
        threshold: z.number().int().min(1).max(20),
        settingsDigest: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .optional(),
    senderId: z.string().min(1).max(160),
    messageId: z.string().min(1).max(512),
    eventTimestampMs: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER / 2 - 1),
    controlRevision: z.number().int().positive(),
    settingsDigest: z.string().regex(/^[a-f0-9]{64}$/),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
    contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    compareMode: z.enum(['MESSAGE', 'TEXT', 'IMAGE']),
    imageScope: z.enum(['SAME_AUTHOR', 'CHAT']).optional(),
    mediaHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(10),
    mediaVersion: z.literal(MESSAGE_DUPLICATE_MEDIA_VERSION),
    hasPhotos: z.boolean(),
    photoControlRevision: z.number().int().positive().nullable(),
    windowSeconds: z.number().int().positive().max(604800),
    requiredCount: z.number().int().min(2).max(21),
  })
  .strict()
  .refine((value) => value.version === 2 || value.sanction === undefined)
  .refine((value) =>
    value.compareMode === 'IMAGE'
      ? value.version === 2 &&
        value.imageScope !== undefined &&
        value.hasPhotos &&
        value.mediaHashes.length > 0 &&
        value.photoControlRevision === null &&
        value.requiredCount >= 2
      : value.imageScope === undefined,
  );
export type MessageDuplicateBinding = z.infer<typeof messageDuplicateBindingSchema>;

export function parseMessageDuplicateBinding(value: unknown): MessageDuplicateBinding | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const metadata = value as Record<string, unknown>;
  if (metadata.duplicateSource !== MESSAGE_DUPLICATE_SOURCE) return null;
  const result = messageDuplicateBindingSchema.safeParse(metadata.messageDuplicate);
  return result.success ? result.data : null;
}

export function isBoundMessageDuplicateDelete(input: {
  ruleCode?: string;
  reasonKey: string;
  event?: { metadata?: unknown };
}): boolean {
  const binding = parseMessageDuplicateBinding(input.event?.metadata);
  const metadata = input.event?.metadata as Record<string, unknown> | undefined;
  return (
    input.ruleCode === 'DUPLICATE_DELETE' &&
    input.reasonKey.startsWith('MESSAGE_DUPLICATE:') &&
    binding !== null &&
    metadata?.enforcementScope === (binding.version === 2 ? 'full' : 'delete_only')
  );
}

export function messageDuplicateSettingsDigest(settings: ChatSettings): string {
  const flow = resolveDuplicateFlowConfig(settings);
  return digestDuplicateContent({
    version: 'text-fixed-window-v4',
    enabled: settings.antiDuplicateEnabled,
    mode: settings.duplicateCompareMode ?? 'MESSAGE',
    preset: settings.duplicateDetectionPreset,
    links: settings.duplicateIgnoreLinksEnabled,
    phones: settings.duplicateIgnorePhonesEnabled,
    near: settings.duplicateNearMatchEnabled,
    window: flow.windowSec,
    allowed: flow.allowedCount,
  });
}

export function messageDuplicateSanctionSettingsDigest(
  settings: ChatSettings,
  imageOnly = false,
): string {
  return digestDuplicateContent({
    settings: imageOnly
      ? exactImageSettingsDigest(settings)
      : messageDuplicateSettingsDigest(settings),
    reactions: resolveDuplicateFlowConfig(settings).reactions,
    muteHours: settings.duplicateMuteDurationHours,
  });
}

export function exactImageSettingsDigest(settings: ChatSettings): string {
  return digestDuplicateContent({
    version: 'exact-image-fixed-window-v2',
    enabled: settings.antiDuplicateEnabled && settings.duplicateCompareMode !== 'TEXT',
    scope: settings.duplicatePhotoScope,
    window: resolveDuplicateFlowConfig(settings).windowSec,
    allowed: resolveDuplicateFlowConfig(settings).allowedCount,
  });
}
