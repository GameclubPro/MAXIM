import { z } from 'zod';
import {
  botButtonTextSchema,
  botButtonUrlSchema,
  isValidBotButtonUrl,
  isValidBotButtonText,
} from './settings-message-field-schemas.js';
export {
  DEFAULT_BROADCAST_BUTTON_TEXT,
  MAX_BROADCAST_LINK_BUTTONS,
  MAX_BROADCAST_LINK_BUTTONS_PER_ROW,
} from './broadcast-common.js';

export const broadcastLinkButtonSchema = z
  .object({
    text: botButtonTextSchema,
    url: botButtonUrlSchema,
  })
  .superRefine((value, ctx) => {
    if (!isValidBotButtonUrl(value.url)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['url'],
        message: 'Укажите корректную ссылку для кнопки (http/https).',
      });
    }

    if (!isValidBotButtonText(value.text)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['text'],
        message: 'Введите название кнопки.',
      });
    }
  });

export type BroadcastLinkButton = z.infer<typeof broadcastLinkButtonSchema>;

export const storedLinkButtonDraftSchema = z.object({
  text: botButtonTextSchema,
  url: botButtonUrlSchema,
});
