import { z } from 'zod';
import {
  MAX_PUBLICATION_BUTTONS,
  MAX_PUBLICATION_IMAGE_BASE64_LENGTH,
  MAX_PUBLICATION_IMAGES,
  MAX_PUBLICATION_IMAGES_TOTAL_BASE64_LENGTH,
  MAX_PUBLICATION_TEXT_LENGTH,
  publicationButtonSchema,
  publicationTextFormatSchema,
  type PublicationButton,
} from './publication.js';

export const MAX_PUBLISHER_AUTO_REPLY_PHRASE_LENGTH = 80;
export const MAX_PUBLISHER_AUTO_REPLY_PHRASES = 10;
export const MAX_PUBLISHER_AUTO_REPLY_PHRASES_TOTAL_LENGTH = 400;
export const MAX_PUBLISHER_AUTO_REPLY_PREVIEW_MESSAGE_LENGTH = 4_096;
export const MAX_PUBLISHER_AUTO_REPLY_TEXT_LENGTH = MAX_PUBLICATION_TEXT_LENGTH;
export const MAX_PUBLISHER_AUTO_REPLY_IMAGES = MAX_PUBLICATION_IMAGES;
export const MAX_PUBLISHER_AUTO_REPLY_BUTTONS = MAX_PUBLICATION_BUTTONS;
export const MAX_PUBLISHER_AUTO_REPLY_COOLDOWN_SECONDS = 86_400;
export const DEFAULT_PUBLISHER_AUTO_REPLY_COOLDOWN_SECONDS = 30;
export const MAX_PUBLISHER_AUTO_REPLY_REQUEST_ID_LENGTH = 128;

export function normalizePublisherAutoReplyPhraseDisplay(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

export function normalizePublisherAutoReplyPhrase(value: string): string {
  return normalizePublisherAutoReplyPhraseDisplay(value).toLocaleLowerCase('ru-RU');
}

export const publisherAutoReplyPhraseSchema = z
  .string()
  .transform(normalizePublisherAutoReplyPhraseDisplay)
  .pipe(z.string().min(1).max(MAX_PUBLISHER_AUTO_REPLY_PHRASE_LENGTH))
  .superRefine((phrase, context) => {
    if (
      Array.from(normalizePublisherAutoReplyPhrase(phrase)).length >
      MAX_PUBLISHER_AUTO_REPLY_PHRASE_LENGTH
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Нормализованная фраза слишком длинная.',
      });
    }
  });

export const publisherAutoReplyPhrasesSchema = z
  .array(publisherAutoReplyPhraseSchema)
  .min(1)
  .max(MAX_PUBLISHER_AUTO_REPLY_PHRASES)
  .superRefine((phrases, context) => {
    const normalizedPhrases = phrases.map(normalizePublisherAutoReplyPhrase);
    const seen = new Set<string>();
    let totalNormalizedLength = 0;

    normalizedPhrases.forEach((normalizedPhrase, index) => {
      const normalizedLength = Array.from(normalizedPhrase).length;
      totalNormalizedLength += normalizedLength;
      if (normalizedLength > MAX_PUBLISHER_AUTO_REPLY_PHRASE_LENGTH) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: 'Нормализованная фраза слишком длинная.',
        });
      }
      if (seen.has(normalizedPhrase)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: 'Фразы должны отличаться.',
        });
      }
      seen.add(normalizedPhrase);
    });

    if (totalNormalizedLength > MAX_PUBLISHER_AUTO_REPLY_PHRASES_TOTAL_LENGTH) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Суммарная длина фраз слишком большая.',
      });
    }
  });
export type PublisherAutoReplyPhrases = z.infer<typeof publisherAutoReplyPhrasesSchema>;

export const publisherAutoReplyRequestIdSchema = z
  .string()
  .trim()
  .min(8)
  .max(MAX_PUBLISHER_AUTO_REPLY_REQUEST_ID_LENGTH)
  .regex(/^[A-Za-z0-9_-]+$/u);

export const publisherAutoReplyInlineImageSchema = z
  .object({
    type: z.literal('image'),
    base64: z.string().trim().min(1).max(MAX_PUBLICATION_IMAGE_BASE64_LENGTH),
    mimeType: z.string().trim().toLowerCase().startsWith('image/').max(128),
    fileName: z.string().trim().max(128).default(''),
  })
  .strict();

export const publisherAutoReplyImageReferenceSchema = z
  .object({
    type: z.literal('image-ref'),
    assetId: z.string().trim().min(1).max(256),
  })
  .strict();

