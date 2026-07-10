import { z } from 'zod';

export const MAX_PUBLICATION_IMAGES = 10;
export const MAX_PUBLICATION_IMAGE_BASE64_LENGTH = 12_000_000;
export const MAX_PUBLICATION_IMAGES_TOTAL_BASE64_LENGTH = 32_000_000;
export const MAX_PUBLICATION_VIDEO_BASE64_LENGTH = 32_000_000;
export const MAX_PUBLICATION_BUTTONS = 8;
export const MAX_PUBLICATION_TARGETS = 500;
export const MAX_PUBLICATION_RECURRENCE_OCCURRENCES = 365;
export const MAX_PUBLICATION_LIST_CURSOR_LENGTH = 1_024;

export const publicationLifecycleSchema = z.enum([
  'DRAFT',
  'ACTIVE',
  'PAUSED',
  'COMPLETED',
  'CANCELED',
  'ERROR',
]);
export const publicationAudienceSelectionSchema = z.enum([
  'SELECTED',
  'ALL_CHATS',
  'ALL_CHANNELS',
  'ALL_MANAGED',
]);
export const publicationAudienceModeSchema = z.enum(['SNAPSHOT', 'DYNAMIC']);
export const publicationEntityTypeSchema = z.enum(['chat', 'channel']);
export const publicationTextFormatSchema = z.enum(['plain', 'markdown']);
export const publicationIntentSchema = z.enum(['draft', 'publish']);
export const publicationOccurrenceStatusSchema = z.enum([
  'SCHEDULED',
  'IN_PROGRESS',
  'SENT',
  'PARTIAL',
  'FAILED',
  'AMBIGUOUS',
  'CANCELED',
]);
export const publicationDeliveryStatusSchema = z.enum([
  'PENDING',
  'SENDING',
  'SENT',
  'FAILED',
  'AMBIGUOUS',
  'CANCELED',
]);

export type PublicationLifecycle = z.infer<typeof publicationLifecycleSchema>;
export type PublicationAudienceSelection = z.infer<typeof publicationAudienceSelectionSchema>;
export type PublicationAudienceMode = z.infer<typeof publicationAudienceModeSchema>;
export type PublicationEntityType = z.infer<typeof publicationEntityTypeSchema>;
export type PublicationTextFormat = z.infer<typeof publicationTextFormatSchema>;
export type PublicationIntent = z.infer<typeof publicationIntentSchema>;
export type PublicationOccurrenceStatus = z.infer<typeof publicationOccurrenceStatusSchema>;
export type PublicationDeliveryStatus = z.infer<typeof publicationDeliveryStatusSchema>;

function isValidPublicationButtonUrl(value: string): boolean {
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return false;
    }
    const startPayload = (parsed.searchParams.get('start') ?? '').trim();
    return !startPayload.startsWith('pmh-') && !startPayload.startsWith('pm2_');
  } catch {
    return false;
  }
}

export const publicationButtonSchema = z.object({
  text: z.string().trim().min(1).max(32),
  url: z
    .string()
    .trim()
    .max(2_048)
    .refine((value) => isValidPublicationButtonUrl(value), {
      message: 'Укажите корректную ссылку для кнопки (http/https).',
    }),
  row: z.number().int().min(0).max(9).default(0),
});
export type PublicationButton = z.infer<typeof publicationButtonSchema>;

export const publicationImageInputSchema = z.object({
  type: z.literal('image'),
  base64: z.string().trim().min(1).max(MAX_PUBLICATION_IMAGE_BASE64_LENGTH),
  mimeType: z.string().trim().toLowerCase().startsWith('image/').max(128),
  fileName: z.string().trim().max(128).default(''),
});

export const publicationVideoInputSchema = z.object({
  type: z.literal('video'),
  payload: z.record(z.string(), z.unknown()).nullable().default(null),
  base64: z.string().trim().max(MAX_PUBLICATION_VIDEO_BASE64_LENGTH).default(''),
  mimeType: z.string().trim().max(128).default(''),
  fileName: z.string().trim().max(128).default(''),
});

export const publicationImageReferenceInputSchema = z.object({
  type: z.literal('image-ref'),
  assetId: z.string().trim().min(1),
});

export const publicationVideoReferenceInputSchema = z.object({
  type: z.literal('video-ref'),
  assetId: z.string().trim().min(1),
});

export const publicationMediaInputSchema = z.discriminatedUnion('type', [
  publicationImageInputSchema,
  publicationVideoInputSchema,
  publicationImageReferenceInputSchema,
  publicationVideoReferenceInputSchema,
]);
export type PublicationMediaInput = z.infer<typeof publicationMediaInputSchema>;

