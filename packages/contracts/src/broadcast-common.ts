import { z } from 'zod';

export const DEFAULT_BROADCAST_BUTTON_TEXT = 'Открыть';
export const MAX_BROADCAST_LINK_BUTTONS = 8;
export const MAX_BROADCAST_LINK_BUTTONS_PER_ROW = 3;
export const MAX_BROADCAST_IMAGES = 10;
export const MAX_BROADCAST_IMAGE_BASE64_LENGTH = 8_000_000;
export const MAX_BROADCAST_IMAGES_TOTAL_BASE64 = 24_000_000;

export const broadcastTextFormatSchema = z.enum(['plain', 'markdown']);
export type BroadcastTextFormat = z.infer<typeof broadcastTextFormatSchema>;

export const broadcastTargetModeSchema = z.enum(['current', 'selected', 'all']);
export type BroadcastTargetMode = z.infer<typeof broadcastTargetModeSchema>;

export const broadcastMediaTypeSchema = z.enum(['image', 'video']);
export type BroadcastMediaType = z.infer<typeof broadcastMediaTypeSchema>;

export const broadcastScheduleModeSchema = z.enum(['legacy', 'calendar']);
export type BroadcastScheduleMode = z.infer<typeof broadcastScheduleModeSchema>;

export const broadcastImageSchema = z
  .object({
    base64: z.string().trim().max(MAX_BROADCAST_IMAGE_BASE64_LENGTH).default(''),
    mimeType: z.string().trim().max(128).default(''),
    fileName: z.string().trim().max(128).default(''),
  })
  .superRefine((value, ctx) => {
    if (!value.base64) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['base64'],
        message: 'Добавьте фото.',
      });
    }

    if (!value.mimeType.trim() || !value.mimeType.toLowerCase().startsWith('image/')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mimeType'],
        message: 'Неверный формат фото.',
      });
    }
  });
export type BroadcastImage = z.infer<typeof broadcastImageSchema>;