export const publisherAutoReplyImageInputSchema = z.discriminatedUnion('type', [
  publisherAutoReplyInlineImageSchema,
  publisherAutoReplyImageReferenceSchema,
]);
export type PublisherAutoReplyImageInput = z.infer<typeof publisherAutoReplyImageInputSchema>;

export const publisherAutoReplyButtonSchema = publicationButtonSchema;
export type PublisherAutoReplyButton = PublicationButton;

export const publisherAutoReplyContentInputSchema = z
  .object({
    text: z.string().max(MAX_PUBLISHER_AUTO_REPLY_TEXT_LENGTH).default(''),
    textFormat: publicationTextFormatSchema.default('plain'),
    images: z
      .array(publisherAutoReplyImageInputSchema)
      .max(MAX_PUBLISHER_AUTO_REPLY_IMAGES)
      .default([]),
    buttons: z
      .array(publisherAutoReplyButtonSchema)
      .max(MAX_PUBLISHER_AUTO_REPLY_BUTTONS)
      .default([]),
  })
  .strict()
  .superRefine((value, context) => {
    const totalInlineLength = value.images.reduce(
      (total, image) => total + (image.type === 'image' ? image.base64.length : 0),
      0,
    );
    if (totalInlineLength > MAX_PUBLICATION_IMAGES_TOTAL_BASE64_LENGTH) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['images'],
        message: 'Суммарный размер фото слишком большой.',
      });
    }
    if (value.text.trim().length === 0 && value.images.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['text'],
        message: 'Введите текст или добавьте фото.',
      });
    }
    const retainedIds = value.images
      .filter(
        (image): image is z.infer<typeof publisherAutoReplyImageReferenceSchema> =>
          image.type === 'image-ref',
      )
      .map((image) => image.assetId);
    if (new Set(retainedIds).size !== retainedIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['images'],
        message: 'Одно и то же фото добавлено несколько раз.',
      });
    }
  });
export type PublisherAutoReplyContentInput = z.infer<typeof publisherAutoReplyContentInputSchema>;

export const publisherAutoReplyAssetSchema = z
  .object({
    id: z.string().trim().min(1),
    mimeType: z.string().trim().min(1),
    fileName: z.string(),
    sizeBytes: z.number().int().min(1),
    previewUrl: z.string().trim().min(1),
  })
  .strict();
export type PublisherAutoReplyAsset = z.infer<typeof publisherAutoReplyAssetSchema>;

export const publisherAutoReplyContentSchema = z
  .object({
    id: z.string().trim().min(1),
    revision: z.number().int().min(1),
    text: z.string().max(MAX_PUBLISHER_AUTO_REPLY_TEXT_LENGTH),
    textFormat: publicationTextFormatSchema,
    images: z.array(publisherAutoReplyAssetSchema).max(MAX_PUBLISHER_AUTO_REPLY_IMAGES),
    buttons: z
      .array(publisherAutoReplyButtonSchema)
      .max(MAX_PUBLISHER_AUTO_REPLY_BUTTONS)
      .default([]),
    createdAt: z.string().datetime(),
  })
  .strict();
export type PublisherAutoReplyContent = z.infer<typeof publisherAutoReplyContentSchema>;

export const publisherAutoReplyRuleSchema = z
  .object({
    id: z.string().trim().min(1),
    chatId: z.string().trim().min(1),
    phrase: publisherAutoReplyPhraseSchema,
    enabled: z.boolean(),
    cooldownSeconds: z.number().int().min(0).max(MAX_PUBLISHER_AUTO_REPLY_COOLDOWN_SECONDS),
    version: z.number().int().min(1),
    currentContentRevisionId: z.string().trim().min(1),
    content: publisherAutoReplyContentSchema,
    createdByUserId: z.string().trim().min(1),
    updatedByUserId: z.string().trim().min(1),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    archivedAt: z.string().datetime().nullable(),
  })
  .strict();
export type PublisherAutoReplyRule = z.infer<typeof publisherAutoReplyRuleSchema>;

export const publisherAutoReplyRuleV2Schema = publisherAutoReplyRuleSchema
  .omit({ phrase: true })
  .extend({
    phrases: publisherAutoReplyPhrasesSchema,
    matchInContext: z.boolean(),
    fuzzyMatch: z.boolean(),
  })
  .strict();
export type PublisherAutoReplyRuleV2 = z.infer<typeof publisherAutoReplyRuleV2Schema>;

export const publisherAutoReplyListResponseSchema = z
  .object({
    items: z.array(publisherAutoReplyRuleSchema),
    total: z.number().int().min(0),
  })
  .strict();
export type PublisherAutoReplyListResponse = z.infer<typeof publisherAutoReplyListResponseSchema>;