export const publicationAssetSchema = z.object({
  id: z.string(),
  type: z.enum(['image', 'video']),
  mimeType: z.string(),
  fileName: z.string(),
  sizeBytes: z.number().int().min(0),
});
export type PublicationAsset = z.infer<typeof publicationAssetSchema>;

export const publicationContentInputSchema = z
  .object({
    text: z.string().max(2_000).default(''),
    textFormat: publicationTextFormatSchema.default('plain'),
    buttons: z.array(publicationButtonSchema).max(MAX_PUBLICATION_BUTTONS).default([]),
    media: z.array(publicationMediaInputSchema).max(MAX_PUBLICATION_IMAGES).default([]),
  })
  .superRefine((value, ctx) => {
    const videos = value.media.filter((item) => item.type === 'video' || item.type === 'video-ref');
    const images = value.media.filter((item) => item.type === 'image' || item.type === 'image-ref');
    const inlineImageBase64Length = value.media.reduce(
      (total, item) => total + (item.type === 'image' ? item.base64.length : 0),
      0,
    );
    if (inlineImageBase64Length > MAX_PUBLICATION_IMAGES_TOTAL_BASE64_LENGTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['media'],
        message: 'Суммарный размер фото слишком большой.',
      });
    }
    if (videos.length > 1 || (videos.length > 0 && images.length > 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['media'],
        message: 'Добавьте либо до 10 фото, либо одно видео.',
      });
    }
    const video = videos[0];
    if (video?.type === 'video') {
      const hasPayload = video.payload !== null && Object.keys(video.payload).length > 0;
      const hasBytes = video.base64.length > 0;
      if (hasPayload === hasBytes) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['media'],
          message: 'Добавьте видеофайл или сохранённое видео.',
        });
      }
      if (hasBytes && !video.mimeType.toLowerCase().startsWith('video/')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['media'],
          message: 'Неверный формат видео.',
        });
      }
    }
    if (value.text.trim().length === 0 && value.media.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['text'],
        message: 'Введите текст, добавьте фото или видео.',
      });
    }
  });
export type PublicationContentInput = z.infer<typeof publicationContentInputSchema>;

export const publicationContentSchema = z.object({
  revision: z.number().int().min(1),
  text: z.string(),
  textFormat: publicationTextFormatSchema,
  buttons: z.array(publicationButtonSchema),
  media: z.array(publicationAssetSchema),
});
export type PublicationContent = z.infer<typeof publicationContentSchema>;

export const publicationTargetInputSchema = z.object({
  chatId: z.string().trim().min(1),
  entityType: publicationEntityTypeSchema,
});
export type PublicationTargetInput = z.infer<typeof publicationTargetInputSchema>;

export const publicationAudienceInputSchema = z
  .object({
    selection: publicationAudienceSelectionSchema.default('SELECTED'),
    mode: publicationAudienceModeSchema.default('SNAPSHOT'),
    targets: z.array(publicationTargetInputSchema).max(MAX_PUBLICATION_TARGETS).default([]),
  })
  .superRefine((value, ctx) => {
    if (value.selection === 'SELECTED' && value.targets.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targets'],
        message: 'Выберите хотя бы один чат или канал.',
      });
    }
    const uniqueTargets = new Set(value.targets.map((target) => target.chatId));
    if (uniqueTargets.size !== value.targets.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targets'],
        message: 'Один получатель выбран несколько раз.',
      });
    }
  });
export type PublicationAudienceInput = z.infer<typeof publicationAudienceInputSchema>;

export const publicationTargetSchema = publicationTargetInputSchema.extend({
  title: z.string(),
  avatarUrl: z.string().url().nullable().default(null),
  link: z.string().url().nullable().default(null),
});
export type PublicationTarget = z.infer<typeof publicationTargetSchema>;

const publicationTimezoneSchema = z.string().trim().min(1).max(128).default('Europe/Moscow');
const publicationDateTimeSchema = z.string().datetime({ offset: true });
const publicationLocalTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u);

