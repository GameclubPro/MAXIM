import { z } from 'zod';
import { normalizeHttpButtonUrl } from './button-url.js';

export const CHANNEL_POST_SIGNATURE_DEFAULT_TEXT = 'Подписаться на канал';
export const CHANNEL_POST_SIGNATURE_TEXT_MAX_LENGTH = 120;
export const CHANNEL_POST_SIGNATURE_URL_MAX_LENGTH = 256;
export const CHANNEL_POST_BUTTON_TEXT_MAX_LENGTH = 32;

export const channelPostSignaturePresentationSchema = z.enum(['signature', 'button']);
export type ChannelPostSignaturePresentation = z.infer<
  typeof channelPostSignaturePresentationSchema
>;

function normalizeChannelPostSignatureUrl(value: string): string | null {
  const normalized = normalizeHttpButtonUrl(value);
  if (!normalized || normalized.length > CHANNEL_POST_SIGNATURE_URL_MAX_LENGTH) {
    return null;
  }

  const parsed = new URL(normalized);
  return parsed.username || parsed.password ? null : normalized;
}

export const channelPostSignatureUrlSchema = z
  .string()
  .trim()
  .max(CHANNEL_POST_SIGNATURE_URL_MAX_LENGTH)
  .refine((value) => value.length === 0 || normalizeChannelPostSignatureUrl(value) !== null, {
    message: 'Укажите корректную ссылку (http/https) без логина и пароля.',
  })
  .transform((value) => (value.length === 0 ? '' : normalizeChannelPostSignatureUrl(value)!));

export const channelPostSignatureSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    presentation: channelPostSignaturePresentationSchema.default('signature'),
    text: z
      .string()
      .trim()
      .min(1, 'Укажите текст ссылки на канал.')
      .max(CHANNEL_POST_SIGNATURE_TEXT_MAX_LENGTH)
      .default(CHANNEL_POST_SIGNATURE_DEFAULT_TEXT),
    url: channelPostSignatureUrlSchema.default(''),
  })
  .superRefine((value, ctx) => {
    if (value.presentation === 'button' && value.text.length > CHANNEL_POST_BUTTON_TEXT_MAX_LENGTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.too_big,
        maximum: CHANNEL_POST_BUTTON_TEXT_MAX_LENGTH,
        origin: 'string',
        inclusive: true,
        path: ['text'],
        message: `Текст кнопки не должен превышать ${CHANNEL_POST_BUTTON_TEXT_MAX_LENGTH} символа.`,
      });
    }
  });
export type ChannelPostSignatureSettings = z.infer<typeof channelPostSignatureSettingsSchema>;

export const updateChannelPostSignatureRequestSchema = z
  .object({
    enabled: z.boolean().optional(),
    presentation: channelPostSignaturePresentationSchema.optional(),
    text: z
      .string()
      .trim()
      .min(1, 'Укажите текст ссылки на канал.')
      .max(CHANNEL_POST_SIGNATURE_TEXT_MAX_LENGTH)
      .optional(),
    url: channelPostSignatureUrlSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Передайте хотя бы одну настройку.',
  });
export type UpdateChannelPostSignatureRequest = z.infer<
  typeof updateChannelPostSignatureRequestSchema
>;
