import { z } from 'zod';

export const CHANNEL_POST_SIGNATURE_DEFAULT_TEXT = 'Подписаться на канал';
export const CHANNEL_POST_SIGNATURE_TEXT_MAX_LENGTH = 120;
export const CHANNEL_POST_SIGNATURE_URL_MAX_LENGTH = 256;

export const channelPostSignatureSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  text: z
    .string()
    .trim()
    .min(1, 'Укажите текст ссылки на канал.')
    .max(CHANNEL_POST_SIGNATURE_TEXT_MAX_LENGTH)
    .default(CHANNEL_POST_SIGNATURE_DEFAULT_TEXT),
});
export type ChannelPostSignatureSettings = z.infer<typeof channelPostSignatureSettingsSchema>;

export const updateChannelPostSignatureRequestSchema = z
  .object({
    enabled: z.boolean().optional(),
    text: z
      .string()
      .trim()
      .min(1, 'Укажите текст ссылки на канал.')
      .max(CHANNEL_POST_SIGNATURE_TEXT_MAX_LENGTH)
      .optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Передайте хотя бы одну настройку.',
  });
export type UpdateChannelPostSignatureRequest = z.infer<
  typeof updateChannelPostSignatureRequestSchema
>;