export const publicationNowScheduleSchema = z.object({
  mode: z.literal('now'),
  timezone: publicationTimezoneSchema,
});
export const publicationOnceScheduleSchema = z.object({
  mode: z.literal('once'),
  timezone: publicationTimezoneSchema,
  at: publicationDateTimeSchema,
  replaceConflicts: z.boolean().default(false),
});
export const publicationSlotsScheduleSchema = z.object({
  mode: z.literal('slots'),
  timezone: publicationTimezoneSchema,
  slots: z.array(publicationDateTimeSchema).min(1).max(186),
  replaceConflicts: z.boolean().default(false),
});
export const publicationRecurrenceScheduleSchema = z
  .object({
    mode: z.literal('recurrence'),
    timezone: publicationTimezoneSchema,
    frequency: z.enum(['daily', 'weekly']),
    interval: z.number().int().min(1).max(31).default(1),
    weekdays: z.array(z.number().int().min(1).max(7)).max(7).default([]),
    times: z.array(publicationLocalTimeSchema).min(1).max(12),
    startsAt: publicationDateTimeSchema.nullable().default(null),
    endsAt: publicationDateTimeSchema.nullable().default(null),
    maxOccurrences: z
      .number()
      .int()
      .min(1)
      .max(MAX_PUBLICATION_RECURRENCE_OCCURRENCES)
      .nullable()
      .default(null),
    replaceConflicts: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    if (value.frequency === 'weekly' && value.weekdays.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['weekdays'],
        message: 'Выберите хотя бы один день недели.',
      });
    }
    if (new Set(value.weekdays).size !== value.weekdays.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['weekdays'],
        message: 'Дни недели не должны повторяться.',
      });
    }
    if (new Set(value.times).size !== value.times.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['times'],
        message: 'Время публикации не должно повторяться.',
      });
    }
    if (value.startsAt && value.endsAt && Date.parse(value.endsAt) <= Date.parse(value.startsAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endsAt'],
        message: 'Дата завершения должна быть позже даты начала.',
      });
    }
  });

export const publicationScheduleInputSchema = z.discriminatedUnion('mode', [
  publicationNowScheduleSchema,
  publicationOnceScheduleSchema,
  publicationSlotsScheduleSchema,
  publicationRecurrenceScheduleSchema,
]);
export type PublicationScheduleInput = z.infer<typeof publicationScheduleInputSchema>;

export const publicationScheduleSchema = publicationScheduleInputSchema.and(
  z.object({
    status: z.enum(['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELED', 'ERROR']),
    revision: z.number().int().min(1),
    nextOccurrenceAt: publicationDateTimeSchema.nullable(),
    lastError: z.string().nullable(),
  }),
);
export type PublicationSchedule = z.infer<typeof publicationScheduleSchema>;

const publicationMutationBaseSchema = z.object({
  title: z.string().trim().max(120).default(''),
  content: publicationContentInputSchema,
  audience: publicationAudienceInputSchema,
  schedule: publicationScheduleInputSchema.nullable().default(null),
  intent: publicationIntentSchema.default('publish'),
});

export const createPublicationRequestSchema = publicationMutationBaseSchema
  .extend({
    requestId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{8,128}$/u),
  })
  .superRefine((value, ctx) => {
    if (value.intent === 'publish' && value.schedule === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['schedule'],
        message: 'Выберите время публикации.',
      });
    }
  });
export type CreatePublicationRequest = z.infer<typeof createPublicationRequestSchema>;

export const updatePublicationRequestSchema = publicationMutationBaseSchema.partial().extend({
  expectedRevision: z.number().int().min(1),
  requestId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{8,128}$/u),
});
export type UpdatePublicationRequest = z.infer<typeof updatePublicationRequestSchema>;

export const testPublicationRequestSchema = z.object({
  requestId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{8,128}$/u),
  content: publicationContentInputSchema,
  sourceTarget: publicationTargetInputSchema,
});
export type TestPublicationRequest = z.infer<typeof testPublicationRequestSchema>;

export const publicationDeliveryStatsSchema = z.object({
  total: z.number().int().min(0),
  pending: z.number().int().min(0),
  sent: z.number().int().min(0),
  failed: z.number().int().min(0),
  ambiguous: z.number().int().min(0),
  canceled: z.number().int().min(0),
});
export type PublicationDeliveryStats = z.infer<typeof publicationDeliveryStatsSchema>;

export const publicationOccurrenceSummarySchema = z.object({
  id: z.string(),
  scheduledAt: publicationDateTimeSchema,
  status: publicationOccurrenceStatusSchema,
  delivery: publicationDeliveryStatsSchema,
  canRetry: z.boolean(),
});
export type PublicationOccurrenceSummary = z.infer<typeof publicationOccurrenceSummarySchema>;

export const publicationSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  lifecycle: publicationLifecycleSchema,
  version: z.number().int().min(1),
  contentPreview: z.string(),
  targetCount: z.number().int().min(0),
  targetPreviews: z.array(publicationTargetSchema).max(6),
  targetOverflowCount: z.number().int().min(0),
  audienceSelection: publicationAudienceSelectionSchema,
  audienceMode: publicationAudienceModeSchema,
  mediaCount: z.number().int().min(0),
  hasVideo: z.boolean(),
  schedule: publicationScheduleSchema.nullable(),
  delivery: publicationDeliveryStatsSchema,
  createdAt: publicationDateTimeSchema,
  updatedAt: publicationDateTimeSchema,
});
export type PublicationSummary = z.infer<typeof publicationSummarySchema>;

