import { z } from 'zod';
import { broadcastTextFormatSchema } from './broadcast-common.js';
import {
  MAX_BROADCAST_IMAGES,
  MAX_BROADCAST_IMAGES_TOTAL_BASE64,
  broadcastImageSchema,
  type BroadcastImage,
} from './core.js';

export const MANAGED_POLL_MIN_OPTIONS = 2;
export const MANAGED_POLL_MAX_OPTIONS = 6;
export const MANAGED_POLL_QUESTION_MAX_LENGTH = 280;
export const MANAGED_POLL_OPTION_MAX_LENGTH = 80;

export const managedPollStatusSchema = z.enum(['DRAFT', 'ACTIVE', 'CLOSED']);
export const managedPollVisibilitySchema = z.enum(['ANONYMOUS', 'OPEN']);
export const managedPollQuestionFormatSchema = broadcastTextFormatSchema;

export type ManagedPollStatus = z.infer<typeof managedPollStatusSchema>;
export type ManagedPollVisibility = z.infer<typeof managedPollVisibilitySchema>;
export type ManagedPollQuestionFormat = z.infer<typeof managedPollQuestionFormatSchema>;
export type ManagedPollImage = BroadcastImage;

const managedPollQuestionSchema = z
  .string()
  .trim()
  .min(1, { message: 'Введите вопрос.' })
  .max(MANAGED_POLL_QUESTION_MAX_LENGTH, {
    message: `Вопрос должен быть не длиннее ${MANAGED_POLL_QUESTION_MAX_LENGTH} символов.`,
  });

const managedPollOptionTextSchema = z
  .string()
  .trim()
  .min(1, { message: 'Заполните вариант ответа.' })
  .max(MANAGED_POLL_OPTION_MAX_LENGTH, {
    message: `Вариант должен быть не длиннее ${MANAGED_POLL_OPTION_MAX_LENGTH} символов.`,
  });

const managedPollImagesInputSchema = z
  .array(broadcastImageSchema)
  .max(MAX_BROADCAST_IMAGES, `Можно добавить до ${MAX_BROADCAST_IMAGES} фото.`)
  .superRefine((images, ctx) => {
    const totalBase64Length = images.reduce((total, image) => total + image.base64.length, 0);
    if (totalBase64Length > MAX_BROADCAST_IMAGES_TOTAL_BASE64) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Суммарный размер фото слишком большой.',
      });
    }
  });

export const managedPollImagesSchema = managedPollImagesInputSchema.default([]);

export const managedPollOptionInputSchema = z.object({
  id: z.string().trim().min(1).max(128).optional(),
  text: managedPollOptionTextSchema,
});
export type ManagedPollOptionInput = z.infer<typeof managedPollOptionInputSchema>;

const managedPollMutationFields = {
  question: managedPollQuestionSchema,
  visibility: managedPollVisibilitySchema.default('ANONYMOUS'),
  options: z
    .array(managedPollOptionInputSchema)
    .min(MANAGED_POLL_MIN_OPTIONS)
    .max(MANAGED_POLL_MAX_OPTIONS),
};

function validateManagedPollOptions(
  value: { options: readonly ManagedPollOptionInput[] },
  ctx: z.RefinementCtx,
): void {
  const optionIds = new Set<string>();
  const optionTexts = new Set<string>();

  for (const [index, option] of value.options.entries()) {
    if (option.id) {
      if (optionIds.has(option.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['options', index, 'id'],
          message: 'Вариант уже добавлен.',
        });
      }
      optionIds.add(option.id);
    }

    const textKey = option.text.replace(/\s+/gu, ' ').toLowerCase().replace(/ё/gu, 'е');
    if (optionTexts.has(textKey)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options', index, 'text'],
        message: 'Варианты ответа не должны повторяться.',
      });
    }
    optionTexts.add(textKey);
  }
}

export const createManagedPollRequestSchema = z
  .object({
    ...managedPollMutationFields,
    questionFormat: managedPollQuestionFormatSchema.default('plain'),
    images: managedPollImagesSchema,
  })
  .superRefine(validateManagedPollOptions);
export type CreateManagedPollRequest = z.infer<typeof createManagedPollRequestSchema>;

export const updateManagedPollRequestSchema = z
  .object({
    ...managedPollMutationFields,
    questionFormat: managedPollQuestionFormatSchema.optional(),
    images: managedPollImagesInputSchema.optional(),
  })
  .superRefine(validateManagedPollOptions);
export type UpdateManagedPollRequest = z.infer<typeof updateManagedPollRequestSchema>;

export const managedPollOptionSchema = z.object({
  id: z.string(),
  position: z
    .number()
    .int()
    .min(0)
    .max(MANAGED_POLL_MAX_OPTIONS - 1),
  text: managedPollOptionTextSchema,
  votes: z.number().int().min(0),
  percent: z.number().int().min(0).max(100),
});
export type ManagedPollOption = z.infer<typeof managedPollOptionSchema>;

export const managedPollSummarySchema = z.object({
  id: z.string(),
  channelId: z.string(),
  question: managedPollQuestionSchema,
  questionFormat: managedPollQuestionFormatSchema.default('plain'),
  status: managedPollStatusSchema,
  visibility: managedPollVisibilitySchema,
  imageCount: z.number().int().min(0).max(MAX_BROADCAST_IMAGES).default(0),
  totalVotes: z.number().int().min(0),
  options: z
    .array(managedPollOptionSchema)
    .min(MANAGED_POLL_MIN_OPTIONS)
    .max(MANAGED_POLL_MAX_OPTIONS),
  publicationPending: z.boolean(),
  publicationNeedsReview: z.boolean(),
  renderRepairNeeded: z.boolean(),
  publicationUrl: z.string().trim().max(2_048).nullable(),
  publishedAt: z.string().datetime().nullable(),
  closedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ManagedPollSummary = z.infer<typeof managedPollSummarySchema>;

export const managedPollListQuerySchema = z.object({
  cursor: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(30),
});
export type ManagedPollListQuery = z.infer<typeof managedPollListQuerySchema>;

export const managedPollListResponseSchema = z.object({
  items: z.array(managedPollSummarySchema),
  nextCursor: z.string().nullable(),
});
export type ManagedPollListResponse = z.infer<typeof managedPollListResponseSchema>;

export const managedPollDetailsSchema = managedPollSummarySchema.extend({
  images: managedPollImagesSchema,
  publicationMessageId: z.string().nullable(),
  lastError: z.string().nullable(),
  lastRenderError: z.string().nullable(),
});
export type ManagedPollDetails = z.infer<typeof managedPollDetailsSchema>;

export const managedPollVoterSchema = z.object({
  id: z.string(),
  pollId: z.string(),
  optionId: z.string(),
  userId: z.string().nullable(),
  displayName: z.string().nullable(),
  username: z.string().nullable(),
  votedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ManagedPollVoter = z.infer<typeof managedPollVoterSchema>;

export const managedPollVotersQuerySchema = z.object({
  cursor: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ManagedPollVotersQuery = z.infer<typeof managedPollVotersQuerySchema>;

export const managedPollVotersResponseSchema = z.object({
  items: z.array(managedPollVoterSchema),
  nextCursor: z.string().nullable(),
});
export type ManagedPollVotersResponse = z.infer<typeof managedPollVotersResponseSchema>;
