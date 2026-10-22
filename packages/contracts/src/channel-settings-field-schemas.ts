import { z } from 'zod';
import {
  botButtonUrlSchema,
  botMessageTextSchema,
  isValidBotButtonUrl,
  isValidBotButtonText,
} from './settings-message-field-schemas.js';

export const channelSuggestionEntryModeSchema = z.enum(['BOT', 'MINIAPP']);

export type ChannelSuggestionEntryMode = z.infer<typeof channelSuggestionEntryModeSchema>;

export const channelSettingsSchema = z
  .object({
    revision: z.number().int().nonnegative().optional(),
    quickButtonsEnabled: z.boolean().default(false),
    postSuggestionsEnabled: z.boolean().default(false),
    postSuggestionsRequireSubscription: z.boolean().default(false),
    postSuggestionsDeleteOnUnsubscribe: z.boolean().default(false),
    postSuggestionsText: botMessageTextSchema,
    postSuggestionsDailyLimit: z.number().int().min(1).max(10).default(10),
    postSuggestionsEntryMode: channelSuggestionEntryModeSchema.default('BOT'),
    engagementMessageText: botMessageTextSchema.default(
      'Есть идея или обратная связь? Нажмите кнопку ниже.',
    ),
    postSuggestionsButtonEnabled: z.boolean().default(false),
    postSuggestionsButtonText: z.string().trim().max(32).default('Предложить пост'),
    postSuggestionsButtonUrl: botButtonUrlSchema,
    commentsEnabled: z.boolean().default(false),
    commentsModerationEnabled: z.boolean().default(false),
    commentsBlockLinksEnabled: z.boolean().default(false),
    commentsAntiSpamEnabled: z.boolean().default(false),
    commentsLimitTwoInRowEnabled: z.boolean().default(false),
    commentsMessageText: botMessageTextSchema,
  })
  .superRefine((value, ctx) => {
    if (
      value.postSuggestionsEnabled &&
      value.postSuggestionsButtonEnabled &&
      !isValidBotButtonUrl(value.postSuggestionsButtonUrl)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['postSuggestionsButtonUrl'],
        message: 'Укажите корректную ссылку для кнопки (http/https).',
      });
    }

    if (
      value.postSuggestionsEnabled &&
      value.postSuggestionsButtonEnabled &&
      !isValidBotButtonText(value.postSuggestionsButtonText)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['postSuggestionsButtonText'],
        message: 'Введите название кнопки.',
      });
    }
  });

export type ChannelSettings = z.infer<typeof channelSettingsSchema>;