export const publisherAutoReplyListResponseV2Schema = z
  .object({
    items: z.array(publisherAutoReplyRuleV2Schema),
    total: z.number().int().min(0),
  })
  .strict();
export type PublisherAutoReplyListResponseV2 = z.infer<
  typeof publisherAutoReplyListResponseV2Schema
>;

export const createPublisherAutoReplyRequestSchema = z
  .object({
    requestId: publisherAutoReplyRequestIdSchema,
    phrase: publisherAutoReplyPhraseSchema,
    enabled: z.boolean().default(true),
    cooldownSeconds: z
      .number()
      .int()
      .min(0)
      .max(MAX_PUBLISHER_AUTO_REPLY_COOLDOWN_SECONDS)
      .default(DEFAULT_PUBLISHER_AUTO_REPLY_COOLDOWN_SECONDS),
    content: publisherAutoReplyContentInputSchema,
  })
  .strict();
export type CreatePublisherAutoReplyRequest = z.infer<typeof createPublisherAutoReplyRequestSchema>;

export const createPublisherAutoReplyV2RequestSchema = z
  .object({
    requestId: publisherAutoReplyRequestIdSchema,
    phrases: publisherAutoReplyPhrasesSchema,
    matchInContext: z.boolean().default(false),
    fuzzyMatch: z.boolean().default(false),
    enabled: z.boolean().default(true),
    cooldownSeconds: z
      .number()
      .int()
      .min(0)
      .max(MAX_PUBLISHER_AUTO_REPLY_COOLDOWN_SECONDS)
      .default(DEFAULT_PUBLISHER_AUTO_REPLY_COOLDOWN_SECONDS),
    content: publisherAutoReplyContentInputSchema,
  })
  .strict();
export type CreatePublisherAutoReplyV2Request = z.infer<
  typeof createPublisherAutoReplyV2RequestSchema
>;

export const updatePublisherAutoReplyRequestSchema = z
  .object({
    requestId: publisherAutoReplyRequestIdSchema,
    expectedVersion: z.number().int().min(1),
    phrase: publisherAutoReplyPhraseSchema.optional(),
    enabled: z.boolean().optional(),
    cooldownSeconds: z
      .number()
      .int()
      .min(0)
      .max(MAX_PUBLISHER_AUTO_REPLY_COOLDOWN_SECONDS)
      .optional(),
    content: publisherAutoReplyContentInputSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.phrase !== undefined ||
      value.enabled !== undefined ||
      value.cooldownSeconds !== undefined ||
      value.content !== undefined,
    'Specify at least one auto-reply change',
  );
export type UpdatePublisherAutoReplyRequest = z.infer<typeof updatePublisherAutoReplyRequestSchema>;

export const updatePublisherAutoReplyV2RequestSchema = z
  .object({
    requestId: publisherAutoReplyRequestIdSchema,
    expectedVersion: z.number().int().min(1),
    phrases: publisherAutoReplyPhrasesSchema.optional(),
    matchInContext: z.boolean().optional(),
    fuzzyMatch: z.boolean().optional(),
    enabled: z.boolean().optional(),
    cooldownSeconds: z
      .number()
      .int()
      .min(0)
      .max(MAX_PUBLISHER_AUTO_REPLY_COOLDOWN_SECONDS)
      .optional(),
    content: publisherAutoReplyContentInputSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.phrases !== undefined ||
      value.matchInContext !== undefined ||
      value.fuzzyMatch !== undefined ||
      value.enabled !== undefined ||
      value.cooldownSeconds !== undefined ||
      value.content !== undefined,
    'Specify at least one auto-reply change',
  );
export type UpdatePublisherAutoReplyV2Request = z.infer<
  typeof updatePublisherAutoReplyV2RequestSchema
>;

export const publisherAutoReplyMatchKindSchema = z.enum([
  'exact_full',
  'exact_context',
  'fuzzy_full',
  'fuzzy_context',
]);
export type PublisherAutoReplyMatchKind = z.infer<typeof publisherAutoReplyMatchKindSchema>;

export const publisherAutoReplyPreviewDraftSchema = z
  .object({
    ruleId: z.string().trim().min(1).optional(),
    phrases: publisherAutoReplyPhrasesSchema,
    matchInContext: z.boolean().default(false),
    fuzzyMatch: z.boolean().default(false),
    enabled: z.boolean().default(true),
  })
  .strict();
export type PublisherAutoReplyPreviewDraft = z.infer<typeof publisherAutoReplyPreviewDraftSchema>;

export const publisherAutoReplyPreviewRequestSchema = z
  .object({
    message: z.string().max(MAX_PUBLISHER_AUTO_REPLY_PREVIEW_MESSAGE_LENGTH),
    draft: publisherAutoReplyPreviewDraftSchema.optional(),
  })
  .strict();
export type PublisherAutoReplyPreviewRequest = z.infer<
  typeof publisherAutoReplyPreviewRequestSchema
>;

export const publisherAutoReplyPreviewOutcomeSchema = z.enum(['no_match', 'matched', 'ambiguous']);
export type PublisherAutoReplyPreviewOutcome = z.infer<
  typeof publisherAutoReplyPreviewOutcomeSchema
>;

export const publisherAutoReplyPreviewSelectionSchema = z
  .object({
    ruleId: z.string().trim().min(1).nullable(),
    phrase: publisherAutoReplyPhraseSchema,
    matchKind: publisherAutoReplyMatchKindSchema,
    distance: z.number().int().min(0),
    matchedDraft: z.boolean(),
  })
  .strict();
export type PublisherAutoReplyPreviewSelection = z.infer<
  typeof publisherAutoReplyPreviewSelectionSchema
>;

export const publisherAutoReplyPreviewResponseSchema = z
  .object({
    outcome: publisherAutoReplyPreviewOutcomeSchema,
    selected: publisherAutoReplyPreviewSelectionSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.outcome === 'matched') !== (value.selected !== null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['selected'],
        message: 'Matched preview outcomes require one selected rule.',
      });
    }
    if (value.selected && value.selected.matchedDraft !== (value.selected.ruleId === null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['selected', 'matchedDraft'],
        message: 'Draft match provenance is inconsistent.',
      });
    }
  });
