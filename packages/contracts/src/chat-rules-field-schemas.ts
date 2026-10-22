import { z } from 'zod';
import { storedLinkButtonDraftSchema } from './broadcast-buttons.js';
import {
  broadcastTextFormatSchema,
  MAX_BROADCAST_IMAGE_BASE64_LENGTH,
  MAX_BROADCAST_LINK_BUTTONS,
} from './broadcast-common.js';
import { botButtonTextSchema, botButtonUrlSchema } from './settings-message-field-schemas.js';

export const MAX_CHAT_RULES_TEXT_LENGTH = 4_000;
export const chatRulesFieldsSchema = z.object({
  revision: z.string().datetime().optional(),
  text: z.string().max(MAX_CHAT_RULES_TEXT_LENGTH).default(''),
  textFormat: broadcastTextFormatSchema.default('markdown'),
  imageBase64: z.string().trim().max(MAX_BROADCAST_IMAGE_BASE64_LENGTH).default(''),
  imageMimeType: z.string().trim().max(128).default(''),
  imageFileName: z.string().trim().max(128).default(''),
  autoTextEnabled: z.boolean().default(false),
  buttons: z.array(storedLinkButtonDraftSchema).max(MAX_BROADCAST_LINK_BUTTONS).default([]),
  buttonEnabled: z.boolean().default(false),
  buttonUrl: botButtonUrlSchema,
  buttonText: botButtonTextSchema,
  adminContactButtonEnabled: z.boolean().default(false),
  adminContactButtonUrl: botButtonUrlSchema,
  publishedMessageId: z.string().trim().min(1).nullable().default(null),
  publishedUrl: z.string().trim().max(2_048).nullable().default(null),
  publishedAt: z.string().datetime().nullable().default(null),
});