export const publicationDetailsSchema = publicationSummarySchema.extend({
  content: publicationContentSchema,
  targets: z.array(publicationTargetSchema),
  occurrences: z.array(publicationOccurrenceSummarySchema),
});
export type PublicationDetails = z.infer<typeof publicationDetailsSchema>;

export const publicationListViewSchema = z.enum(['plan', 'drafts', 'schedules', 'history']);
export const publicationListStatusFilterSchema = z.enum([
  'active',
  'paused',
  'completed',
  'failed',
]);

export const publicationListCursorPayloadSchema = z.object({
  v: z.literal(1),
  updatedAt: publicationDateTimeSchema,
  id: z.string().trim().min(1).max(256),
  view: publicationListViewSchema,
  query: z.string().max(120),
  entityType: publicationEntityTypeSchema.optional(),
  status: publicationListStatusFilterSchema.optional(),
});
export type PublicationListCursorPayload = z.infer<typeof publicationListCursorPayloadSchema>;

export function encodePublicationListCursor(payload: PublicationListCursorPayload): string {
  const parsed = publicationListCursorPayloadSchema.parse(payload);
  const bytes = new TextEncoder().encode(JSON.stringify(parsed));
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return globalThis.btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

export function decodePublicationListCursor(value: string): PublicationListCursorPayload | null {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_PUBLICATION_LIST_CURSOR_LENGTH ||
    !/^[A-Za-z0-9_-]+$/u.test(normalized)
  ) {
    return null;
  }

  try {
    const padding = '='.repeat((4 - (normalized.length % 4)) % 4);
    const binary = globalThis.atob(
      `${normalized.replace(/-/gu, '+').replace(/_/gu, '/')}${padding}`,
    );
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const decoded = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    const parsed = publicationListCursorPayloadSchema.safeParse(decoded);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export const listPublicationsQuerySchema = z.object({
  view: publicationListViewSchema.default('plan'),
  cursor: z.string().trim().min(1).max(MAX_PUBLICATION_LIST_CURSOR_LENGTH).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  query: z.string().trim().max(120).default(''),
  entityType: publicationEntityTypeSchema.optional(),
  status: publicationListStatusFilterSchema.optional(),
});
export type ListPublicationsQuery = z.infer<typeof listPublicationsQuerySchema>;

export const listPublicationsResponseSchema = z.object({
  items: z.array(publicationSummarySchema),
  nextCursor: z.string().nullable(),
});
export type ListPublicationsResponse = z.infer<typeof listPublicationsResponseSchema>;

export const publicationDeliverySchema = z.object({
  id: z.string(),
  occurrenceId: z.string(),
  target: publicationTargetSchema,
  status: publicationDeliveryStatusSchema,
  attemptCount: z.number().int().min(0),
  remoteMessageId: z.string().nullable(),
  lastError: z.string().nullable(),
  sentAt: publicationDateTimeSchema.nullable(),
});
export type PublicationDelivery = z.infer<typeof publicationDeliverySchema>;

export const listPublicationDeliveriesQuerySchema = z.object({
  occurrenceId: z.string().trim().min(1).optional(),
  status: publicationDeliveryStatusSchema.optional(),
  excludeStatus: publicationDeliveryStatusSchema.optional(),
  cursor: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListPublicationDeliveriesQuery = z.infer<typeof listPublicationDeliveriesQuerySchema>;

export const listPublicationDeliveriesResponseSchema = z.object({
  items: z.array(publicationDeliverySchema),
  nextCursor: z.string().nullable(),
});
export type ListPublicationDeliveriesResponse = z.infer<
  typeof listPublicationDeliveriesResponseSchema
>;

export const publicationActionRequestSchema = z.object({
  expectedRevision: z.number().int().min(1),
  requestId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{8,128}$/u),
});
export type PublicationActionRequest = z.infer<typeof publicationActionRequestSchema>;

export const retryPublicationOccurrenceRequestSchema = z.object({
  requestId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{8,128}$/u),
});
export type RetryPublicationOccurrenceRequest = z.infer<
  typeof retryPublicationOccurrenceRequestSchema
>;

export const resolvePublicationAmbiguousDeliveryRequestSchema = z.object({
  requestId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{8,128}$/u),
  deliveryId: z.string().trim().min(1),
  resolution: z.enum(['mark_sent', 'mark_failed']),
});
export type ResolvePublicationAmbiguousDeliveryRequest = z.infer<
  typeof resolvePublicationAmbiguousDeliveryRequestSchema
>;
