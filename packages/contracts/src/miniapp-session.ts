import { z } from 'zod';
import {
  miniappCapabilitySchema,
  miniappHomeRouteSchema,
  miniappProfileSchema,
} from './publisher.js';

const botDialogUrlSchema = z
  .string()
  .trim()
  .url()
  .regex(/^https:\/\/max\.ru\/[^/?#\s]+$/u);

export const meSchema = z.object({
  userId: z.string(),
  username: z.string().nullable(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().trim().url().nullable().default(null),
  profileUrl: z.string().trim().url().nullable().default(null),
  profileHandoffUrl: z.string().trim().url().nullable().default(null),
  botDialogUrl: botDialogUrlSchema.nullable().default(null),
  canAccessSystem: z.boolean().optional(),
  networksEnabled: z.boolean().optional(),
  profile: miniappProfileSchema.default('moderation'),
  capabilities: z
    .array(miniappCapabilitySchema)
    .default(['moderation_workspace', 'publisher_policy_write']),
  homeRoute: miniappHomeRouteSchema.default('/'),
});
export type Me = z.infer<typeof meSchema>;
