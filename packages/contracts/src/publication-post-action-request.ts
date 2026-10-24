import { z } from 'zod';
import { utcTimestampSchema } from './validator-compat.js';

const base = {
  requestId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{8,128}$/u),
  expectedVersion: z.string().regex(/^[a-f0-9]{64}$/u),
};
export const publicationPostActionRequestSchema = z.discriminatedUnion('action', [
  z.object({ ...base, action: z.literal('cancel_delete') }).strict(),
  z.object({ ...base, action: z.literal('retry_delete') }).strict(),
  z.object({ ...base, action: z.literal('retry_pin') }).strict(),
  z
    .object({ ...base, action: z.literal('reschedule_delete'), deleteAt: utcTimestampSchema })
    .strict(),
]);
export type PublicationPostActionRequest = z.infer<typeof publicationPostActionRequestSchema>;
