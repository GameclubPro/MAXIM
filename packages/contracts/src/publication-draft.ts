import { z } from 'zod';
import {
  publicationDetailsSchema,
  publicationDraftContentInputSchema,
  publicationTargetInputSchema,
  MAX_PUBLICATION_TARGETS,
  MAX_PUBLICATION_EXPLICIT_SLOTS,
  MAX_PUBLICATION_BUTTONS,
} from './publication.js';

export const MAX_PUBLICATION_SERVER_DRAFTS = 50;
export const MAX_PUBLICATION_DRAFT_STORAGE_BYTES = 128 * 1024 * 1024;
const time = z.string().regex(/^(?:|(?:[01]\d|2[0-3]):[0-5]\d)$/u);
const instant = z.string().datetime().nullable();
const zone = z
  .string()
  .max(128)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('ru-RU', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, 'Выберите корректный часовой пояс.');

export const publicationDraftStateSchema = z.object({
  formatVersion: z.literal(1),
  timingMode: z.enum(['now', 'once', 'schedule']),
  scheduleKind: z.enum(['slots', 'recurrence']),
  scheduleTimezone: zone,
  scheduledSlots: z.array(z.string().datetime()).max(MAX_PUBLICATION_EXPLICIT_SLOTS),
  onceDate: z.string().max(10),
  onceTime: time,
  buttons: z
    .array(z.object({ text: z.string().max(128), url: z.string().max(2048) }))
    .max(MAX_PUBLICATION_BUTTONS)
    .optional(),
  buttonEnabled: z.boolean().optional(),
  recurrence: z.object({
    frequency: z.enum(['daily', 'weekly']),
    interval: z.number().int().min(1).max(31),
    weekdays: z.array(z.number().int().min(1).max(7)).max(7),
    times: z.array(time).max(12),
    startsAt: instant,
    endsAt: instant,
    maxOccurrences: z.number().int().min(1).max(365).nullable(),
  }),
});
export type PublicationDraftState = z.infer<typeof publicationDraftStateSchema>;

export const savePublicationDraftRequestSchema = z
  .object({
    requestId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{8,128}$/u),
    expectedRevision: z.number().int().min(1).optional(),
    title: z.string().trim().max(120),
    content: publicationDraftContentInputSchema,
    targets: z
      .array(publicationTargetInputSchema)
      .max(MAX_PUBLICATION_TARGETS)
      .refine(
        (targets) => new Set(targets.map((target) => target.chatId)).size === targets.length,
        'Один получатель выбран несколько раз.',
      ),
    state: publicationDraftStateSchema,
  })
  .strict();
export type SavePublicationDraftRequest = z.infer<typeof savePublicationDraftRequestSchema>;
export const publicationDraftResponseSchema = z.object({
  publication: publicationDetailsSchema,
  state: publicationDraftStateSchema.nullable(),
});
export type PublicationDraftResponse = z.infer<typeof publicationDraftResponseSchema>;
