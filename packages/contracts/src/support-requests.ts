import { z } from 'zod';

export const supportRequestStatusSchema = z.enum(['NEW', 'CLOSED']);
export type SupportRequestStatus = z.infer<typeof supportRequestStatusSchema>;

export const supportRequestAttachmentSchema = z.object({
  type: z.enum(['image', 'file', 'video', 'unknown']),
  fileName: z.string().nullable().default(null),
  mimeType: z.string().nullable().default(null),
  url: z.string().url().nullable().default(null),
  payload: z.record(z.string(), z.unknown()).nullable().default(null),
});
export type SupportRequestAttachment = z.infer<typeof supportRequestAttachmentSchema>;

export const supportRequestItemSchema = z.object({
  id: z.string(),
  status: supportRequestStatusSchema,
  botId: z.string().nullable().default(null),
  privateChatId: z.string(),
  userId: z.string(),
  userName: z.string().nullable().default(null),
  messageId: z.string().nullable().default(null),
  text: z.string(),
  attachments: z.array(supportRequestAttachmentSchema).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  closedAt: z.string().datetime().nullable().default(null),
});
export type SupportRequestItem = z.infer<typeof supportRequestItemSchema>;

export const supportRequestSummarySchema = z.object({
  new: z.number().int().min(0).default(0),
  closed: z.number().int().min(0).default(0),
});
export type SupportRequestSummary = z.infer<typeof supportRequestSummarySchema>;

export const supportRequestQueueResponseSchema = z.object({
  generatedAt: z.string().datetime(),
  items: z.array(supportRequestItemSchema).default([]),
  summary: supportRequestSummarySchema,
});
export type SupportRequestQueueResponse = z.infer<typeof supportRequestQueueResponseSchema>;

export const supportRequestDecisionResponseSchema = z.object({
  item: supportRequestItemSchema.nullable().default(null),
  queue: supportRequestQueueResponseSchema,
  message: z.string(),
});
export type SupportRequestDecisionResponse = z.infer<typeof supportRequestDecisionResponseSchema>;