export type PublisherAutoReplyPreviewResponse = z.infer<
  typeof publisherAutoReplyPreviewResponseSchema
>;

export const archivePublisherAutoReplyRequestSchema = z
  .object({
    requestId: publisherAutoReplyRequestIdSchema,
    expectedVersion: z.number().int().min(1),
  })
  .strict();
export type ArchivePublisherAutoReplyRequest = z.infer<
  typeof archivePublisherAutoReplyRequestSchema
>;

export const archivePublisherAutoReplyResponseSchema = z
  .object({
    id: z.string().trim().min(1),
    archived: z.literal(true),
    version: z.number().int().min(2),
    archivedAt: z.string().datetime(),
  })
  .strict();
export type ArchivePublisherAutoReplyResponse = z.infer<
  typeof archivePublisherAutoReplyResponseSchema
>;

export const publisherAutoReplyAuthoringStateSchema = z.enum([
  'awaiting_start',
  'awaiting_phrase',
  'awaiting_content',
  'processing',
  'review',
  'saving',
  'completed',
  'canceled',
  'failed',
  'expired',
]);
export type PublisherAutoReplyAuthoringState = z.infer<
  typeof publisherAutoReplyAuthoringStateSchema
>;

export const publisherAutoReplyAuthoringSessionSchema = z
  .object({
    id: z.string().trim().min(1),
    state: publisherAutoReplyAuthoringStateSchema,
    targetChatId: z.string().trim().min(1).nullable(),
    phrase: publisherAutoReplyPhraseSchema.nullable(),
    ruleId: z.string().trim().min(1).nullable(),
    contentRevisionId: z.string().trim().min(1).nullable(),
    expiresAt: z.string().datetime(),
  })
  .strict();
export type PublisherAutoReplyAuthoringSession = z.infer<
  typeof publisherAutoReplyAuthoringSessionSchema
>;

export const createPublisherAutoReplyAuthoringSessionRequestSchema = z
  .object({ requestId: publisherAutoReplyRequestIdSchema })
  .strict();
export type CreatePublisherAutoReplyAuthoringSessionRequest = z.infer<
  typeof createPublisherAutoReplyAuthoringSessionRequestSchema
>;

export const publisherAutoReplyAuthoringSessionResponseSchema = z
  .object({
    session: publisherAutoReplyAuthoringSessionSchema,
    botUrl: z.string().url().nullable(),
  })
  .strict();
export type PublisherAutoReplyAuthoringSessionResponse = z.infer<
  typeof publisherAutoReplyAuthoringSessionResponseSchema
>;

export const publisherAutoReplyAuthoringSessionCurrentResponseSchema = z
  .object({
    session: publisherAutoReplyAuthoringSessionSchema.nullable(),
    botUrl: z.string().url().nullable(),
  })
  .strict();
export type PublisherAutoReplyAuthoringSessionCurrentResponse = z.infer<
  typeof publisherAutoReplyAuthoringSessionCurrentResponseSchema
>;
